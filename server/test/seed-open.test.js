/**
 * Phase 4 — open seed contract (deterministic, offline).
 *
 * Proves, without any API keys or network (provider doubles injected):
 *   - known simulated seller: record found + explicit not-proof language
 *   - unknown seller: UNKNOWN, never adverse
 *   - conflicting scheme/government claim: CONTRADICTORY signal, no verdict
 *   - provider outage: UNKNOWN everywhere, never verified-or-safe
 *   - clean seller is not proof (even when everything is consistent)
 *   - missing slots: targeted ask, never guessed; simulated provenance labeled
 *
 *   node --test test/seed-open.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import { resolveTargetCase, getConversation } from '../services/session.service.js';
import { setPurchaseMode } from '../services/seed/seed-slot.service.js';
import { runOpenStep, parseCropVarietyClaim } from '../services/seed/open-seed.workflow.js';
import { getEvidence, clearEvidenceForTest } from '../services/seed/seed-evidence.service.js';
import {
    setProviderAvailability,
    resetProviderAvailability,
} from '../services/seed/providers.js';

const uid = (p = 't-seed4') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const openCase = (p = 'o4', { image = '/seed.jpg' } = {}) => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: image, domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'OPEN');
    return { cid, kase };
};

const NO_VERDICT = (t) => assert.ok(!/genuine|fake|asli|nakli|100% safe|blacklist/i.test(t), 'no verdict/enforcement words');

// --- claim parsing units ----------------------------------------------------------------
test('parseCropVarietyClaim: marked input, prose stays null', () => {
    assert.deepEqual(parseCropVarietyClaim('crop: paddy, variety: Swarna'), { crop: 'paddy', variety: 'Swarna' });
    assert.deepEqual(parseCropVarietyClaim('fasal wheat kism HD2967'), { crop: 'wheat', variety: 'HD2967' });
    assert.deepEqual(parseCropVarietyClaim('achha beej chahiye'), { crop: null, variety: null });
    assert.deepEqual(parseCropVarietyClaim(''), { crop: null, variety: null });
});

// --- known seller ----------------------------------------------------------------------------
test('known simulated seller: record found with not-proof language', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('known');
    const r = await runOpenStep({
        kase,
        text: 'seller: Ramesh Beej Bhandar, crop: paddy, variety: Swarna, price: 600',
    });
    assert.equal(r.ran, true);
    const ev = getEvidence(kase.caseId);
    const seller = ev.filter((e) => e.type === 'seller-record').at(-1);
    assert.equal(seller.value.signal, 'SUPPORTING');
    assert.equal(seller.sourceType, 'SIMULATED');
    assert.ok(seller.value.summary.includes('NOT proof'));
    assert.ok(r.replyText.includes('not proof of seed quality'));
    assert.ok(r.replyText.includes('NOT official'));
    const claim = ev.filter((e) => e.type === 'seller-claim').at(-1);
    assert.equal(claim.sourceType, 'USER_INPUT');
    assert.equal(claim.value.detail.seller, 'Ramesh Beej Bhandar');
    NO_VERDICT(r.replyText);
});

// --- unknown seller ------------------------------------------------------------------------------
test('unknown seller: UNKNOWN, never adverse', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('unknown');
    const r = await runOpenStep({ kase, text: 'seller: Mystery Shop X, crop: paddy, price: 600' });
    const ev = getEvidence(kase.caseId);
    const seller = ev.filter((e) => e.type === 'seller-record').at(-1);
    assert.equal(seller.value.signal, 'UNKNOWN');
    assert.ok(!/fraud|fake|blacklist|beware/i.test(r.replyText), 'no adverse labeling');
    NO_VERDICT(r.replyText);
});

// --- conflicting scheme/government claim --------------------------------------------------------------
test('conflicting government claim: CONTRADICTORY signal, conflict noted, no verdict', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('conflict');
    const r = await runOpenStep({
        kase,
        text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    const ev = getEvidence(kase.caseId);
    const scheme = ev.filter((e) => e.type === 'scheme-check').at(-1);
    assert.equal(scheme.value.signal, 'CONTRADICTORY');
    assert.ok(r.replyText.toLowerCase().includes('conflict'));
    assert.ok(!/blacklist|report him|punish/i.test(r.replyText), 'no enforcement language');
    NO_VERDICT(r.replyText);
});

// --- provider outage -----------------------------------------------------------------------------------------
test('provider outage: UNKNOWN everywhere, never verified-or-safe', async () => {
    clearEvidenceForTest();
    setProviderAvailability({ seller: false, price: false, scheme: false, seed: false });
    try {
        const { kase } = openCase('outage');
        const r = await runOpenStep({
            kase,
            text: 'seller: Ramesh Beej Bhandar, crop: paddy, variety: Swarna, price: 600, scheme: Sample Seed Subsidy Scheme',
        });
        const ev = getEvidence(kase.caseId);
        for (const t of ['seller-record', 'price-reference', 'seed-variety', 'scheme-check']) {
            const rec = ev.filter((e) => e.type === t).at(-1);
            assert.ok(rec, `${t} recorded`);
            assert.equal(rec.value.signal, 'UNKNOWN');
            assert.equal(rec.value.detail.reason, 'provider-unavailable');
        }
        assert.ok(r.replyText.includes('unavailable'));
        assert.ok(!/verified|safe|genuine/i.test(r.replyText));
    } finally {
        resetProviderAvailability();
    }
});

// --- clean seller is not proof ------------------------------------------------------------------------------------
test('clean seller is not proof: all-consistent still carries not-proof language', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('clean');
    const r = await runOpenStep({
        kase,
        text: 'seller: Ramesh Beej Bhandar, crop: paddy, variety: Swarna, price: 600',
    });
    const ev = getEvidence(kase.caseId);
    const signals = new Set(ev.map((e) => e.value.signal));
    assert.ok(!signals.has('CONTRADICTORY'));
    assert.ok(r.replyText.includes('not proof of seed quality'));
    assert.ok(!/genuine|certified authentic|100% safe/i.test(r.replyText));
});

// --- missing slots: ask, don't guess ---------------------------------------------------------------------------------
test('missing slots: targeted ask lists what is needed', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('missing');
    const r = await runOpenStep({ kase, text: 'open hai' });
    assert.equal(r.ran, true);
    assert.ok(r.replyText.includes('seller'));
    assert.ok(r.replyText.includes('price'));
    const ev = getEvidence(kase.caseId);
    assert.equal(ev.filter((e) => e.type === 'seller-record').at(-1).value.signal, 'UNKNOWN');
    assert.equal(ev.filter((e) => e.type === 'seed-variety').at(-1).value.signal, 'UNKNOWN');
});

// --- no image ----------------------------------------------------------------------------------------------------------------
test('open without photo asks for photo first', async () => {
    clearEvidenceForTest();
    const cid = uid('nophoto');
    const { case: kase } = resolveTargetCase({ conversationId: cid, text: 'open beej check karo' });
    assert.equal(kase.caseType, 'SEED_VERIFICATION');
    const r = await runOpenStep({ kase, text: 'seller: Ramesh Beej Bhandar' });
    assert.equal(r.ran, false);
    assert.ok(r.replyText.includes('फोटो'));
});

// --- dedupe -------------------------------------------------------------------------------------------------------------------------
test('repeat run with identical inputs appends no new evidence', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = openCase('dedupe');
    const args = { kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' };
    await runOpenStep(args);
    const n1 = getEvidence(kase.caseId).length;
    const ids1 = kase.seedContext.evidenceIds.length;
    await runOpenStep(args);
    assert.equal(getEvidence(kase.caseId).length, n1);
    assert.equal(kase.seedContext.evidenceIds.length, ids1);
});

// --- agent wiring (offline-safe: fake urls never hit network) ---------------------------------------------------------------------------
test('agent: OPEN turn delegates to open workflow end to end', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const cid = uid('agent-o');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    await processMessage({ sessionId: cid, text: 'open hai' });
    const r = await processMessage({ sessionId: cid, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' });
    const kase = getConversation(cid).cases[0];
    assert.equal(kase.seedContext.seedSubject.crop, 'paddy');
    assert.equal(kase.seedContext.sellerRef.name, 'Ramesh Beej Bhandar');
    assert.ok(r.text.includes('open seed'));
    assert.ok(r.text.includes('seller'));
    assert.ok(!r.text.toLowerCase().includes('location pin'));
    NO_VERDICT(r.text);
});
