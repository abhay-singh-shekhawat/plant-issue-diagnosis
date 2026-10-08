/**
 * P1-E regression: TTS reliability (AUD-010/011/030/031 fixes).
 * `generateAudio(text, lang, httpPost)` takes an injectable post fn so Sarvam
 * is mocked offline. The success path DOES run the real bundled ffmpeg
 * (node_modules/ffmpeg-static, no network) to prove WAV→OGG works end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateAudio, describeWavFormat } from '../services/tts.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESPONSES_DIR = path.join(__dirname, '..', 'user_audio_whatsapp', 'responses');

const withKeys = async (fn) => {
    const savedKeys = process.env.SARVAM_API_KEYS;
    const savedKey = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEYS;
    process.env.SARVAM_API_KEY = 'test-key';
    try {
        return await fn();
    } finally {
        if (savedKeys === undefined) delete process.env.SARVAM_API_KEYS;
        else process.env.SARVAM_API_KEYS = savedKeys;
        if (savedKey === undefined) delete process.env.SARVAM_API_KEY;
        else process.env.SARVAM_API_KEY = savedKey;
    }
};

const withNoKeys = async (fn) => {
    const savedKeys = process.env.SARVAM_API_KEYS;
    const savedKey = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEYS;
    delete process.env.SARVAM_API_KEY;
    try {
        return await fn();
    } finally {
        if (savedKeys !== undefined) process.env.SARVAM_API_KEYS = savedKeys;
        if (savedKey !== undefined) process.env.SARVAM_API_KEY = savedKey;
    }
};

/** Builds a minimal valid PCM WAV (mono 16-bit @ sampleRate, N samples). */
const makeWav = (sampleRate = 8000, samples = 800, channels = 1, bits = 16) => {
    const bytesPerSample = bits / 8;
    const dataLen = samples * channels * bytesPerSample;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buf.writeUInt16LE(channels * bytesPerSample, 32);
    buf.writeUInt16LE(bits, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    return buf;
};

const okPost = (wavBuf) => async (url, body, config) => {
    assert.ok(config.timeout === 30000, 'Sarvam call must carry a timeout');
    return { data: { audios: [wavBuf.toString('base64')] } };
};

const sweepTmpWavs = () => {
    if (!fs.existsSync(RESPONSES_DIR)) return [];
    return fs.readdirSync(RESPONSES_DIR).filter((f) => f.startsWith('tmp-'));
};

// --- describeWavFormat ----------------------------------------------------------
test('P1-E: describeWavFormat validates PCM headers, rejects garbage', () => {
    const fmt = describeWavFormat(makeWav());
    assert.deepEqual(fmt, { audioFormat: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16 });
    assert.equal(describeWavFormat(Buffer.alloc(10)), null, 'too short');
    assert.equal(describeWavFormat(Buffer.alloc(44)), null, 'no RIFF/WAVE magic');
    assert.equal(describeWavFormat('not-a-buffer'), null);
    assert.equal(describeWavFormat(null), null);
});

// --- no-key / empty --------------------------------------------------------------
test('P1-E: no Sarvam keys → null without any HTTP call', async () => {
    await withNoKeys(async () => {
        let called = false;
        const r = await generateAudio('hello', 'hi', async () => { called = true; });
        assert.equal(r, null);
        assert.equal(called, false);
    });
});

test('P1-E: blank text → null without any HTTP call', async () => {
    await withKeys(async () => {
        let called = false;
        const r = await generateAudio('   ***   ', 'hi', async () => { called = true; });
        assert.equal(r, null);
        assert.equal(called, false, 'markdown-only text has no letters, no call');
    });
});

// --- all-or-nothing ----------------------------------------------------------------
test('P1-E: partial chunk failure → null (no silent dropped remedy steps)', async () => {
    await withKeys(async () => {
        const wav = makeWav();
        let n = 0;
        const r = await generateAudio(
            'First remedy step here. Second remedy step here.',
            'hi',
            async () => {
                n++;
                if (n === 2) throw Object.assign(new Error('chunk boom'), { response: { status: 500 } });
                return { data: { audios: [wav.toString('base64')] } };
            }
        );
        assert.equal(r, null, 'ANY failed chunk refuses the whole voice note');
        assert.equal(n, 2);
    });
});

test('P1-E: non-WAV chunk bytes → null (stitch validation, not corrupt audio)', async () => {
    await withKeys(async () => {
        const garbage = Buffer.from('not audio at all, just text bytes....................');
        const r = await generateAudio('Single sentence here.', 'hi', okPost(garbage));
        assert.equal(r, null);
    });
});

test('P1-E: mismatched PCM formats across chunks → null', async () => {
    await withKeys(async () => {
        const a = makeWav(8000);
        const b = makeWav(16000); // different sample rate
        let n = 0;
        const r = await generateAudio(
            'First sentence here. Second sentence here.',
            'hi',
            async () => ({ data: { audios: [(n++ === 0 ? a : b).toString('base64')] } })
        );
        assert.equal(r, null, 'format mismatch must not stitch');
    });
});

// --- success path (real ffmpeg, mocked Sarvam) --------------------------------------
test('P1-E: matching chunks stitch and convert to OGG end to end', async () => {
    await withKeys(async () => {
        const wav = makeWav();
        const before = sweepTmpWavs();
        const r = await generateAudio(
            'First sentence here. Second sentence here.',
            'hi',
            okPost(wav)
        );
        assert.ok(typeof r === 'string' && r.endsWith('.ogg'), `expected ogg path, got ${r}`);
        assert.ok(fs.existsSync(r), 'ogg file must exist on disk');
        const stat = fs.statSync(r);
        assert.ok(stat.size > 0, 'ogg must be non-empty');
        fs.unlinkSync(r); // clean up the artifact
        const after = sweepTmpWavs().filter((f) => !before.includes(f));
        assert.deepEqual(after, [], 'no tmp wav files leaked by the success path');
    });
});

test('P1-E: unsupported language falls back to Hindi voice (loud warn, still works)', async () => {
    await withKeys(async () => {
        const wav = makeWav();
        const r = await generateAudio('Single sentence here.', 'ja', okPost(wav));
        assert.ok(typeof r === 'string' && r.endsWith('.ogg'), 'ja → hi-IN fallback still produces audio');
        fs.unlinkSync(r);
    });
});
