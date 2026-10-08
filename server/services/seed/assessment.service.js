/**
 * assessment.service.js — Phase 5: deterministic assessment snapshots.
 *
 * Builds an explainable, reconstructable snapshot from a case's evidence
 * (PRD R9): signal counts, one reason per material evidence, unknown ledger,
 * farmer guidance derived by fixed rules, and a risk level from the approved
 * aggregation policy (`risk-policy-v1-precedence`, user-approved Phase-5 gate).
 */

import { getEvidence } from './seed-evidence.service.js';
import { ASSESSMENT_VERSION, POLICY_VERSION, computeRiskLevel } from './risk.rules.js';

let seq = 0;
const snapshots = new Map(); // assessmentId -> snapshot

const countSignals = (evidence) => {
    const counts = { SUPPORTING: 0, WARNING: 0, CONTRADICTORY: 0, UNKNOWN: 0 };
    for (const e of evidence) {
        if (counts[e.value?.signal] !== undefined) counts[e.value.signal] += 1;
    }
    return counts;
};

const keyFacts = (e) => {
    const d = e.value?.detail || {};
    const bits = [];
    if (d.brand) bits.push(`brand ${d.brand}`);
    if (d.variety) bits.push(`variety ${d.variety}`);
    if (d.crop) bits.push(`crop ${d.crop}`);
    if (d.name) bits.push(d.name);
    if (d.scheme) bits.push(d.scheme);
    if (Number.isFinite(d.observed) && Number.isFinite(d.refMrp)) bits.push(`₹${d.observed} vs ref ₹${d.refMrp}`);
    if (d.fields && typeof d.fields === 'object') {
        const f = d.fields;
        bits.push(`packet brand ${f.brand || '?'} | variety ${f.variety || '?'} | lot ${f.lot || '?'}`);
    }
    if (d.reason) bits.push(`reason: ${d.reason}`);
    if (d.note) bits.push(d.note);
    return bits.join('; ');
};

/** One explainable line per evidence record (audit trail, English). */
const reasonFor = (e) => ({
    evidenceId: e.evidenceId,
    type: e.type,
    signal: e.value.signal,
    text: `${e.type}: ${e.value.summary}${keyFacts(e) ? ` — ${keyFacts(e)}` : ''}`,
});

/**
 * Fixed-priority next steps derived from UNKNOWN evidence
 * (ordered, deterministic; not weights — just completeness prompts).
 * Each entry: { hi, en }.
 */
const stepForUnknown = (e) => {
    const reason = e.value?.detail?.reason || '';
    switch (e.type) {
        case 'packet-extraction':
            return { hi: 'पैकेट/बीज की साफ फोटो दोबारा भेजें।', en: 'Resend a clear photo of the packet/seed.' };
        case 'brand-catalog':
            return reason.includes('not readable')
                ? { hi: 'ब्रांड, लॉट और MRP लिखकर भेजें।', en: 'Send brand, lot and MRP as typed text.' }
                : { hi: 'ब्रांड जांच संदर्भ सूची में नहीं मिली — इसे अनचेक मानें।', en: 'Brand is not in the reference list — treat as unchecked.' };
        case 'lot-format':
            return { hi: 'लॉट/बैच नंबर साफ लिखकर भेजें।', en: 'Send the lot/batch number as typed text.' };
        case 'lot-format':
            return { hi: 'लॉट/बैच नंबर साफ लिखकर भेजें।', en: 'Send the lot/batch number as typed text.' };
        case 'price-reference':
            return reason.includes('not provided')
                ? { hi: 'चुकाया/बताया गया भाव भेजें।', en: 'Share the price you paid or were offered.' }
                : { hi: 'भाव की संदर्भ जांच उपलब्ध नहीं — अनचेक मानें।', en: 'Price reference check is unavailable — treat as unchecked.' };
        case 'seller-record':
            return reason.includes('not provided')
                ? { hi: 'विक्रेता/दुकान का नाम बताएं।', en: 'Share the seller/shop name.' }
                : { hi: 'विक्रेता संदर्भ सूची में नहीं है — अनचेक मानें।', en: 'Seller is not in the reference list — treat as unchecked.' };
        case 'seed-variety':
            return { hi: 'फसल और किस्म बताएं (जैसे "crop: paddy, variety: Swarna")।', en: 'Share crop and variety (e.g. "crop: paddy, variety: Swarna").' };
        case 'scheme-check':
            return { hi: 'योजना का सही नाम और फसल बताएं।', en: 'Share the exact scheme name and crop.' };
        case 'barcode-qr':
            return { hi: 'बारकोड जांच उपलब्ध नहीं — अनचेक मानें।', en: 'Barcode check is unavailable — treat as unchecked.' };
        case 'seed-photo':
            return null; // photo present; nothing to ask
        case 'seller-claim':
            return null; // claim on file; nothing to ask
        default:
            return reason.includes('provider-unavailable')
                ? { hi: 'संदर्भ जांच उपलब्ध नहीं — अनचेक मानें।', en: 'Reference check is unavailable — treat as unchecked.' }
                : null;
    }
};

/**
 * Builds (and stores) a snapshot for a case. Returns null when the case has
 * no evidence yet. Never throws for normal inputs. Deterministic: identical
 * evidence => identical snapshot content (ids/timestamps excluded).
 */
export const buildAssessment = (caseId) => {
    if (typeof caseId !== 'string' || !caseId.trim()) return null;
    const evidence = getEvidence(caseId.trim());
    if (evidence.length === 0) return null;
    const signalCounts = countSignals(evidence);
    const reasons = evidence.map(reasonFor);
    const unknowns = evidence
        .filter((e) => e.value.signal === 'UNKNOWN')
        .map((e) => ({ type: e.type, reason: e.value?.detail?.reason || e.value.summary }));

    const seen = new Set();
    const nextSteps = [];
    for (const e of evidence.filter((x) => x.value.signal === 'UNKNOWN')) {
        const step = stepForUnknown(e);
        if (!step) continue;
        const key = `${step.hi}|${step.en}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nextSteps.push(step);
    }

    const snapshot = {
        assessmentId: `asmt-${Date.now()}-${(seq += 1)}`,
        caseId: caseId.trim(),
        createdAt: Date.now(),
        assessmentVersion: ASSESSMENT_VERSION,
        evidenceRefs: evidence.map((e) => e.evidenceId),
        signalCounts,
        reasons,
        unknowns,
        farmerGuidance: {
            summary: {
                hi: `जांच सारांश: supporting ${signalCounts.SUPPORTING}, warning ${signalCounts.WARNING}, contradictory ${signalCounts.CONTRADICTORY}, unknown ${signalCounts.UNKNOWN}।`,
                en: `Check summary: ${signalCounts.SUPPORTING} supporting, ${signalCounts.WARNING} warning, ${signalCounts.CONTRADICTORY} contradictory, ${signalCounts.UNKNOWN} unknown.`,
            },
            unknownNote: {
                hi: 'जो जांचा नहीं गया, वह ठीक नहीं माना गया — unknown का मतलब अनचेक है।',
                en: 'Not checked does not mean fine — unknown means unchecked.',
            },
            conflictNote: signalCounts.CONTRADICTORY > 0
                ? {
                    hi: 'एक विरोध दर्ज है — रसीद/पैकेट संभालकर रखें; विरोध पर फैसला मानव समीक्षक करेगा।',
                    en: 'A conflict is on record — keep bills/packet as proof; a human reviewer decides conflicts.',
                }
                : null,
            nextSteps,
        },
        riskLevel: computeRiskLevel(signalCounts),
        policyVersion: POLICY_VERSION,
    };
    snapshots.set(snapshot.assessmentId, snapshot);
    return snapshot;
};

/** Latest snapshot for a case, or null. */
export const getLatestAssessment = (caseId) => {
    const all = [...snapshots.values()].filter((s) => s.caseId === caseId);
    return all.length ? all[all.length - 1] : null;
};

/** Snapshot by id, or null. */
export const getAssessment = (assessmentId) => snapshots.get(assessmentId) || null;

/** Test-only reset. */
export const clearAssessmentsForTest = () => {
    snapshots.clear();
    seq = 0;
};

/**
 * Farmer-facing assessment section appended to workflow replies.
 * Observations + unknowns + next steps + the policy-assigned level.
 * Word-hygiene: avoids genuine/fake/safe/verified/blacklist/pass so
 * Phase-3/4 honesty assertions keep holding.
 */
export const formatAssessmentSection = (snapshot) => {
    if (!snapshot) return '';
    const c = snapshot.signalCounts;
    const g = snapshot.farmerGuidance;
    const levelNote = {
        HIGH: {
            hi: 'उच्च ध्यान — एक विरोध दर्ज है; मानव समीक्षक फैसला करेगा।',
            en: 'Needs high attention — a conflict is on record; a human reviewer decides.',
        },
        MEDIUM: {
            hi: 'सावधानी — कुछ जांचें ध्यान मांगती हैं या अनचेक हैं।',
            en: 'Caution — some checks need attention or are unchecked.',
        },
        LOW: {
            hi: 'सभी जांची गई बातें सुसंगत — कोई अनचेक बात नहीं।',
            en: 'All checked items are consistent — nothing unchecked.',
        },
    }[snapshot.riskLevel] || null;
    const lines = [
        '---',
        'Assessment — observations + policy level (अवलोकन + नीति-स्तर):',
        `· supporting ${c.SUPPORTING} · warning ${c.WARNING} · contradictory ${c.CONTRADICTORY} · unknown ${c.UNKNOWN}`,
        `· Risk level: ${snapshot.riskLevel} (policy ${snapshot.policyVersion}).`,
    ];
    if (levelNote) lines.push(`· ${levelNote.en} (${levelNote.hi})`);
    lines.push(`· ${g.unknownNote.en} (${g.unknownNote.hi})`);
    if (snapshot.unknowns.length > 0) {
        const list = snapshot.unknowns.map((u) => `${u.type} (${u.reason})`).join('; ');
        lines.push(`· Unchecked items: ${list}`);
    }
    if (g.conflictNote) lines.push(`· ${g.conflictNote.en} (${g.conflictNote.hi})`);
    if (g.nextSteps.length > 0) {
        lines.push(`· Next: ${g.nextSteps.map((s) => s.en).join(' | ')}`);
        lines.push(`· आगे: ${g.nextSteps.map((s) => s.hi).join(' | ')}`);
    }
    return lines.join('\n');
};
