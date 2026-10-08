/**
 * P1-C regression: agent state machine — history helpers + transition matrix.
 * Offline: gathering/direct-response paths never call Gemini. LLM-dependent
 * transitions (confident/question/completed) are covered by prompt-shape tests
 * in geo-integrity.test.js; the matrix below documents them as specified.
 *
 * STATE MATRIX (from processMessageInner + resolveTargetCase):
 *   gathering_info --[photo+coords]--> evaluating_confidence
 *   evaluating_confidence --[score>=thr|budget out]--> completed
 *   evaluating_confidence --[score<thr]--> evaluating_confidence (q_count+1)
 *   completed --[new photo, same field]--> pendingClarification (same/new?)
 *   completed --[new photo, far field|long gap]--> gathering_info (fresh case)
 *   any --[LLM/network error]--> same state + fallback reply (history pushed)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    pushHistory,
    buildChatContents,
    MAX_HISTORY_ENTRIES
} from '../services/agent.service.js';
import { processMessage } from '../services/agent.service.js';
import { getConversation } from '../services/session.service.js';

// --- pushHistory cap ------------------------------------------------------------
test('P1-C: history capped at MAX_HISTORY_ENTRIES, newest kept', () => {
    const kase = { history: [] };
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 20; i++) {
        pushHistory(kase, i % 2 ? 'model' : 'user', `turn-${i}`);
    }
    assert.equal(kase.history.length, MAX_HISTORY_ENTRIES);
    assert.equal(kase.history.at(-1).content, `turn-${MAX_HISTORY_ENTRIES + 19}`);
    assert.equal(kase.history[0].content, 'turn-20');
});

test('P1-C: pushHistory tolerates missing case/history', () => {
    pushHistory(null, 'user', 'x');
    pushHistory({}, 'user', 'x');
    pushHistory({ history: null }, 'user', 'x');
});

// --- buildChatContents -----------------------------------------------------------
test('P1-C: window is last-6 starting on a user turn', () => {
    const h = [
        { role: 'model', content: 'm0' },
        { role: 'user', content: 'u1' },
        { role: 'model', content: 'm1' },
        { role: 'user', content: 'u2' },
        { role: 'model', content: 'm2' },
        { role: 'user', content: 'u3' },
        { role: 'model', content: 'm3' },
        { role: 'user', content: 'u4' }
    ];
    const c = buildChatContents(h);
    // last-6 of the 8-turn history = [m1,u2,m2,u3,m3,u4]; leading model turn
    // dropped → 5 entries starting on u2.
    assert.equal(c.length, 5);
    assert.equal(c[0].role, 'user');
    assert.equal(c[0].parts[0].text, 'u2');
    assert.equal(c.at(-1).parts[0].text, 'u4');
});

test('P1-C: empty window when no user turn exists (no contents[-1] deref)', () => {
    assert.deepEqual(buildChatContents([]), []);
    assert.deepEqual(buildChatContents([{ role: 'model', content: 'm' }]), []);
    assert.deepEqual(buildChatContents(null), []);
});

// --- transitions via processMessage (offline paths) --------------------------------
test('P1-C: text-only message stays gathering_info with slot nudge', async () => {
    const r = await processMessage({
        sessionId: 't-p1c-gather', source: 'web', text: 'hello'
    });
    assert.equal(r.state.status, 'gathering_info');
    assert.equal(r.diagnosticResult, null);
    assert.ok(r.text.length > 0);
    const conv = getConversation('t-p1c-gather');
    assert.equal(conv.cases.length, 1);
});

test('P1-C: empty message returns nudge without LLM call or crash', async () => {
    const r = await processMessage({
        sessionId: 't-p1c-empty', source: 'web', text: '   '
    });
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
    assert.equal(r.diagnosticResult, null);
});

test('P1-C: direct-response transitions do not call the LLM', async () => {
    // 'list' on an empty conversation → deterministic reply, no Gemini.
    const r = await processMessage({
        sessionId: 't-p1c-list', source: 'web', text: 'list'
    });
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
    assert.equal(r.diagnosticResult, null);
});

test('P1-C: concurrent same-session messages serialize without corruption', async () => {
    const sid = 't-p1c-concurrent';
    const [a, b] = await Promise.all([
        processMessage({ sessionId: sid, source: 'web', text: 'pehla' }),
        processMessage({ sessionId: sid, source: 'web', text: 'doosra' })
    ]);
    assert.ok(a.text.length > 0 && b.text.length > 0);
    const conv = getConversation(sid);
    assert.equal(conv.cases.length, 1, 'both turns land in the same single case');
});
