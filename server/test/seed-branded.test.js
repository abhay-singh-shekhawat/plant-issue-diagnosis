/**
 * Phase 3 — branded seed contract (deterministic, offline).
 *
 * Proves, without any API keys or network (vision/provider doubles injected):
 *   - clear packet: fields stored, catalog evidence SUPPORTING, provenance SIMULATED
 *   - unreadable packet: targeted resend ask, UNKNOWN evidence, no invented fields
 *   - partial extraction: only missing critical data re-asked, present fields used
 *   - provider outage: every affected signal UNKNOWN, never verified/safe
 *   - simulated data labeled simulated, never official; no verdict words
 *   - barcode: no decoder, always UNKNOWN, never a manufactured success
 *   - packet image required only when needed; seed photo reusable via confirm
 *   - repeat runs with identical inputs append nothing new
 *
 *   node --test test/seed-branded.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import { resolveTargetCase, getConversation } from '../services/session.service.js';
import { setPurchaseMode } from '../services/seed/seed-slot.service.js';
import { runBrandedStep, parseBrandedSlots } from '../services/seed/branded-seed.workflow.js';
import { normalizePacketExtraction } from '../services/seed/packet-extractor.service.js';
import { getEvidence, clearEvidenceForTest } from '../services/seed/seed-evidence.service.js';
import {
    setProviderAvailability,
    resetProviderAvailability,
} from '../services/seed/providers.js';

const uid = (p = 't-seed3') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const CLEAR_PACKET = {
    brand: 'Annapurna Seeds',
    crop: 'paddy',
    variety: 'Swarna',
    lot: 'AB123456',
    mrp: '650',
    mfgDate: '01/2026',
    expiryDate: '12/2027',
    labelText: 'Certified AX-11',
    barcodeText: null,
};

const brandedCase = (p = 'b3') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'BRANDED');
    return { cid, kase };
};

const NO_VERDICT = (t) => assert.ok(!/genuine|fake|asli|nakli|100% safe/i.test(t), 'no authenticity verdict words');

// --- extractor contract units -------------------------------------------------------
test('extractor: clear / partial / unreadable / garbage mapping', () => {
    assert.equal(normalizePacketExtraction({ ...CLEAR_PACKET }).status, 'clear');
    const partial = normalizePacketExtraction({ brand: 'Annapurna Seeds', crop: 'paddy' });
    assert.equal(partial.status, 'partial');
    assert.ok(partial.unknownFields.includes('lot'));
    assert.equal(normalizePacketExtraction({ brand: ' ', lot: '' }).status, 'unreadable');
    assert.equal(normalizePacketExtraction(null).status, 'unreadable');
    assert.equal(normalizePacketExtraction('nope').status, 'unreadable');
});

// --- slot parsing units ----------------------------------------------------------------
test('parseBrandedSlots: price / seller / scheme markers, prose stays null', () => {
    assert.deepEqual(parseBrandedSlots('price: 640'), { priceAmount: 640, sellerName: null, schemeClaim: null });
    assert.ok(parseBrandedSlots('bhav 450 hai').priceAmount === 450);
    assert.equal(parseBrandedSlots('seller: Ramesh Beej Bhandar').sellerName, 'Ramesh Beej Bhandar');
    assert.equal(parseBrandedSlots('scheme: Sample Seed Subsidy Scheme').schemeClaim, 'Sample Seed Subsidy Scheme');
    assert.deepEqual(parseBrandedSlots('ok aur batao'), { priceAmount: null, sellerName: null, schemeClaim: null });
});

// --- packet image requirement ------------------------------------------------------------
test('branded without packet image asks for it (mentions confirm option)', async () => {
    clearEvidenceForTest();
    const { kase } = brandedCase('need-pkt');
    const r = await runBrandedStep({ kase, text: 'branded hai' });
    assert.equal(r.ran, false);
    assert.ok(r.replyText.includes('same packet'));
    assert.ok(r.replyText.toLowerCase().includes('branded'));
    assert.equal(kase.seedContext.packetImageUrl, undefined);
});

test('confirm cue reuses the seed photo as the packet image', async () => {
    clearEvidenceForTest();
    const { kase } = brandedCase('confirm');
    const r = await runBrandedStep({
        kase,
        text: 'same packet',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
    });
    assert.equal(r.ran, true);
    assert.equal(kase.seedContext.packetImageUrl, '/seed.jpg');
    assert.equal(kase.seedContext.packetData.status, 'clear');
});

test('new photo after BRANDED becomes the packet image', async () => {
    clearEvidenceForTest();
    const { kase } = brandedCase('newpkt');
    const r = await runBrandedStep({
        kase,
        text: '',
        imageUrl: '/packet.jpg',
        photoChanged: true,
        modeBefore: 'BRANDED',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
    });
    assert.equal(kase.seedContext.packetImageUrl, '/packet.jpg');
    assert.equal(r.ran, true);
});

// --- clear packet ----------------------------------------------------------------------------
test('clear packet: fields stored, catalog SUPPORTING, provenance SIMULATED', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = brandedCase('clear');
    const r = await runBrandedStep({
        kase,
        text: 'same packet. price: 640, seller: Ramesh Beej Bhandar',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
    });
    assert.equal(kase.seedContext.packetData.status, 'clear');
    assert.equal(kase.seedContext.packetData.fields.brand, 'Annapurna Seeds');
    assert.equal(kase.seedContext.observedPrice.amount, 640);
    assert.equal(kase.seedContext.sellerRef.name, 'Ramesh Beej Bhandar');

    const ev = getEvidence(kase.caseId);
    const brand = ev.filter((e) => e.type === 'brand-catalog').at(-1);
    assert.equal(brand.value.signal, 'SUPPORTING');
    assert.equal(brand.sourceType, 'SIMULATED');
    assert.equal(brand.verificationLevel, 'SIMULATED');
    assert.ok(brand.provider.startsWith('simulated-'));

    const price = ev.filter((e) => e.type === 'price-reference').at(-1);
    assert.equal(price.value.signal, 'SUPPORTING');

    assert.ok(r.replyText.includes('NOT official'));
    assert.ok(!/government records confirm|sarkari record/i.test(r.replyText));
    NO_VERDICT(r.replyText);
});

// --- unreadable packet --------------------------------------------------------------------------
test('unreadable packet: targeted resend ask, UNKNOWN evidence, nothing invented', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = brandedCase('unread');
    const r = await runBrandedStep({
        kase,
        text: 'same packet',
        deps: { visionCall: async () => null },
    });
    assert.equal(kase.seedContext.packetData.status, 'unreadable');
    assert.equal(kase.seedContext.packetData.fields, null);
    assert.ok(r.replyText.toLowerCase().includes('resend'));
    const ev = getEvidence(kase.caseId);
    const ext = ev.filter((e) => e.type === 'packet-extraction').at(-1);
    assert.equal(ext.value.signal, 'UNKNOWN');
    const brand = ev.filter((e) => e.type === 'brand-catalog').at(-1);
    assert.equal(brand.value.signal, 'UNKNOWN');
    NO_VERDICT(r.replyText);
});

// --- partial extraction ----------------------------------------------------------------------------
test('partial extraction: present fields used, missing stay unknown', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = brandedCase('partial');
    const r = await runBrandedStep({
        kase,
        text: 'same packet',
        deps: { visionCall: async () => ({ brand: 'Annapurna Seeds', crop: 'paddy' }) },
    });
    assert.equal(kase.seedContext.packetData.status, 'partial');
    assert.deepEqual(kase.seedContext.packetData.unknownFields.filter((f) => ['lot', 'variety'].includes(f)), ['variety', 'lot']);
    const ev = getEvidence(kase.caseId);
    const ext = ev.filter((e) => e.type === 'packet-extraction').at(-1);
    assert.equal(ext.value.signal, 'WARNING');
    assert.equal(ev.filter((e) => e.type === 'brand-catalog').at(-1).value.signal, 'UNKNOWN');
    assert.ok(r.replyText.includes('unknown'));
    NO_VERDICT(r.replyText);
});

// --- provider outage ----------------------------------------------------------------------------------
test('provider outage: UNKNOWN everywhere, never verified-or-safe', async () => {
    clearEvidenceForTest();
    setProviderAvailability({ brand: false, price: false, seller: false, scheme: false });
    try {
        const { kase } = brandedCase('outage');
        const r = await runBrandedStep({
            kase,
            text: 'same packet. price: 640, seller: Ramesh Beej Bhandar, scheme: Sample Seed Subsidy Scheme',
            deps: { visionCall: async () => ({ ...CLEAR_PACKET }) },
        });
        const ev = getEvidence(kase.caseId);
        for (const t of ['brand-catalog', 'price-reference', 'seller-record', 'scheme-check']) {
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

// --- unknown brand is UNKNOWN, not contradiction ---------------------------------------------------------
test('unknown brand is UNKNOWN (absence proves nothing)', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = brandedCase('unkbrand');
    await runBrandedStep({
        kase,
        text: 'same packet',
        deps: { visionCall: async () => ({ ...CLEAR_PACKET, brand: 'Mystery Brand X', variety: 'Z99' }) },
    });
    const ev = getEvidence(kase.caseId);
    assert.equal(ev.filter((e) => e.type === 'brand-catalog').at(-1).value.signal, 'UNKNOWN');
});

// --- barcode: never a manufactured success ------------------------------------------------------------------
test('barcode: always UNKNOWN capability-unavailable, no decoder invoked', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    let decoderCalls = 0;
    const { kase } = brandedCase('barcode');
    await runBrandedStep({
        kase,
        text: 'same packet',
        deps: {
            visionCall: async () => ({ ...CLEAR_PACKET }),
            barcode: () => {
                decoderCalls += 1;
                return { available: false, reason: 'no-decoder-configured' };
            },
        },
    });
    const ev = getEvidence(kase.caseId);
    const rec = ev.filter((e) => e.type === 'barcode-qr').at(-1);
    assert.equal(rec.value.signal, 'UNKNOWN');
    assert.equal(rec.value.detail.reason, 'capability-unavailable');
    assert.equal(decoderCalls, 1, 'capability checked, nothing decoded');
});

// --- repeat runs append nothing new ------------------------------------------------------------------------------
test('repeat run with identical inputs appends no new evidence', async () => {
    clearEvidenceForTest();
    resetProviderAvailability();
    const { kase } = brandedCase('dedupe');
    const deps = { visionCall: async () => ({ ...CLEAR_PACKET }) };
    await runBrandedStep({ kase, text: 'same packet. price: 640', deps });
    const n1 = getEvidence(kase.caseId).length;
    const ids1 = kase.seedContext.evidenceIds.length;
    await runBrandedStep({ kase, text: 'same packet. price: 640', deps });
    assert.equal(getEvidence(kase.caseId).length, n1);
    assert.equal(kase.seedContext.evidenceIds.length, ids1);
});

// --- agent-level wiring (default deps, offline-safe: fake urls never hit network) -----------------------------------
test('agent: branded text-only turn asks for packet photo (no crash, no location ask)', async () => {
    clearEvidenceForTest();
    const cid = uid('agent-b');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    const r = await processMessage({ sessionId: cid, text: 'branded packet hai' });
    assert.equal(getConversation(cid).cases[0].seedContext.purchaseMode, 'BRANDED');
    assert.ok(r.text.includes('same packet'));
    assert.ok(!r.text.toLowerCase().includes('location pin'));
});
