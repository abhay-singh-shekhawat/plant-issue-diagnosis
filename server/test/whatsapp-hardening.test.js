/**
 * P1-E regression: WhatsApp hardening (AUD-025/028 fixes).
 * Pure-function tests — no WA session, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    selectSenderDigits,
    reconnectDelayMs,
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
