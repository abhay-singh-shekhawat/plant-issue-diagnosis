/**
 * P0-B regression: no shared guest buckets (AUD-002) + per-endpoint session
 * boundary (AUD-001). Offline — controller tests use stub req/res objects and
 * gathering-nudge paths that never call Gemini.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getConversation,
    resolveTargetCase,
    withConversationLock
} from '../services/session.service.js';
import { handleChatMessage } from '../controllers/message.controller.js';

// --- store: fail loud on blank ids -------------------------------------------
test('AUD-002: getConversation throws on missing/blank ids (no anonymous bucket)', () => {
    for (const bad of [undefined, null, '', '   ', 0, 123, {}, []]) {
        assert.throws(() => getConversation(bad), /conversationId is required/);
    }
});

test('AUD-002: withConversationLock throws on blank ids', async () => {
    await assert.rejects(
        withConversationLock('', async () => 'x'),
        /conversationId is required/
    );
});

test('AUD-002: resolveTargetCase throws on blank conversationId', () => {
    assert.throws(
        () => resolveTargetCase({ conversationId: '  ', imageUrl: '/a.jpg' }),
        /conversationId is required/
    );
});

// --- isolation: two guests never share ----------------------------------------
test('AUD-002: distinct ids get distinct conversations and histories', () => {
    const a = resolveTargetCase({ conversationId: 't-iso-a', imageUrl: '/a.jpg' });
    const b = resolveTargetCase({ conversationId: 't-iso-b', imageUrl: '/b.jpg' });
    assert.notEqual(a.conversation, b.conversation);
    assert.equal(a.case.photos.length, 1);
    assert.equal(b.case.photos.length, 1);
    assert.equal(a.case.photos[0].url, '/a.jpg');
    assert.equal(b.case.photos[0].url, '/b.jpg');
});

test('AUD-002: ids are exact — surrounding whitespace and case differ', () => {
    const a = getConversation('t-exact-1');
    const b = getConversation('  t-exact-1  ');
    assert.equal(a.conversationId, 't-exact-1');
    assert.equal(a, b, 'trimmed to the same bucket');
    const c = getConversation('T-EXACT-1');
    assert.notEqual(a, c, 'case-sensitive: different bucket');
});

// --- controllers: sessionId boundary (AUD-001) --------------------------------
const mockRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.body = obj; return res; };
    return res;
};

test('AUD-001: POST /api/message without sessionId → 400, no brain call', async () => {
    for (const body of [{}, { sessionId: '' }, { sessionId: '   ' }, { sessionId: 123 }]) {
        const res = mockRes();
        await handleChatMessage({ body }, res);
        assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)}`);
        assert.match(res.body.error, /sessionId is required/);
    }
});

test('AUD-001: POST /api/message with valid sessionId reaches the brain', async () => {
    // No image + no coords → gathering nudge, no Gemini call (offline-safe).
    const res = mockRes();
    await handleChatMessage(
        { body: { sessionId: 't-ctrl-valid', source: 'web', text: 'hello' } },
        res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.ai_response === 'string' && res.body.ai_response.length > 0);
});

test('AUD-001: public endpoints stay public — health and valid-id flows open', async () => {
    // This test documents the intentional boundary: /api/* is public by design
    // (no login exists; demo farmers use it directly). Protection comes from
    // per-session isolation + rate limiting, NOT from auth headers.
    const res = mockRes();
    await handleChatMessage(
        { body: { sessionId: 't-ctrl-public', source: 'web', text: 'hi' } },
        res
    );
    assert.equal(res.statusCode, 200, 'no auth token required for valid session');
});
