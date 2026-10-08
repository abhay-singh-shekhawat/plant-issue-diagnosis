/**
 * gemini-retry.js
 * ---------------
 * Thin wrapper that retries a Gemini API call with exponential backoff
 * whenever a 503 (overloaded) or 429 (rate-limited) response is received.
 *
 * Usage:
 *   import { geminiWithRetry } from './gemini-retry.js';
 *   const result = await geminiWithRetry(() => model.generateContent(parts));
 */

const RETRYABLE_CODES  = [429, 503];
const MAX_RETRIES      = 4;       // up to 4 retries (5 total attempts)
const BASE_DELAY_MS    = 1000;    // 1 s base → 1, 2, 4, 8 s
const MAX_DELAY_MS     = 15000;   // cap at 15 s

/**
 * Returns true when the error looks like a transient Gemini overload.
 */
const isRetryable = (err) => {
    if (!err) return false;
    const msg = (err.message || err.toString());
    // GoogleGenerativeAI errors embed the HTTP status in the message text
    return RETRYABLE_CODES.some(code => msg.includes(`[${code}]`) || msg.includes(`${code} `))
        || msg.toLowerCase().includes('high demand')
        || msg.toLowerCase().includes('rate limit')
        || msg.toLowerCase().includes('overloaded');
};

/**
 * @param {() => Promise<any>} fn   Zero-argument async factory that performs ONE Gemini call.
 * @param {number} [maxRetries]     Override default MAX_RETRIES if needed.
 * @returns {Promise<any>}
 */
export const geminiWithRetry = async (fn, maxRetries = MAX_RETRIES) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isRetryable(err) || attempt === maxRetries) throw err;

            const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
            const jitter = Math.floor(Math.random() * 500); // ±500 ms jitter
            const wait   = delay + jitter;
            console.warn(
                `[GeminiRetry] attempt ${attempt + 1}/${maxRetries + 1} failed (${(err.message || '').slice(0, 80)}). ` +
                `Retrying in ${wait} ms…`
            );
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }
    throw lastError;
};
