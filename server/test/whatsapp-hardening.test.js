/**
 * P1-E regression: WhatsApp hardening (AUD-025/028 fixes).
 * Pure-function tests — no WA session, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    selectSenderDigits,
    reconnectDelayMs,
    findSystemChromium,
    __reconnectForTest
} from '../services/whatsapp.service.js';

// --- selectSenderDigits (AUD-025: LID/phone order instability) -----------------
test('P1-E: phone preferred over LID regardless of candidate order', () => {
    assert.equal(
        selectSenderDigits(['214490817773586', '918426078507']),
        '918426078507',
        'LID-first ordering still keys on the phone'
    );
    assert.equal(
        selectSenderDigits(['918426078507', '214490817773586']),
        '918426078507',
        'phone-first ordering unchanged'
    );
});

test('P1-E: bare 10-digit and LID-only fallbacks behave', () => {
    assert.equal(selectSenderDigits(['8426078507']), '8426078507');
    assert.equal(
        selectSenderDigits(['214490817773586']),
        '214490817773586',
        'LID-only sender keeps its LID (no phone known)'
    );
    assert.equal(selectSenderDigits([]), '');
    assert.equal(selectSenderDigits(null), '');
});

// --- reconnectDelayMs (AUD-028: fixed-5s flap loop) --------------------------------
test('P1-E: reconnect backoff doubles from 5s and caps at 2min', () => {
    assert.equal(reconnectDelayMs(1), 5000);
    assert.equal(reconnectDelayMs(2), 10000);
    assert.equal(reconnectDelayMs(3), 20000);
    assert.equal(reconnectDelayMs(6), 120000, 'capped at RECONNECT_MAX_MS');
    assert.equal(reconnectDelayMs(99), 120000, 'never exceeds the cap');
    assert.equal(reconnectDelayMs(0), 5000, 'clamped to first attempt');
});

test('P1-E: reconnect counter helper resets', () => {
    __reconnectForTest.reset();
    assert.equal(__reconnectForTest.attempts, 0);
});

// --- findSystemChromium (npm-start Chrome fix) ----------------------------------
test('WA-boot: resolver returns a real executable or empty string, never throws', () => {
    const found = findSystemChromium();
    assert.equal(typeof found, 'string');
    if (found) {
        // Must be a file the launcher can actually spawn — not a zip, dir, or
        // half-downloaded puppeteer cache entry.
        assert.ok(fs.existsSync(found), `resolved browser exists: ${found}`);
        assert.ok(fs.statSync(found).isFile(), 'resolved browser is a file');
        assert.ok(!/\.zip$/i.test(found), 'never a cache zip');
    }
});

test('WA-boot: explicit PUPPETEER_EXECUTABLE_PATH wins when it points at a real file', async () => {
    // The candidate list puts the env var first, but it is read at module
    // load — so re-import with a cache-busting query and the env var pointed
    // at this very node binary (a guaranteed-real file).
    const old = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
    try {
        const fresh = await import(`../services/whatsapp.service.js?waenv=${Date.now()}`);
        assert.equal(fresh.findSystemChromium(), process.execPath, 'env path takes priority');
    } finally {
        if (old === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
        else process.env.PUPPETEER_EXECUTABLE_PATH = old;
    }
});
