import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processMessage } from './agent.service.js';
import { transcribeAudio } from './stt.service.js';
import { generateAudio } from './tts.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level handle so the process can shut down cleanly and reconnect.
let clientRef = null;

// Running count of messages silently ignored due to allowlist.
let ignoredMessageCount = 0;

/**
 * Retries msg.downloadMedia() up to MAX_ATTEMPTS times with exponential backoff.
 *
 * WhatsApp Web sometimes delivers the message event before the media has fully
 * resolved in the page (mediaStage is still FETCHING). The WAWebDownloadManager
 * throws a minified `r: r` error in that case. Waiting a moment and retrying
 * almost always succeeds on the 2nd or 3rd attempt.
 */
const downloadMediaWithRetry = async (msg, tag = '') => {
    const MAX_ATTEMPTS = 4;
    const DELAYS_MS = [1500, 3000, 5000]; // waits before attempt 2, 3, 4
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const media = await msg.downloadMedia();
            if (media && media.data) {
                if (attempt > 1) console.log(`${tag} downloadMedia succeeded on attempt ${attempt}.`);
                return media;
            }
            // downloadMedia returned but empty — treat same as a throw
            lastErr = new Error('empty media returned');
        } catch (err) {
            lastErr = err;
            console.warn(`${tag} downloadMedia attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err && err.message) || err}`);
        }
        if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, DELAYS_MS[attempt - 1]));
        }
    }
    throw lastErr;
};

// Judge/demo mode: JUDGE_MODE=true = open bot, welcome message, short voice.
// Per-number daily cap guards the paid quota when the bot is open to strangers.
const JUDGE_MODE = String(process.env.JUDGE_MODE || 'false').toLowerCase() === 'true';
const MAX_DIAG_PER_NUMBER = Number(process.env.MAX_DIAG_PER_NUMBER || 20);
const diagCountByNumber = new Map(); // senderDigits -> { date: 'YYYY-MM-DD', count: n }

// First-time senders get a short how-to-use guide so a judge with no briefing
// can use the bot from their own phone in 30 seconds.
const WELCOME_TEXT = [
    'Hi! I am your crop doctor bot. 🌱',
    '',
    'Send me in ONE chat:',
    '1) A clear photo of the sick leaf/crop',
    '2) Your location pin 📍 (Attach → Location)',
    '',
    'I will check the photo + weather/soil and reply with the disease + remedy in your language (text + voice).',
    'You can also send a voice note instead of typing.',
    '',
    'Try now — send a crop photo!'
].join('\n');

/** Closes the Puppeteer/Chromium client so it does not leak on restart. */
export const destroyWhatsAppClient = async () => {
    if (!clientRef) return;
    const client = clientRef;
    clientRef = null;
    try {
        await client.destroy();
        console.log('[WhatsApp] Client destroyed.');
    } catch (err) {
        console.error('[WhatsApp] Error destroying client:', err.message);
    }
};

/**
 * WhatsApp Web runs its message pipeline in exactly ONE tab per browser profile
 * — the first tab to claim the lock wins. LocalAuth keeps a persistent Chrome
 * profile, so if the previous process was killed uncleanly (Ctrl+C / crash),
 * Chrome "restores" the old WhatsApp Web tab on the next launch. Puppeteer then
 * opens its own tab as well; that second tab LOSES the lock, sits on
 * "WhatsApp is open in another window" and never receives a single message.
 * The bot then looks dead while the session is perfectly logged in (so no QR is
 * shown either) even though the handler below is correct.
 *
 * Closing the extra tab is not enough — the remaining tab stays parked on that
 * screen until it reloads — so we close the duplicates and reload the tab
 * whatsapp-web.js controls, handing it the session lock.
 *
 * Timing matters: initialize() resolves BEFORE `ready` fires, and reloading
 * while the library is mid-attachEventListeners() destroys the page context
 * and kills the wiring (deaf bot, no `ready`). So we wait for `ready` first
 * and only reload if the client still hasn't synced — a tab that reaches
 * `ready` already owns the session and just needs its duplicates gone.
 */
const ensureSingleControlledTab = async (client, isReady) => {
    const browser = client && client.pupBrowser;
    const page = client && client.pupPage;
    if (!browser || !page) return;

    try {
        const others = (await browser.pages()).filter(
            (p) => p !== page && /^https:\/\/web\.whatsapp\.com/i.test(p.url() || '')
        );
        if (others.length === 0) return;

        console.log(`[WhatsApp] ${others.length} stale WhatsApp Web tab(s) found (browser session restore).`);

        // Give the controlled tab a chance to finish wiring + sync on its own
        // before we consider navigating it away.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !isReady()) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        for (const p of others) {
            await p.close().catch(() => { /* already gone */ });
        }

        if (isReady()) {
            console.log('[WhatsApp] Client already synced; closed stale tabs without reloading.');
            return;
        }

        console.log('[WhatsApp] Client not ready yet — reloading the controlled tab to hand it the session lock.');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await page.reload({ waitUntil: 'load', timeout: 0 });
        console.log('[WhatsApp] Controlled tab reloaded; it now owns the WhatsApp Web session.');
    } catch (err) {
        console.error('[WhatsApp] Duplicate-tab cleanup failed:', (err && err.message) || err);
    }
};

/**
 * True when ANY of the sender's known id forms matches the configured allowlist.
 *
 * WhatsApp can deliver a 1:1 message from a LID ("linked id") rather than the
 * phone-number JID. In that case `msg.from` and `contact.number` are LID values
 * and the real number only shows on the contact's phone-number id — so a single
 * candidate check would reject a farmer who IS on the list.
 *
 * Entries are digits only; a bare 10-digit number matches regardless of the 91
 * country prefix. An empty allowlist means "everyone" (returns true).
 */
export const isSenderAllowed = (senderCandidates, allowedNumbers) => {
    const candidates = (senderCandidates || [])
        .map((value) => String(value == null ? '' : value).replace(/\D/g, ''))
        .filter(Boolean);
    const allowed = (allowedNumbers || [])
        .map((value) => String(value == null ? '' : value).replace(/\D/g, ''))
        .filter(Boolean);

    if (allowed.length === 0) return true;

    return candidates.some((candidate) => {
        const candidateShort = candidate.replace(/^91(?=\d{10}$)/, '');
        return allowed.some((a) => {
            const norm = a.replace(/^91(?=\d{10}$)/, '');
            return candidate === a || candidateShort === norm || candidate.endsWith(norm);
        });
    });
};

/**
 * Recovery net for the whatsapp-web.js startup race.
 *
 * `initialize()` resolves before `ready` fires, and two known races can kill
 * the wiring that leads to `ready`:
 *   1. page.reload() (duplicate-tab cleanup) lands while attachEventListeners()
 *      is mid-flight → the page context dies, some listeners never bind;
 *   2. Socket 'change:hasSynced' fires before inject() finishes registering the
 *      listener (typical right after a reload) → the sync handler never runs.
 *
 * Either way the bot is logged in (no QR) but permanently deaf. The library's
 * exposed functions are idempotent (exposeFunctionIfAbsent), so we can safely
 * re-run the missing steps ourselves: fill in listeners, then invoke the
 * library's own sync handler to (re)finish injection and emit `ready`.
 */
const startReadyWatchdog = (client, isReady) => {
    let attempts = 0;
    let lastQrAt = 0;
    client.on('qr', () => { lastQrAt = Date.now(); });

    const startedAt = Date.now();
    const timer = setInterval(async () => {
        if (clientRef !== client) { clearInterval(timer); return; } // re-initialized
        if (isReady()) { clearInterval(timer); return; }

        const sinceStart = Date.now() - startedAt;
        // First-login flow: don't inject while the user is still scanning —
        // wait until the QR has gone quiet for a while.
        const qrPending = lastQrAt > 0 && Date.now() - lastQrAt < 12000;
        if (sinceStart < 20000 || qrPending) return;

        attempts++;
        if (attempts > 4) {
            console.error('[WhatsApp] READY never fired after 4 recovery attempts — bot will stay deaf. Restart the server (or delete .wwebjs_auth/ for a fresh login).');
            clearInterval(timer);
            return;
        }

        console.warn(`[WhatsApp] ready event missing — recovery attempt ${attempts}/4.`);
        try {
            const page = client.pupPage;
            if (!page) throw new Error('no page');

            // Inspect the page before touching anything:
            //  - injected: LoadUtils ran (window.WWebJS exists)
            //  - hooked:   the library's Msg.on('add') → onAddMessageEvent
            //              wiring is registered. attachEventListeners() is
            //              idempotent for the Node-side exposed functions but
            //              NOT for this page-side registration — re-running it
            //              unguarded would make the bot answer twice.
            const state = await page.evaluate(() => {
                let hooked = false;
                try {
                    const { Msg } = window.require('WAWebCollections');
                    const entries = Msg.$4('add');
                    hooked = Array.isArray(entries) && entries.some((e) => {
                        const cb = e && (e.callback || e.cb || e);
                        return typeof cb === 'function' && String(cb).includes('onAddMessageEvent');
                    });
                } catch (_) { /* emitter internals unavailable → assume missing */ }
                return {
                    injected: typeof window.WWebJS !== 'undefined',
                    hooked,
                    hasHandler: typeof window.onAppStateHasSyncedEvent === 'function',
                };
            });
            console.warn(`[WhatsApp] Recovery state: injected=${state.injected} msgListenerWired=${state.hooked}`);

            if (!state.hooked) {
                // Wiring incomplete (or never ran) — (re)bind Node-side exposed
                // functions (idempotent) and register the page-side listeners.
                await client.attachEventListeners();
            }
            if (state.hasHandler) {
                // Library's own handler: LoadUtils if needed → emit `ready`.
                await page.evaluate(() => window.onAppStateHasSyncedEvent());
            } else if (state.hooked || state.injected) {
                // Extremely unlikely (exposed functions survive navigation),
                // but if the handler binding is gone: listeners are in place,
                // so emit ready directly rather than leaving the bot silent.
                client.emit('ready');
            } else {
                throw new Error('page not initialized yet (no WWebJS, no handler)');
            }
            if (isReady()) {
                console.warn(`[WhatsApp] Recovery attempt ${attempts} succeeded.`);
                clearInterval(timer);
            }
        } catch (err) {
            console.warn(`[WhatsApp] Recovery attempt ${attempts} failed:`, (err && err.message) || err);
            // Next tick retries (page may have been mid-reload/navigation).
        }
    }, 5000);
};

export const initializeWhatsAppClient = () => {

    // Chrome/Chromium is env-driven so the bot works cross-platform.
    // Empty PUPPETEER_EXECUTABLE_PATH => whatsapp-web.js's bundled Chromium.
    const puppeteerOptions = {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '../../.wwebjs_auth') }),
        // Skip the default ("local") web-version cache: it installs request
        // interception on the WhatsApp Web page. One less moving part during
        // startup — we load the live WhatsApp Web build directly.
        webVersionCache: { type: 'none' },
        puppeteer: puppeteerOptions
    });

    let sawQr = false;
    let readyFired = false;
    client.on('qr', (qr) => {
        sawQr = true;
        console.log('\n======================================================');
        console.log('WhatsApp Bot: Scan this QR code to log in to WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log('======================================================\n');
    });

    client.on('ready', async () => {
        readyFired = true;
        const botNumber = (process.env.WHATSAPP_BOT_NUMBER || '').replace(/\D/g, '');
        console.log(`✅ WhatsApp Client is ready and connected!${botNumber ? ` (bot: +${botNumber})` : ''}`);
    });

    // --- lifecycle: the bot must not die silently --------------------------
    client.on('auth_failure', (msg) => {
        console.error('[WhatsApp] Authentication failed:', msg);
    });

    client.on('disconnected', (reason) => {
        console.warn(`[WhatsApp] Disconnected (${reason}). Re-initializing in 5s...`);
        destroyWhatsAppClient()
            .then(() => {
                setTimeout(() => {
                    try {
                        initializeWhatsAppClient();
                    } catch (err) {
                        console.error('[WhatsApp] Re-initialize failed:', err.message);
                    }
                }, 5000);
            })
            .catch((err) => console.error('[WhatsApp] Re-initialize failed:', err.message));
    });

    client.on('change_state', (state) => {
        console.log(`[WhatsApp] State changed: ${state}`);
    });

    client.on('message', async (msg) => {
        const from = msg.from;
        const msgTag = '[WhatsApp:' + from + ':' + ((msg && msg.id && msg.id._serialized) || 'no-id') + ']';
        console.log(msgTag + ' incoming type=' + msg.type + ' hasMedia=' + msg.hasMedia + ' bodyLen=' + ((msg.body || '').length));

        // The agent is strictly 1:1. Ignore groups, broadcasts and newsletters —
        // otherwise `from` is a group id and every member would share one case.
        if (msg.fromMe) { console.log(msgTag + ' ignored (own message).'); return; }
        if (from === 'status@broadcast' || /@(g\.us|newsletter|broadcast)$/.test(from)) {
            return;
        }

        // Who can use the bot: JUDGE_MODE=true ignores the allowlist (open demo
        // for unknown judges). Otherwise empty allowlist = everyone, set = only listed.
        const allowed = (process.env.WHATSAPP_ALLOWED_NUMBERS || '')
            .split(',')
            .map((n) => n.replace(/\D/g, ''))
            .filter(Boolean);
        // Resolve the sender's phone number. WhatsApp can deliver a 1:1 message
        // from a LID ("linked id") instead of the phone-number JID. In that case
        // `contact.number` is undefined and `from` itself is a LID, so the real
        // number only appears on the contact's phone-number id. Collect every
        // candidate and match the allowlist against all of them — otherwise a
        // listed farmer is rejected as an unknown number.
        const digitsOnly = (value) => String(value == null ? '' : value).replace(/\D/g, '');
        const senderCandidates = [];
        try {
            const contact = await msg.getContact();
            senderCandidates.push(
                digitsOnly(contact && contact.number),
                digitsOnly(contact && contact.id && contact.id._serialized),
                digitsOnly(contact && contact.userid),
                digitsOnly(contact && contact.phoneNumber)
            );
        } catch (ce) { console.warn(msgTag + ' getContact failed: ' + ((ce && ce.message) || ce)); }
        // Raw JID digits last: the only fallback left when the lookup fails.
        senderCandidates.push(digitsOnly(from.split('@')[0]));
        const uniqueSenders = [...new Set(senderCandidates.filter(Boolean))];
        const senderDigits = uniqueSenders[0] || '';

        if (!JUDGE_MODE && allowed.length > 0) {
            if (!isSenderAllowed(uniqueSenders, allowed)) {
                ignoredMessageCount++;
                console.log(`[WhatsApp] Ignored message #${ignoredMessageCount} from unlisted number: ${uniqueSenders.join('|') || from}`);
                return;
            }
            console.log(msgTag + ' allowlist OK sender=' + uniqueSenders.join('|'));
        }

        // Quota guard for open demos: max N diagnoses per number per day.
        // Counts only messages that reach the brain (not group spam filtered above).
        if (JUDGE_MODE && Number.isFinite(MAX_DIAG_PER_NUMBER) && MAX_DIAG_PER_NUMBER > 0) {
            const today = new Date().toISOString().slice(0, 10);
            const entry = diagCountByNumber.get(senderDigits);
            if (entry && entry.date === today && entry.count >= MAX_DIAG_PER_NUMBER) {
                await msg.reply(`Demo limit reached (${MAX_DIAG_PER_NUMBER}/day for this number). Please try again tomorrow.`);
                return;
            }
            diagCountByNumber.set(senderDigits, {
                date: today,
                count: entry && entry.date === today ? entry.count + 1 : 1
            });
        }

        // First message from this number in judge mode → welcome + how-to-use.
        // Sent once (tracked in-memory + survives via session map), then normal flow.
        if (JUDGE_MODE && !globalThis.__waWelcomed?.has(senderDigits)) {
            if (!globalThis.__waWelcomed) globalThis.__waWelcomed = new Set();
            globalThis.__waWelcomed.add(senderDigits);
            try { await msg.reply(WELCOME_TEXT); } catch { /* ignore */ }
            // If they sent only "hi", stop after welcome — wait for real photo.
            const bodyText = (msg.body || '').trim().toLowerCase();
            if (!msg.hasMedia && !msg.location && ['hi', 'hello', 'hey', 'hii', ''].includes(bodyText)) return;
        }

        const extractedData = {
            sessionId: from,
            source: 'whatsapp',
            // Keep photo captions: they can carry a command ("new" / "same") and
            // they are useful context for the agent.
            text: msg.body && typeof msg.body === 'string' && !msg.location ? msg.body : '',
            imageUrl: null,
            coordinates: null,
            language: null
        };

        try {
            if (msg.hasMedia) {
                console.log(msgTag + ' downloading media...');
                let media = null;
                try { media = await downloadMediaWithRetry(msg, msgTag); }
                catch (dlErr) {
                    console.error(msgTag + ' downloadMedia failed after retries: ' + ((dlErr && dlErr.stack) || dlErr));
                    try { await msg.reply('फोटो डाउनलोड नहीं हो पाई। कृपया फोटो दोबारा भेजें।\nCould not download the photo. Please resend it.'); } catch (e2) {}
                    return;
                }
                if (!media || !media.data) {
                    console.error(msgTag + ' downloadMedia empty; asking user to resend.');
                    try { await msg.reply('फोटो डाउनलोड नहीं हो पाई। कृपया फोटो दोबारा भेजें।\nCould not download the photo. Please resend it.'); } catch (e2) {}
                    return;
                }
                console.log(msgTag + ' media ' + media.mimetype + ' b64len=' + (media.data || '').length);

                if (media && media.mimetype && media.mimetype.startsWith('image/')) {
                    const extension = media.mimetype.split('/')[1].split(';')[0] || 'jpg';
                    const filename = `whatsapp-${Date.now()}.${extension}`;

                    const destDir = path.join(__dirname, '../user_img_whatsapp');
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }

                    const filepath = path.join(destDir, filename);
                    fs.writeFileSync(filepath, media.data, 'base64');

                    extractedData.imageUrl = `/user_img_whatsapp/${filename}`;
                } else if (media && media.mimetype && (media.mimetype.startsWith('audio/') || media.mimetype.includes('ogg'))) {
                    // Handle Voice Notes
                    const extension = media.mimetype.split('/')[1].split(';')[0] || 'ogg';
                    const filename = `whatsapp-audio-${Date.now()}.${extension}`;

                    const destDir = path.join(__dirname, '../user_audio_whatsapp');
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }

                    const filepath = path.join(destDir, filename);
                    fs.writeFileSync(filepath, media.data, 'base64');

                    // Voice note → text (Deepgram). Always delete the raw file after.
                    const sttResult = await transcribeAudio(filepath);
                    // The raw voice note has served its purpose (or failed to) —
                    // always reclaim the disk space, STT result or not.
                    try { fs.unlinkSync(filepath); } catch { /* ignore */ }
                    if (sttResult.text) {
                        extractedData.text = sttResult.text;
                        extractedData.language = sttResult.language || null;
                        extractedData.isVoiceNote = true;
                    } else {
                        await msg.reply('वॉइस नोट समझ नहीं आई। कृपया दोबारा रिकॉर्ड करके भेजें।\nCould not understand the voice note. Please try recording again.');
                        return;
                    }
                } else {
                    console.warn(msgTag + ' unsupported media: ' + media.mimetype);
                    try { await msg.reply('कृपया फसल की फोटो, वॉइस नोट, या लोकेशन पिन भेजें — यह फाइल टाइप सपोर्ट नहीं है।\nPlease send a crop photo, a voice note, or a location pin. That file type is not supported.'); } catch (e2) {}
                    return;
                }
            }

            // Check for Location
            if (msg.location) {
                extractedData.coordinates = {
                    lat: msg.location.latitude,
                    lon: msg.location.longitude
                };
            }

            console.log(msgTag + ' extracted image=' + (extractedData.imageUrl || 'none') + ' textLen=' + ((extractedData.text || '').length));
            console.log(msgTag + ' calling processMessage...');
            const aiResult = await processMessage(extractedData);
            console.log(msgTag + ' processMessage done replyLen=' + (((aiResult && aiResult.text) || '').length));

            // Send back to the same address the message came from.
            // The patch to Utils.js normalizes lidUser._serialized so the
            // media upload memoizer no longer throws "id property undefined".
            const sendText  = async (text) => client.sendMessage(from, text);
            const sendMedia = async (media, opts) => client.sendMessage(from, media, opts);

            if (aiResult.text && aiResult.text.length > 0) {
                const userLang = aiResult?.language || extractedData.language || 'hi';

                let voiceText = aiResult.text;
                if (JUDGE_MODE) {
                    const sentences = String(aiResult.text).match(/[^.?!।\n]+[.?!।\n]*/g) || [aiResult.text];
                    voiceText = sentences.slice(0, 2).join(' ').trim() || aiResult.text;
                }
                const audioPath = await generateAudio(voiceText, userLang);

                if (extractedData.isVoiceNote && audioPath && fs.existsSync(audioPath)) {
                    // Voice note in → voice note reply only (no text wall).
                    try {
                        const audioMedia = MessageMedia.fromFilePath(audioPath);
                        await sendMedia(audioMedia, { sendAudioAsVoice: true });
                        console.log(msgTag + ' voice-note reply sent (voice-in → voice-out).');
                    } catch (se) {
                        console.error(msgTag + ' voice sendMessage FAILED, falling back to text: ' + ((se && se.stack) || se));
                        try { await sendText(aiResult.text); console.log(msgTag + ' text fallback sent.'); } catch { /* ignore */ }
                    }
                    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
                } else {
                    // Text/image/location input → text first, then voice note.
                    try { await sendText(aiResult.text); console.log(msgTag + ' text reply sent.'); }
                    catch (se) { console.error(msgTag + ' sendMessage FAILED: ' + ((se && se.stack) || se)); }

                    if (audioPath && fs.existsSync(audioPath)) {
                        try {
                            const audioMedia = MessageMedia.fromFilePath(audioPath);
                            await sendMedia(audioMedia, { sendAudioAsVoice: true });
                            console.log(msgTag + ' voice note sent.');
                        } catch (se) {
                            console.error(msgTag + ' voice sendMessage FAILED: ' + ((se && se.stack) || se));
                        }
                        try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
                    }
                }
            } else {
                console.error(msgTag + ' EMPTY reply; sending fallback.');
                try { await sendText('कृपया फसल की एक साफ फोटो और अपनी लोकेशन पिन भेजें।\nPlease send a crop photo and your location pin.'); } catch (e2) {}
            }

        } catch (err) {
            console.error(msgTag + ' handler exception:', (err && err.stack) || err);
            try {
                const errText = 'कुछ तकनीकी समस्या आई। कृपया थोड़ी देर बाद दोबारा भेजें।\nA technical error occurred. Please try again in a moment.';
                await msg.reply(errText);
            } catch { /* ignore */ }
        }
    });

    
    clientRef = client;

    // initialize() returns a promise; an unhandled rejection here would crash
    // the whole API process, so it must always be caught.
    client.initialize()
        .then(async () => {
            if (!sawQr) {
                console.log('[WhatsApp] Saved session reused — no QR scan needed (delete .wwebjs_auth/ to force a fresh login).');
            }
            await ensureSingleControlledTab(client, () => readyFired);
            startReadyWatchdog(client, () => readyFired);
        })
        .catch((err) => {
            console.error('[WhatsApp] Could not start the WhatsApp client:', err.message);
            console.error('[WhatsApp] The server keeps running in WEB-ONLY mode.');
            clientRef = null;
        });

    return client;
};
