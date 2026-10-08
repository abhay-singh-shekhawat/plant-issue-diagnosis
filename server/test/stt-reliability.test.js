/**
 * P1-A regression: STT/external-service reliability.
 * `transcribeAudio(path, httpPost)` takes an injectable post fn so every failure
 * class is tested offline — no Deepgram key, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transcribeAudio } from '../services/stt.service.js';
import { safeExt } from '../services/whatsapp.service.js';

const withKey = (key, fn) => {
    const old = process.env.DEEPGRAM_API_KEY;
    if (key === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = key;
    return Promise.resolve().then(fn).finally(() => {
        if (old === undefined) delete process.env.DEEPGRAM_API_KEY;
        else process.env.DEEPGRAM_API_KEY = old;
    });
};

// Suite hygiene: fixture dirs accumulate (one mkdtemp per fixture call), so
// track and remove them at process exit.
const fixtureDirs = new Set();
process.on('exit', () => {
    for (const d of fixtureDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

const fixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
    fixtureDirs.add(dir);
    const p = path.join(dir, 'note.ogg');
    fs.writeFileSync(p, Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]));
    return p;
};

const okPayload = (text = 'tamatar me dhabbe', lang = 'hi') => ({
    data: { results: { channels: [{ alternatives: [{ transcript: text }], detected_language: lang }] } }
});

test('P1-A: success returns text + stripped language', async () => {
    await withKey('k', async () => {
        let seenConfig = null;
        const r = await transcribeAudio(fixture(), async (url, buf, config) => {
            seenConfig = config;
            assert.ok(url.includes('detect_language=true'));
            assert.equal((url.match(/detect_language=true/g) || []).length, 1, 'no duplicate param');
            return okPayload();
        });
        assert.equal(r.text, 'tamatar me dhabbe');
        assert.equal(r.language, 'hi');
        assert.equal(seenConfig.timeout, 30000, 'timeout must be set');
    });
});

test('P1-A: timeout error returns empty (no fake text), never throws', async () => {
    await withKey('k', async () => {
        const err = new Error('timeout of 30000ms exceeded');
        err.code = 'ECONNABORTED';
        const r = await transcribeAudio(fixture(), async () => { throw err; });
        assert.deepEqual(r, { text: '', language: '' });
    });
});

test('P1-A: provider 401 returns empty (no leak of key material in logs path)', async () => {
    await withKey('k', async () => {
        const err = new Error('Request failed with status code 401');
        err.response = { status: 401, data: { err: 'invalid key' } };
        const r = await transcribeAudio(fixture(), async () => { throw err; });
        assert.deepEqual(r, { text: '', language: '' });
    });
});

test('P1-A: malformed payloads degrade to empty text, never throw', async () => {
    await withKey('k', async () => {
        for (const bad of [undefined, null, {}, { data: null }, { data: { results: null } },
            { data: { results: { channels: [] } } },
            { data: { results: { channels: [{ alternatives: [] }] } } }]) {
            const r = await transcribeAudio(fixture(), async () => bad);
            assert.equal(r.text, '', `payload ${JSON.stringify(bad)}`);
        }
    });
});

test('P1-A: empty transcript returns empty (caller asks to re-record)', async () => {
    await withKey('k', async () => {
        const r = await transcribeAudio(fixture(), async () => okPayload('', 'hi'));
        assert.deepEqual(r, { text: '', language: 'hi' });
    });
});

test('P1-A: BCP-47 language stripped to base code', async () => {
    await withKey('k', async () => {
        const r = await transcribeAudio(fixture(), async () => okPayload('x', 'gu-Deva'));
        assert.equal(r.language, 'gu');
    });
});

test('P1-A: no key / missing file return empty without calling HTTP', async () => {
    await withKey(undefined, async () => {
        let called = false;
        const r = await transcribeAudio(fixture(), async () => { called = true; });
        assert.deepEqual(r, { text: '', language: '' });
        assert.equal(called, false);
    });
    await withKey('k', async () => {
        let called = false;
        const r = await transcribeAudio('/nonexistent/note.ogg', async () => { called = true; });
        assert.deepEqual(r, { text: '', language: '' });
        assert.equal(called, false);
    });
});

test('P1-A: duplicate invocation safe — two calls, two independent results', async () => {
    await withKey('k', async () => {
        const f = fixture();
        const [a, b] = await Promise.all([
            transcribeAudio(f, async () => okPayload('first', 'hi')),
            transcribeAudio(f, async () => okPayload('second', 'mr'))
        ]);
        assert.equal(a.text, 'first');
        assert.equal(b.text, 'second');
        assert.equal(b.language, 'mr');
    });
});

// --- safeExt (AUD-026 fix) ------------------------------------------------------
test('P1-A: safeExt never throws on slash-less/malformed mimetypes', () => {
    assert.equal(safeExt('image/jpeg'), 'jpeg');
    assert.equal(safeExt('audio/ogg; codecs=opus'), 'ogg');
    assert.equal(safeExt('ogg'), '');
    assert.equal(safeExt(''), '');
    assert.equal(safeExt(null), '');
    assert.equal(safeExt(undefined), '');
    assert.equal(safeExt('image/'), '');
});
