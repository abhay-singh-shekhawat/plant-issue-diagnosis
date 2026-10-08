import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

import { envNum } from '../env.js';
import { coerceLanguage } from '../language.js';
import { getWeatherData } from './weather.service.js';
import { getMockSatelliteData } from './satellite.service.js';
import { getVisualDiagnosis } from './vision.service.js';
import { resolveTargetCase, getActiveCase, setCaseLabel, withConversationLock } from './session.service.js';
import { geminiWithRetry } from './gemini-retry.js';

// Initialize Gemini API (lazy + guarded so the server never crashes on boot)
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Diagnosis is finalised only at/above this score, unless the follow-up budget
// is exhausted (the anti-infinite-loop breaker). Validated via envNum: garbage
// like "abc" falls back to defaults instead of NaN (which broke comparisons).
const CONFIDENCE_THRESHOLD = envNum('CONFIDENCE_THRESHOLD', 85);
const MAX_FOLLOW_UP_QUESTIONS = envNum('MAX_FOLLOW_UP_QUESTIONS', 2);

const FALLBACK_FOLLOW_UP = 'कृपया मुझे अपनी समस्या के बारे में और जानकारी दें।';

// --- history helpers ----------------------------------------------------------
/** Hard cap on stored turns per case. The send window is still last-6; this only
 *  bounds memory so a long-lived case cannot grow `history` forever. */
export const MAX_HISTORY_ENTRIES = 50;

/** Pushes one turn and trims the tail so history never exceeds the cap. */
export const pushHistory = (kase, role, content) => {
    if (!kase || !Array.isArray(kase.history)) return;
    kase.history.push({ role, content });
    if (kase.history.length > MAX_HISTORY_ENTRIES) {
        kase.history.splice(0, kase.history.length - MAX_HISTORY_ENTRIES);
    }
};

/**
 * Builds the Gemini `contents` array from case history: last 6 turns, starting
 * on a user turn (the API rejects history starting with a model turn).
 * Returns `[]` when no user turn exists in the window — the caller must handle
 * that explicitly instead of dereferencing `contents[-1]`.
 */
export const buildChatContents = (history) => {
    const window = (Array.isArray(history) ? history : []).slice(-6);
    const firstUserIndex = window.findIndex((m) => m && m.role === 'user');
    if (firstUserIndex === -1) return [];
    return window.slice(firstUserIndex).map((msg) => ({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
};

let genAIClient = null;
const getGenAI = () => {
    if (!GEMINI_API_KEY) return null;
    if (!genAIClient) genAIClient = new GoogleGenerativeAI(GEMINI_API_KEY);
    return genAIClient;
};

/**
 * Builds a Gemini model carrying the system instruction natively (instead of
 * stuffing it into the last user turn). Cheap: no network call happens here.
 */
const getModel = (systemInstruction) => {
    const genAI = getGenAI();
    if (!genAI) return null;
    const config = { model: GEMINI_MODEL };
    if (systemInstruction) config.systemInstruction = systemInstruction;
    return genAI.getGenerativeModel(config);
};
// ---------------------------------------------------------------------------
// NOTE: the flat per-session state store that used to live here has moved to
// ./session.service.js as a conversation -> case model. A conversation is the
// channel thread (one phone number / one browser); a case is ONE crop problem
// inside it. That lets a farmer diagnose two problems at once and re-open a
// finished case when the same disease gets worse.
// ---------------------------------------------------------------------------

// Runs the three evidence collectors together: photo understanding (Track A)
// + live weather + soil estimate (Track B). Always runs together on a new photo.
const runDiagnosticEngine = async (imageUrl, coordinates) => {
    const visualDiagnosis = await getVisualDiagnosis(imageUrl);

    const weatherData = await getWeatherData(coordinates.lat, coordinates.lon);

    const satelliteData = await getMockSatelliteData(coordinates.lat, coordinates.lon, weatherData);

    const geoSpatialData = {
        weather: weatherData,
        soil_satellite_mock: satelliteData
    };

    return {
        visual_diagnosis: visualDiagnosis,
        geo_spatial_data: geoSpatialData,
        raw_data: { image: imageUrl, loc: coordinates }
    };
};

const processMessageInner = async ({
    sessionId,
    source,
    text = '',
    imageUrl = null,
    coordinates = null,
    language = null,
    action = null,
    caseId = null
}) => {
    // 0. Resolve WHICH case this message belongs to (create / switch / clarify / progress).
    const resolution = resolveTargetCase({
        conversationId: sessionId,
        text,
        imageUrl,
        coordinates,
        action,
        caseId
    });
    const { conversation, photoChanged, isProgression, needsClarification, directResponse } = resolution;
    let kase = resolution.case;

    // Language boundary (R3): raw caller input is NEVER stored verbatim.
    // Valid → canonical code. Invalid on an existing session → keep the prior
    // valid language (never clobber, never 400 an established conversation).
    // Invalid with no prior → DEFAULT_LANGUAGE. This also fixes the crash where
    // a non-string `language` reached buildGatheringNudge's `.split()`.
    if (language !== null && language !== undefined && language !== '') {
        conversation.language = coerceLanguage(language, conversation.language);
    }

    // Deterministic reply (case list / switch ack / "same or new?"): no LLM call needed.
    if (directResponse) {
        const target = kase || getActiveCase(conversation);
        if (target) pushHistory(target, 'model', directResponse);
        return {
            text: directResponse,
            diagnosticResult: null,
            state: target,
            conversation,
            language: conversation.language,
            needsClarification
        };
    }

    if (!kase) kase = getActiveCase(conversation);

    // 1. Slot filling (a photo was already attached by the resolver)
    if (coordinates) kase.coordinates = coordinates;

    const slotReady = !!(kase.image_url && kase.coordinates);
    console.log(`[Agent] sessionId=${sessionId} caseId=${kase.caseId} status=${kase.status} hasImage=${!!kase.image_url} hasLocation=${!!kase.coordinates} slotReady=${slotReady} photoChanged=${photoChanged} isProgression=${isProgression}`);
    let systemPromptAddition = '';
    let isConfidenceEval = false;

    // 2. Choose the reasoning mode for this turn
    // Crash-loop guard: when the photo attachment is dropped (e.g. an unreadable
    // file or a race), kase.image_url may be empty while the resolver flagged a
    // new photo. Fall back to the raw_data image so runDiagnosticEngine still
    // re-runs on the intended photo instead of throwing on null.
    const photoUrl = (isProgression && kase.image_url)
        || kase.diagnostic_data?.raw_data?.image
        || kase.image_url;
    if (isProgression && slotReady) {
        kase.diagnostic_data = await runDiagnosticEngine(photoUrl, kase.coordinates);
        kase.status = 'evaluating_confidence';
        kase.question_count = 0;   // fresh verdict for the new evidence
        isConfidenceEval = true;
        systemPromptAddition = buildProgressionPrompt(kase, conversation);
    } else if (slotReady && kase.status !== 'completed') {
        if (photoChanged || !kase.diagnostic_data) {
            kase.diagnostic_data = await runDiagnosticEngine(photoUrl, kase.coordinates);
        }
        kase.status = 'evaluating_confidence';
        isConfidenceEval = true;
        systemPromptAddition = buildDiagnosisPrompt(kase, conversation);
    } else if (kase.status === 'completed') {
        systemPromptAddition = buildCompletedPrompt(kase, conversation);
    } else {
        // Still gathering slots (no image or no location yet). No need to call
        // Gemini — just tell the farmer exactly what is missing in their language.
        const nudge = buildGatheringNudge(kase, conversation.language || language);
        pushHistory(kase, 'model', nudge);
        kase.updatedAt = Date.now();
        return {
            text: nudge,
            diagnosticResult: null,
            state: kase,
            conversation,
            language: conversation.language,
            needsClarification: null
        };
    }

    // 3. Assemble the system instruction. It is passed to Gemini natively
    //    (via systemInstruction) rather than being concatenated into the user
    //    turn, which keeps the transcript clean and the instruction stronger.
    //
    // LANGUAGE RULE — baked in explicitly so Gemini never has to guess.
    // conversation.language is set from Deepgram STT detection or the user's
    // typed text on every turn, so it always reflects the farmer's actual language.
    const detectedLang = conversation.language || language || 'hi';
    const langInstruction = `
CRITICAL LANGUAGE RULE: You MUST reply ONLY in this language code: "${detectedLang}".
Do NOT use any other language. Do NOT mix languages. Do NOT use Japanese, Chinese, Korean or any script the farmer did not use.
If the code is "hi" reply in Hindi (Devanagari script).
If the code is "gu" reply in Gujarati. If "mr" reply in Marathi. If "ta" reply in Tamil.
If "te" reply in Telugu. If "kn" reply in Kannada. If "ml" reply in Malayalam.
If "pa" reply in Punjabi. If "bn" reply in Bengali. If "en" reply in English.
For any other code, reply in Hindi as the safe default.
`;
    const systemInstruction = `
You are an expert Agentic Agronomist AI. You help farmers diagnose crop diseases.
${langInstruction}
${systemPromptAddition}
`;

    // 4. Add the user's turn to THIS case's short-term memory.
    const inputContent = buildUserTurn({ text, imageUrl, coordinates });

    if (!inputContent) {
        // Empty message (sticker, blank forward) — don't call the AI, just nudge.
        const target = kase || getActiveCase(conversation);
        return {
            text: buildGatheringPromptNudge(target, conversation.language || language),
            diagnosticResult: null,
            state: target,
            conversation,
            language: conversation.language,
            needsClarification: null
        };
    }

    pushHistory(kase, 'user', inputContent);

    // 5. Send window: last 6 turns starting on a user turn. An empty window
    //    (no user turn — only reachable via synthetic/legacy histories) falls
    //    back to the current input alone instead of dereferencing contents[-1].
    let contents = buildChatContents(kase.history);
    if (contents.length === 0) {
        contents = [{ role: 'user', parts: [{ text: inputContent }] }];
    }

    const latestUserMsgIndex = contents.length - 1;

    // Ask Gemini for the next step.
    try {
        let aiResponseText = "";
        let isFinalDiag = false;

        const model = getModel(systemInstruction);
        if (!model) {
            aiResponseText = "Missing Gemini key. Please configure GEMINI_API_KEY on the server.";
        } else {
            const chatConfig = { history: contents.slice(0, -1) };

            // Native JSON mode enforcement for the diagnostic turns
            if (isConfidenceEval) {
                chatConfig.generationConfig = { responseMimeType: "application/json" };
            }

            const chat = model.startChat(chatConfig);
            const result = await geminiWithRetry(() => chat.sendMessage(contents[latestUserMsgIndex].parts[0].text));
            const rawText = result.response.text();

            if (isConfidenceEval) {
                let jsonResponse;
                try {
                    jsonResponse = JSON.parse(rawText);

                    // Finalize only when the model says "confident" with a good
                    // score, or when we've already asked max questions.
                    const parsedScore = Number(jsonResponse.confidence_score);
                    const score = Number.isFinite(parsedScore) ? parsedScore : null;
                    const forced = kase.question_count >= MAX_FOLLOW_UP_QUESTIONS;
                    const confidentEnough = jsonResponse.status === 'confident'
                        && (score === null || score >= CONFIDENCE_THRESHOLD);

                    if (confidentEnough || forced) {
                        aiResponseText = jsonResponse.final_diagnosis_draft
                            || "Based on the provided information, I have reached a conclusion.";
                        kase.status = 'completed';
                        kase.last_diagnosis = aiResponseText;
                        kase.confidence = score;
                        if (jsonResponse.case_label) setCaseLabel(kase, jsonResponse.case_label);
                        isFinalDiag = true;
                    } else {
                        const questions = jsonResponse.follow_up_questions || [];
                        aiResponseText = questions.length > 0 ? questions.join(' ') : FALLBACK_FOLLOW_UP;
                        kase.question_count += 1;
                    }
                } catch (e) {
                    // Model reply wasn't valid JSON — ask a generic follow-up.
                    aiResponseText = FALLBACK_FOLLOW_UP;
                    kase.question_count += 1;
                }
            } else {
                aiResponseText = rawText;
            }
        }

        // Add to history so the AI remembers the actual question it asked
        pushHistory(kase, 'model', aiResponseText);
        kase.updatedAt = Date.now();

        return {
            text: aiResponseText,
            diagnosticResult: isFinalDiag ? kase.diagnostic_data : null,
            state: kase,
            conversation,
            language: conversation.language,
            needsClarification: null
        };
    } catch (error) {
        // Network / API failure — give the farmer actionable guidance instead
        // of a generic error. If we already know what they are missing, tell
        // them specifically; otherwise ask for the photo + location.
        console.error('[Agent] processMessage error:', (error && error.message) || error);
        // Record the failure turn: the transcript must show the farmer's
        // message AND the fallback reply, like the success path does.
        pushHistory(kase, 'model', '[turn failed: Gemini/network error — fallback reply sent]');
        if (kase) kase.updatedAt = Date.now();
        const hasImage = !!(kase && kase.image_url);
        const hasLocation = !!(kase && kase.coordinates);
        let fallback;
        if (!hasImage && !hasLocation) {
            fallback = 'नमस्ते! 🌱 कृपया अपनी फसल की एक साफ फोटो और अपनी लोकेशन पिन भेजें — फिर मैं आपकी फसल की बीमारी पहचानकर उपाय बताऊंगा।\n\nHello! Please send a clear photo of your crop and share your location pin 📍 — I will then diagnose the problem and suggest a remedy in your language.';
        } else if (!hasImage) {
            fallback = 'कृपया प्रभावित फसल की एक साफ फोटो भेजें। / Please send a clear photo of the affected crop.';
        } else if (!hasLocation) {
            fallback = 'कृपया अपनी लोकेशन पिन भेजें (Attach → Location) ताकि मैं मौसम और मिट्टी की जानकारी देख सकूं। / Please share your location pin (Attach → Location) so I can check weather and soil data.';
        } else {
            fallback = 'कुछ तकनीकी समस्या आई। कृपया थोड़ी देर बाद दोबारा भेजें। / A technical issue occurred. Please try sending again in a moment.';
        }
        return {
            text: fallback,
            diagnosticResult: null,
            state: kase,
            conversation,
            language: conversation.language,
            needsClarification: null
        };
    }
};

// ===========================================================================
// Public entry point — serialized per conversation.
// Concurrent messages from the same farmer are queued so their awaits cannot
// interleave and corrupt the case state.
// ===========================================================================
export const processMessage = (args) =>
    withConversationLock(args?.sessionId, () => processMessageInner(args));

// ===========================================================================
// Prompt builders — one per reasoning mode. Declared at module scope
// (function declarations are hoisted) so processMessage can call them.
// ===========================================================================

/** Shared output contract for every diagnostic turn (Phase 3 and Phase 3B). */
const DIAGNOSIS_JSON_CONTRACT = `
CRITICAL INSTRUCTION: You MUST format your ENTIRE output as a valid JSON object. Do not include markdown codeblocks (\`\`\`json) outside of the structure, just output raw JSON:
{
  "confidence_score": <number 0-100>,
  "internal_reasoning": "<string explaining your logic>",
  "status": "confident" | "needs_more_info",
  "follow_up_questions": ["<question 1 in the EXACT SAME language the user used>"],
  "final_diagnosis_draft": "<Markdown formatted final diagnosis in the EXACT SAME language the user used, empty if 'needs_more_info'>",
  "case_label": "<2-5 word English label for this crop problem, e.g. 'Tomato leaf blight'>"
}
`;

export function buildDiagnosisPrompt(kase, conversation) {
    const d = kase.diagnostic_data;
    return `
[PHASE 3: CONFIDENCE-BASED DYNAMIC DIAGNOSIS]
You are an Expert Agronomist communicating directly with a farmer.
We have collected initial multi-modal data:
--- VISUAL DIAGNOSIS (analysis of the farmer's actual photo) ---
- Suspected Disease: ${d.visual_diagnosis.suspected_disease}
- Visual Cues: ${d.visual_diagnosis.visual_cues}
- Visual Model Confidence: ${d.visual_diagnosis.confidence}%
- Alternatives considered: ${(d.visual_diagnosis.differential || []).join('; ') || 'none'}
- Visual Source: ${d.visual_diagnosis.source || 'unknown'}${d.visual_diagnosis.source === 'fallback' ? ' — NO automated visual analysis was possible; do NOT describe photo details as observed fact' : ''}

--- GEO-SPATIAL DATA ---
Weather: ${d.geo_spatial_data.weather.temperature_c}°C, Humidity ${d.geo_spatial_data.weather.humidity_percent}% (source: ${d.geo_spatial_data.weather.source || 'unknown'}${d.geo_spatial_data.weather.source === 'fallback' ? ' — service was down, this is an average-day placeholder, NOT a measurement' : ''})
Soil Moisture: ${d.geo_spatial_data.soil_satellite_mock.soil_moisture_percent}% (source: ${d.geo_spatial_data.soil_satellite_mock.source || 'estimated'} — formula estimate from weather, NOT satellite-measured; never present as measured data)

This case is labelled: ${kase.label}
Previous Follow-up Questions Asked by you: ${kase.question_count}
Maximum Allowed Questions before forcing a best-guess diagnosis: ${MAX_FOLLOW_UP_QUESTIONS}

YOUR TASK:
Evaluate if this raw symptomatic and environmental data, combined with the farmer's chat history, is sufficient to make a confident diagnosis (> ${CONFIDENCE_THRESHOLD}% confidence score).
If confidence is < ${CONFIDENCE_THRESHOLD} AND you haven't asked ${MAX_FOLLOW_UP_QUESTIONS} questions yet, output 'needs_more_info' and provide exactly 1-2 follow-up questions to gather more specific clues (e.g. usage of fertilizers, watering history, when it started).
If confidence is >= ${CONFIDENCE_THRESHOLD} OR you have already asked ${MAX_FOLLOW_UP_QUESTIONS} questions, output 'confident' and provide the final_diagnosis_draft.
${DIAGNOSIS_JSON_CONTRACT}`;
}

/**
 * Phase 3B — the farmer reported the SAME problem again, later, with a NEW
 * photo. Compare against the previous conclusion instead of re-interviewing.
 */
export function buildProgressionPrompt(kase, conversation) {
    const d = kase.diagnostic_data;
    const previous = kase.last_diagnosis || 'No previous conclusion was recorded for this case.';
    return `
[PHASE 3B: PROGRESSION RE-CHECK]
You are an Expert Agronomist. The farmer has sent a NEW photo of a problem you have already diagnosed in this same case.
This is photo number ${kase.photos.length} for case "${kase.label}". Do NOT restart the interview and do NOT re-ask questions the farmer has already answered in this chat.

--- YOUR PREVIOUS DIAGNOSIS (for reference) ---
${previous}

--- FRESH SIGNALS FROM THE NEW PHOTO ---
- Suspected Disease: ${d.visual_diagnosis.suspected_disease}
- Visual Cues: ${d.visual_diagnosis.visual_cues}
- Visual Model Confidence: ${d.visual_diagnosis.confidence}%
- Alternatives considered: ${(d.visual_diagnosis.differential || []).join('; ') || 'none'}
- Visual Source: ${d.visual_diagnosis.source || 'unknown'}${d.visual_diagnosis.source === 'fallback' ? ' — NO automated visual analysis was possible; do NOT describe photo details as observed fact' : ''}
Weather now: ${d.geo_spatial_data.weather.temperature_c}°C, Humidity ${d.geo_spatial_data.weather.humidity_percent}% (source: ${d.geo_spatial_data.weather.source || 'unknown'}${d.geo_spatial_data.weather.source === 'fallback' ? ' — placeholder, NOT measured' : ''})
Soil Moisture now: ${d.geo_spatial_data.soil_satellite_mock.soil_moisture_percent}% (source: ${d.geo_spatial_data.soil_satellite_mock.source || 'estimated'} — estimate, NOT measured)

YOUR TASK:
Decide whether the condition is IMPROVING, STABLE or WORSENING compared with your previous diagnosis, and revise the remedy accordingly (escalate if it is worsening).
If the new symptoms contradict your earlier conclusion, say so in internal_reasoning and correct the diagnosis.
If you genuinely need one more detail to judge the trend, you may ask up to ${MAX_FOLLOW_UP_QUESTIONS} follow-up questions.
State the trend explicitly at the start of final_diagnosis_draft.
${DIAGNOSIS_JSON_CONTRACT}`;
}

function buildCompletedPrompt(kase, conversation) {
    return `The final diagnosis for case "${kase.label}" is already complete. You are chatting friendly with the farmer about it. If the farmer sends a NEW photo, treat it as a possible progression of this case and re-check it. CRITICAL: Reply in the EXACT SAME language the farmer is using (Hindi, Gujarati, Marathi, Tamil, Telugu, etc.).`;
}

function buildGatheringPrompt(kase) {
    return `
Current State:
- Has user provided an image? ${kase.image_url ? 'YES' : 'NO'}
- Has user provided a location? ${kase.coordinates ? 'YES' : 'NO'}

Your task: Assess state. If missing image, ask for crop photo. If missing location, ask for location pin.
CRITICAL LANGUAGE RULE: You MUST speak the EXACT SAME language the user is typing/speaking in (e.g., Gujarati, Hindi, Marathi, Tamil, Telugu, Kannada, Malayalam, Odia, Punjabi, Bengali, or English). Never force English unless they use English. Do NOT hallucinate a diagnosis until both are YES.
`;
}

/**
 * Turns an incoming message into the text that goes into the case history.
 * Returns '' when there is genuinely nothing to say, so the caller can skip the
 * LLM call instead of pushing an empty part (which Gemini rejects).
 */
function buildUserTurn({ text, imageUrl, coordinates }) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed) return trimmed;
    if (imageUrl && coordinates) return '[User submitted both an image and location simultaneously]';
    if (imageUrl) return '[User uploaded an image]';
    if (coordinates) return `[User shared location: Lat ${coordinates.lat}, Lon ${coordinates.lon}]`;
    return '';
}

/** Localized nudge used when a message carried no interpretable content. */
function buildGatheringPromptNudge(kase, lang) {
    return buildGatheringNudge(kase, lang);
}

/**
 * Direct, no-API-call nudge for the gathering phase.
 * Replies in the farmer's detected language when known; falls back to
 * bilingual Hindi+English so a new farmer always understands the instruction.
 */
function buildGatheringNudge(kase, lang) {
    const hasImage = !!(kase && kase.image_url);
    const hasLocation = !!(kase && kase.coordinates);
    const l = (lang || '').split('-')[0].toLowerCase();

    // Language-specific nudges (add more as needed)
    const nudges = {
        hi: {
            both:     'नमस्ते! 🌱 कृपया एक ही मैसेज में भेजें:\n1) प्रभावित पत्ती/फसल की साफ फोटो 📷\n2) अपनी लोकेशन पिन 📍 (Attach → Location)',
            noPhoto:  'कृपया प्रभावित फसल की एक साफ फोटो भेजें। 📷',
            noLoc:    'कृपया अपनी लोकेशन पिन भेजें 📍 (Attach → Location) ताकि मैं मौसम और मिट्टी की जानकारी देख सकूं।'
        },
        gu: {
            both:     'નમસ્તે! 🌱 કૃપા કરીને એક જ સંદેશમાં મોકલો:\n1) અસરગ્રસ્ત પાક/પાંદડાનો સ્પષ્ટ ફોટો 📷\n2) તમારો લોકેશન પિન 📍 (Attach → Location)',
            noPhoto:  'કૃપા કરીને અસરગ્રસ્ત પાકનો સ્પષ્ટ ફોટો મોકલો. 📷',
            noLoc:    'કૃપા કરીને તમારો લોકેશન પિન 📍 (Attach → Location) મોકલો.'
        },
        mr: {
            both:     'नमस्कार! 🌱 कृपया एकाच संदेशात पाठवा:\n1) बाधित पीक/पानाचा स्पष्ट फोटो 📷\n2) तुमचा लोकेशन पिन 📍 (Attach → Location)',
            noPhoto:  'कृपया बाधित पिकाचा स्पष्ट फोटो पाठवा. 📷',
            noLoc:    'कृपया तुमचा लोकेशन पिन 📍 (Attach → Location) पाठवा.'
        },
        ta: {
            both:     'வணக்கம்! 🌱 ஒரே செய்தியில் அனுப்பவும்:\n1) பாதிக்கப்பட்ட பயிர்/இலையின் தெளிவான படம் 📷\n2) உங்கள் இருப்பிட பின் 📍 (Attach → Location)',
            noPhoto:  'பாதிக்கப்பட்ட பயிரின் தெளிவான படம் அனுப்பவும். 📷',
            noLoc:    'உங்கள் இருப்பிட பின் 📍 (Attach → Location) அனுப்பவும்.'
        },
        te: {
            both:     'నమస్కారం! 🌱 ఒకే సందేశంలో పంపండి:\n1) దెబ్బతిన్న పంట/ఆకు యొక్క స్పష్టమైన ఫోటో 📷\n2) మీ లొకేషన్ పిన్ 📍 (Attach → Location)',
            noPhoto:  'దెబ్బతిన్న పంట యొక్క స్పష్టమైన ఫోటో పంపండి. 📷',
            noLoc:    'మీ లొకేషన్ పిన్ 📍 (Attach → Location) పంపండి.'
        },
        kn: {
            both:     'ನಮಸ್ಕಾರ! 🌱 ಒಂದೇ ಸಂದೇಶದಲ್ಲಿ ಕಳುಹಿಸಿ:\n1) ಹಾನಿಗೊಳಗಾದ ಬೆಳೆ/ಎಲೆಯ ಸ್ಪಷ್ಟ ಫೋಟೋ 📷\n2) ನಿಮ್ಮ ಲೊಕೇಶನ್ ಪಿನ್ 📍 (Attach → Location)',
            noPhoto:  'ಹಾನಿಗೊಳಗಾದ ಬೆಳೆಯ ಸ್ಪಷ್ಟ ಫೋಟೋ ಕಳುಹಿಸಿ. 📷',
            noLoc:    'ನಿಮ್ಮ ಲೊಕೇಶನ್ ಪಿನ್ 📍 (Attach → Location) ಕಳುಹಿಸಿ.'
        },
        ml: {
            both:     'നമസ്കാരം! 🌱 ഒരു സന്ദേശത്തിൽ അയക്കുക:\n1) ബാധിച്ച വിള/ഇലയുടെ വ്യക്തമായ ഫോട്ടോ 📷\n2) നിങ്ങളുടെ ലൊക്കേഷൻ പിൻ 📍 (Attach → Location)',
            noPhoto:  'ബാധിച്ച വിളയുടെ വ്യക്തമായ ഫോട്ടോ അയക്കുക. 📷',
            noLoc:    'നിങ്ങളുടെ ലൊക്കേഷൻ പിൻ 📍 (Attach → Location) അയക്കുക.'
        },
        pa: {
            both:     'ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ! 🌱 ਇੱਕ ਸੁਨੇਹੇ ਵਿੱਚ ਭੇਜੋ:\n1) ਪ੍ਰਭਾਵਿਤ ਫ਼ਸਲ/ਪੱਤੇ ਦੀ ਸਾਫ਼ ਫ਼ੋਟੋ 📷\n2) ਆਪਣਾ ਲੋਕੇਸ਼ਨ ਪਿੰਨ 📍 (Attach → Location)',
            noPhoto:  'ਕਿਰਪਾ ਕਰਕੇ ਪ੍ਰਭਾਵਿਤ ਫ਼ਸਲ ਦੀ ਸਾਫ਼ ਫ਼ੋਟੋ ਭੇਜੋ. 📷',
            noLoc:    'ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਲੋਕੇਸ਼ਨ ਪਿੰਨ 📍 (Attach → Location) ਭੇਜੋ.'
        },
        bn: {
            both:     'নমস্কার! 🌱 একটি বার্তায় পাঠান:\n1) আক্রান্ত ফসল/পাতার স্পষ্ট ছবি 📷\n2) আপনার অবস্থান পিন 📍 (Attach → Location)',
            noPhoto:  'অনুগ্রহ করে আক্রান্ত ফসলের স্পষ্ট ছবি পাঠান। 📷',
            noLoc:    'অনুগ্রহ করে আপনার অবস্থান পিন 📍 (Attach → Location) পাঠান।'
        },
        en: {
            both:     'Hello! 🌱 Please send in ONE message:\n1) A clear photo of the affected crop/leaf 📷\n2) Your location pin 📍 (Attach → Location)',
            noPhoto:  'Please send a clear photo of the affected crop. 📷',
            noLoc:    'Please share your location pin 📍 (Attach → Location) so I can check weather and soil data.'
        }
    };

    // Use detected language if available, otherwise bilingual Hindi+English
    const t = nudges[l] || null;

    if (!hasImage && !hasLocation) {
        if (t) return t.both;
        return [
            'नमस्ते! 🌱 कृपया एक ही मैसेज में भेजें:',
            '1) प्रभावित पत्ती/फसल की साफ फोटो 📷',
            '2) अपनी लोकेशन पिन 📍 (Attach → Location)',
            '',
            'Hello! Please send in ONE message:',
            '1) A clear photo of the affected leaf/crop 📷',
            '2) Your location pin 📍 (Attach → Location)'
        ].join('\n');
    }
    if (!hasImage) {
        if (t) return t.noPhoto;
        return 'कृपया प्रभावित फसल की एक साफ फोटो भेजें। 📷\nPlease send a clear photo of the affected crop. 📷';
    }
    if (t) return t.noLoc;
    return 'कृपया अपनी लोकेशन पिन भेजें 📍 (Attach → Location) ताकि मैं मौसम और मिट्टी की जानकारी देख सकूं।\nPlease share your location pin 📍 (Attach → Location) so I can check weather and soil data.';
}
