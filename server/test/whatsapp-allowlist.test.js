/**
 * Offline regression tests for the WhatsApp access allowlist.
 * No network, no WhatsApp session, no API keys required — `npm test`.
 *
 * Regression guard: WhatsApp started delivering 1:1 messages from LID
 * ("linked id") JIDs. For those senders `contact.number` is undefined and the
 * raw `from` is a LID, so a single-candidate check rejected farmers who ARE on
 * WHATSAPP_ALLOWED_NUMBERS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isSenderAllowed } from '../services/whatsapp.service.js';

test('allowlist matches a sender by phone-number JID', () => {
    assert.equal(isSenderAllowed(['918426078507'], ['8426078507']), true);
    assert.equal(isSenderAllowed(['918426078507'], ['918426078507']), true);
    assert.equal(isSenderAllowed(['918426078507'], ['8426078508']), false);
});

test('allowlist matches a LID sender through the contact phone-number id', () => {
    // Real shape for a LID chat: contact.number is undefined, the PN id holds
    // the phone number and `from` is the LID.
    const senders = ['918426078507', '214490817773586'];
    assert.equal(isSenderAllowed(senders, ['8426078507']), true);
});

test('allowlist blocks unknown senders but stays open when unset', () => {
    assert.equal(isSenderAllowed(['214490817773586'], ['8426078507']), false, 'LID alone must not leak access');
    assert.equal(isSenderAllowed(['919999999999'], ['8426078507']), false);
    assert.equal(isSenderAllowed(['919999999999'], []), true, 'empty allowlist = reply to everyone');
    assert.equal(isSenderAllowed([], ['8426078507']), false, 'no sender info must not pass a locked bot');
});

test('allowlist tolerates +, spaces, dashes and absent country codes', () => {
    assert.equal(isSenderAllowed(['918426078507'], ['+91 84260 78507']), true);
    assert.equal(isSenderAllowed(['8426078507'], ['8426078507']), true);
    assert.equal(isSenderAllowed([undefined, null, ''], ['8426078507']), false);
});
