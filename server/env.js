/**
 * env.js — validated numeric environment reader.
 *
 * `Number(process.env.X || default)` silently yields NaN on garbage like "abc",
 * and every comparison against NaN is false — so guards (rate limit, TTLs,
 * confidence thresholds) switch OFF instead of failing safe. All numeric env
 * reads go through envNum() so a typo degrades to the documented default.
 */

/**
 * Reads an env var as a finite number.
 * Missing / empty / non-numeric / infinite values fall back to `def` (with a
 * warning so misconfiguration is visible in logs). Explicit finite numbers —
 * including 0 and negatives — pass through unchanged (operator intent).
 */
export const envNum = (name, def) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        console.warn(`[env] ${name}="${raw}" is not a finite number — using default ${def}.`);
        return def;
    }
    return n;
};
