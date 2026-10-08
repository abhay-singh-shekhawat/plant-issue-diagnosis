/**
 * Phase 1 — seed-aware routing contract (deterministic, offline).
 *
 * Proves, without any API keys or network:
 *   - crop routing is unchanged (photo + location gate, bare photo = crop)
 *   - seed routes via explicit domain OR seed keyword cues
 *   - seed proceeds with photo only (location never requested)
 *   - ambiguous crop+seed on a new conversation asks instead of guessing
 *   - case commands stay deterministic on seed conversations
 *   - duplicate messageIds mutate once
 *   - seed completed+photo asks same/new (no crop geo heuristic)
 *   - gateway + intent + idempotency units behave
 *
 *   node --test test/seed-routing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import { resolveTargetCase, getConversation } from '../services/session.service.js';
import { detectDomain, DOMAINS, AMBIGUOUS } from '../services/intent.router.js';
import { normalizeMessage } from '../services/message.gateway.js';
import {
    getCachedReply,
    markMessageSeen,
    clearIdempotencyForTest,
} from '../services/idempotency.service.js';

const uid = (p = 't-seed1') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// --- intent.router units -------------------------------------------------------
test('intent: explicit domain wins over text cues', () => {
    assert.equal(detectDomain({ text: 'leaf disease spot', domain: 'SEED_VERIFICATION' }).domain, DOMAINS.SEED);
    assert.equal(detectDomain({ text: 'beej packet', domain: 'CROP_DIAGNOSIS' }).domain, DOMAINS.CROP);
});

test('intent: seed cues route to seed, complaint cues to complaint', () => {
    assert.equal(detectDomain({ text: 'mere beej ki packet check karo' }).domain, DOMAINS.SEED);
    assert.equal(detectDomain({ text: 'duplicate seed sold, complaint against seller' }).domain, DOMAINS.COMPLAINT);
});

test('intent: crop cues route to crop, mixed cues are ambiguous, silence is null', () => {
    assert.equal(detectDomain({ text: 'leaf par rog lag gaya' }).domain, DOMAINS.CROP);
    assert.equal(
        detectDomain({ text: 'beej wali fasal ke leaf par daag hai, seed packet check karo' }).domain,
        AMBIGUOUS
    );
    assert.equal(detectDomain({ text: '' }).domain, null);
    assert.equal(detectDomain({}).domain, null);
});

// --- gateway + idempotency units -----------------------------------------------
test('gateway: normalizes, caps text, correlates', () => {
    const m = normalizeMessage({ sessionId: '  abc  ', text: 'x'.repeat(5000) });
    assert.equal(m.sessionId, 'abc');
    assert.equal(m.text.length, 2000);
    assert.ok(m.correlationId.startsWith('corr-'));
    const m2 = normalizeMessage({ sessionId: 'abc', correlationId: '  k1  ' });
    assert.equal(m2.correlationId, 'k1');
});

test('idempotency: mark/get round-trips, blanks ignored', () => {
    clearIdempotencyForTest();
    assert.equal(getCachedReply('nope'), null);
    markMessageSeen('  ', { text: 'hi' });
    assert.equal(getCachedReply('  '), null);
    markMessageSeen('m-1', { text: 'hello', language: 'hi', needsClarification: null });
    assert.equal(getCachedReply('m-1').text, 'hello');
    clearIdempotencyForTest();
});

// --- resolver-level defaults ----------------------------------------------------
test('resolver: bare photo still opens a CROP case (legacy default preserved)', () => {
    const r = resolveTargetCase({ conversationId: uid('crop-default'), imageUrl: '/a.jpg' });
    assert.equal(r.case.caseType, 'CROP_DIAGNOSIS');
    assert.equal(r.needsClarification, null);
});

test('resolver: seed-cue photo opens a SEED case', () => {
    const r = resolveTargetCase({
        conversationId: uid('seed-cue'),
        imageUrl: '/seed.jpg',
        text: 'mere beej ki packet check karo',
    });
    assert.equal(r.case.caseType, 'SEED_VERIFICATION');
});

test('resolver: ambiguous first message asks domain instead of guessing', () => {
    const r = resolveTargetCase({
        conversationId: uid('ambig'),
        text: 'beej wali fasal ke leaf par daag hai, seed packet check karo',
    });
    assert.equal(r.needsClarification?.type, 'domain');
    assert.ok(r.directResponse.includes('seed') && r.directResponse.includes('crop'));
});

// --- agent-level routing ----------------------------------------------------------
test('crop photo without location still waits for location pin', async () => {
    const r = await processMessage({ sessionId: uid('crop-wait'), text: '', imageUrl: '/crop.jpg' });
    assert.equal(r.state.caseType, 'CROP_DIAGNOSIS');
    assert.ok(r.text.includes('लोकेशन') || r.text.toLowerCase().includes('location'));
    assert.equal(r.diagnosticResult, null);
});

test('seed photo without location proceeds (never asks for a pin)', async () => {
    const r = await processMessage({
        sessionId: uid('seed-go'),
        domain: 'SEED_VERIFICATION',
        imageUrl: '/seed.jpg',
    });
    assert.equal(r.state.caseType, 'SEED_VERIFICATION');
    assert.ok(r.text.includes('No location is needed'));
    assert.ok(r.text.includes('branded'));
    assert.ok(!r.text.includes('लोकेशन पिन'));
});

test('seed photo via keyword cues proceeds without explicit domain', async () => {
    const r = await processMessage({
        sessionId: uid('seed-kw'),
        text: 'mere beej ki packet check karni hai',
        imageUrl: '/seed2.jpg',
    });
    assert.equal(r.state.caseType, 'SEED_VERIFICATION');
    assert.ok(r.text.includes('branded'));
});

test('seed text without photo asks for a photo, never for location', async () => {
    const r = await processMessage({
        sessionId: uid('seed-nophoto'),
        domain: 'SEED_VERIFICATION',
        text: 'beej check karna hai',
    });
    assert.equal(r.state.caseType, 'SEED_VERIFICATION');
    assert.ok(r.text.includes('फोटो'));
    assert.ok(!r.text.toLowerCase().includes('location pin'));
});

test('complaint cues open a SEED_COMPLAINT case with photo-only gate', async () => {
    const r = await processMessage({
        sessionId: uid('compl'),
        text: 'duplicate seed sold, complaint against seller',
        imageUrl: '/proof.jpg',
    });
    assert.equal(r.state.caseType, 'SEED_COMPLAINT');
    assert.ok(r.text.toLowerCase().includes('complaint'));
});

test('explicit seed photo on an active crop case opens a new seed case (crop untouched)', async () => {
    const cid = uid('switch-dom');
    const first = await processMessage({ sessionId: cid, imageUrl: '/crop.jpg' });
    assert.equal(first.state.caseType, 'CROP_DIAGNOSIS');
    const second = await processMessage({
        sessionId: cid,
        domain: 'SEED_VERIFICATION',
        imageUrl: '/seed.jpg',
    });
    assert.equal(second.state.caseType, 'SEED_VERIFICATION');
    assert.notEqual(second.state.caseId, first.state.caseId);
    const conv = getConversation(cid);
    assert.equal(conv.cases.length, 2);
    assert.equal(conv.cases[0].photos.length, 1);
});

// --- commands stay deterministic on seed conversations ------------------------------
test('case commands stay deterministic on seed cases', async () => {
    const cid = uid('seed-cmd');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s1.jpg' });
    const listed = await processMessage({ sessionId: cid, text: 'list' });
    assert.ok(listed.text.includes('Your cases'));
    const opened = await processMessage({ sessionId: cid, text: 'new' });
    assert.equal(getConversation(cid).cases.length, 2);
    assert.equal(opened.state.caseType, 'SEED_VERIFICATION');
    const back = await processMessage({ sessionId: cid, text: '1' });
    assert.ok(back.text.includes('Switched to'));
});

// --- duplicate delivery mutates once -------------------------------------------------
test('duplicate messageId mutates once and replays the same reply', async () => {
    clearIdempotencyForTest();
    const cid = uid('dedupe');
    const first = await processMessage({
        sessionId: cid,
        domain: 'SEED_VERIFICATION',
        imageUrl: '/dup.jpg',
        messageId: 'wa-mid-1',
    });
    const second = await processMessage({
        sessionId: cid,
        domain: 'SEED_VERIFICATION',
        imageUrl: '/dup.jpg',
        messageId: 'wa-mid-1',
    });
    assert.equal(first.text, second.text);
    assert.equal(second.deduped, true);
    assert.equal(getConversation(cid).cases[0].photos.length, 1);
    clearIdempotencyForTest();
});

// --- seed progression skips the crop geo heuristic ------------------------------------
test('completed seed case + new photo asks same/new (no geo auto-new)', async () => {
    const cid = uid('seed-prog');
    const first = await processMessage({
        sessionId: cid,
        domain: 'SEED_VERIFICATION',
        imageUrl: '/s1.jpg',
    });
    first.state.status = 'completed';
    const r = await processMessage({ sessionId: cid, imageUrl: '/s2.jpg' });
    assert.equal(r.needsClarification?.type, 'new_vs_same');
    assert.equal(getConversation(cid).cases.length, 1);
    const same = await processMessage({ sessionId: cid, text: 'same' });
    assert.equal(same.state.image_url, '/s2.jpg');
});
