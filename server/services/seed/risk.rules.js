/**
 * risk.rules.js — Phase 5: deterministic assessment rules (NO numeric weights).
 *
 * What this module *does* define (all derived from PRD R6–R10, never invented):
 * - the signal taxonomy every evidence record already carries,
 * - what each signal MEANS per evidence type (observation semantics),
 * - the non-negotiable aggregation invariants (unknown stays unknown, etc.).
 *
 * What it deliberately does NOT define:
 * - the LOW / MEDIUM / HIGH aggregation policy (thresholds/counts/precedence).
 *   That is unapproved policy. `buildAssessment()` therefore records
 *   `riskLevel: 'PENDING_POLICY'` until the user approves an explicit policy.
 *   See the Phase-5 report: BLOCKED — DECISION REQUIRED.
 */

export const ASSESSMENT_VERSION = 'assess-v1';

export const RISK_LEVELS = {
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    /** No aggregation policy configured yet — no level is assigned. */
    PENDING_POLICY: 'PENDING_POLICY',
};

/**
 * Approved aggregation policy (user decision, Phase-5 gate).
 * Precedence, no numbers:
 *   1. any CONTRADICTORY  → HIGH   (contradictions dominate, unknowns or not)
 *   2. else any WARNING   → MEDIUM
 *   3. else all SUPPORTING (zero unknown) → LOW
 *   4. else (unknowns present, or nothing supporting) → MEDIUM
 * Rule 4 is the unknown-cap: a level above MEDIUM is never assigned while
 * anything is unchecked, and LOW requires a fully-checked evidence set.
 */
export const POLICY_VERSION = 'risk-policy-v1-precedence';

export const computeRiskLevel = (signalCounts = {}) => {
    // Phase 8: null / non-object counts degrade to all-unknown (MEDIUM cap),
    // never throw — the policy function is on the reply path.
    const counts = signalCounts && typeof signalCounts === 'object' ? signalCounts : {};
    const c = Number(counts.CONTRADICTORY) || 0;
    const w = Number(counts.WARNING) || 0;
    const s = Number(counts.SUPPORTING) || 0;
    const u = Number(counts.UNKNOWN) || 0;
    if (c >= 1) return RISK_LEVELS.HIGH;
    if (w >= 1) return RISK_LEVELS.MEDIUM;
    if (s >= 1 && u === 0) return RISK_LEVELS.LOW;
    return RISK_LEVELS.MEDIUM;
};

/**
 * Aggregation invariants. These are product rules from the PRD/architecture,
 * not tunable weights:
 * 1. UNKNOWN evidence never supports a positive conclusion (R7).
 * 2. A contradictory signal is never averaged away by supporting ones (R9:
 *    the assessment must stay reconstructable — contradictions stay visible).
 * 3. Determinism: identical evidence sets always yield identical snapshots.
 */
export const AGGREGATION_INVARIANTS = [
    'unknown-never-supports-positive-conclusion',
    'contradictions-stay-visible',
    'identical-evidence-identical-snapshot',
];

/**
 * Observation semantics per evidence type: what a signal means HERE.
 * (Signals are consistency notes, never authenticity verdicts.)
 */
export const SIGNAL_MEANING = {
    'packet-extraction': {
        SUPPORTING: 'packet fields were readable',
        WARNING: 'packet only partially readable',
        CONTRADICTORY: 'not used for this type',
        UNKNOWN: 'packet unreadable or reading unavailable',
    },
    'brand-catalog': {
        SUPPORTING: 'brand (+variety, when given) matches the internal sample catalog',
        WARNING: 'not used for this type',
        CONTRADICTORY: 'claimed variety is not listed under this brand in the sample catalog',
        UNKNOWN: 'brand absent from the sample list, unchecked, or provider down',
    },
    'lot-format': {
        SUPPORTING: 'lot format consistent with the sample pattern',
        WARNING: 'lot format unexpected vs the sample pattern (format only)',
        CONTRADICTORY: 'not used for this type',
        UNKNOWN: 'no reference pattern or lot unreadable',
    },
    'price-reference': {
        SUPPORTING: 'observed price within the provisional band of the sample reference',
        WARNING: 'observed price well below the sample reference (warning only)',
        CONTRADICTORY: 'not used for this type',
        UNKNOWN: 'no reference, no observed price, or provider down',
    },
    'seller-record': {
        SUPPORTING: 'seller found in internal sample records — NOT proof of seed quality',
        WARNING: 'not used for this type',
        CONTRADICTORY: 'not used for this type (records are never adverse)',
        UNKNOWN: 'seller absent from sample records, not provided, or provider down',
    },
    'seed-variety': {
        SUPPORTING: 'claimed variety present in the sample catalog',
        WARNING: 'not used for this type',
        CONTRADICTORY: 'not used for this type',
        UNKNOWN: 'variety not claimed, absent from sample catalog, or provider down',
    },
    'scheme-check': {
        SUPPORTING: 'scheme claim consistent with the sample list',
        WARNING: 'not used for this type',
        CONTRADICTORY: 'scheme claim conflicts with the sample list for this crop',
        UNKNOWN: 'no scheme claimed, unknown scheme, or provider down',
    },
    'barcode-qr': {
        SUPPORTING: 'not used — no decoder is configured',
        WARNING: 'not used — no decoder is configured',
        CONTRADICTORY: 'not used — no decoder is configured',
        UNKNOWN: 'barcode/QR was not decoded',
    },
    'seed-photo': {
        SUPPORTING: 'not used — a photo alone proves nothing',
        WARNING: 'not used — a photo alone proves nothing',
        CONTRADICTORY: 'not used — a photo alone proves nothing',
        UNKNOWN: 'photo received, visual assessment pending',
    },
    'seller-claim': {
        SUPPORTING: 'not used — farmer statements are recorded, not scored',
        WARNING: 'not used — farmer statements are recorded, not scored',
        CONTRADICTORY: 'not used — farmer statements are recorded, not scored',
        UNKNOWN: 'farmer-reported claim on file',
    },
    'farmer-complaint': {
        SUPPORTING: 'not used — a complaint is a report on file, never confirmation',
        WARNING: 'not used — a complaint is a report on file, never confirmation',
        CONTRADICTORY: 'not used — a complaint is a report on file, never confirmation',
        UNKNOWN: 'post-purchase complaint recorded, awaiting human review',
    },
};
