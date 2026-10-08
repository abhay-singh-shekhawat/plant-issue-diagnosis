/**
 * P1-B regression: TTL / lifecycle boundaries for media sweep + session sweep.
 * Offline — uses os.tmpdir fixtures and env manipulation (restored after).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sweepTempFiles } from '../services/cleanup.service.js';
import { getConversation, sweepConversations } from '../services/session.service.js';

const withEnv = async (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

// --- media sweep uses real dirs under server/ — redirect via fresh files -----
// NOTE: sweepTempFiles walks server/user_img_web etc. To stay hermetic we create
// files there and delete them after; every aged file uses mtime in the past.
const IMG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', 'user_img_web');

const plantAgedFile = (ageMs) => {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const p = path.join(IMG_DIR, `p1b-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50]));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
};

test('P1-B: TTL=0 disables the media sweep (nothing deleted)', async () => {
    const f = plantAgedFile(30 * 60 * 60 * 1000); // 30 h old — would die under TTL 24
    await withEnv({ MEDIA_TTL_HOURS: '0' }, async () => {
        const r = sweepTempFiles();
        assert.equal(r.disabled, true);
        assert.equal(r.removed, 0);
    });
    assert.ok(fs.existsSync(f), 'file must survive a disabled sweep');
    fs.unlinkSync(f);
});

test('P1-B: garbage TTL falls back to 24 h (expired file removed, fresh kept)', async () => {
    const old = plantAgedFile(30 * 60 * 60 * 1000);
    const fresh = plantAgedFile(5 * 60 * 1000);
    await withEnv({ MEDIA_TTL_HOURS: 'abc' }, async () => {
        const r = sweepTempFiles();
        assert.equal(r.disabled, undefined);
        assert.equal(Number(r), 1, 'exactly the expired file removed');
    });
    assert.ok(!fs.existsSync(old), 'expired file removed');
    // fresh file is young-skipped (grace period) — still on disk either way
    assert.ok(fs.existsSync(fresh), 'fresh file kept');
    fs.unlinkSync(fresh);
});

test('P1-B: young files are skipped even when TTL is tiny', async () => {
    const f = plantAgedFile(30 * 1000); // 30 s old
    await withEnv({ MEDIA_TTL_HOURS: '0.0001' }, async () => {
        const r = sweepTempFiles();
        assert.ok(r.skipped >= 1, 'grace period must skip the young file');
    });
    assert.ok(fs.existsSync(f), 'young file must survive');
    fs.unlinkSync(f);
});

test('P1-B: repeated sweeps are idempotent', async () => {
    const old = plantAgedFile(30 * 60 * 60 * 1000);
    await withEnv({ MEDIA_TTL_HOURS: '24' }, async () => {
        assert.equal(Number(sweepTempFiles()), 1, 'first sweep removes');
        assert.equal(Number(sweepTempFiles()), 0, 'second sweep finds nothing');
    });
    assert.ok(!fs.existsSync(old));
});

test('Closeout: photo dropped with a switch/list command is deleted, not orphaned (AUD-035)', async () => {
    const { resolveTargetCase, getConversation } = await import('../services/session.service.js');
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const mk = (name) => {
        const p = path.join(IMG_DIR, name);
        fs.writeFileSync(p, Buffer.from([0x89, 0x50]));
        return `/user_img_web/${name}`;
    };
    const cid = 't-closeout-parked';
    getConversation(cid);
    resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    // A photo riding along with a switch action attaches nowhere: the file the
    // upload already wrote must be deleted, not left for the hourly sweep.
    const url = mk(`p1b-dropped-${Date.now()}.png`);
    const abs = path.join(IMG_DIR, path.basename(url));
    assert.ok(fs.existsSync(abs), 'dropped file starts on disk');
    resolveTargetCase({ conversationId: cid, imageUrl: url, action: 'switch', caseId: 'c-nope' });
    assert.ok(!fs.existsSync(abs), 'dropped file deleted at resolve time');
});

test('Closeout: unknown action-switch caseId shows the case list, not a false ack (AUD-036)', async () => {
    const { resolveTargetCase } = await import('../services/session.service.js');
    const cid = 't-closeout-switch';
    resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    const r = resolveTargetCase({ conversationId: cid, action: 'switch', caseId: 'c-nope' });
    assert.ok(!r.directResponse.startsWith('Switched to'), 'no false switch ack');
    assert.ok(r.directResponse.includes('Your cases') || r.directResponse.includes('केस'), 'case list shown instead');
});

// --- session sweep boundaries --------------------------------------------------
test('P1-B: TTL=0 disables idle eviction but LRU cap still bounds memory', async () => {
    const c = getConversation('t-p1b-ttl0');
    c.updatedAt = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days idle
    await withEnv({ CONVERSATION_TTL_HOURS: '0', MAX_CONVERSATIONS: '5000' }, async () => {
        assert.equal(sweepConversations(), 0, 'nothing evicted when TTL disabled');
    });
    assert.ok(getConversation('t-p1b-ttl0'), 'idle conversation preserved');
});

test('P1-B: garbage session TTL falls back to 48 h (fresh kept, ancient evicted)', async () => {
    const fresh = getConversation('t-p1b-fresh');
    const ancient = getConversation('t-p1b-ancient');
    ancient.updatedAt = Date.now() - 60 * 24 * 60 * 60 * 1000;
    await withEnv({ CONVERSATION_TTL_HOURS: 'abc' }, async () => {
        const removed = sweepConversations();
        assert.ok(removed >= 1, 'ancient evicted under default TTL');
    });
    assert.ok(getConversation('t-p1b-fresh'), 'fresh conversation kept');
});
