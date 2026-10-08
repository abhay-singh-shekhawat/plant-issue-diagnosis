import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { normalizeLanguage, DEFAULT_LANGUAGE } from '../language.js';

// Deepgram needs the real container type; sending everything as audio/ogg made
// forwarded .wav/.mp3/.m4a notes fail.
const EXT_TO_MIME = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
    '.amr': 'audio/amr'
};

const detectMimeType = (filePath) => EXT_TO_MIME[path.extname(filePath).toLowerCase()] || 'audio/ogg';

/**
 * Transcribes a WhatsApp voice note via Deepgram Nova-3.
 *
 * Failure contract (never broken): ANY failure returns empty text — the caller
 * asks the farmer to re-record. We never return guessed text; a fake sentence
 * could drive a wrong diagnosis.
 *
 * @param {string} filePath raw voice-note file (caller deletes it afterwards).
 * @param {function} httpPost injectable HTTP post (default axios.post) — exists
 *   so tests can simulate timeout / provider-error / malformed payloads.
 */
export const transcribeAudio = async (filePath, httpPost = axios.post) => {
    // No key = can't transcribe. Return empty so the bot asks to re-record.
    if (!process.env.DEEPGRAM_API_KEY) {
        return { text: '', language: '' };
    }

    if (!filePath || !fs.existsSync(filePath)) {
        return { text: '', language: '' };
    }

    try {
        const audioBuffer = fs.readFileSync(filePath);
        const contentType = detectMimeType(filePath);

        const response = await httpPost(
            // nova-3 with language detection for Indian languages.
            // `language=hi` is only a search-space hint (prevents misdetection
            // as Japanese/Chinese/Korean on low-quality audio); detect_language
            // still overrides the hint when confident. Listed ONCE — the old URL
            // duplicated detect_language=true.
            'https://api.deepgram.com/v1/listen?model=nova-3&detect_language=true' +
            '&language=hi' +
            '&filler_words=false&smart_format=true',
            audioBuffer,
            {
                // A hung Deepgram call must not block the farmer's message
                // handler forever (the per-conversation lock serializes turns).
                timeout: 30000,
                maxBodyLength: 25 * 1024 * 1024,
                headers: {
                    'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
                    'Content-Type': contentType
                }
            }
        );

        const data = response?.data;
        const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        const rawLang = data?.results?.channels?.[0]?.detected_language || 'hi';

        // Deepgram sometimes returns BCP-47 like "hi-Latn" or "gu-Deva" —
        // normalize through the canonical table so a provider-novel code
        // (e.g. "ja" misdetection) can never silently become session state.
        // Unsupported → DEFAULT_LANGUAGE, never a verbatim exotic code.
        const language = normalizeLanguage(rawLang) || DEFAULT_LANGUAGE;

        return { text, language };
    } catch (error) {
        // Log the failure CLASS (status / timeout / network) for ops, never the
        // key or audio. Empty return keeps the no-fake-text contract.
        const status = error?.response?.status;
        const kind = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')
            ? 'timeout'
            : status ? `http-${status}` : 'network';
        console.error(`[STT] Deepgram failed (${kind}): ${error?.message || error}`);
        return { text: '', language: '' };
    }
};
