/**
 * seed-slot.service.js — Phase 2: seed case metadata + purchase-mode state.
 *
 * Pure functions, no imports, no network, no LLM calls.
 * Owns the seed vocabulary so session.service.js (case storage) and
 * agent.service.js (orchestration) never hardcode keyword lists.
 *
 * Purchase modes: BRANDED (packaged) | OPEN (loose) | UNDECIDED.
 * Rule: UNDECIDED asks, never guesses. Explicit cues always win when present,
 * so a farmer can correct an earlier answer ("actually open hai").
 */

export const PURCHASE_MODES = {
    BRANDED: 'BRANDED',
    OPEN: 'OPEN',
    UNDECIDED: 'UNDECIDED',
};

export const AMBIGUOUS_MODE = 'AMBIGUOUS';

// Narrow, high-precision cues: explicit packaging words only. Price, seller,
// variety or lot words alone do NOT imply a mode (they occur in both).
const BRANDED_CUES = [
    'branded',
    'brand',
    'packet',
    'packat',
    'packaged',
    'packed',
    'sealed pack',
    'sealed',
    'company pack',
    'dabba pack',
    'पैकेट',
    'ब्रांड',
    'ब्रांडेड',
    'सीलबंद',
    'कंपनी का बीज',
];

const OPEN_CUES = [
    'open seed',
    'open beej',
    'open',
    'loose',
    'khula',
    'khule',
    'khula beej',
    'unpacked',
    'unpackaged',
    'bulk',
    'खुला',
    'खुले',
];

const containsAny = (haystack, cues) =>
    cues.some((cue) => {
        const c = String(cue || '').toLowerCase().trim();
        return c && haystack.includes(c);
    });

/**
 * Parses a purchase mode from free text.
 * @returns {'BRANDED'|'OPEN'|'AMBIGUOUS'|null} null = no signal (stay UNDECIDED)
 */
export const parsePurchaseMode = (text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    const hay = text.toLowerCase();
    const brandedHit = containsAny(hay, BRANDED_CUES);
    const openHit = containsAny(hay, OPEN_CUES);
    if (brandedHit && openHit) return AMBIGUOUS_MODE;
    if (brandedHit) return PURCHASE_MODES.BRANDED;
    if (openHit) return PURCHASE_MODES.OPEN;
    return null;
};

/** Empty slot shell for a seed case. Later phases fill these (never invent). */
export const emptySeedContext = () => ({
    purchaseMode: PURCHASE_MODES.UNDECIDED,
    seedSubject: null,
    packetData: null,
    sellerRef: null,
    brandRef: null,
    observedPrice: null,
    evidenceIds: [],
    assessmentIds: [],
    complaintIds: [],
    reviewId: null,
});

/**
 * Guarantees a well-formed seedContext on a seed case.
 * Migrates Phase-1 cases (which only had { purchaseMode }) in place.
 * Returns the context, or null for non-seed cases.
 */
export const ensureSeedContext = (kase) => {
    if (!kase || typeof kase.caseType !== 'string' || !kase.caseType.startsWith('SEED')) return null;
    const fresh = emptySeedContext();
    const cur = kase.seedContext && typeof kase.seedContext === 'object' ? kase.seedContext : {};
    kase.seedContext = { ...fresh, ...cur };
    if (!Object.values(PURCHASE_MODES).includes(kase.seedContext.purchaseMode)) {
        kase.seedContext.purchaseMode = PURCHASE_MODES.UNDECIDED;
    }
    for (const k of ['evidenceIds', 'assessmentIds', 'complaintIds']) {
        if (!Array.isArray(kase.seedContext[k])) kase.seedContext[k] = [];
    }
    return kase.seedContext;
};

/**
 * Stores a purchase mode. Ignores invalid values (never corrupts state).
 * @returns {boolean} true when the stored value changed
 */
export const setPurchaseMode = (kase, mode) => {
    const ctx = ensureSeedContext(kase);
    if (!ctx) return false;
    if (!Object.values(PURCHASE_MODES).includes(mode)) return false;
    if (ctx.purchaseMode === mode) return false;
    ctx.purchaseMode = mode;
    return true;
};
