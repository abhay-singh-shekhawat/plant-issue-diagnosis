/**
 * branded-seed.workflow.js — Phase 3: branded/packaged seed collection step.
 *
 * Deterministic orchestration (no LLM here; the extractor owns the vision call):
 *   packet image? → extract+validate → typed/provider slots → normalize to
 *   evidence with provenance → farmer-facing summary.
 *
 * Honesty rules (never broken):
 * - Missing/unreadable stays UNKNOWN, never filled in.
 * - Simulated provider data is labeled internal-sample, never official.
 * - No authenticity verdict words (genuine/fake) anywhere in replies.
 * - No barcode verifier exists: barcode evidence is always UNKNOWN
 *   (capability-unavailable) — never a manufactured success.
 */

import { ensureSeedContext } from './seed-slot.service.js';
import { extractPacketData, getBarcodeCapability } from './packet-extractor.service.js';
import {
    getEvidence, appendIfChanged, trackEvidence,
    SOURCE_TYPES, VERIFICATION_LEVELS, SIGNALS,
} from './seed-evidence.service.js';
import { simulatedProviders, priceSignalForRatio, safeProviderCall } from './providers.js';
import { buildAssessment, getLatestAssessment, formatAssessmentSection } from './assessment.service.js';

export const PACKET_CONFIRM_CUES = [
    'same packet',
    'wahi packet',
    'packet hi hai',
    'yeh packet hai',
    'ye packet hai',
    'yes packet',
    'packet photo hai',
    'यही पैकेट',
    'पैकेट ही है',
];

const containsAny = (haystack, cues) =>
    cues.some((c) => haystack.includes(String(c).toLowerCase()));

/**
 * Narrow deterministic slot parsing for structured chat input
 * ("price: 450", "seller Ramesh Beej Bhandar", "scheme: ...").
 * Free prose without these markers yields nulls (never guessed).
 */
export const parseBrandedSlots = (text) => {
    const out = { priceAmount: null, sellerName: null, schemeClaim: null };
    if (typeof text !== 'string' || !text.trim()) return out;
    const t = text;

    const priceM =
        t.match(/(?:price|rate|mrp|dam|daam|bhav|bhaav|kimat|keemat|भाव|कीमत)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*(\d{2,6})/i)
        || t.match(/(?:₹|rs\.?)\s*(\d{2,6})/i);
    if (priceM) {
        const n = Number(priceM[1]);
        if (Number.isFinite(n) && n > 0) out.priceAmount = n;
    }

    const sellerM = t.match(
        /(?:seller|dukandar|dukaandar|shop|dealer|store|विक्रेता|दुकान)\s*(?:name)?\s*[:\-]?\s*([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F .&]{1,60})/i
    );
    if (sellerM) {
        // Cut trailing prose ("... is good", "... se liya") — keep the name only.
        const cut = sellerM[1].split(/\s+(is|hai|hain|se|from|mein|me)\s+/i)[0];
        const name = cut.replace(/[,.!?।\n]+$/g, '').trim().slice(0, 60);
        if (name.length >= 2) out.sellerName = name;
    }

    const schemeM = t.match(/(?:scheme|yojana|योजना|subsidy)\s*[:\-]?\s*([A-Za-z][A-Za-z ]{2,60})/i);
    if (schemeM) {
        const claim = schemeM[1].replace(/[,.!?।\n]+$/g, '').trim().slice(0, 60);
        if (claim.length >= 3) out.schemeClaim = claim;
    }
    return out;
};

const packetAskReply = () => [
    'ब्रांडेड बीज (branded seed) के लिए पैकेट की साफ फोटो भेजें। 📷',
    'अगर ऊपर वाली फोटो में ही पैकेट साफ दिख रहा है तो लिखें: *same packet*',
    'बीज जांच के लिए लोकेशन जरूरी नहीं है।',
    '',
    'For this branded seed, please send a clear photo of the packet. 📷',
    'If the photo above already shows the packet clearly, reply: *same packet*',
    'No location is needed.',
].join('\n');

const simNote = 'internal sample data — NOT official (आंतरिक नमूना जांच, सरकारी पुष्टि नहीं)';

/**
 * One branded collection step. Never throws for normal inputs.
 * @param {object} args.kase seed case (mutated: packet image/data, slots, evidenceIds)
 * @param {object} deps { visionCall?, providers?, barcode? } — tests inject doubles
 */
export const runBrandedStep = async ({
    kase,
    text = '',
    imageUrl = null,
    photoChanged = false,
    modeBefore = 'BRANDED',
    deps = {},
} = {}) => {
    const ctx = ensureSeedContext(kase);
    if (!ctx) return { replyText: packetAskReply(), ran: false };
    const providers = deps.providers || simulatedProviders;
    // Phase 8 hardening: every provider call degrades to `unavailable` on
    // throw (buggy double, future real provider) — the workflow never crashes.
    const shortName = (fnName) => fnName.replace(/(Lookup|Reference|Check)$/, '').toLowerCase();
    const call = (fnName, args) => safeProviderCall(shortName(fnName), () => providers[fnName](args));
    const barcodeCapability = deps.barcode || getBarcodeCapability;

    // 1. Packet image assignment (only when needed).
    if (!ctx.packetImageUrl) {
        const hay = (text || '').toLowerCase();
        if (containsAny(hay, PACKET_CONFIRM_CUES) && kase.photos.length > 0) {
            ctx.packetImageUrl = kase.photos[0].url;
        } else if (photoChanged && imageUrl && modeBefore === 'BRANDED') {
            ctx.packetImageUrl = imageUrl;
        }
    }
    if (!ctx.packetImageUrl) return { replyText: packetAskReply(), ran: false };

    // 2. Packet extraction (once per packet image).
    if (!ctx.packetData || ctx.packetData.fromImage !== ctx.packetImageUrl) {
        const res = await extractPacketData({ imageUrl: ctx.packetImageUrl, visionCall: deps.visionCall });
        ctx.packetData = { ...res, fromImage: ctx.packetImageUrl };
        const extractionSignal =
            res.status === 'clear' ? SIGNALS.SUPPORTING
            : res.status === 'partial' ? SIGNALS.WARNING
            : SIGNALS.UNKNOWN;
        const { record } = appendIfChanged(kase.caseId, 'packet-extraction', {
            type: 'packet-extraction',
            value: {
                signal: extractionSignal,
                summary: `packet ${res.status}`,
                detail: res.status === 'clear' || res.status === 'partial' ? { fields: res.fields } : { reason: res.reason },
            },
            sourceType: res.status === 'unavailable' ? SOURCE_TYPES.SYSTEM_RULE : SOURCE_TYPES.MODEL,
            verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
            derivedFrom: { mediaIds: [ctx.packetImageUrl] },
        });
        trackEvidence(ctx, record.evidenceId);

        // 3. Barcode capability: no decoder configured — always UNKNOWN.
        const cap = (typeof barcodeCapability === 'function' ? barcodeCapability : getBarcodeCapability)();
        if (!cap.available) {
            const { record: brec } = appendIfChanged(kase.caseId, 'barcode-qr', {
                type: 'barcode-qr',
                value: { signal: SIGNALS.UNKNOWN, summary: 'barcode/QR not decoded', detail: { reason: 'capability-unavailable' } },
                sourceType: SOURCE_TYPES.SYSTEM_RULE,
                verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
                derivedFrom: { mediaIds: [ctx.packetImageUrl] },
            });
            trackEvidence(ctx, brec.evidenceId);
        }
    }

    // 4. Typed slots from this message.
    const slots = parseBrandedSlots(text);
    if (slots.priceAmount !== null) ctx.observedPrice = { amount: slots.priceAmount, currency: 'INR' };
    if (slots.sellerName) ctx.sellerRef = { name: slots.sellerName };
    if (slots.schemeClaim) ctx.schemeClaim = slots.schemeClaim;
    const fields = ctx.packetData?.fields || {};
    const crop = fields.crop || null;

    // 5. Provider checks through interfaces (missing input => UNKNOWN, no call).
    if (fields.brand) {
        const r = await call('brandLookup', { brand: fields.brand, crop, variety: fields.variety });
        pushProviderEvidence(kase, ctx, 'brand-catalog', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'brand not in sample list', detail: { note: 'absence proves nothing' } };
            if (data.varietyMatch === true) return { signal: SIGNALS.SUPPORTING, summary: 'brand+variety match sample catalog', detail: { brand: fields.brand, variety: fields.variety } };
            if (data.varietyMatch === false) return { signal: SIGNALS.CONTRADICTORY, summary: 'variety not listed under brand in sample catalog', detail: { brand: fields.brand, variety: fields.variety } };
            return { signal: SIGNALS.UNKNOWN, summary: 'brand known, variety unchecked', detail: { brand: fields.brand } };
        });
    } else {
        pushMissingEvidence(kase, ctx, 'brand-catalog', 'brand not readable from packet');
    }

    if (fields.lot) {
        const pattern = await brandLotPattern(call, fields);
        if (pattern) {
            const match = new RegExp(pattern).test(fields.lot);
            pushLocalEvidence(kase, ctx, 'lot-format', match
                ? { signal: SIGNALS.SUPPORTING, summary: 'lot format consistent with sample pattern', detail: { lot: fields.lot } }
                : { signal: SIGNALS.WARNING, summary: 'lot format unexpected vs sample pattern', detail: { lot: fields.lot, note: 'format only, not proof' } });
        } else {
            pushMissingEvidence(kase, ctx, 'lot-format', 'no sample lot pattern for this brand/crop');
        }
    } else {
        pushMissingEvidence(kase, ctx, 'lot-format', 'lot not readable from packet');
    }

    if (ctx.observedPrice?.amount && crop) {
        const r = await call('priceReference', { crop, variety: fields.variety, brand: fields.brand });
        pushProviderEvidence(kase, ctx, 'price-reference', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'no sample price reference', detail: {} };
            const ratio = ctx.observedPrice.amount / data.refMrp;
            const signal = priceSignalForRatio(ratio);
            if (signal === SIGNALS.SUPPORTING) return { signal, summary: 'observed price consistent with sample reference', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp } };
            if (signal === SIGNALS.WARNING) return { signal, summary: 'observed price well below sample reference', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp, note: 'warning only, not proof' } };
            return { signal, summary: 'price comparison inconclusive', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp } };
        });
    } else {
        pushMissingEvidence(kase, ctx, 'price-reference', ctx.observedPrice?.amount ? 'crop unknown, cannot compare' : 'observed price not provided');
    }

    if (ctx.sellerRef?.name) {
        const r = await call('sellerLookup', { name: ctx.sellerRef.name });
        pushProviderEvidence(kase, ctx, 'seller-record', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'seller not in sample records', detail: { note: 'absence proves nothing' } };
            return { signal: SIGNALS.SUPPORTING, summary: 'seller found in sample records (not proof of seed quality)', detail: { name: ctx.sellerRef.name } };
        });
    } else {
        pushMissingEvidence(kase, ctx, 'seller-record', 'seller not provided');
    }

    if (ctx.schemeClaim) {
        const r = await call('schemeCheck', { claim: ctx.schemeClaim, crop });
        pushProviderEvidence(kase, ctx, 'scheme-check', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'scheme claim not in sample list', detail: {} };
            return data.consistent
                ? { signal: SIGNALS.SUPPORTING, summary: 'scheme claim consistent with sample list', detail: { scheme: data.scheme } }
                : { signal: SIGNALS.CONTRADICTORY, summary: 'scheme claim conflicts with sample list for this crop', detail: { scheme: data.scheme, note: 'signal only, needs human review' } };
        });
    }

    return { replyText: withAssessment(kase, ctx, buildBrandedSummary(kase, ctx)), ran: true };
};

/**
 * Attaches the current assessment snapshot (rebuilt only when the evidence
 * set changed — identical evidence reuses the snapshot) and appends the
 * farmer-facing section. Returns the full reply text.
 */
export const withAssessment = (kase, ctx, summaryText) => {
    const key = ctx.evidenceIds.join(',');
    let assessment = ctx.lastAssessmentKey === key ? getLatestAssessment(kase.caseId) : null;
    if (!assessment) {
        assessment = buildAssessment(kase.caseId);
        if (assessment) {
            ctx.lastAssessmentKey = key;
            if (!ctx.assessmentIds.includes(assessment.assessmentId)) {
                ctx.assessmentIds.push(assessment.assessmentId);
            }
        }
    }
    if (!assessment) return summaryText;
    return `${summaryText}\n${formatAssessmentSection(assessment)}`;
};

const brandLotPattern = async (call, fields) => {
    try {
        const r = await call('brandLookup', { brand: fields.brand, crop: fields.crop, variety: fields.variety });
        return r.status === 'ok' && r.data?.lotPattern ? r.data.lotPattern : null;
    } catch {
        return null;
    }
};

const pushProviderEvidence = (kase, ctx, type, result, toValue) => {
    let value;
    let sourceType = SOURCE_TYPES.SIMULATED;
    let verificationLevel = VERIFICATION_LEVELS.SIMULATED;
    if (result.status !== 'ok') {
        value = { signal: SIGNALS.UNKNOWN, summary: `${type} unavailable`, detail: { reason: 'provider-unavailable' } };
        sourceType = SOURCE_TYPES.SYSTEM_RULE;
        verificationLevel = VERIFICATION_LEVELS.UNVERIFIED;
    } else {
        value = toValue(result.data);
    }
    const { record } = appendIfChanged(kase.caseId, type, {
        type,
        value,
        sourceType,
        provider: result.provider || null,
        providerVersion: result.providerVersion || null,
        verificationLevel,
    });
    trackEvidence(ctx, record.evidenceId);
};

const pushMissingEvidence = (kase, ctx, type, reason) => {
    const { record } = appendIfChanged(kase.caseId, type, {
        type,
        value: { signal: SIGNALS.UNKNOWN, summary: `${type} unknown`, detail: { reason } },
        sourceType: SOURCE_TYPES.SYSTEM_RULE,
        verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
    });
    trackEvidence(ctx, record.evidenceId);
};

const pushLocalEvidence = (kase, ctx, type, value) => {
    const { record } = appendIfChanged(kase.caseId, type, {
        type,
        value,
        sourceType: SOURCE_TYPES.SYSTEM_RULE,
        verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
    });
    trackEvidence(ctx, record.evidenceId);
};

const fmtField = (v) => (v === null || v === undefined || v === '' ? 'unknown' : String(v));

/** Farmer-facing summary: observations + unknowns, never a verdict. */
const buildBrandedSummary = (kase, ctx) => {
    const f = ctx.packetData?.fields || {};
    const lines = [
        'ब्रांडेड बीज पैकेट जांच (branded seed check) — ' + simNote + ':',
        '',
    ];
    if (ctx.packetData?.status === 'clear' || ctx.packetData?.status === 'partial') {
        lines.push(`· Packet (${ctx.packetData.status}): brand ${fmtField(f.brand)}, crop ${fmtField(f.crop)}, variety ${fmtField(f.variety)}, lot ${fmtField(f.lot)}, MRP ${fmtField(f.mrp)}`);
    } else if (ctx.packetData?.status === 'unreadable') {
        lines.push('· Packet: unreadable — कृपया साफ फोटो दोबारा भेजें (please resend a clearer photo).');
    } else {
        lines.push('· Packet: automated reading unavailable — typed details (brand, lot, MRP) help. (स्वचालित पढ़ाई उपलब्ध नहीं)');
    }
    const byType = (t) => {
        const all = getEvidenceSnapshot(kase, t);
        return all.length ? all[all.length - 1].value.summary : 'unknown';
    };
    lines.push(`· Brand catalog: ${byType('brand-catalog')}`);
    lines.push(`· Lot format: ${byType('lot-format')}`);
    lines.push(`· Price: ${byType('price-reference')}`);
    lines.push(`· Seller: ${byType('seller-record')}`);
    if (ctx.schemeClaim) lines.push(`· Scheme: ${byType('scheme-check')}`);
    lines.push('· Barcode/QR: not decoded (no decoder configured) — unknown.');
    lines.push('');
    lines.push('आगे: missing जानकारी भेजें (brand/lot/MRP/price/seller) — हरी झंडी या रोक का फैसला यह जांच नहीं देती।');
    lines.push('Next: share any missing details. This check gives observations only — no pass/fail verdict.');
    return lines.join('\n');
};

const getEvidenceSnapshot = (kase, type) => getEvidence(kase.caseId).filter((e) => e.type === type);
