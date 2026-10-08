/**
 * P0-C regression: single rate-limit gate (AUD-003), validated env numerics
 * (AUD-004), exact allowlist match (AUD-008). Offline, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { envNum } from '../env.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { isSenderAllowed } from '../services/whatsapp.service.js';

// --- envNum -------------------------------------------------------------------
test('AUD-004: envNum passes explicit finite numbers through, even 0', () => {
    process.env.T_GUARD_NUM = '0';
    assert.equal(envNum('T_GUARD_NUM', 30), 0);
    process.env.T_GUARD_NUM = '15';
    assert.equal(envNum('T_GUARD_NUM', 30), 15);
    delete process.env.T_GUARD_NUM;
});

test('AUD-004: envNum falls back on missing/empty/garbage', () => {
    delete process.env.T_GUARD_MISSING;
    assert.equal(envNum('T_GUARD_MISSING', 30), 30);
    for (const bad of ['', 'abc', 'NaN', 'Infinity', '12px', undefined]) {
        process.env.T_GUARD_BAD = bad;
        assert.equal(envNum('T_GUARD_BAD', 30), 30, `raw=${bad}`);
    }
    delete process.env.T_GUARD_BAD;
});

test('AUD-004: garbage RATE_LIMIT_PER_MINUTE keeps the limiter ON at 30', () => {
    const old = process.env.RATE_LIMIT_PER_MINUTE;
    process.env.RATE_LIMIT_PER_MINUTE = 'abc';
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 35; i++) {
        const req = { ip: '10.9.9.9' };
        const res = { status: (c) => { res.code = c; return res; }, json: () => res };
        let nexted = false;
        rateLimit(req, res, () => { nexted = true; });
        if (nexted) allowed++;
        else if (res.code === 429) blocked++;
    }
    assert.equal(allowed, 30, 'default 30 enforced despite garbage env');
    assert.equal(blocked, 5);
    if (old === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
    else process.env.RATE_LIMIT_PER_MINUTE = old;
});

// --- AUD-003: single gate -------------------------------------------------------
test('AUD-003: rateLimit mounted once per route file (app level only)', () => {
    const stripComments = (src) => src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const uploadRoutes = stripComments(fs.readFileSync(
        new URL('../routes/upload.routes.js', import.meta.url), 'utf8'
    ));
    const messageRoutes = stripComments(fs.readFileSync(
        new URL('../routes/message.routes.js', import.meta.url), 'utf8'
    ));
    const serverJs = fs.readFileSync(
        new URL('../server.js', import.meta.url), 'utf8'
    );
    assert.ok(!uploadRoutes.includes('rateLimit'), 'upload routes must not re-mount');
    assert.ok(!messageRoutes.includes('rateLimit'), 'message routes must not re-mount');
    assert.ok(serverJs.includes("app.use('/api', rateLimit"), 'app-level gate intact');
});

// --- AUD-008: exact match --------------------------------------------------------
test('AUD-008: suffix over-match rejected, legit forms still pass', () => {
    assert.equal(
        isSenderAllowed(['998426078507'], ['8426078507']),
        false, 'attacker sharing victim suffix must be rejected'
    );
    assert.equal(isSenderAllowed(['918426078507'], ['8426078507']), true, '91-prefix ok');
    assert.equal(isSenderAllowed(['918426078507'], ['918426078507']), true, 'exact ok');
    assert.equal(isSenderAllowed(['8426078507'], ['8426078507']), true, 'bare 10-digit ok');
    assert.equal(
        isSenderAllowed(['918426078507', '214490817773586'], ['8426078507']),
        true, 'LID multi-candidate still matches via phone id'
    );
    assert.equal(
        isSenderAllowed(['214490817773586'], ['214490817773586']),
        true, 'listed LID id matches exactly'
    );
    assert.equal(
        isSenderAllowed(['998426078507'], []),
        true, 'empty allowlist stays open'
    );
});
