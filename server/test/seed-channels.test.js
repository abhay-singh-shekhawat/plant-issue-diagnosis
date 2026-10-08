/**
 * Phase 7 — channel parity contract (deterministic, offline).
 *
 * Proves, without any API keys or network:
 *   - seed domain code never touches WhatsApp specifics (and the WhatsApp
 *     adapter carries no seed business logic) — static guards
 *   - Web photo upload with an explicit domain opens a seed case
 *   - Web duplicate delivery (same messageId) mutates once + cleans the orphan
 *   - Web text messages forward domain/seedHints into the same brain
 *   - identical seed payloads via `web` and `whatsapp` converge: same case
 *     type, same reply (one shared business path, not two implementations)
 *   - WhatsApp voice pipeline shape holds: STT text+language → shared brain →
 *     seed reply with the farmer's language preserved for TTS routing
 *   - multilingual plumbing: arbitrary supported languages round-trip through
 *     seed cases untouched (copy localization itself is future work)
 *
 *   node --test test/seed-channels.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processMessage } from '../services/agent.service.js';
import { getConversation } from '../services/session.service.js';
import { handleImageUpload } from '../controllers/upload.controller.js';
import { handleChatMessage } from '../controllers/message.controller.js';
import { transcribeAudio } from '../services/stt.service.js';

const uid = (p = 't-seed7') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', 'services', 'seed');

const mockRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.body = obj; return res; };
    return res;
};

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const tmpPng = () => {
    const p = path.join(os.tmpdir(), `ch7-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    fs.writeFileSync(p, PNG_HEAD);
    return p;
};
const multerFile = (p, name = 'seed.png') => ({
    path: p,
    filename: path.basename(p),
    originalname: name,
    mimetype: 'image/png',
    size: fs.statSync(p).size,
});

// --- static isolation guards ---------------------------------------------------------
test('seed domain never imports WhatsApp specifics', () => {
    for (const f of fs.readdirSync(SEED_DIR)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(SEED_DIR, f), 'utf8');
        assert.ok(!/whatsapp/i.test(src), `${f} must not reference WhatsApp`);
    }
});

test('WhatsApp adapter carries no seed business logic', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsapp.service.js'), 'utf8');
    assert.ok(!/\bseed\b/i.test(src), 'adapter stays a channel adapter');
    assert.ok(!/purchaseMode|BRANDED|packet/i.test(src), 'no seed workflow inside the adapter');
});

// --- Web photo upload ---------------------------------------------------------------------
test('Web seed photo upload opens a seed case (photo-only, no location)', async () => {
    const p = tmpPng();
    try {
        const req = {
            file: multerFile(p),
            body: { sessionId: uid('web-seed'), source: 'web', domain: 'SEED_VERIFICATION' },
        };
        const res = mockRes();
        await handleImageUpload(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.ai_response.includes('No location is needed'));
        assert.ok(res.body.ai_response.includes('branded'));
    } finally {
        try { fs.unlinkSync(p); } catch { /* uploaded file referenced by case is the same path; remove */ }
    }
});

test('Web duplicate upload (same messageId) mutates once and cleans the orphan', async () => {
    const sid = uid('web-dupe');
    const mid = `web-mid-${Date.now()}`;
    const mkReq = () => ({
        file: multerFile(tmpPng()),
        body: { sessionId: sid, source: 'web', domain: 'SEED_VERIFICATION', messageId: mid },
    });
    const r1 = mockRes();
    await handleImageUpload(mkReq(), r1);
    assert.equal(r1.statusCode, 200);
    const secondPathHolder = {};
    const req2 = mkReq();
    secondPathHolder.path = req2.file.path;
    const r2 = mockRes();
    await handleImageUpload(req2, r2);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.body.ai_response, r1.body.ai_response, 'duplicate replays the first reply');
    assert.equal(getConversation(sid).cases[0].photos.length, 1, 'photo attached once');
    assert.ok(!fs.existsSync(secondPathHolder.path), 'orphan upload deleted, not left on disk');
    try { fs.unlinkSync(r1.body.data.image_url.replace('/user_img_web/', os.tmpdir() + '/')); } catch { /* best-effort */ }
});

// --- Web text message -----------------------------------------------------------------------
test('Web text message forwards domain into the shared brain', async () => {
    const res = mockRes();
    await handleChatMessage({
        body: { sessionId: uid('web-txt'), source: 'web', text: 'mere beej ki packet check karni hai', domain: 'SEED_VERIFICATION' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.ai_response.includes('branded'));
});

// --- parity: web vs whatsapp converge ------------------------------------------------------------
test('parity: identical seed payloads via web and whatsapp give identical results', async () => {
    const base = { domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' };
    const web = await processMessage({ ...base, sessionId: uid('par-w'), source: 'web' });
    const wa = await processMessage({ ...base, sessionId: uid('par-wa'), source: 'whatsapp' });
    assert.equal(web.state.caseType, wa.state.caseType);
    assert.equal(web.state.caseType, 'SEED_VERIFICATION');
    assert.equal(web.text, wa.text, 'one shared business path, not two implementations');
});

test('parity: follow-up text behaves identically on both channels', async () => {
    const run = async (source) => {
        const sid = uid(`parf-${source}`);
        await processMessage({ sessionId: sid, source, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
        return processMessage({ sessionId: sid, source, text: 'khula beej hai' });
    };
    const web = await run('web');
    const wa = await run('whatsapp');
    assert.equal(web.state.seedContext.purchaseMode, 'OPEN');
    assert.equal(wa.state.seedContext.purchaseMode, 'OPEN');
    assert.equal(web.text, wa.text);
});

// --- voice pipeline shape (STT → brain, language preserved for TTS) ------------------------------------
test('voice follow-up: STT text+language flows through the seed brain', async () => {
    const audioPath = path.join(os.tmpdir(), `ch7-v-${Date.now()}.ogg`);
    fs.writeFileSync(audioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
    // Deepgram key is configured in this repo; inject the HTTP layer so the
    // test stays offline while exercising the real response-shaping code.
    const fakePost = async () => ({
        data: { results: { channels: [{ alternatives: [{ transcript: 'khula beej hai' }], detected_language: 'hi' }] } },
    });
    const stt = await transcribeAudio(audioPath, fakePost);
    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
    assert.equal(stt.text, 'khula beej hai');

    const sid = uid('voice-seed');
    await processMessage({ sessionId: sid, source: 'whatsapp', domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    // Exactly what whatsapp.service.js does with a voice note: text + language in.
    const r = await processMessage({
        sessionId: sid, source: 'whatsapp', text: stt.text, language: stt.language,
    });
    assert.equal(r.state.seedContext.purchaseMode, 'OPEN');
    assert.equal(r.language, 'hi', 'farmer language preserved for the TTS reply path');
});

// --- multilingual plumbing -------------------------------------------------------------------------------
test('multilingual path: supported languages round-trip through seed cases', async () => {
    for (const lang of ['ta', 'bn', 'mr']) {
        const sid = uid(`ml-${lang}`);
        const r = await processMessage({
            sessionId: sid, source: 'whatsapp', domain: 'SEED_VERIFICATION',
            imageUrl: '/s.jpg', language: lang,
        });
        assert.equal(r.language, lang);
        assert.equal(getConversation(sid).language, lang);
        assert.equal(r.state.caseType, 'SEED_VERIFICATION');
    }
});
