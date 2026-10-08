/**
 * Phase 5 — evidence + risk contract (deterministic, offline).
 *
 * Proves, without any API keys or network:
 *   - supporting / warning / contradictory / unknown signals aggregate correctly
 *   - mixed evidence stays fully explainable (counts + per-evidence reasons)
 *   - no provider means UNKNOWN everywhere — and the snapshot takes NO level
 *   - snapshots are reproducible; identical re-runs reuse the snapshot
 *   - guidance names unknowns + next steps, never a verdict
 *   - agent turns attach assessment snapshots to the case
 *
 * Risk levels (LOW/MEDIUM/HIGH) are intentionally absent: no aggregation
 * policy is approved. Every snapshot records riskLevel PENDING_POLICY.
 *
 *   node --test test/seed-risk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import { resolveTargetCase, getConversation } from '../services/session.service.js';
import { setPurchaseMode } from '../services/seed/seed-slot.service.js';
import { runBrandedStep } from '../services/seed/branded-seed.workflow.js';
import { runOpenStep } from '../services/seed/open-seed.workflow.js';
import {
    buildAssessment,
    getLatestAssessment,
    clearAssessmentsForTest,
} from '../services/seed/assessment.service.js';
import { getEvidence, clearEvidenceForTest } from '../services/seed/seed-evidence.service.js';
import {
    setProviderAvailability,
    resetProviderAvailability,
} from '../services/seed/providers.js';

const uid = (p = 't-seed5') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const CLEAR_PACKET = {
    brand: 'Annapurna Seeds', crop: 'paddy', variety: 'Swarna', lot: 'AB123456',
    mrp: '650', mfgDate: '01/2026', expiryDate: '12/2027', labelText: 'Certified AX-11', barcodeText: null,
};

const brandedCase = (p = 'r5') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'BRANDED');
    return { cid, kase };
};

const openCase = (p = 'r5o') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'OPEN');
    return { cid, kase };
};

const resetAll = () => {
    clearEvidenceForTest();
    clearAssessmentsForTest();
    resetProviderAvailability();
};

// Hygiene shared with Phases 3/4: replies/sections carry no verdict language.
const NO_VERDICT = (t) => {
    assert.ok(!/genuine|fake|asli|nakli|100% safe|blacklist/i.test(t), 'no verdict words');
    assert.ok(!/verified|\bsafe\b/i.test(t), 'no verified/safe words');
};

// --- supporting ------------------------------------------------------------------
test('supporting signal: counts, reasons, guidance, MEDIUM via unknown-cap', async () => {
    resetAll();
    const { kase } = brandedCase('sup');
    const r = await runBrandedStep({
        kase, text: 'same packet. price: 640, seller: Ramesh Beej Bhandar',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
    });
    assert.ok(kase.seedContext.assessmentIds.length >= 1);
    const snap = getLatestAssessment(kase.caseId);
    assert.ok(snap);
    assert.ok(snap.signalCounts.SUPPORTING >= 3, `expected supporting pile-up, got ${JSON.stringify(snap.signalCounts)}`);
    assert.equal(snap.evidenceRefs.length, getEvidence(kase.caseId).length);
    for (const reason of snap.reasons) {
        assert.ok(reason.evidenceId && reason.type && reason.signal && reason.text);
    }
    assert.equal(snap.riskLevel, 'MEDIUM', 'barcode unknown caps supporting pile-up at MEDIUM');
    assert.equal(snap.policyVersion, 'risk-policy-v1-precedence');
    assert.ok(r.replyText.includes('Assessment'));
    NO_VERDICT(r.replyText);
});

// --- warning ---------------------------------------------------------------------
test('warning signal: low price + partial packet surface as warnings with next steps', async () => {
    resetAll();
    const { kase } = brandedCase('warn');
    const r = await runBrandedStep({
        kase, text: 'same packet. price: 300',
        deps: { visionCall: async () => ({ brand: 'Annapurna Seeds', crop: 'paddy', variety: 'Swarna' }) },
    });
    const snap = getLatestAssessment(kase.caseId);
    assert.ok(snap.signalCounts.WARNING >= 2, `expected warnings, got ${JSON.stringify(snap.signalCounts)}`);
    assert.ok(snap.farmerGuidance.nextSteps.length > 0);
    assert.ok(r.replyText.includes('warning'));
    assert.equal(snap.riskLevel, 'MEDIUM');
    NO_VERDICT(r.replyText);
});

// --- contradictory ----------------------------------------------------------------
test('contradictory signal: scheme conflict stays visible with reviewer note', async () => {
    resetAll();
    const { kase } = openCase('contra');
    const r = await runOpenStep({
        kase, text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    const snap = getLatestAssessment(kase.caseId);
    assert.equal(snap.signalCounts.CONTRADICTORY, 1);
    assert.ok(snap.farmerGuidance.conflictNote, 'conflict note present');
    assert.ok(snap.reasons.some((x) => x.signal === 'CONTRADICTORY'));
    assert.equal(snap.riskLevel, 'HIGH', 'contradiction dominates');
    assert.ok(r.replyText.includes('reviewer'));
    NO_VERDICT(r.replyText);
});

// --- unknown ----------------------------------------------------------------------
test('unknown signal: outage means all-unknown, MEDIUM cap (never LOW)', async () => {
    resetAll();
    setProviderAvailability({ brand: false, price: false, seller: false, scheme: false, seed: false });
    try {
        const { kase } = openCase('unk');
        const r = await runOpenStep({
            kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, variety: Swarna, price: 600',
        });
        const snap = getLatestAssessment(kase.caseId);
        assert.equal(snap.signalCounts.SUPPORTING, 0);
        assert.ok(snap.signalCounts.UNKNOWN >= 4);
        assert.equal(snap.riskLevel, 'MEDIUM', 'all-unknown caps at MEDIUM, never LOW');
        assert.equal(snap.policyVersion, 'risk-policy-v1-precedence');
        assert.ok(r.replyText.includes('Not checked does not mean fine'));
        assert.ok(r.replyText.includes('Risk level: MEDIUM'));
        NO_VERDICT(r.replyText);
    } finally {
        resetProviderAvailability();
    }
});

// --- mixed -------------------------------------------------------------------------
test('mixed evidence: every signal counted, every evidence explained', async () => {
    resetAll();
    const { kase } = brandedCase('mixed');
    await runBrandedStep({
        kase, text: 'same packet. price: 640',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
    });
    const snap = getLatestAssessment(kase.caseId);
    assert.ok(snap.signalCounts.SUPPORTING >= 1);
    assert.ok(snap.signalCounts.UNKNOWN >= 1, 'missing seller stays unknown');
    const types = new Set(snap.reasons.map((x) => x.type));
    for (const t of ['packet-extraction', 'brand-catalog', 'price-reference', 'seller-record']) {
        assert.ok(types.has(t), `reason covers ${t}`);
    }
    // Reconstructable: every reason points at stored evidence.
    for (const reason of snap.reasons) {
        assert.ok(getEvidence(kase.caseId).some((e) => e.evidenceId === reason.evidenceId));
    }
});

// --- reproducibility ------------------------------------------------------------------
test('reproducible: identical re-run reuses the snapshot, adds nothing', async () => {
    resetAll();
    const { kase } = openCase('repro');
    const args = { kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' };
    const r1 = await runOpenStep(args);
    const snap1 = getLatestAssessment(kase.caseId);
    const n1 = kase.seedContext.assessmentIds.length;
    const r2 = await runOpenStep(args);
    assert.equal(kase.seedContext.assessmentIds.length, n1, 'no duplicate snapshot');
    assert.equal(getLatestAssessment(kase.caseId).assessmentId, snap1.assessmentId, 'same snapshot reused');
    assert.ok(r2.replyText.includes(`unknown ${snap1.signalCounts.UNKNOWN}`));
});

// --- approved precedence policy (user decision, Phase-5 gate) --------------------
test('policy: contradiction dominates; warnings cap; LOW needs zero unknown', async () => {
    const { computeRiskLevel } = await import('../services/seed/risk.rules.js');
    assert.equal(computeRiskLevel({ SUPPORTING: 5, WARNING: 2, CONTRADICTORY: 1, UNKNOWN: 3 }), 'HIGH');
    assert.equal(computeRiskLevel({ SUPPORTING: 5, WARNING: 1, CONTRADICTORY: 0, UNKNOWN: 0 }), 'MEDIUM');
    assert.equal(computeRiskLevel({ SUPPORTING: 5, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 0 }), 'LOW');
    assert.equal(computeRiskLevel({ SUPPORTING: 5, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 1 }), 'MEDIUM');
    assert.equal(computeRiskLevel({ SUPPORTING: 0, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 4 }), 'MEDIUM');
});

// --- empty -----------------------------------------------------------------------------
test('no evidence means no assessment', () => {
    resetAll();
    const { case: kase } = resolveTargetCase({ conversationId: uid('empty'), imageUrl: '/x.jpg' });
    assert.equal(buildAssessment(kase.caseId), null);
    assert.equal(getLatestAssessment(kase.caseId), null);
});

// --- agent wiring -------------------------------------------------------------------------
test('agent turns attach assessment snapshots (branded + open)', async () => {
    resetAll();
    const cidB = uid('agent-rb');
    await processMessage({ sessionId: cidB, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    await processMessage({ sessionId: cidB, text: 'branded hai' });
    const rb = await processMessage({ sessionId: cidB, text: 'same packet' });
    const kb = getConversation(cidB).cases[0];
    assert.ok(kb.seedContext.assessmentIds.length >= 1);
    assert.ok(rb.text.includes('Assessment'));

    const cidO = uid('agent-ro');
    await processMessage({ sessionId: cidO, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    await processMessage({ sessionId: cidO, text: 'open hai' });
    const ro = await processMessage({ sessionId: cidO, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' });
    const ko = getConversation(cidO).cases[0];
    assert.ok(ko.seedContext.assessmentIds.length >= 1);
    assert.ok(ro.text.includes('Assessment'));
    NO_VERDICT(rb.text);
    NO_VERDICT(ro.text);
});
