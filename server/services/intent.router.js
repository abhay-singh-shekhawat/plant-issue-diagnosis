/**
 * intent.router.js — deterministic domain/intent classification (Phase 1).
 *
 * Pure functions, no imports, no network, no LLM calls.
 * Priority (first match wins):
 *   1. explicit `domain` param (channel-supplied, e.g. Web seed button)
 *   2. complaint cues  -> SEED_COMPLAINT
 *   3. seed cues       -> SEED_VERIFICATION
 *   4. crop cues       -> CROP_DIAGNOSIS
 *   5. both crop+seed  -> AMBIGUOUS (caller asks, never guesses)
 *   6. none            -> null (caller keeps its default)
 *
 * Keyword lists are deliberately narrow and documented here — they are a
 * routing heuristic, not an authenticity verdict. Tune only with approval.
 */

export const DOMAINS = {
    CROP: 'CROP_DIAGNOSIS',
    SEED: 'SEED_VERIFICATION',
    COMPLAINT: 'SEED_COMPLAINT',
};

export const AMBIGUOUS = 'AMBIGUOUS';

const VALID_EXPLICIT = new Set([DOMAINS.CROP, DOMAINS.SEED, DOMAINS.COMPLAINT]);

// Narrow, high-precision cues. Romanized + Devanagari + common English.
const SEED_CUES = [
    'seed', 'seeds', 'beej', 'bij', 'बीज', 'ਬੀਜ',
    'packet', 'packets', 'packaged', 'packat', 'पैकेट',
    'variety', 'veriety', 'किस्म',
    'lot', 'batch', 'lot no', 'batch no', 'लॉट', 'बैच',
    'mrp', 'expiry', 'mfg date', 'manufacturing date',
    'brand', 'company seed', 'duplicate seed', 'nakli beej', 'nakli seed', 'fake seed',
    'seller', 'dukandar', 'दुकानदार', 'shop', 'dealer', 'agency',
    'germination', 'ankuran', 'अंकुरण',
    'seed rate', 'seed price', 'beej ka rate', 'beej rate',
];

const COMPLAINT_CUES = [
    'complaint', 'shikayat', 'शिकायत', 'फरियाद',
    'fraud', 'dhokha', 'धोखा', 'dhokhadhadi',
    'report seller', 'report shop', 'report dealer',
    'fake seed sold', 'duplicate seed sold', 'nakli beej becha',
    'refund', 'paise wapas', 'paisa wapas',
];

const CROP_CUES = [
    'disease', 'desease', 'rog', 'रोग', 'bimari', 'बीमारी',
    'pest', 'keeda', 'कीड़ा', 'keede', 'insect',
    'leaf', 'leaves', 'पत्ती', 'पत्ता', 'पत्ते',
    'crop', 'fasal', 'फसल', 'plant', 'paudha', 'पौधा',
    'blight', 'wilt', 'rust', 'mildew', 'spot on leaf', 'yellow leaf', 'peela pad',
    'stem', 'root rot', 'flower drop', 'phool gir',
    'spray', 'fertilizer', 'khad', 'खाद', 'pesticide', 'dawai chhidkav',
];

const normalizeText = (t) => (typeof t === 'string' ? t.toLowerCase() : '');

const containsAny = (haystack, cues) => {
    if (!haystack) return false;
    return cues.some((cue) => {
        const c = String(cue || '').toLowerCase().trim();
        if (!c) return false;
        return haystack.includes(c);
    });
};

/**
 * Classifies an inbound message into a domain.
 * @param {{text?: string, domain?: string|null, seedHints?: string[]}} args
 * @returns {{ domain: string|null, reason: string }}
 */
export const detectDomain = ({ text = '', domain = null, seedHints = [] } = {}) => {
    // 1. Explicit channel-supplied domain wins (validated, never trusted blindly).
    // Accepts canonical codes plus short aliases ('seed'/'crop'/'complaint').
    if (typeof domain === 'string' && domain.trim()) {
        const d = domain.trim().toUpperCase();
        if (VALID_EXPLICIT.has(d)) return { domain: d, reason: 'explicit' };
        if (d === 'SEED') return { domain: DOMAINS.SEED, reason: 'explicit-alias' };
        if (d === 'CROP' || d === 'CROP_DIAGNOSIS') return { domain: DOMAINS.CROP, reason: 'explicit-alias' };
        if (d === 'COMPLAINT') return { domain: DOMAINS.COMPLAINT, reason: 'explicit-alias' };
    }

    const hay = normalizeText(text);
    const hintHay = normalizeText(Array.isArray(seedHints) ? seedHints.join(' ') : '');
    const combined = `${hay} ${hintHay}`.trim();

    if (!combined) return { domain: null, reason: 'no-signal' };

    const seedHit = containsAny(combined, SEED_CUES);
    const complaintHit = containsAny(combined, COMPLAINT_CUES);
    const cropHit = containsAny(combined, CROP_CUES);

    // 2. Complaint cues outrank generic seed cues (a complaint IS seed-domain).
    if (complaintHit) return { domain: DOMAINS.COMPLAINT, reason: 'complaint-cue' };
    if (seedHit && cropHit) return { domain: AMBIGUOUS, reason: 'crop-and-seed-cues' };
    if (seedHit) return { domain: DOMAINS.SEED, reason: 'seed-cue' };
    if (cropHit) return { domain: DOMAINS.CROP, reason: 'crop-cue' };
    return { domain: null, reason: 'no-signal' };
};

/** True when the detected domain belongs to the seed family. */
export const isSeedDomain = (d) => d === DOMAINS.SEED || d === DOMAINS.COMPLAINT;
