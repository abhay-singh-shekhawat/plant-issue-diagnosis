/**
 * seed-evidence.service.js — Phase 3: evidence object + provenance store.
 *
 * One append-oriented record per signal (arch §9). Every record carries
 * provenance so an assessment can later be reconstructed from its evidence
 * (PRD R9). Module-level Map: restart loss is an explicit MVP limitation.
 */

let seq = 0;
const store = new Map(); // caseId -> Evidence[]

export const SOURCE_TYPES = {
    MODEL: 'MODEL',
    SIMULATED: 'SIMULATED',
    USER_INPUT: 'USER_INPUT',
    SYSTEM_RULE: 'SYSTEM_RULE',
};

export const VERIFICATION_LEVELS = {
    UNVERIFIED: 'UNVERIFIED',
    SIMULATED: 'SIMULATED',
    EXTERNALLY_VERIFIED: 'EXTERNALLY_VERIFIED',
};

export const SIGNALS = {
    SUPPORTING: 'SUPPORTING',
    WARNING: 'WARNING',
    CONTRADICTORY: 'CONTRADICTORY',
    UNKNOWN: 'UNKNOWN',
};

/**
 * Appends one evidence record. Never throws for normal inputs.
 * value = { signal, summary, detail? } — signal is an observed consistency
 * note, NOT an authenticity verdict (verdicts belong to Phase 5+).
 */
export const appendEvidence = (caseId, {
    type,
    value,
    sourceType,
    provider = null,
    providerVersion = null,
    confidence = null,
    verificationLevel = VERIFICATION_LEVELS.UNVERIFIED,
    derivedFrom = {},
} = {}) => {
    if (typeof caseId !== 'string' || !caseId.trim()) throw new Error('caseId is required');
    if (!type || !value || !Object.values(SOURCE_TYPES).includes(sourceType)) {
        throw new Error('type, value and a valid sourceType are required');
    }
    const record = {
        evidenceId: `ev-${Date.now()}-${(seq += 1)}`,
        caseId: caseId.trim(),
        type,
        value,
        sourceType,
        provider,
        providerVersion,
        confidence,
        verificationLevel,
        capturedAt: Date.now(),
        derivedFromMediaIds: Array.isArray(derivedFrom.mediaIds) ? derivedFrom.mediaIds : [],
        derivedFromMessageIds: Array.isArray(derivedFrom.messageIds) ? derivedFrom.messageIds : [],
    };
    if (!store.has(record.caseId)) store.set(record.caseId, []);
    store.get(record.caseId).push(record);
    return record;
};

/** All records for a case, oldest first. Returns a copy. */
export const getEvidence = (caseId) => [...(store.get(caseId) || [])];

/**
 * Appends unless the newest record of this type is already identical.
 * Returns { record, fresh }. Keeps repeat runs from duplicating evidence.
 */
export const appendIfChanged = (caseId, type, parts) => {
    const prev = getEvidence(caseId).filter((e) => e.type === type).at(-1);
    const same =
        prev &&
        JSON.stringify({ v: prev.value, s: prev.sourceType, p: prev.provider }) ===
            JSON.stringify({ v: parts.value, s: parts.sourceType, p: parts.provider || null });
    if (same) return { record: prev, fresh: false };
    return { record: appendEvidence(caseId, parts), fresh: true };
};

/** Tracks an evidence id on a seed context exactly once. */
export const trackEvidence = (seedContext, evidenceId) => {
    if (!seedContext || !Array.isArray(seedContext.evidenceIds)) return;
    if (!seedContext.evidenceIds.includes(evidenceId)) seedContext.evidenceIds.push(evidenceId);
};

/** Records of one type for a case. */
export const getEvidenceByType = (caseId, type) => getEvidence(caseId).filter((e) => e.type === type);

/** Test-only reset. */
export const clearEvidenceForTest = () => {
    store.clear();
    seq = 0;
};
