import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFilePromise = promisify(execFile);

// Use the bundled ffmpeg binary from ffmpeg-static (no system install needed).
// createRequire lets us require() a CJS package from an ESM module.
const require = createRequire(import.meta.url);
let FFMPEG_BIN;
try {
    FFMPEG_BIN = require('ffmpeg-static');
    console.log('[TTS] ffmpeg-static binary:', FFMPEG_BIN);
} catch {
    FFMPEG_BIN = 'ffmpeg'; // fall back to system ffmpeg if somehow missing
    console.warn('[TTS] ffmpeg-static not found, falling back to system ffmpeg');
}

// Provider map: canonical code → Sarvam BCP-47 voice. Covers exactly the
// SUPPORTED_LANGUAGES set (server/language.js); `od` is accepted as an input
// alias but never stored (normalizeLanguage maps it to `or` upstream).
// Any code outside this map falls back to hi-IN with a loud warn (see below).
const languageMap = {
    'hi': 'hi-IN',
    'bn': 'bn-IN',
    'ta': 'ta-IN',
    'te': 'te-IN',
    'mr': 'mr-IN',
    'kn': 'kn-IN',
    'ml': 'ml-IN',
    'gu': 'gu-IN',
    'pa': 'pa-IN',
    'en': 'en-IN',
    'or': 'od-IN',
    'od': 'od-IN',
};

/**
 * Validates a WAV buffer's 44-byte header and returns its format descriptor.
 * Returns null when the buffer is too short or not a PCM WAV (`RIFF....WAVE`).
 */
export const describeWavFormat = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    return {
        audioFormat: buf.readUInt16LE(20),
        channels: buf.readUInt16LE(22),
        sampleRate: buf.readUInt32LE(24),
        bitsPerSample: buf.readUInt16LE(34)
    };
};

/**
 * Concatenates multiple WAV buffers in pure JS (no ffmpeg needed for this step).
 * All chunks must share the same PCM format (format/rate/channels/bits) —
 * verified, not assumed: Sarvam could change encoding per chunk, and stitching
 * raw bytes across formats produces corrupt audio. Throws on mismatch.
 */
const concatWavBuffers = (buffers) => {
    if (buffers.length === 1) return buffers[0];
    const HEADER_SIZE = 44;
    const reference = describeWavFormat(buffers[0]);
    if (!reference || reference.audioFormat !== 1) {
        throw new Error('TTS stitch: first chunk is not PCM WAV');
    }
    for (let i = 1; i < buffers.length; i++) {
        const fmt = describeWavFormat(buffers[i]);
        if (!fmt || fmt.audioFormat !== 1
            || fmt.channels !== reference.channels
            || fmt.sampleRate !== reference.sampleRate
            || fmt.bitsPerSample !== reference.bitsPerSample) {
            throw new Error(`TTS stitch: chunk ${i} PCM format differs (ref ${reference.sampleRate}Hz/${reference.channels}ch/${reference.bitsPerSample}bit)`);
        }
    }
    const pcmParts = buffers.map(buf => buf.slice(HEADER_SIZE));
    const totalPcm = Buffer.concat(pcmParts);
    const header = Buffer.from(buffers[0].slice(0, HEADER_SIZE));
    header.writeUInt32LE(HEADER_SIZE + totalPcm.length - 8, 4); // ChunkSize
    header.writeUInt32LE(totalPcm.length, 40);                  // Subchunk2Size
    return Buffer.concat([header, totalPcm]);
};

export const generateAudio = async (text, languageCode = 'hi', httpPost = axios.post) => {
    try {
        const baseCode = String(languageCode || 'hi').toLowerCase().split(/[-_]/)[0];

        const apiKeys = process.env.SARVAM_API_KEYS
            ? process.env.SARVAM_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
            : (process.env.SARVAM_API_KEY ? [process.env.SARVAM_API_KEY.trim()] : []);

        if (apiKeys.length === 0) {
            console.warn('[TTS] No Sarvam API key — skipping voice note.');
            return null;
        }

        // Unknown languages fall back to Hindi voice — say so loudly instead of
        // silently producing a wrong-language voice note over foreign text.
        const sarvamLang = languageMap[baseCode] || 'hi-IN';
        if (!languageMap[baseCode]) {
            console.warn(`[TTS] Unsupported language "${baseCode}" — falling back to Hindi voice (hi-IN).`);
        }
        const cleanText = text.replace(/[*_#\[\]`~]/g, '').trim();
        if (!cleanText) return null;

        // Split into ≤400-char sentence chunks
        const MAX_CHARS = 400;
        const rawChunks = cleanText.match(/[^.?!।\n]+[.?!।\n]*/g) || [cleanText];
        const validChunks = [];
        for (const raw of rawChunks) {
            const sentence = (raw || '').trim();
            if (!sentence || !/[\p{L}]/u.test(sentence)) continue;
            if (sentence.length <= MAX_CHARS) { validChunks.push(sentence); continue; }
            const words = sentence.split(/\s+/);
            let piece = '';
            for (const word of words) {
                if (word.length > MAX_CHARS) {
                    if (piece) { validChunks.push(piece); piece = ''; }
                    for (let i = 0; i < word.length; i += MAX_CHARS) validChunks.push(word.slice(i, i + MAX_CHARS));
                    continue;
                }
                const candidate = piece ? `${piece} ${word}` : word;
                if (candidate.length > MAX_CHARS) { validChunks.push(piece); piece = word; }
                else { piece = candidate; }
            }
            if (piece) validChunks.push(piece);
        }
        if (validChunks.length === 0) return null;

        // Call Sarvam for each chunk in parallel (round-robin across API keys).
        // Each call has a timeout so one hung chunk cannot stall the voice note.
        const wavBuffers = await Promise.all(validChunks.map(async (chunk, index) => {
            const apiKey = apiKeys[index % apiKeys.length];
            try {
                const response = await httpPost(
                    'https://api.sarvam.ai/text-to-speech',
                    { text: chunk, target_language_code: sarvamLang, speaker: 'shubh', model: 'bulbul:v3' },
                    {
                        timeout: 30000,
                        headers: { 'api-subscription-key': apiKey, 'Content-Type': 'application/json' }
                    }
                );
                const b64 = response?.data?.audios?.[0];
                if (!b64) { console.warn(`[TTS] Empty audio for chunk ${index}`); return null; }
                return Buffer.from(b64, 'base64');
            } catch (err) {
                console.error(`[TTS] Sarvam chunk ${index} failed:`, err?.response?.data || err.message);
                return null;
            }
        }));

        // All-or-nothing: a partially-failed voice note would silently drop
        // remedy steps (the old code stitched whatever survived). Missing audio
        // for ANY chunk → text-only reply via the caller's TTS-null path.
        const failed = wavBuffers.filter((b) => !b).length;
        if (failed > 0) {
            console.error(`[TTS] ${failed}/${wavBuffers.length} Sarvam chunks failed — refusing partial voice note.`);
            return null;
        }

        // Step 1: stitch WAVs in pure JS (format-verified inside)
        const stitchedWav = concatWavBuffers(wavBuffers);

        const destDir = path.join(__dirname, '../user_audio_whatsapp/responses');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const ts = `${Date.now()}-${process.pid}`;
        const wavPath = path.join(destDir, `tmp-${ts}.wav`);
        const oggPath = path.join(destDir, `response-${ts}.ogg`);

        fs.writeFileSync(wavPath, stitchedWav);

        // Step 2: WAV → OGG/Opus using bundled ffmpeg-static binary
        // WhatsApp Web requires OGG/Opus for sendAudioAsVoice to work.
        // execFile (argv array, no shell) so paths with spaces/quotes can never
        // break quoting or inject shell commands — the old exec() interpolated
        // them into a shell string.
        try {
            await execFilePromise(
                FFMPEG_BIN,
                ['-y', '-i', wavPath, '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', oggPath],
                { timeout: 60000 }
            );
        } catch (ffErr) {
            console.error('[TTS] ffmpeg failed:', ffErr?.message || ffErr);
        } finally {
            try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
        }

        if (!fs.existsSync(oggPath)) {
            console.error('[TTS] ffmpeg produced no output file.');
            return null;
        }

        console.log(`[TTS] Voice note ready: response-${ts}.ogg (lang=${sarvamLang})`);
        return oggPath;

    } catch (error) {
        console.error('[TTS] generateAudio failed:', error.message);
        return null;
    }
};
