/**
 * language.js — the single canonical language definition for SC-Main.
 *
 * Supported set derived from evidence (not invented):
 *   - session STRINGS keys: en, hi
 *   - gathering-nudge locales: hi gu mr ta te kn ml pa bn en
 *   - agent langInstruction: hi gu mr ta te kn ml pa bn en
 *   - TTS languageMap keys: hi bn ta te mr kn ml gu pa en or od
 * Union → { en hi gu mr ta te kn ml pa bn or }. `od` is a TTS-side alias of
 * `or` (both map to od-IN) and is normalized to `or` here.
 *
 * Invariant: every persisted/active conversation language is either a
 * canonical supported code or the DEFAULT ('hi'). Raw caller input is NEVER
 * stored verbatim — it passes through normalizeLanguage() first.
 */

/** Canonical supported ISO-639-1 codes. */
export const SUPPORTED_LANGUAGES = ['en', 'hi', 'gu', 'mr', 'ta', 'te', 'kn', 'ml', 'pa', 'bn', 'or'];

/** Safe default: Hindi (Devanagari) — matches the agent's pre-existing fallback. */
export const DEFAULT_LANGUAGE = 'hi';

/** Legacy/alias spellings → canonical code. */
const ALIASES = {
    od: 'or',       // TTS-side alias (both map to od-IN voice)
    ori: 'or',      // ISO-639-2 for Odia
    pan: 'pa',      // ISO-639-2 for Punjabi
    ben: 'bn',      // ISO-639-2 for Bengali
    tam: 'ta',
    tel: 'te',
    mar: 'mr',
    guj: 'gu',
    kan: 'kn',
    mal: 'ml',
    hin: 'hi',
    eng: 'en'
};

/**
 * Normalizes arbitrary input to a canonical supported code.
 *   - non-strings, empty/blank, malformed → null (caller decides fallback)
 *   - case-insensitive; surrounding whitespace ignored
 *   - regional variants stripped (`hi-Latn` → `hi`, `en_US` → `en`)
 *   - aliases resolved (`od` → `or`)
 *   - unsupported codes → null (never silently relabeled to another language)
 *
 * Returns the canonical code, or null when the input carries no usable
 * language signal.
 */
export const normalizeLanguage = (value) => {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) return null;
    // Strip regional/script variants: hi-Latn, en_US, pt-BR → base.
    const base = cleaned.split(/[-_]/)[0];
    if (!/^[a-z]{2,3}$/.test(base)) return null; // malformed (digits, symbols, sentences)
    const canonical = ALIASES[base] || base;
    return SUPPORTED_LANGUAGES.includes(canonical) ? canonical : null;
};

/**
 * Boundary helper for inbound language values.
 *
 *   - valid input → canonical code (stored/used).
 *   - invalid input on an EXISTING session → keep `current` (never clobber a
 *     good language with garbage; never 400 an established conversation).
 *   - invalid input with no current → DEFAULT_LANGUAGE.
 *
 * Never throws, never returns a non-canonical value.
 */
export const coerceLanguage = (incoming, current = null) => {
    const normalized = normalizeLanguage(incoming);
    if (normalized) return normalized;
    const currentNorm = normalizeLanguage(current);
    return currentNorm || DEFAULT_LANGUAGE;
};
