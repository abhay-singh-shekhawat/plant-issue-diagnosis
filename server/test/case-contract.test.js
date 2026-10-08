/**
 * R2 regression: the case/session response contract (AUD-017).
 *
 * Contract finding (verified against client/src + controllers + serializers):
 * the server DTO was ALREADY minimal — `serializeConversation` exposes only
 * identity/display fields, and both controllers return exactly
 * { success?, data?, ai_response, diagnostic, conversation, needsClarification }.
 * The transcript-mixing symptom lived client-side (single shared `messages`
 * array, append-only). R2 therefore pins the contract from BOTH sides:
 *
 *   server: the DTO contains exactly the frontend-required fields and nothing
 *   sensitive (no history, no diagnostic_data, no coordinates values, no photo
 *   URLs, no internal state);
 *   client: every bubble carries caseId and the shared filter predicate keeps
 *   only active-case + unstamped bubbles (predicate mirrored here in JS).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveTargetCase,
    getConversation,
    serializeConversation
} from '../services/session.service.js';

/** The exact predicate ChatContainer.jsx uses to filter messages per case. */
const visibleForCase = (messages, activeCaseId) =>
    messages.filter((m) => !m.caseId || !activeCaseId || m.caseId === activeCaseId);

// --- 1. normal case ---------------------------------------------------------------
test('R2-1: normal case serializes with exactly the required fields', () => {
    const r = resolveTargetCase({ conversationId: 't-r2-normal', imageUrl: '/a.jpg' });
    const view = serializeConversation(r.conversation);
    assert.deepEqual(Object.keys(view).sort(), ['activeCaseId', 'cases', 'conversationId', 'language']);
    assert.deepEqual(
        Object.keys(view.cases[0]).sort(),
        ['caseId', 'createdAt', 'hasCoordinates', 'label', 'photoCount', 'status', 'updatedAt']
    );
});

// --- 2. multiple cases --------------------------------------------------------------
test('R2-2: multiple cases each serialize independently', () => {
    const cid = 't-r2-multi';
    const first = resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    first.case.status = 'completed';
    const second = resolveTargetCase({ conversationId: cid, imageUrl: '/b.jpg', text: 'new' });
    const view = serializeConversation(getConversation(cid));
    assert.equal(view.cases.length, 2);
    assert.equal(view.activeCaseId, second.case.caseId);
    assert.ok(view.cases.every((c) => typeof c.caseId === 'string' && typeof c.label === 'string'));
});

// --- 3. empty case list --------------------------------------------------------------
test('R2-3: empty conversation serializes with zero cases', () => {
    const view = serializeConversation(getConversation('t-r2-empty'));
    assert.deepEqual(view.cases, []);
    assert.equal(view.activeCaseId, null);
});

// --- 4. case with transcript ------------------------------------------------------------
test('R2-4: transcript/history never leaks into the DTO', () => {
    const r = resolveTargetCase({ conversationId: 't-r2-transcript', imageUrl: '/a.jpg' });
    r.case.history.push({ role: 'user', content: 'secret farmer detail' });
    r.case.history.push({ role: 'model', content: 'secret diagnosis draft' });
    const raw = JSON.stringify(serializeConversation(r.conversation));
    assert.ok(!raw.includes('secret farmer detail'), 'user history must not leak');
    assert.ok(!raw.includes('secret diagnosis draft'), 'model history must not leak');
});

// --- 5. case with photo --------------------------------------------------------------------
test('R2-5: photo exposed as count only, never the URL', () => {
    const r = resolveTargetCase({ conversationId: 't-r2-photo', imageUrl: '/user_img_web/secret-abc123.jpg' });
    const view = serializeConversation(r.conversation);
    assert.equal(view.cases[0].photoCount, 1);
    const raw = JSON.stringify(view);
    assert.ok(!raw.includes('secret-abc123'), 'photo URL must not leak');
    assert.ok(!raw.includes('user_img_web'), 'storage path must not leak');
});

// --- 6. case with coordinates -----------------------------------------------------------------
test('R2-6: coordinates exposed as boolean only, never values', () => {
    const r = resolveTargetCase({
        conversationId: 't-r2-coords', imageUrl: '/a.jpg',
        coordinates: { lat: 26.1234, lon: 75.5678 }
    });
    const view = serializeConversation(r.conversation);
    assert.equal(view.cases[0].hasCoordinates, true);
    const raw = JSON.stringify(view);
    assert.ok(!raw.includes('26.1234'), 'lat must not leak');
    assert.ok(!raw.includes('75.5678'), 'lon must not leak');
});

// --- 7. diagnostic/internal metadata ----------------------------------------------------------------
test('R2-7: diagnostic_data, photos array, question_count never leak', () => {
    // NOTE: fixture id deliberately free of the asserted needles — an earlier
    // draft used `t-r2-internal` and matched its own name, not a leak.
    const r = resolveTargetCase({ conversationId: 't-r2-priv', imageUrl: '/a.jpg' });
    r.case.diagnostic_data = { visual_diagnosis: { confidence: 99 }, secret: 'internal' };
    r.case.question_count = 2;
    r.case.last_diagnosis = 'internal draft';
    const raw = JSON.stringify(serializeConversation(r.conversation));
    for (const needle of ['diagnostic_data', 'question_count', 'last_diagnosis', 'internal', 'photos']) {
        assert.ok(!raw.includes(needle), `${needle} must not leak`);
    }
});

// --- 8. ownership/session isolation --------------------------------------------------------------------
test('R2-8: sessions never see each others cases', () => {
    resolveTargetCase({ conversationId: 't-r2-own-a', imageUrl: '/a.jpg' });
    resolveTargetCase({ conversationId: 't-r2-own-b', imageUrl: '/b.jpg' });
    const a = serializeConversation(getConversation('t-r2-own-a'));
    const b = serializeConversation(getConversation('t-r2-own-b'));
    assert.equal(a.cases.length, 1);
    assert.equal(b.cases.length, 1);
    assert.notEqual(a.cases[0].caseId, b.cases[0].caseId);
    assert.notEqual(a.conversationId, b.conversationId);
});

// --- 9. frontend-required fields present -----------------------------------------------------------------
test('R2-9: every field CaseSwitcher/ChatContainer reads is present', () => {
    const r = resolveTargetCase({ conversationId: 't-r2-required', imageUrl: '/a.jpg' });
    const view = serializeConversation(r.conversation);
    // CaseSwitcher.jsx: conversation.cases, c.caseId, activeCaseId, c.label, c.status
    assert.ok(Array.isArray(view.cases));
    assert.ok(typeof view.activeCaseId === 'string');
    assert.ok(typeof view.cases[0].caseId === 'string');
    assert.ok(typeof view.cases[0].label === 'string');
    assert.ok(typeof view.cases[0].status === 'string');
    // ChatContainer.jsx: result.conversation truthy, needsClarification shape untouched
    assert.ok(view);
});

// --- 10. filter predicate (client mirror) ----------------------------------------------------------------------
test('R2-10: per-case filter keeps active + unstamped, hides other cases', () => {
    const msgs = [
        { message_id: '1', caseId: 'c1', text: 'tomato' },
        { message_id: '2', caseId: 'c2', text: 'wheat' },
        { message_id: '3', text: 'optimistic temp bubble' },
        { message_id: '4', caseId: null, text: 'legacy unstamped' }
    ];
    const forC1 = visibleForCase(msgs, 'c1');
    assert.deepEqual(forC1.map((m) => m.message_id), ['1', '3', '4']);
    const forC2 = visibleForCase(msgs, 'c2');
    assert.deepEqual(forC2.map((m) => m.message_id), ['2', '3', '4']);
    const noActive = visibleForCase(msgs, null);
    assert.equal(noActive.length, 4, 'no active case → nothing hidden');
});
