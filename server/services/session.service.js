/**
 * session.service.js — in-memory conversation and case store.
 *
 * Each browser session or WhatsApp number maps to one Conversation.
 * Inside a Conversation there can be multiple Cases (one per crop problem).
 *
 * Exports (all pure / side-effect-free except the store mutations):
 *   parseCommand          — recognise user commands (new/same/list/N)
 *   normalizeCoordinates  — validate + coerce a {lat,lon} pair (AUD-005)
 *   createCase            — make a fresh case object
 *   getConversation       — get-or-create by id (throws on blank id)
 *   getConversationCount  — current map size
 *   getActiveCase         — get the active case for a conversation
 *   resolveTargetCase     — main entry: route any incoming message to a case
 *   setCaseLabel          — update a case's human-readable label
 *   serializeConversation — safe DTO (no history, no coords values)
 *   sweepConversations    — evict idle conversations past TTL
 *   withConversationLock  — serialise concurrent calls for one session
 *   startSessionSweeper   — background interval (called by server.js)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { envNum } from '../env.js';
import { detectDomain, DOMAINS, AMBIGUOUS, isSeedDomain } from './intent.router.js';
import { emptySeedContext } from './seed/seed-slot.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** @type {Map<string, Conversation>} */
const store = new Map();

// Per-session mutex: prevents concurrent processMessage() calls from
// corrupting the same conversation (race in case creation / photo parking).
const locks = new Map();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Max km between two locations to be considered the "same field".
const SAME_FIELD_KM = 10;

// After this many days idle, a *completed* case auto-opens a new one.
const REOPEN_GAP_DAYS = 14;

// Max stored conversations before LRU eviction (memory safety).
const MAX_CONVERSATIONS = envNum('MAX_CONVERSATIONS', 5000);

// Max label length (truncated silently).
const MAX_LABEL_LENGTH = 120;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _caseSeq = 0;
const makeCaseId = () => `case-${Date.now()}-${++_caseSeq}`;

// ---------------------------------------------------------------------------
// normalizeCoordinates (AUD-005)
// ---------------------------------------------------------------------------

/**
 * Returns {lat, lon} with both values coerced to finite numbers within valid
 * geographic ranges, or null if anything is missing / out-of-range.
 *
 * @param {any} coords
 * @returns {{ lat: number, lon: number } | null}
 */
export const normalizeCoordinates = (coords) => {
    if (!coords || typeof coords !== 'object' || Array.isArray(coords)) return null;
    const lat = Number(coords.lat);
    const lon = Number(coords.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
};

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------

const haversineKm = (a, b) => {
    if (!a || !b) return Infinity;
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const sin2 = (x) => Math.sin(x / 2) ** 2;
    const h = sin2(dLat) + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sin2(dLon);
    return R * 2 * Math.asin(Math.sqrt(h));
};

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

// Multi-script synonym tables
const NEW_WORDS = new Set([
    'new', 'नया', 'naya', 'नई', 'नई', 'नए', 'புது', 'নতুন', 'नवीन',
    'nuevo', 'neue', 'nouveau', 'নতুন', 'ಹೊಸ', 'പുതിയ', 'नवो', 'नव',
]);
const SAME_WORDS = new Set([
    'same', 'वही', 'wahi', 'वहीं', 'same', 'அதே', 'একই', 'तेच', 'ओही',
    'mismo', 'gleich', 'même', 'ഒന്നേ', 'ಅದೇ', 'అదే',
]);
const LIST_WORDS = new Set(['list', 'सूची', 'सूचि', 'cases', 'केस']);

/**
 * Recognise single-intent commands. Returns null for normal prose.
 *
 * @param {string} text
 * @returns {{ intent: string, index?: number } | null}
 */
export const parseCommand = (text) => {
    if (typeof text !== 'string' || text.length > 100) return null;
    const t = text.trim().toLowerCase();
    if (!t) return null;

    // Case switch: bare digit or "case N"
    const numMatch = t.match(/^(?:case\s+)?(\d+)$/);
    if (numMatch) return { intent: 'switch', index: parseInt(numMatch[1], 10) };

    // Strip trailing punctuation for keyword matching
    const word = t.replace(/[!?।.]+$/, '').trim();
    if (NEW_WORDS.has(word)) return { intent: 'new' };
    if (SAME_WORDS.has(word)) return { intent: 'same' };
    if (LIST_WORDS.has(word)) return { intent: 'list' };

    return null;
};

// ---------------------------------------------------------------------------
// Case factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh case object.
 * Phase 2: seed cases carry the full `seedContext` slot shell (purchaseMode +
 * empty slots for Phases 3-6). Crop cases keep `seedContext: null`.
 * @param {Partial<{imageUrl: string, coordinates: {lat:number,lon:number}, caseType: string}>} opts
 * @returns {Case}
 */
export const createCase = ({ imageUrl = null, coordinates = null, caseType = null } = {}) => {
    const coords = normalizeCoordinates(coordinates);
    const now = Date.now();
    const type = caseType === DOMAINS.SEED || caseType === DOMAINS.COMPLAINT
        ? caseType
        : DOMAINS.CROP;
    return {
        caseId: makeCaseId(),
        caseType: type,
        label: 'Case',
        status: 'gathering_info',
        image_url: imageUrl || null,
        photos: imageUrl ? [{ url: imageUrl, uploadedAt: now }] : [],
        coordinates: coords,
        history: [],
        questionCount: 0,
        createdAt: now,
        updatedAt: now,
        followUpOf: null,
        seedContext: isSeedDomain(type) ? emptySeedContext() : null,
    };
};

/** True when the case belongs to the seed family. Pure helper for routers. */
export const isSeedCase = (kase) => !!kase && isSeedDomain(kase.caseType);

// ---------------------------------------------------------------------------
// Conversation factory
// ---------------------------------------------------------------------------

const createConversation = (conversationId) => ({
    conversationId,
    cases: [],
    activeCaseId: null,
    language: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
});

// ---------------------------------------------------------------------------
// Store accessors
// ---------------------------------------------------------------------------

/**
 * Get-or-create a conversation. Throws for blank / non-string ids.
 *
 * @param {string} id
 * @returns {Conversation}
 */
export const getConversation = (id) => {
    if (typeof id !== 'string') throw new Error('conversationId is required');
    const trimmed = id.trim();
    if (!trimmed) throw new Error('conversationId is required');

    if (store.has(trimmed)) return store.get(trimmed);

    // LRU eviction: if at capacity, drop the oldest entry.
    if (store.size >= MAX_CONVERSATIONS) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
        locks.delete(oldestKey);
    }

    const conv = createConversation(trimmed);
    store.set(trimmed, conv);
    return conv;
};

/** Returns number of active conversations. */
export const getConversationCount = () => store.size;

/**
 * Returns the active case for a conversation id, or null.
 *
 * @param {string} conversationId
 * @returns {Case|null}
 */
export const getActiveCase = (conversationId) => {
    if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
    const conv = store.get(conversationId.trim());
    if (!conv) return null;
    return conv.cases.find((c) => c.caseId === conv.activeCaseId) || null;
};

// ---------------------------------------------------------------------------
// setCaseLabel
// ---------------------------------------------------------------------------

/**
 * Update the human-readable label for a case.
 * Non-string values are silently ignored. Over-long labels are truncated.
 *
 * @param {Case} kase
 * @param {string} label
 */
export const setCaseLabel = (kase, label) => {
    if (!kase || typeof label !== 'string') return;
    const trimmed = label.trim();
    if (!trimmed) return;
    kase.label = trimmed.slice(0, MAX_LABEL_LENGTH);
    kase.updatedAt = Date.now();
};

// ---------------------------------------------------------------------------
// serializeConversation — safe client DTO (AUD-017)
// ---------------------------------------------------------------------------

/**
 * Returns a view safe to send to the frontend.
 * Strips history, coordinates values, diagnostic_data, internal state.
 *
 * @param {Conversation} conv
 * @returns {ConversationDTO}
 */
export const serializeConversation = (conv) => ({
    conversationId: conv.conversationId,
    activeCaseId: conv.activeCaseId,
    language: conv.language || null,
    cases: conv.cases.map((c) => ({
        caseId: c.caseId,
        label: c.label,
        status: c.status,
        photoCount: c.photos.length,
        hasCoordinates: !!c.coordinates,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
    })),
});

// ---------------------------------------------------------------------------
// resolveTargetCase — main routing function
// ---------------------------------------------------------------------------

/**
 * Routes an incoming event to the right case, creating / switching as needed.
 *
 * Params:
 *   conversationId  (required, non-blank)
 *   text            plain-text message
 *   imageUrl        URL of a newly-uploaded image
 *   coordinates     { lat, lon } — validated internally
 *   action          'switch' to force-switch to caseId
 *   caseId          target for action='switch'
 *
 * Returns a rich result object (never throws for normal inputs).
 * @returns {ResolveResult}
 */
export const resolveTargetCase = ({
    conversationId,
    text = '',
    imageUrl = null,
    coordinates = null,
    action = null,
    caseId: targetCaseId = null,
    domain = null,
    seedHints = [],
} = {}) => {
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
        throw new Error('conversationId is required');
    }

    const conv = getConversation(conversationId);
    conv.updatedAt = Date.now();

    const coords = normalizeCoordinates(coordinates);
    const textTrimmed = typeof text === 'string' ? text.trim() : '';

    // Phase 1 — domain detection (deterministic, never LLM). Explicit channel
    // domain wins; otherwise keyword cues; otherwise null (keep legacy default).
    const detected = detectDomain({ text: textTrimmed, domain, seedHints });
    const requestedType = detected.domain && detected.domain !== AMBIGUOUS ? detected.domain : null;

    // ── Helper: find a case by id ────────────────────────────────────────
    const findCase = (id) => conv.cases.find((c) => c.caseId === id) || null;
    const activeCase = () => findCase(conv.activeCaseId);
    const setActive = (c) => { conv.activeCaseId = c.caseId; };

    // ── Helper: build case list text ─────────────────────────────────────
    const caseListText = () => {
        if (conv.cases.length === 0) return 'No cases yet. Send a photo to start.';
        const lines = conv.cases.map((c, i) => {
            const mark = c.caseId === conv.activeCaseId ? ' ◀' : '';
            return `${i + 1}. ${c.label} [${c.status}]${mark}`;
        });
        return `Your cases:\n${lines.join('\n')}`;
    };

    // ── action='switch' ─────────────────────────────────────────────────
    if (action === 'switch') {
        // Delete a photo that arrived alongside an invalid switch (AUD-035)
        if (imageUrl) {
            const rel = imageUrl.startsWith('/user_img_web/') ? imageUrl.slice('/user_img_web/'.length) : null;
            if (rel) {
                const abs = path.join(__dirname, '../user_img_web', rel);
                try { fs.unlinkSync(abs); } catch { /* ignore */ }
            }
        }
        const target = targetCaseId ? findCase(targetCaseId) : null;
        if (target) {
            setActive(target);
            return {
                conversation: conv,
                case: target,
                command: 'switch',
                photoChanged: false,
                isProgression: false,
                needsClarification: null,
                directResponse: `Switched to Case ${conv.cases.indexOf(target) + 1}: ${target.label}`,
            };
        }
        // Unknown caseId → show list
        return {
            conversation: conv,
            case: activeCase(),
            command: null,
            photoChanged: false,
            isProgression: false,
            needsClarification: null,
            directResponse: caseListText(),
        };
    }

    // ── Parse command ───────────────────────────────────────────────────
    const command = textTrimmed ? parseCommand(textTrimmed) : null;

    // ── 'list' command ──────────────────────────────────────────────────
    if (command?.intent === 'list') {
        return {
            conversation: conv,
            case: activeCase(),
            command: 'list',
            photoChanged: false,
            isProgression: false,
            needsClarification: null,
            directResponse: caseListText(),
        };
    }

    // ── 'switch' by number ──────────────────────────────────────────────
    if (command?.intent === 'switch') {
        const idx = command.index - 1;
        // Only hijack digit if there is more than one case (AUD-004)
        if (conv.cases.length > 1 && idx >= 0 && idx < conv.cases.length) {
            const target = conv.cases[idx];
            setActive(target);
            return {
                conversation: conv,
                case: target,
                command: 'switch',
                photoChanged: false,
                isProgression: false,
                needsClarification: null,
                directResponse: `Switched to Case ${idx + 1}: ${target.label}`,
            };
        }
        if (conv.cases.length > 1 && (idx < 0 || idx >= conv.cases.length)) {
            return {
                conversation: conv,
                case: activeCase(),
                command: null,
                photoChanged: false,
                isProgression: false,
                needsClarification: null,
                directResponse: caseListText(),
            };
        }
        // Single case → treat as prose
    }

    // ── No active case yet → create case #1 ───────────────────────────
    // Phase 1: explicit/seed-cue messages open a seed case; everything else
    // keeps the legacy crop default (bare photos stay crop — regression-safe).
    // Crop+seed mixed cues on a brand-new conversation ask instead of guessing.
    if (conv.cases.length === 0) {
        if (detected.domain === AMBIGUOUS) {
            const c = createCase({ imageUrl, coordinates: coords });
            conv.cases.push(c);
            setActive(c);
            // Do not attach diagnostic meaning yet — ask the domain question.
            // The photo (if any) stays parked on the case; the next explicit
            // seed/crop message re-routes without losing it.
            const question = 'Is this about a crop problem or about seed verification?\nReply: *crop* or *seed*\n\nक्या यह फसल की बीमारी के बारे में है या बीज की जांच के बारे में?\nजवाब दें: *crop* या *seed*';
            return {
                conversation: conv,
                case: c,
                command: null,
                photoChanged: false,
                isProgression: false,
                needsClarification: { type: 'domain' },
                directResponse: question,
            };
        }
        const c = createCase({ imageUrl, coordinates: coords, caseType: requestedType });
        conv.cases.push(c);
        setActive(c);

        // 'new' before any case → just created one
        if (command?.intent === 'new') {
            return {
                conversation: conv,
                case: c,
                command: null,
                photoChanged: false,
                isProgression: false,
                needsClarification: null,
                directResponse: null,
            };
        }

        return {
            conversation: conv,
            case: c,
            command: null,
            photoChanged: !!imageUrl,
            isProgression: false,
            needsClarification: null,
            directResponse: null,
        };
    }

    const current = activeCase() || conv.cases[conv.cases.length - 1];
    setActive(current);

    // ── Resolve pending clarification (same / new answer) ─────────────
    if (current.status === 'pendingClarification' && command) {
        const parked = conv._pendingPhoto;

        if (command.intent === 'same') {
            // Attach parked photo to current case (progression)
            if (parked) {
                current.image_url = parked.url;
                current.photos.push({ url: parked.url, uploadedAt: parked.at });
                if (parked.coords) current.coordinates = parked.coords;
                conv._pendingPhoto = null;
            }
            current.status = 'evaluating_confidence';
            current.updatedAt = Date.now();
            return {
                conversation: conv,
                case: current,
                command: 'same',
                photoChanged: !!parked,
                isProgression: true,
                needsClarification: null,
                directResponse: null,
            };
        }

        if (command.intent === 'new') {
            // Open a new case, attach parked photo to it.
            // Phase 1: the new case inherits the clarified case's domain
            // unless this message explicitly requests another domain.
            const nc = createCase({
                imageUrl: parked?.url || null,
                coordinates: parked?.coords || null,
                caseType: requestedType || current.caseType,
            });
            nc.followUpOf = current.caseId;
            conv.cases.push(nc);
            setActive(nc);
            conv._pendingPhoto = null;
            return {
                conversation: conv,
                case: nc,
                command: 'new',
                photoChanged: !!parked,
                isProgression: false,
                needsClarification: null,
                directResponse: null,
            };
        }
    }

    // ── 'new' command explicitly requests a fresh case ─────────────────
    // Phase 1: explicit seed/crop signal in the same message sets the new
    // case domain; a bare 'new' inherits the active case domain (seed stays
    // seed, crop stays crop) instead of always resetting to crop.
    if (command?.intent === 'new') {
        const nc = createCase({ imageUrl, coordinates: coords, caseType: requestedType || current?.caseType });
        conv.cases.push(nc);
        setActive(nc);
        return {
            conversation: conv,
            case: nc,
            command: 'new',
            photoChanged: !!imageUrl,
            isProgression: false,
            needsClarification: null,
            directResponse: null,
        };
    }

    // ── Phase 1: explicit domain switch with a photo ───────────────────
    // A seed photo arriving on an active crop case (or vice versa) must not
    // corrupt the active case — open a new case of the requested domain.
    // Text-only domain switches stay on the active case (clarified next turn).
    if (imageUrl && requestedType && requestedType !== current.caseType) {
        const nc = createCase({ imageUrl, coordinates: coords, caseType: requestedType });
        conv.cases.push(nc);
        setActive(nc);
        return {
            conversation: conv,
            case: nc,
            command: null,
            photoChanged: true,
            isProgression: false,
            needsClarification: null,
            directResponse: null,
        };
    }

    // ── Incoming photo while current case is not completed ─────────────
    if (imageUrl && current.status !== 'completed') {
        const changed = current.image_url !== imageUrl;
        current.image_url = imageUrl;
        current.photos.push({ url: imageUrl, uploadedAt: Date.now() });
        if (coords) current.coordinates = coords;
        current.updatedAt = Date.now();
        return {
            conversation: conv,
            case: current,
            command: null,
            photoChanged: changed,
            isProgression: false,
            needsClarification: null,
            directResponse: null,
        };
    }

    // ── Incoming photo while current case IS completed ─────────────────
    // Phase 1: seed cases NEVER use the crop 5km/14-day geo heuristic — a new
    // seed photo always asks 'same seed or new seed?' unless the farmer said
    // 'new' explicitly (handled above). Crop behavior below is untouched.
    if (imageUrl && current.status === 'completed' && isSeedCase(current)) {
        conv._pendingPhoto = { url: imageUrl, at: Date.now(), coords };
        current.status = 'pendingClarification';
        current.updatedAt = Date.now();

        const question = 'Is this the same seed getting checked again, or a new seed?\nReply: *same* or *new*\n\nक्या यह वही बीज है या नया बीज है?\nजवाब दें: *same* या *new*';
        return {
            conversation: conv,
            case: current,
            command: null,
            photoChanged: false,
            isProgression: false,
            needsClarification: { type: 'new_vs_same' },
            directResponse: question,
        };
    }

    if (imageUrl && current.status === 'completed') {
        const lastCoords = current.coordinates;
        const dist = (coords && lastCoords) ? haversineKm(coords, lastCoords) : 0;
        const gapMs = Date.now() - current.updatedAt;
        const gapDays = gapMs / (1000 * 60 * 60 * 24);

        // Auto-new: far field or long gap
        if (dist > SAME_FIELD_KM || gapDays > REOPEN_GAP_DAYS) {
            const nc = createCase({ imageUrl, coordinates: coords });
            nc.followUpOf = current.caseId;
            conv.cases.push(nc);
            setActive(nc);
            return {
                conversation: conv,
                case: nc,
                command: null,
                photoChanged: true,
                isProgression: false,
                needsClarification: null,
                directResponse: null,
            };
        }

        // Close enough in space/time → ask same or new
        conv._pendingPhoto = { url: imageUrl, at: Date.now(), coords };
        current.status = 'pendingClarification';
        current.updatedAt = Date.now();

        const question = 'Is this the same problem getting worse, or a new one?\nReply: *same* or *new*\n\nक्या यह वही समस्या है जो बढ़ रही है, या नई है?\nजवाब दें: *same* या *new*';
        return {
            conversation: conv,
            case: current,
            command: null,
            photoChanged: false,
            isProgression: false,
            needsClarification: { type: 'new_vs_same' },
            directResponse: question,
        };
    }

    // ── Plain text / coordinates update ───────────────────────────────
    if (coords && !current.coordinates) {
        current.coordinates = coords;
        current.updatedAt = Date.now();
    }

    return {
        conversation: conv,
        case: current,
        command: null,
        photoChanged: false,
        isProgression: false,
        needsClarification: null,
        directResponse: null,
    };
};

// ---------------------------------------------------------------------------
// sweepConversations — evict idle conversations
// ---------------------------------------------------------------------------

/**
 * Removes conversations idle past the configured TTL.
 * TTL=0 disables time-based eviction (LRU cap still applies on insert).
 *
 * @returns {number} count of evicted conversations
 */
export const sweepConversations = () => {
    const ttlHours = envNum('CONVERSATION_TTL_HOURS', 48);
    if (ttlHours === 0) return 0;

    const ttlMs = ttlHours * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;

    for (const [id, conv] of store.entries()) {
        if (conv.updatedAt < cutoff) {
            store.delete(id);
            locks.delete(id);
            removed++;
        }
    }

    if (removed > 0) {
        console.log(`[Session] Swept ${removed} idle conversation(s).`);
    }

    return removed;
};

// ---------------------------------------------------------------------------
// withConversationLock — per-session mutex
// ---------------------------------------------------------------------------

/**
 * Serialises async operations for a single conversationId so concurrent
 * messages cannot corrupt shared state.
 *
 * @param {string} conversationId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export const withConversationLock = async (conversationId, fn) => {
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
        throw new Error('conversationId is required');
    }

    const id = conversationId.trim();
    const prev = locks.get(id) || Promise.resolve();
    let releaseLock;
    const next = new Promise((resolve) => { releaseLock = resolve; });
    locks.set(id, prev.then(() => next));

    try {
        await prev;
        return await fn();
    } finally {
        releaseLock();
        // Garbage-collect lock if nobody is waiting
        if (locks.get(id) === next.then(() => {})) locks.delete(id);
    }
};

// ---------------------------------------------------------------------------
// startSessionSweeper — background interval (called by server.js)
// ---------------------------------------------------------------------------

/**
 * Starts the periodic conversation cleanup sweep.
 * Called once at server startup (server.js).
 */
export const startSessionSweeper = () => {
    const intervalMs = envNum('SESSION_SWEEP_INTERVAL_MINUTES', 30) * 60 * 1000;
    const handle = setInterval(sweepConversations, intervalMs);
    if (handle.unref) handle.unref(); // don't block process exit
    console.log(`[Session] Sweeper started (interval: ${intervalMs / 60000} min).`);
};
