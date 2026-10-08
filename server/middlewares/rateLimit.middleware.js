/**
 * Minimal dependency-free fixed-window rate limiter.
 * Protects the paid Gemini / Sarvam / Deepgram quotas from abuse.
 */
import { envNum } from '../env.js';

const hits = new Map();

const WINDOW_MS = 60 * 1000;

// Read per-request (not at module load) so the limit is tunable at runtime and
// testable without re-importing the module. Validated: garbage like "abc" falls
// back to 30 instead of NaN (which would disable the limiter entirely).
const maxRequests = () => envNum('RATE_LIMIT_PER_MINUTE', 30);

export const rateLimit = (req, res, next) => {
    try {
        const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const entry = hits.get(key);

    if (!entry || now - entry.start >= WINDOW_MS) {
        hits.set(key, { start: now, count: 1 });
        // Opportunistic sweep so the map cannot grow unbounded.
        if (hits.size > 5000) {
            for (const [k, v] of hits) {
                if (now - v.start >= WINDOW_MS) hits.delete(k);
            }
        }
        return next();
    }

    entry.count += 1;
    if (entry.count > maxRequests()) {
        res.status(429).json({
            error: `Too many requests. Limit is ${maxRequests()} per minute.`
        });
        return;
    }

    next();
    } catch (err) {
        console.error('[RateLimit] error:', err.message);
        next();
    }
};