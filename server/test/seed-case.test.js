/**
 * Phase 2 — seed case/slots contract (deterministic, offline).
 *
 * Proves, without any API keys or network:
 *   - seed cases carry full slot shells; crop cases carry none
 *   - branded vs open answers route to the stored purchase mode
 *   - UNDECIDED asks rather than guesses (incl. ambiguous both-cue input)
 *   - stored mode is correctable by an explicit later answer
 *   - case isolation: modes/histories never leak across cases
 *   - new/same on seed cases never corrupt crop cases (and vice versa)
 *
 *   node --test test/seed-case.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import {
    resolveTargetCase,
    getConversation,
    serializeConversation,
} from '../services/session.service.js';
import {
    parsePurchaseMode,
    setPurchaseMode,
    ensureSeedContext,
    emptySeedContext,
    PURCHASE_MODES,
    AMBIGUOUS_MODE,
} from '../services/seed/seed-slot.service.js';

const uid = (p = 't-seed2') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// --- slot-service units ----------------------------------------------------------
test('parsePurchaseMode: branded cues (en/hi/romanized)', () => {
    assert.equal(parsePurchaseMode('branded hai'), PURCHASE_MODES.BRANDED);
    assert.equal(parsePurchaseMode('packet wala beej hai'), PURCHASE_MODES.BRANDED);
    assert.equal(parsePurchaseMode('यह ब्रांडेड बीज है'), PURCHASE_MODES.BRANDED);
    assert.equal(parsePurchaseMode('sealed pack hai'), PURCHASE_MODES.BRANDED);
});

test('parsePurchaseMode: open cues (en/hi/romanized)', () => {
    assert.equal(parsePurchaseMode('open hai'), PURCHASE_MODES.OPEN);
    assert.equal(parsePurchaseMode('khula beej liya'), PURCHASE_MODES.OPEN);
    assert.equal(parsePurchaseMode('यह खुला बीज है'), PURCHASE_MODES.OPEN);
    assert.equal(parsePurchaseMode('loose seed'), PURCHASE_MODES.OPEN);
});

test('parsePurchaseMode: no signal stays null, both signals are ambiguous', () => {
    assert.equal(parsePurchaseMode('ok aur batao'), null);
    assert.equal(parsePurchaseMode(''), null);
    assert.equal(parsePurchaseMode(null), null);
    assert.equal(parsePurchaseMode('branded bhi hai open bhi'), AMBIGUOUS_MODE);
});

test('seed context: shell defaults, crop exclusion, legacy migration', () => {
    const seed = resolveTargetCase({
        conversationId: uid('shell'),
        imageUrl: '/s.jpg',
        domain: 'SEED_VERIFICATION',
    }).case;
    assert.deepEqual({ ...seed.seedContext, purchaseMode: seed.seedContext.purchaseMode }, {
        ...emptySeedContext(),
    });
    assert.deepEqual(seed.seedContext.evidenceIds, []);

    const crop = resolveTargetCase({ conversationId: uid('shell-crop'), imageUrl: '/c.jpg' }).case;
    assert.equal(crop.seedContext, null);
    assert.equal(setPurchaseMode(crop, 'BRANDED'), false);

    // Phase-1 legacy case (only { purchaseMode }) migrates in place.
    const legacy = { caseType: 'SEED_VERIFICATION', seedContext: { purchaseMode: 'UNDECIDED' } };
    ensureSeedContext(legacy);
    assert.deepEqual(Object.keys(legacy.seedContext).sort(), Object.keys(emptySeedContext()).sort());

    assert.equal(setPurchaseMode(seed, 'BOGUS'), false);
    assert.equal(seed.seedContext.purchaseMode, 'UNDECIDED');
});

// --- agent-level slot behavior -----------------------------------------------------
test('branded answer stores BRANDED and names the packet step', async () => {
    const cid = uid('branded');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    const r = await processMessage({ sessionId: cid, text: 'branded packet hai' });
    const kase = getConversation(cid).cases[0];
    assert.equal(kase.seedContext.purchaseMode, 'BRANDED');
    assert.ok(r.text.toLowerCase().includes('branded'));
    assert.ok(r.text.toLowerCase().includes('packet'));
    assert.ok(!r.text.toLowerCase().includes('location pin'));
});

test('open answer stores OPEN and names the seller+price step', async () => {
    const cid = uid('open');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    const r = await processMessage({ sessionId: cid, text: 'khula beej hai' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'OPEN');
    assert.ok(r.text.toLowerCase().includes('open'));
    assert.ok(r.text.toLowerCase().includes('seller'));
});

test('unresolved mode asks rather than guesses', async () => {
    const cid = uid('undecided');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    const r = await processMessage({ sessionId: cid, text: 'ok aur batao' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'UNDECIDED');
    assert.ok(r.text.includes('*branded*') && r.text.includes('*open*'));
});

test('ambiguous both-cue answer asks for one word, stores nothing', async () => {
    const cid = uid('ambmode');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    const r = await processMessage({ sessionId: cid, text: 'branded bhi hai open bhi' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'UNDECIDED');
    assert.ok(r.text.includes('*branded*') && r.text.includes('*open*'));
});

test('stored mode is correctable by an explicit later answer', async () => {
    const cid = uid('correct');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    await processMessage({ sessionId: cid, text: 'branded hai' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'BRANDED');
    const r = await processMessage({ sessionId: cid, text: 'sorry, actually open hai' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'OPEN');
    assert.ok(r.text.toLowerCase().includes('open'));
});

// --- isolation -----------------------------------------------------------------------
test('modes and histories never leak across cases', async () => {
    const cid = uid('isol');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s1.jpg' });
    await processMessage({ sessionId: cid, text: 'branded hai' });
    await processMessage({ sessionId: cid, text: 'new' });
    const conv = getConversation(cid);
    assert.equal(conv.cases.length, 2);
    assert.equal(conv.cases[0].seedContext.purchaseMode, 'BRANDED');
    assert.equal(conv.cases[1].seedContext.purchaseMode, 'UNDECIDED');
    assert.notEqual(conv.cases[0].caseId, conv.cases[1].caseId);
    assert.ok(!conv.cases[1].history.some((h) => (h.content || '').toLowerCase().includes('branded')));
});

// --- new/same never corrupts the other domain -------------------------------------------
test('seed new/same never corrupts crop cases', async () => {
    const cid = uid('xdom');
    const crop = await processMessage({ sessionId: cid, imageUrl: '/crop.jpg' });
    assert.equal(crop.state.caseType, 'CROP_DIAGNOSIS');
    assert.equal(crop.state.seedContext, null);

    // Mode words on a crop case do not convert it.
    const still = await processMessage({ sessionId: cid, text: 'branded' });
    assert.equal(still.state.caseType, 'CROP_DIAGNOSIS');
    assert.equal(still.state.seedContext, null);

    // New seed photo opens a separate seed case; crop case keeps its slots.
    const seed = await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    assert.equal(seed.state.caseType, 'SEED_VERIFICATION');
    const conv = getConversation(cid);
    assert.equal(conv.cases[0].photos.length, 1);
    assert.equal(conv.cases[0].seedContext, null);
});

test('seed same-progression keeps purchase mode', async () => {
    const cid = uid('keepmode');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s1.jpg' });
    await processMessage({ sessionId: cid, text: 'open hai' });
    const kase = getConversation(cid).cases[0];
    kase.status = 'completed';
    await processMessage({ sessionId: cid, imageUrl: '/s2.jpg' });
    const same = await processMessage({ sessionId: cid, text: 'same' });
    assert.equal(same.state.seedContext.purchaseMode, 'OPEN');
    assert.equal(same.state.image_url, '/s2.jpg');
});

// --- DTO stays clean ----------------------------------------------------------------------
test('serializeConversation still exposes no seed internals', () => {
    const r = resolveTargetCase({
        conversationId: uid('dto'),
        imageUrl: '/s.jpg',
        domain: 'SEED_VERIFICATION',
    });
    const view = serializeConversation(r.conversation);
    assert.deepEqual(
        Object.keys(view.cases[0]).sort(),
        ['caseId', 'createdAt', 'hasCoordinates', 'label', 'photoCount', 'status', 'updatedAt']
    );
    assert.ok(!JSON.stringify(view).includes('purchaseMode'));
});
