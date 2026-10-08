/**
 * idempotency.service.js — duplicate-message guard (Phase 1).
 *
 * Bounded in-memory map: messageId -> cached reply summary.
 * MVP semantics: a repeated WhatsApp/Web delivery of the SAME messageId
 * returns the first accepted reply WITHOUT re-mutating case state.
 * Restart loss is an explicit MVP limitation (same as conversations).
 */

import { envNum } from '../env.js';

const MAX_ENTRIES = 1000;
const TTL_MS_DEFAULT = 30 * 60 * 1000; // 30 min

const cache = new Map(); // messageId -> { at, reply }

const resolveTtlMs = () => {
    const minutes = envNum('IDEMPOTENCY_TTL_MINUTES', 30);
    if (!(minutes > 0)) return TTL_MS_DEFAULT;
    return minutes * 60 * 1000;
};

const evictExpired = (now) => {
    const ttl = resolveTtlMs();
    for (const [k, v] of cache) {
        if (now - v.at > ttl) cache.delete(k);
    }
    // Hard bound: drop oldest inserts when over capacity.
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
};

/** Returns the cached reply for messageId, or null. */
export const getCachedReply = (messageId) => {
    if (typeof messageId !== 'string' || !messageId.trim()) return null;
    const entry = cache.get(messageId.trim());
    if (!entry) return null;
    if (Date.now() - entry.at > resolveTtlMs()) {
        cache.delete(messageId.trim());
        return null;
    }
    return entry.reply;
};

/** True when this messageId was already accepted. */
export const hasSeenMessage = (messageId) => getCachedReply(messageId) !== null;

/**
 * Records the accepted reply for messageId. Stores a small summary
 * (text + language + needsClarification), never full media or secrets.
 */
export const markMessageSeen = (messageId, reply) => {
    if (typeof messageId !== 'string' || !messageId.trim()) return;
    cache.set(messageId.trim(), {
        at: Date.now(),
        reply: {
            text: reply?.text ?? '',
            language: reply?.language ?? null,
            needsClarification: reply?.needsClarification ?? null,
        },
    });
    // Bound AFTER insert (Phase 8): evicting before left room for size+1.
    evictExpired(Date.now());
};

/** Test-only reset. */
export const clearIdempotencyForTest = () => cache.clear();

/** Current cache size (observability, tested). */
export const idempotencySize = () => cache.size;
