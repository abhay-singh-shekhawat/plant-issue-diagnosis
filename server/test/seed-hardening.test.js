/**
 * Phase 8 — hardening contract (deterministic, offline).
 *
 * Regression coverage for the failure classes that break chatbots in the
 * field. Every test runs without API keys or network (doubles injected,
 * env restored, no live calls):
 *   - duplicate message ids (incl. cross-session id reuse)
 *   - rapid concurrent messages on one chat (serialization)
 *   - provider failures: throwing doubles + partial outages
 *   - malformed vision input: throwing/garbage extractors, missing key,
 *     path traversal, missing files
 *   - media hygiene: seed turns write no files; idempotency store is bounded
 *   - risk boundaries: garbage counts, price-band edges, NaN/Infinity
 *   - case/domain leakage: evidence/assessments/reviews never cross cases;
 *     crop cases untouched by seed review machinery
 *   - crop guards alongside seed traffic
 *
 *   node --test test/seed-hardening.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processMessage } from '../services/agent.service.js';
import {
    resolveTargetCase,
    getConversation,
    serializeConversation,
} from '../services/session.service.js';
import { setPurchaseMode } from '../services/seed/seed-slot.service.js';
import { runBrandedStep } from '../services/seed/branded-seed.workflow.js';
import { runOpenStep } from '../services/seed/open-seed.workflow.js';
import { extractPacketData } from '../services/seed/packet-extractor.service.js';
import {
    buildAssessment,
    getLatestAssessment,
    clearAssessmentsForTest,
} from '../services/seed/assessment.service.js';
import { getEvidence, clearEvidenceForTest } from '../services/seed/seed-evidence.service.js';
import { computeRiskLevel, POLICY_VERSION } from '../services/seed/risk.rules.js';
import { priceSignalForRatio, setProviderAvailability, resetProviderAvailability } from '../services/seed/providers.js';
import {
    ensureReviewTaskForAssessment,
    listOpenReviews,
    listWatchlist,
    clearReviewsForTest,
} from '../services/seed/review.service.js';
import { clearComplaintsForTest } from '../services/seed/complaint.service.js';
import {
    markMessageSeen,
    getCachedReply,
    clearIdempotencyForTest,
    idempotencySize,
} from '../services/idempotency.service.js';

const uid = (p = 't-seed8') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..');

const resetAll = () => {
    clearEvidenceForTest();
    clearAssessmentsForTest();
    clearComplaintsForTest();
    clearReviewsForTest();
    clearIdempotencyForTest();
    resetProviderAvailability();
};

const CLEAR_PACKET = {
    brand: 'Annapurna Seeds', crop: 'paddy', variety: 'Swarna', lot: 'AB123456',
    mrp: '650', mfgDate: '01/2026', expiryDate: '12/2027', labelText: 'Certified AX-11', barcodeText: null,
};

const brandedCase = (p = 'h8b') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'BRANDED');
    return { cid, kase };
};

const openCase = (p = 'h8o') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'OPEN');
    return { cid, kase };
};

// --- duplicate message ids ------------------------------------------------------------
test('duplicate id across sessions: first reply wins globally, no cross-talk', async () => {
    resetAll();
    const mid = `x-sess-${Date.now()}`;
    const a = await processMessage({ sessionId: uid('dupA'), domain: 'SEED_VERIFICATION', imageUrl: '/a.jpg', messageId: mid });
    const b = await processMessage({ sessionId: uid('dupB'), domain: 'SEED_VERIFICATION', imageUrl: '/DIFFERENT.jpg', messageId: mid });
    assert.equal(b.text, a.text, 'same id replays the first accepted reply');
    assert.equal(b.deduped, true);
    assert.ok(!getConversation(b.conversation.conversationId).cases.some((c) => c.image_url === '/DIFFERENT.jpg'));
});

// --- rapid messages -------------------------------------------------------------------------
test('rapid messages: 5 concurrent seed photos serialize into one consistent case', async () => {
    resetAll();
    const sid = uid('rapid');
    const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => processMessage({ sessionId: sid, domain: 'SEED_VERIFICATION', imageUrl: `/r${i}.jpg` }))
    );
    const conv = getConversation(sid);
    assert.equal(conv.cases.length, 1, 'no case duplication under concurrency');
    assert.equal(conv.cases[0].photos.length, 5, 'every photo attached exactly once');
    assert.ok(results.every((r) => r.state.caseId === conv.cases[0].caseId));
});

// --- throwing providers --------------------------------------------------------------------------
test('throwing providers degrade to UNKNOWN (branded), reply still produced', async () => {
    resetAll();
    const boom = async () => { throw new Error('provider exploded'); };
    const { kase } = brandedCase('throw-b');
    const r = await runBrandedStep({
        kase, text: 'same packet. price: 640, seller: Ramesh Beej Bhandar',
        deps: {
            visionCall: async () => ({ ...CLEAR_PACKET }),
            providers: { brandLookup: boom, priceReference: boom, sellerLookup: boom, schemeCheck: boom, seedLookup: boom },
        },
    });
    assert.equal(r.ran, true);
    for (const t of ['brand-catalog', 'price-reference', 'seller-record']) {
        const rec = getEvidence(kase.caseId).filter((e) => e.type === t).at(-1);
        assert.equal(rec.value.signal, 'UNKNOWN');
        assert.equal(rec.value.detail.reason, 'provider-unavailable');
    }
    assert.ok(r.replyText.includes('unavailable'));
});

test('throwing providers degrade to UNKNOWN (open), reply still produced', async () => {
    resetAll();
    const boom = async () => { throw new Error('provider exploded'); };
    const { kase } = openCase('throw-o');
    const r = await runOpenStep({
        kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600',
        deps: { providers: { brandLookup: boom, priceReference: boom, sellerLookup: boom, schemeCheck: boom, seedLookup: boom } },
    });
    assert.equal(r.ran, true);
    assert.ok(getEvidence(kase.caseId).every((e) => e.value.signal === 'UNKNOWN'));
});

test('partial outage: only the down provider reads UNKNOWN', async () => {
    resetAll();
    setProviderAvailability({ price: false });
    try {
        const { kase } = brandedCase('partial-out');
        await runBrandedStep({
            kase, text: 'same packet. price: 640',
            deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
        });
        const ev = getEvidence(kase.caseId);
        assert.equal(ev.filter((e) => e.type === 'price-reference').at(-1).value.signal, 'UNKNOWN');
        assert.equal(ev.filter((e) => e.type === 'brand-catalog').at(-1).value.signal, 'SUPPORTING');
    } finally {
        resetProviderAvailability();
    }
});

// --- malformed vision input ---------------------------------------------------------------------------
test('throwing extractor becomes unreadable (never a crash, never invented)', async () => {
    resetAll();
    const r = await extractPacketData({ imageUrl: '/p.jpg', visionCall: async () => { throw new Error('gemini blew up'); } });
    assert.equal(r.status, 'unreadable');
    assert.equal(r.fields, null);
});

test('garbage extractor output becomes unreadable', async () => {
    resetAll();
    for (const garbage of [null, 42, 'not-json', [], { brand: {} }]) {
        const r = await extractPacketData({ imageUrl: '/p.jpg', visionCall: async () => garbage });
        assert.equal(r.status, 'unreadable', `garbage ${JSON.stringify(garbage)} must not parse`);
    }
});

test('missing key and missing/traversal files become unavailable (no network, no throw)', async () => {
    resetAll();
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        const r = await extractPacketData({ imageUrl: '/user_img_web/real.jpg' });
        assert.equal(r.status, 'unavailable');
        assert.equal(r.reason, 'vision-unavailable');
    } finally {
        if (saved === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = saved;
    }
    // Key present but file outside the server root / missing: still unavailable.
    const t1 = await extractPacketData({ imageUrl: '/../../../etc/passwd' });
    assert.equal(t1.status, 'unavailable');
    const t2 = await extractPacketData({ imageUrl: '/user_img_web/does-not-exist-12345.jpg' });
    assert.equal(t2.status, 'unavailable');
});

test('branded turn with an unreadable packet file still answers honestly', async () => {
    resetAll();
    const cid = uid('media-miss');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/user_img_web/does-not-exist-12345.jpg' });
    await processMessage({ sessionId: cid, text: 'branded hai' });
    const r = await processMessage({ sessionId: cid, text: 'same packet' });
    assert.ok(r.text.includes('unavailable') || r.text.includes('UNKNOWN') || r.text.includes('unknown'));
});

// --- cleanup / TTL ------------------------------------------------------------------------------------------
test('seed turns write no media files to disk', async () => {
    resetAll();
    const snap = () => ['user_img_web', 'user_img_whatsapp', 'user_audio_whatsapp'].map((d) => {
        const abs = path.join(SERVER_ROOT, d);
        try { return fs.readdirSync(abs).sort().join(','); } catch { return ''; }
    }).join('|');
    const before = snap();
    const cid = uid('no-files');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    await processMessage({ sessionId: cid, text: 'branded hai' });
    await processMessage({ sessionId: cid, text: 'same packet. price: 640' });
    assert.equal(snap(), before, 'all seed state stays in memory');
});

test('idempotency store is bounded; reset helpers clear every seed store', async () => {
    resetAll();
    for (let i = 0; i < 1010; i += 1) markMessageSeen(`flood-${i}`, { text: 'x' });
    assert.ok(idempotencySize() <= 1000, `bounded at ${idempotencySize()}`);
    assert.ok(getCachedReply('flood-0') === null || getCachedReply('flood-1009') !== null, 'oldest evicted first');
    resetAll();
    assert.equal(idempotencySize(), 0);
    const { kase } = openCase('cleared');
    assert.equal(getEvidence(kase.caseId).length, 0);
    assert.equal(buildAssessment(kase.caseId), null);
});

// --- risk boundaries -----------------------------------------------------------------------------------------------
test('risk boundaries: garbage counts never crash, always a valid level', () => {
    for (const bad of [undefined, null, {}, { SUPPORTING: 'x' }, { WARNING: -1 }, { CONTRADICTORY: NaN }]) {
        const level = computeRiskLevel(bad);
        assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(level), `valid level for ${JSON.stringify(bad)}`);
    }
    assert.equal(computeRiskLevel({ SUPPORTING: 0, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 0 }), 'MEDIUM');
    assert.equal(computeRiskLevel({ SUPPORTING: 1, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 0 }), 'LOW');
    assert.equal(computeRiskLevel({ SUPPORTING: 0, WARNING: 1, CONTRADICTORY: 0, UNKNOWN: 0 }), 'MEDIUM');
});

test('price-band edges: exact thresholds documented by behavior', () => {
    assert.equal(priceSignalForRatio(0.8), 'SUPPORTING');
    assert.equal(priceSignalForRatio(1.2), 'SUPPORTING');
    assert.equal(priceSignalForRatio(0.7999), 'UNKNOWN', 'just-inside gap is inconclusive, not supporting');
    assert.equal(priceSignalForRatio(1.2001), 'UNKNOWN');
    assert.equal(priceSignalForRatio(0.7), 'UNKNOWN', '0.7 boundary is inconclusive by design');
    assert.equal(priceSignalForRatio(0.6999), 'WARNING');
    for (const bad of [NaN, 0, -5, Infinity, 'x', null, undefined]) {
        assert.equal(priceSignalForRatio(bad), 'UNKNOWN');
    }
});

test('policy version stamps every snapshot', async () => {
    resetAll();
    const { kase } = openCase('polver');
    await runOpenStep({ kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' });
    assert.equal(getLatestAssessment(kase.caseId).policyVersion, POLICY_VERSION);
});

// --- leakage --------------------------------------------------------------------------------------------------------------
test('no cross-case leakage: assessments and evidence stay in their case', async () => {
    resetAll();
    const a = openCase('leak-a');
    const b = openCase('leak-b');
    await runOpenStep({ kase: a.kase, text: 'seller: Ramesh Beej Bhandar, crop: paddy, price: 600' });
    await runOpenStep({ kase: b.kase, text: 'crop: wheat' });
    const sa = getLatestAssessment(a.kase.caseId);
    const sb = getLatestAssessment(b.kase.caseId);
    assert.ok(sa.evidenceRefs.every((id) => !sb.evidenceRefs.includes(id)), 'evidence refs disjoint');
    assert.ok(sb.reasons.every((r) => !JSON.stringify(r).includes('Ramesh')));
    assert.ok(a.kase.seedContext.assessmentIds.every((id) => !b.kase.seedContext.assessmentIds.includes(id)));
});

test('seed review machinery never touches crop cases in the same chat', async () => {
    resetAll();
    const cid = uid('scope');
    const crop = await processMessage({ sessionId: cid, imageUrl: '/crop.jpg' });
    assert.equal(crop.state.caseType, 'CROP_DIAGNOSIS');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    await processMessage({ sessionId: cid, text: 'open hai' });
    await processMessage({
        sessionId: cid, text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    const conv = getConversation(cid);
    const cropCase = conv.cases.find((c) => c.caseType === 'CROP_DIAGNOSIS');
    const seedCase = conv.cases.find((c) => c.caseType === 'SEED_VERIFICATION');
    assert.equal(cropCase.seedContext, null);
    assert.equal(cropCase.reviewId, undefined);
    assert.ok(seedCase.seedContext.reviewId, 'review linked to the seed case only');
    assert.equal(listOpenReviews().length, 1);
    assert.equal(listOpenReviews()[0].caseId, seedCase.caseId);
    assert.equal(listWatchlist().length, 0, 'flag alone lists nothing');
});

test('client DTO stays clean after complaints, assessments and reviews exist', async () => {
    resetAll();
    const cid = uid('dto-clean');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    await processMessage({ sessionId: cid, text: 'open hai' });
    await processMessage({
        sessionId: cid, text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    const view = serializeConversation(getConversation(cid));
    assert.deepEqual(
        Object.keys(view.cases[0]).sort(),
        ['caseId', 'createdAt', 'hasCoordinates', 'label', 'photoCount', 'status', 'updatedAt']
    );
    const raw = JSON.stringify(view);
    for (const needle of ['purchaseMode', 'evidenceIds', 'assessmentIds', 'reviewId', 'complaintIds', 'rev-', 'asmt-', 'ev-']) {
        assert.ok(!raw.includes(needle), `${needle} must not leak to the client`);
    }
});

// --- crop guards ---------------------------------------------------------------------------------------------------------------
test('crop photo-only still gathers (seed traffic cannot change crop slots)', async () => {
    resetAll();
    const cid = uid('crop-guard');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/s.jpg' });
    await processMessage({ sessionId: cid, text: 'new' });
    // Explicit crop domain + photo opens a separate crop case (domain switch);
    // bare photos would correctly stay on the unfinished seed case.
    const crop = await processMessage({ sessionId: cid, domain: 'CROP_DIAGNOSIS', imageUrl: '/crop.jpg' });
    assert.equal(crop.state.caseType, 'CROP_DIAGNOSIS');
    assert.ok(crop.text.includes('लोकेशन') || crop.text.toLowerCase().includes('location'));
    assert.equal(crop.diagnosticResult, null);
});
