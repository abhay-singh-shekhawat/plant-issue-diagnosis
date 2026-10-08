/**
 * Offline regression tests for SC-Main's pure decision logic.
 * These need NO API keys and NO network: they cover the case/state machine and
 * the request-guard middlewares.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import multer from 'multer';

import {
    parseCommand,
    resolveTargetCase,
    getConversation,
    getConversationCount,
    sweepConversations,
    serializeConversation,
    setCaseLabel
} from '../services/session.service.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { notFound, errorHandler } from '../middlewares/error.middleware.js';

// --- Command parsing --------------------------------------------------------
test('parseCommand recognises new / same / list in several scripts', () => {
    assert.deepEqual(parseCommand('new'), { intent: 'new' });
    assert.deepEqual(parseCommand('NEW!'), { intent: 'new' });
    assert.deepEqual(parseCommand('नया'), { intent: 'new' });
    assert.deepEqual(parseCommand('naya'), { intent: 'new' });
    assert.deepEqual(parseCommand('same'), { intent: 'same' });
    assert.deepEqual(parseCommand('वही'), { intent: 'same' });
    assert.deepEqual(parseCommand('list'), { intent: 'list' });
});

test('parseCommand recognises switch by number, but ignores prose', () => {
    assert.deepEqual(parseCommand('2'), { intent: 'switch', index: 2 });
    assert.deepEqual(parseCommand('case 3'), { intent: 'switch', index: 3 });
    assert.equal(parseCommand('my tomato plant has spots'), null);
    assert.equal(parseCommand('the disease got worse after 2 days'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('x'.repeat(200)), null, 'over-long text is never a command');
});

// --- Case lifecycle ---------------------------------------------------------
test('first photo creates case #1 and fills the image slot', () => {
    const r = resolveTargetCase({ conversationId: 't-create', imageUrl: '/a.jpg' });
    assert.equal(r.conversation.cases.length, 1);
    assert.equal(r.case.image_url, '/a.jpg');
    assert.equal(r.conversation.activeCaseId, r.case.caseId);
});

test('a second photo on an unfinished case attaches to the SAME case', () => {
    const first = resolveTargetCase({ conversationId: 't-same', imageUrl: '/a.jpg' });
    const second = resolveTargetCase({ conversationId: 't-same', imageUrl: '/b.jpg' });
    assert.equal(second.case.caseId, first.case.caseId);
    assert.equal(second.photoChanged, true);
    assert.equal(second.case.photos.length, 2);
});

test('completed case + new photo asks "same or new?" and parks the photo', () => {
    const cid = 't-clarify';
    const first = resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    first.case.status = 'completed';
    first.case.coordinates = { lat: 21.0, lon: 78.0 };

    const r = resolveTargetCase({
        conversationId: cid, imageUrl: '/b.jpg', coordinates: { lat: 21.0, lon: 78.0 }
    });
    assert.equal(r.needsClarification?.type, 'new_vs_same');
    assert.ok(r.directResponse, 'the farmer must be asked a question');
    assert.equal(r.conversation.cases.length, 1, 'no new case until answered');

    const same = resolveTargetCase({ conversationId: cid, text: 'same' });
    assert.equal(same.case.caseId, first.case.caseId);
    assert.equal(same.isProgression, true);
    assert.equal(same.case.image_url, '/b.jpg');
    assert.equal(same.case.photos.length, 2);
    assert.equal(same.needsClarification, null);
});

test('answering "new" instead opens a second case', () => {
    const cid = 't-clarify-new';
    const first = resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    first.case.status = 'completed';
    first.case.coordinates = { lat: 21.0, lon: 78.0 };
    resolveTargetCase({
        conversationId: cid, imageUrl: '/b.jpg', coordinates: { lat: 21.0, lon: 78.0 }
    });
    const n = resolveTargetCase({ conversationId: cid, text: 'new' });
    assert.equal(n.conversation.cases.length, 2);
    assert.notEqual(n.case.caseId, first.case.caseId);
});

test('a photo from a DIFFERENT field auto-opens a new case (no question asked)', () => {
    const cid = 't-distance';
    const first = resolveTargetCase({
        conversationId: cid, imageUrl: '/a.jpg', coordinates: { lat: 21.0, lon: 78.0 }
    });
    first.case.status = 'completed';
    const r = resolveTargetCase({
        conversationId: cid, imageUrl: '/b.jpg', coordinates: { lat: 23.0, lon: 78.0 }
    });
    assert.equal(r.conversation.cases.length, 2);
    assert.equal(r.needsClarification, null);
    assert.equal(r.case.followUpOf, first.case.caseId);
});

test('a photo after a long silence auto-opens a new case', () => {
    const cid = 't-gap';
    const first = resolveTargetCase({
        conversationId: cid, imageUrl: '/a.jpg', coordinates: { lat: 21.0, lon: 78.0 }
    });
    first.case.status = 'completed';
    first.case.updatedAt = Date.now() - (20 * 24 * 60 * 60 * 1000); // 20 days ago
    const r = resolveTargetCase({
        conversationId: cid, imageUrl: '/b.jpg', coordinates: { lat: 21.0, lon: 78.0 }
    });
    assert.equal(r.conversation.cases.length, 2);
});

test('two diseases can be tracked at once and switched by number', () => {
    const cid = 't-two';
    resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    resolveTargetCase({ conversationId: cid, text: 'new' });
    const conv = getConversation(cid);
    resolveTargetCase({ conversationId: cid, imageUrl: '/b.jpg' });
    assert.equal(conv.cases.length, 2);

    const sw = resolveTargetCase({ conversationId: cid, text: '1' });
    assert.equal(sw.conversation.activeCaseId, conv.cases[0].caseId);
    assert.ok(sw.directResponse.includes(conv.cases[0].label));

    const bad = resolveTargetCase({ conversationId: cid, text: '9' });
    assert.ok(bad.directResponse, 'an out-of-range index falls back to the case list');
});

test('a bare number is NOT hijacked when there is only one case', () => {
    resolveTargetCase({ conversationId: 't-digit', imageUrl: '/a.jpg' });
    const r = resolveTargetCase({ conversationId: 't-digit', text: '2' });
    assert.equal(r.command, null, '"2 days" must stay normal prose');
});

test('case history does not leak between cases', () => {
    const cid = 't-isolation';
    const a = resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    a.case.history.push({ role: 'user', content: 'tomato question' });
    const b = resolveTargetCase({ conversationId: cid, text: 'new' });
    b.case.history.push({ role: 'user', content: 'banana question' });
    assert.notEqual(a.case.caseId, b.case.caseId);
    assert.ok(!b.case.history.some((h) => h.content === 'tomato question'));
    assert.ok(!a.case.history.some((h) => h.content === 'banana question'));
});

test('serializeConversation never leaks history to the client', () => {
    const cid = 't-serialize';
    const r = resolveTargetCase({ conversationId: cid, imageUrl: '/a.jpg' });
    r.case.history.push({ role: 'user', content: 'secret farmer detail' });
    setCaseLabel(r.case, 'Tomato leaf blight');
    const view = serializeConversation(getConversation(cid));
    assert.equal(view.cases.length, 1);
    assert.equal(view.cases[0].label, 'Tomato leaf blight');
    assert.equal(view.cases[0].history, undefined);
    assert.equal(JSON.stringify(view).includes('secret farmer detail'), false);
});

test('sweepConversations evicts conversations idle past the TTL', () => {
    const conv = getConversation('t-sweep');
    conv.updatedAt = Date.now() - (1000 * 60 * 60 * 24 * 30); // 30 days
    const before = getConversationCount();
    const removed = sweepConversations();
    assert.ok(removed >= 1);
    assert.ok(getConversationCount() < before);
});

// --- Middlewares ------------------------------------------------------------
const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
};

test('rateLimit allows a burst then answers 429', () => {
    const prev = process.env.RATE_LIMIT_PER_MINUTE;
    process.env.RATE_LIMIT_PER_MINUTE = '3';
    const req = { ip: '9.9.9.9', socket: {} };
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 6; i += 1) {
        const res = mockRes();
        rateLimit(req, res, () => { allowed += 1; });
        if (res.statusCode === 429) blocked += 1;
    }
    assert.equal(allowed, 3);
    assert.equal(blocked, 3);
    if (prev === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
    else process.env.RATE_LIMIT_PER_MINUTE = prev;
});

test('notFound returns JSON, not HTML', () => {
    const res = mockRes();
    notFound({ originalUrl: '/nope' }, res);
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.error);
});

test('errorHandler maps multer rejections to 400 and hides internals', () => {
    const res1 = mockRes();
    errorHandler(new multer.MulterError('LIMIT_FILE_SIZE'), {}, res1, () => {});
    assert.equal(res1.statusCode, 400);
    assert.ok(!String(res1.body.error).includes('Trace'));

    const res2 = mockRes();
    errorHandler(new Error('Only image files are allowed!'), {}, res2, () => {});
    assert.equal(res2.statusCode, 400);

    const res3 = mockRes();
    errorHandler(new Error('boom'), {}, res3, () => {});
    assert.equal(res3.statusCode, 500);
    assert.equal(res3.body.error, 'Internal Server Error', 'no internals leaked');
});