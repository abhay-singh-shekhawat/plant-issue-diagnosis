/**
 * open-seed.workflow.js — Phase 4: open/loose seed collection step.
 *
 * Deterministic orchestration (no LLM; visual seed observation arrives with
 * the Phase-5 evidence contracts — until then the seed photo is recorded as
 * farmer-provided evidence, never auto-judged):
 *   seed photo? → typed slots (seller/price/crop/variety/scheme) →
 *   simulated seller/price/scheme/seed checks through interfaces →
 *   evidence with provenance → farmer-facing summary.
 *
 * Honesty rules (never broken):
 * - A clean seller record is NOT proof of seed quality (stated in evidence
 *   AND in the reply whenever the seller is known).
 * - Unknown seller/price/scheme stays UNKNOWN, never adverse, never verified.
 * - Simulated data labeled internal-sample, never official. No verdict words.
 */

import { ensureSeedContext } from './seed-slot.service.js';
import { parseBrandedSlots } from './branded-seed.workflow.js';
import {
    appendIfChanged, trackEvidence, getEvidence,
    SOURCE_TYPES, VERIFICATION_LEVELS, SIGNALS,
} from './seed-evidence.service.js';
import { simulatedProviders, priceSignalForRatio, safeProviderCall } from './providers.js';
import { buildAssessment, getLatestAssessment, formatAssessmentSection } from './assessment.service.js';
import { withAssessment } from './branded-seed.workflow.js';

/**
 * Claimed crop/variety parsing for marked chat input
 * ("crop: paddy", "variety Swarna", "kism HD2967"). Free prose without these
 * markers yields nulls (never guessed).
 */
export const parseCropVarietyClaim = (text) => {
    const out = { crop: null, variety: null };
    if (typeof text !== 'string' || !text.trim()) return out;
    const cropM = text.match(/(?:crop|fasal|फसल)\s*[:\-]?\s*([A-Za-z]{3,30})/i);
    if (cropM) out.crop = cropM[1].trim().slice(0, 30);
    const varietyM = text.match(
        /(?:variety|veriety|kism|किस्म)\s*[:\-]?\s*([A-Za-z0-9]{2,20}(?:\s+[A-Za-z0-9]{1,20})?)/i
    );
    if (varietyM) {
        const v = varietyM[1].replace(/[,.!?।\n]+$/g, '').trim().slice(0, 40);
        if (v.length >= 2) out.variety = v;
    }
    return out;
};

const simNote = 'internal sample data — NOT official (आंतरिक नमूना जांच, सरकारी पुष्टि नहीं)';

const openPhotoAskReply = () => [
    'खुले बीज (open seed) के लिए बीज की एक साफ फोटो भेजें। 📷',
    'बीज जांच के लिए लोकेशन जरूरी नहीं है।',
    '',
    'For this open seed, please send a clear photo of the seed. 📷',
    'No location is needed.',
].join('\n');

/**
 * One open-seed collection step. Never throws for normal inputs.
 * @param {object} deps.providers — tests inject doubles/outages
 */
export const runOpenStep = async ({ kase, text = '', deps = {} } = {}) => {
    const ctx = ensureSeedContext(kase);
    if (!ctx) return { replyText: openPhotoAskReply(), ran: false };
    const providers = deps.providers || simulatedProviders;
    // Phase 8 hardening: every provider call degrades to `unavailable` on
    // throw — the workflow never crashes, evidence stays UNKNOWN.
    const shortName = (fnName) => fnName.replace(/(Lookup|Reference|Check)$/, '').toLowerCase();
    const call = (fnName, args) => safeProviderCall(shortName(fnName), () => providers[fnName](args));

    if (!kase.image_url) return { replyText: openPhotoAskReply(), ran: false };

    // 1. Seed photo on file: record farmer-provided evidence (once per photo).
    {
        const { record } = appendIfChanged(kase.caseId, 'seed-photo', {
            type: 'seed-photo',
            value: {
                signal: SIGNALS.UNKNOWN,
                summary: 'seed photo received, visual assessment pending',
                detail: { note: 'photo alone proves nothing about quality' },
            },
            sourceType: SOURCE_TYPES.USER_INPUT,
            verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
            derivedFrom: { mediaIds: [kase.image_url] },
        });
        trackEvidence(ctx, record.evidenceId);
    }

    // 2. Typed slots from this message.
    const branded = parseBrandedSlots(text);
    const claim = parseCropVarietyClaim(text);
    if (branded.priceAmount !== null) ctx.observedPrice = { amount: branded.priceAmount, currency: 'INR' };
    if (branded.sellerName) ctx.sellerRef = { name: branded.sellerName };
    if (branded.schemeClaim) ctx.schemeClaim = branded.schemeClaim;
    if (claim.crop || claim.variety) {
        ctx.seedSubject = {
            crop: claim.crop || ctx.seedSubject?.crop || null,
            variety: claim.variety || ctx.seedSubject?.variety || null,
        };
    }
    const crop = ctx.seedSubject?.crop || null;
    const variety = ctx.seedSubject?.variety || null;

    // 3. Farmer's own claim snapshot (provenance: what THEY said, verbatim scope).
    if (branded.sellerName || claim.crop || claim.variety || branded.schemeClaim) {
        const { record } = appendIfChanged(kase.caseId, 'seller-claim', {
            type: 'seller-claim',
            value: {
                signal: SIGNALS.UNKNOWN,
                summary: 'farmer-reported claim recorded',
                detail: {
                    seller: branded.sellerName || ctx.sellerRef?.name || null,
                    crop, variety,
                    scheme: branded.schemeClaim || ctx.schemeClaim || null,
                    price: ctx.observedPrice,
                },
            },
            sourceType: SOURCE_TYPES.USER_INPUT,
            verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
        });
        trackEvidence(ctx, record.evidenceId);
    }

    // 4. Simulated checks through interfaces.
    if (ctx.sellerRef?.name) {
        const r = await call('sellerLookup', { name: ctx.sellerRef.name });
        pushProviderEvidence(kase, ctx, 'seller-record', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'seller not in sample records', detail: { note: 'absence proves nothing' } };
            return {
                signal: SIGNALS.SUPPORTING,
                summary: 'seller found in sample records — NOT proof of seed quality',
                detail: { name: ctx.sellerRef.name, note: 'clean record is not proof' },
            };
        });
    } else {
        pushMissingEvidence(kase, ctx, 'seller-record', 'seller not provided');
    }

    if (crop || variety) {
        const r = await call('seedLookup', { crop, variety });
        pushProviderEvidence(kase, ctx, 'seed-variety', r, (data) => data.known
            ? { signal: SIGNALS.SUPPORTING, summary: 'claimed variety in sample catalog', detail: { crop, variety } }
            : { signal: SIGNALS.UNKNOWN, summary: 'claimed variety not in sample catalog', detail: { crop, variety, note: 'absence proves nothing' } });
    } else {
        pushMissingEvidence(kase, ctx, 'seed-variety', 'crop/variety not claimed yet');
    }

    if (ctx.observedPrice?.amount && crop) {
        const r = await call('priceReference', { crop, variety });
        pushProviderEvidence(kase, ctx, 'price-reference', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'no sample price reference', detail: {} };
            const ratio = ctx.observedPrice.amount / data.refMrp;
            const signal = priceSignalForRatio(ratio);
            if (signal === SIGNALS.SUPPORTING) return { signal, summary: 'offered price consistent with sample reference', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp } };
            if (signal === SIGNALS.WARNING) return { signal, summary: 'offered price well below sample reference', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp, note: 'warning only, not proof' } };
            return { signal, summary: 'price comparison inconclusive', detail: { observed: ctx.observedPrice.amount, refMrp: data.refMrp } };
        });
    } else {
        pushMissingEvidence(kase, ctx, 'price-reference', ctx.observedPrice?.amount ? 'crop unknown, cannot compare' : 'offered price not provided');
    }

    if (ctx.schemeClaim) {
        const r = await call('schemeCheck', { claim: ctx.schemeClaim, crop });
        pushProviderEvidence(kase, ctx, 'scheme-check', r, (data) => {
            if (!data.known) return { signal: SIGNALS.UNKNOWN, summary: 'scheme claim not in sample list', detail: {} };
            return data.consistent
                ? { signal: SIGNALS.SUPPORTING, summary: 'scheme claim consistent with sample list', detail: { scheme: data.scheme } }
                : { signal: SIGNALS.CONTRADICTORY, summary: 'scheme claim conflicts with sample list for this crop', detail: { scheme: data.scheme, note: 'conflict noted — keep bills/proof; no verdict here' } };
        });
    }

    return { replyText: withAssessment(kase, ctx, buildOpenSummary(kase, ctx)), ran: true };
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
        type, value, sourceType,
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

const buildOpenSummary = (kase, ctx) => {
    const byType = (t) => {
        const all = getEvidenceSnapshot(kase, t);
        return all.length ? all[all.length - 1].value.summary : 'unknown';
    };
    const claimed = ctx.seedSubject?.crop || ctx.seedSubject?.variety
        ? `${ctx.seedSubject.crop || 'unknown crop'} / ${ctx.seedSubject.variety || 'unknown variety'}`
        : 'not yet shared';
    const lines = [
        `खुला बीज जांच (open seed check, type: open seed) — ${simNote}:`,
        '',
        `· Seed photo: received. (फोटो मिल गई — फोटो अकेले गुणवत्ता साबित नहीं करती।)`,
        `· Claimed seed: ${claimed} (farmer-reported)`,
        `· Seller: ${byType('seller-record')}`,
        `· Price: ${byType('price-reference')}`,
        `· Variety catalog: ${byType('seed-variety')}`,
    ];
    if (ctx.schemeClaim) lines.push(`· Scheme: ${byType('scheme-check')}`);
    if (byType('seller-record').includes('NOT proof')) {
        lines.push('· साफ रिकॉर्ड बीज अच्छा होने का सबूत नहीं है — a clean seller record is not proof of seed quality.');
    }
    lines.push('');
    const missing = [];
    if (!ctx.sellerRef?.name) missing.push('seller/shop name (विक्रेता)');
    if (!ctx.seedSubject?.crop && !ctx.seedSubject?.variety) missing.push('crop/variety (फसल/किस्म)');
    if (!ctx.observedPrice?.amount) missing.push('price (भाव)');
    if (missing.length) {
        lines.push(`आगे यह भेजें: ${missing.join(', ')} — जैसे "seller: नाम, crop: paddy, price: 450"।`);
        lines.push(`Next, share: ${missing.join(', ')} — e.g. "seller: name, crop: paddy, price: 450".`);
    } else {
        lines.push('जानकारी पूरी होने पर अगला कदम बताया जाएगा। This check gives observations only — no pass/fail verdict.');
    }
    return lines.join('\n');
};

const getEvidenceSnapshot = (kase, type) => getEvidence(kase.caseId).filter((e) => e.type === type);
