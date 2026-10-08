/**
 * Conversation -> Case store for the SC-Main agronomy agent.
 *
 * A **conversation** is the channel thread with one human: a WhatsApp phone JID
 * ("9198...@c.us") or a browser UUID for the web chat.
 *
 * A **case** is ONE crop problem being diagnosed *inside* that conversation.
 * This separation is what lets a farmer:
 *   - track two different diseases at the same time (two open cases), and
 *   - report the SAME disease again days later when it gets worse
 *     (a "progression": the case is re-opened and the new photo is re-analysed
 *     instead of silently reusing the old diagnosis).
 *
 * Conversation
 *   { conversationId, language, activeCaseId, cases[], pendingClarification, createdAt, updatedAt }
 *
 * Case
 *   { caseId, label, coordinates, photos:[{url,at}], image_url, diagnostic_data,
 *     history[], question_count, status, last_diagnosis, followUpOf, createdAt, updatedAt }
 */
import { envNum } from '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const conversations = new Map();

const SESSION_SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Deletes a parked (superseded) upload file. Clamped to the server root like
 * vision's resolveImagePath so a crafted URL can never escape into deletion.
 * Silent on missing/locked files — the hourly media sweep is the backstop.
 */
const deleteParkedFile = (imageUrl) => {
    try {
        if (!imageUrl || typeof imageUrl !== 'string') return;
        const abs = path.resolve(SESSION_SERVER_ROOT, imageUrl.replace(/^[/\\]+/, ''));
        if (!abs.startsWith(SESSION_SERVER_ROOT + path.sep)) return;
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.unlinkSync(abs);
    } catch { /* sweep backstop handles it */ }
};

const MAX_CASES = 5;                          // keeps the switcher usable + bounds memory
const NEW_CASE_DISTANCE_KM = 5;               // a different field => different case
const NEW_CASE_GAP_DAYS = 14;                 // a long silence => treat as a fresh problem
const CLARIFY_TTL_MS = 24 * 60 * 60 * 1000;   // unanswered "same or new?" expires after a day
const MAX_COMMAND_LENGTH = 40;                // only short standalone replies count as commands
/**
 * TTL / capacity resolved per sweep (not frozen at import) so env changes take
 * effect without a restart. Non-positive values fail safe: TTL eviction is
 * skipped (the MAX_CONVERSATIONS LRU cap still bounds memory) and a bad cap
 * falls back to the default — instead of `now - lastSeen > 0` wiping every
 * conversation on the next sweep.
 */
const resolveConversationTtlMs = () => {
    const hours = envNum('CONVERSATION_TTL_HOURS', 48);
    if (!(hours > 0)) {
        console.warn(`[Session] CONVERSATION_TTL_HOURS="${process.env.CONVERSATION_TTL_HOURS}" is not positive — idle eviction disabled (LRU cap still applies).`);
        return 0;
    }
    return hours * 60 * 60 * 1000;
};
const resolveMaxConversations = () => {
    const max = envNum('MAX_CONVERSATIONS', 5000);
    if (!(max > 0)) {
        console.warn(`[Session] MAX_CONVERSATIONS="${process.env.MAX_CONVERSATIONS}" is not positive — using default 5000.`);
        return 5000;
    }
    return Math.floor(max);
};

export const CASE_STATUS_LABEL = {
    gathering_info: 'collecting info',
    evaluating_confidence: 'in progress',
    completed: 'diagnosis ready'
};

// --- deterministic, localized replies (no LLM call needed) ------------------
const STRINGS = {
    en: {
        clarify: 'Got your photo. Is this the SAME problem you reported earlier, or a NEW problem? Please reply "same" or "new".',
        retry: 'Sorry, I did not understand. Please reply "same" or "new".',
        switched: (label) => `Switched to: ${label}`,
        listHeader: 'Your cases:',
        listFooter: 'Reply with a number to switch cases.',
        listEmpty: 'You do not have a case yet. Send a photo of the affected crop to start.',
        newCase: 'Started a new case. Please send a photo of the affected crop and your location.'
    },
    hi: {
        clarify: 'आपकी फोटो मिल गई। क्या यह पहले वाली समस्या ही है या नई समस्या है? कृपया "same" या "new" लिखें।',
        retry: 'क्षमा करें, समझ नहीं आया। कृपया "same" या "new" लिखें।',
        switched: (label) => `केस बदल दिया: ${label}`,
        listHeader: 'आपके केस:',
        listFooter: 'केस बदलने के लिए नंबर लिखें।',
        listEmpty: 'अभी कोई केस नहीं है। शुरू करने के लिए फसल की फोटो भेजें।',
        newCase: 'नया केस शुरू किया। कृपया प्रभावित फसल की फोटो और अपनी लोकेशन भेजें।'
    }
};

const stringsFor = (conversation) => STRINGS[conversation.language] || STRINGS.en;

// --- coordinate validation --------------------------------------------------
/**
 * Validates farmer-supplied coordinates and normalizes them to finite numbers.
 * Returns `{ lat, lon }` when usable, `null` otherwise (missing, non-numeric,
 * NaN/Infinity, or out of geographic range). Central gate so invalid values can
 * never flow into weather URLs, soil math, or the LLM prompt as real data.
 */
export const normalizeCoordinates = (coords) => {
    if (!coords || typeof coords !== 'object' || Array.isArray(coords)) return null;
    const lat = Number(coords.lat);
    const lon = Number(coords.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
};

// --- command vocabulary (spoken/textual, romanized + native scripts) --------
const NEW_WORDS = [
    'new', 'new problem', 'new case', 'another problem',
    'naya', 'nayi', 'nava', 'nawi',
    'नया', 'नई', 'नवीन', 'નવું', 'নতুন', 'புதிய', 'కొత్త', 'ಹೊಸ', 'പുതിയ', 'ନୂଆ', 'ਨਵਾਂ'
];
const SAME_WORDS = [
    'same', 'same problem', 'same case', 'wahi', 'vahi', 'usi', 'wahi problem',
    'वही', 'वही समस्या', 'એ જ', 'একই', 'அதே', 'అదే', 'ಅದೇ', 'അതേ', 'ସେହି', 'ਉਹੀ'
];
const LIST_WORDS = [
    'list', 'cases', 'case list', 'my cases', 'all cases',
    'लिस्ट', 'केस लिस्ट', 'કેસ', 'सूची'
];

const normalize = (value) =>
    (value == null ? '' : String(value))
        .toLowerCase()
        .replace(/[।.!?,;:]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Parses a short user message into a case command.
 * Returns null when the message is normal prose (i.e. not a command).
 */
export const parseCommand = (rawText) => {
    const text = normalize(rawText);
    if (!text || text.length > MAX_COMMAND_LENGTH) return null;

    if (NEW_WORDS.includes(text)) return { intent: 'new' };
    if (SAME_WORDS.includes(text)) return { intent: 'same' };
    if (LIST_WORDS.includes(text)) return { intent: 'list' };

    const digit = text.match(/^(?:case\s*)?(\d{1,2})$/);
    if (digit) return { intent: 'switch', index: parseInt(digit[1], 10) };

    return null;
};

// --- store primitives -------------------------------------------------------
/**
 * Every conversation id must be explicit and non-empty — there are no shared
 * buckets. A missing/blank id is a caller bug (controllers reject it with 400
 * before it reaches here); fail loud instead of leaking cross-user history.
 */
const requireConversationId = (conversationId) => {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!id) throw new Error('conversationId is required (no shared guest bucket)');
    return id;
};

export const getConversation = (conversationId) => {
    const id = requireConversationId(conversationId);
    if (!conversations.has(id)) {
        const now = Date.now();
        conversations.set(id, {
            conversationId: id,
            // Default matches DEFAULT_LANGUAGE ('hi') + the agent's
            // `conversation.language || language || 'hi'` fallback chain.
            language: 'hi',
            activeCaseId: null,
            cases: [],
            pendingClarification: null,
            createdAt: now,
            updatedAt: now
        });
    }
    return conversations.get(id);
};

let caseSequence = 0;
const nextCaseId = () => `c${++caseSequence}`;

// --- lifecycle: eviction + concurrency --------------------------------------

export const getConversationCount = () => conversations.size;

/**
 * Removes idle conversations (TTL) and, if still over capacity, the least
 * recently used ones. Without this the in-memory Map grows forever.
 */
export const sweepConversations = () => {
    const now = Date.now();
    const ttlMs = resolveConversationTtlMs();
    const maxConvs = resolveMaxConversations();
    let removed = 0;

    if (ttlMs > 0) {
        for (const [id, conv] of conversations) {
            const lastSeen = conv.updatedAt || conv.createdAt || 0;
            if (now - lastSeen > ttlMs) {
                conversations.delete(id);
                removed += 1;
            }
        }
    }

    if (conversations.size > maxConvs) {
        const byAge = [...conversations.entries()]
            .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
        const excess = conversations.size - maxConvs;
        for (let i = 0; i < excess; i += 1) {
            conversations.delete(byAge[i][0]);
            removed += 1;
        }
    }

    if (removed > 0) {
        console.log(`[Session] Swept ${removed} idle conversation(s). ${conversations.size} remaining.`);
    }
    return removed;
};

/** Starts the periodic sweep. Unref'd so it never blocks process exit. */
export const startSessionSweeper = (intervalMs = 10 * 60 * 1000) => {
    const timer = setInterval(sweepConversations, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    console.log(`[Session] Eviction sweep every ${Math.round(intervalMs / 60000)} min (TTL ${Math.round(resolveConversationTtlMs() / 3600000)}h, max ${resolveMaxConversations()} conversations).`);
    return timer;
};

// One promise-chain queue per conversation, so two rapid messages from the same
// farmer cannot interleave their awaits and corrupt the case state.
const locks = new Map();

// Upper bound on one conversation turn. Without it, a single stuck downstream
// call (Gemini hang, un-timed-out fetch) wedges that farmer's session forever:
// every later message queues behind the never-settling `previous` promise.
// 120 s is generous (worst case Gemini retries ≈ 15 s backoff + slow vision),
// and the loser only gets an error — its state was never entered.
const LOCK_TIMEOUT_MS = 120000;

export const withConversationLock = async (conversationId, task) => {
    const id = requireConversationId(conversationId);
    const previous = locks.get(id) || Promise.resolve();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => gate);
    locks.set(id, chained);

    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Conversation is busy — a previous request is taking too long. Please try again.')), LOCK_TIMEOUT_MS)
    );
    // A timed-out waiter abandons the queue WITHOUT disturbing it: the running
    // task still completes and releases normally for the next waiter.
    await Promise.race([previous, timeout]);
    try {
        return await task();
    } finally {
        release();
        // Only clear the slot if nobody queued up behind us.
        if (locks.get(id) === chained) locks.delete(id);
    }
};

export const getActiveCase = (conversation) =>
    conversation.cases.find((c) => c.caseId === conversation.activeCaseId) || null;

export const getCaseById = (conversation, caseId) =>
    conversation.cases.find((c) => c.caseId === caseId) || null;

export const createCase = (conversation, { coordinates = null, followUpOf = null } = {}) => {
    const now = Date.now();
    const kase = {
        caseId: nextCaseId(),
        label: `Case ${conversation.cases.length + 1}`,
        coordinates: coordinates || null,
        photos: [],
        image_url: null,
        diagnostic_data: null,
        history: [],
        question_count: 0,
        status: 'gathering_info',
        last_diagnosis: null,
        followUpOf: followUpOf || null,
        createdAt: now,
        updatedAt: now
    };

    conversation.cases.push(kase);

    // Bound memory: drop the oldest case that is not the one being worked on.
    if (conversation.cases.length > MAX_CASES) {
        const victim = conversation.cases.findIndex((c) => c.caseId !== conversation.activeCaseId);
        if (victim !== -1) conversation.cases.splice(victim, 1);
    }

    conversation.activeCaseId = kase.caseId;
    conversation.updatedAt = now;
    return kase;
};

export const switchCase = (conversation, caseId) => {
    const kase = getCaseById(conversation, caseId);
    if (!kase) return null;
    conversation.activeCaseId = kase.caseId;
    conversation.updatedAt = Date.now();
    return kase;
};

/** Attaches a photo. Returns true only when it is genuinely new (dedupe by URL). */
export const addPhotoToCase = (kase, imageUrl) => {
    if (!imageUrl || !kase) return false;
    if (kase.photos.some((p) => p.url === imageUrl)) return false;
    kase.photos.push({ url: imageUrl, at: Date.now() });
    kase.image_url = imageUrl;
    kase.updatedAt = Date.now();
    return true;
};

export const setCaseLabel = (kase, label) => {
    if (!kase || typeof label !== 'string') return;
    const clean = label.replace(/\s+/g, ' ').trim();
    if (clean) kase.label = clean.slice(0, 60);
};

// --- helpers ----------------------------------------------------------------
const distanceKm = (a, b) => {
    if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
    const R = 6371;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const formatCaseList = (conversation) => {
    const s = stringsFor(conversation);
    if (conversation.cases.length === 0) return s.listEmpty;

    const lines = conversation.cases.map((c, i) => {
        const activeMark = c.caseId === conversation.activeCaseId ? '  <-- active' : '';
        const status = CASE_STATUS_LABEL[c.status] || c.status;
        return `${i + 1}. ${c.label} (${status})${activeMark}`;
    });

    return [s.listHeader, ...lines, s.listFooter].join('\n');
};

/** Public, non-leaky view of a conversation for the HTTP API / web UI. */
export const serializeConversation = (conversation) => {
    if (!conversation) return null;
    return {
        conversationId: conversation.conversationId,
        activeCaseId: conversation.activeCaseId,
        language: conversation.language,
        cases: conversation.cases.map((c) => ({
            caseId: c.caseId,
            label: c.label,
            status: c.status,
            photoCount: c.photos.length,
            hasCoordinates: !!c.coordinates,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
        }))
    };
};

/**
 * Decides WHICH case an incoming message belongs to.
 *
 * Returns { conversation, case, command, photoChanged, isProgression,
 *           needsClarification, directResponse }
 *
 * `directResponse` (when set) is a deterministic reply that needs no LLM call.
 */
export const resolveTargetCase = ({
    conversationId,
    text = '',
    imageUrl = null,
    coordinates = null,
    action = null,
    caseId = null
}) => {
    const conversation = getConversation(conversationId);
    const now = Date.now();
    conversation.updatedAt = now;

    // Defense in depth: every entry path (web upload, WhatsApp location pin,
    // direct callers) funnels through here. Invalid values become "missing" so
    // the slot check asks for a location instead of diagnosing on garbage.
    coordinates = normalizeCoordinates(coordinates);

    const result = (extra = {}) => ({
        conversation,
        case: null,
        command: null,
        photoChanged: false,
        isProgression: false,
        needsClarification: null,
        directResponse: null,
        ...extra
    });

    /** Attach a photo; a photo that re-opens a finished case is a progression. */
    const attach = (kase, url, extra = {}) => {
        const changed = addPhotoToCase(kase, url);
        return result({
            case: kase,
            photoChanged: changed,
            isProgression: changed && kase.status === 'completed',
            ...extra
        });
    };

    const s = stringsFor(conversation);

    // A bare number is only a "switch case" command when there is more than one
    // case to switch between — otherwise it is just an answer like "2 days".
    let cmd = parseCommand(text);
    if (cmd && cmd.intent === 'switch' && conversation.cases.length < 2) cmd = null;

    // ---------- 0. explicit action from the web UI (buttons) ----------
    if (action === 'new') {
        const kase = createCase(conversation, { coordinates });
        return imageUrl ? attach(kase, imageUrl) : result({ case: kase, directResponse: s.newCase });
    }
    if (action === 'switch') {
        const kase = caseId ? switchCase(conversation, caseId) : null;
        // A photo riding along with a switch action is never attached anywhere
        // (multer already wrote it to disk) — delete it instead of orphaning.
        if (imageUrl) deleteParkedFile(imageUrl);
        if (caseId && !kase) {
            // Unknown caseId: say so honestly instead of a false "Switched to"
            // ack on whatever case happened to be active.
            return result({ case: getActiveCase(conversation), directResponse: formatCaseList(conversation) });
        }
        const active = kase || getActiveCase(conversation);
        return result({ case: active, directResponse: active ? s.switched(active.label) : null });
    }

    const wantsSame = action === 'same' || (cmd !== null && cmd.intent === 'same');
    const wantsNew = cmd !== null && cmd.intent === 'new';

    // ---------- 1. answering a parked "same or new?" question ----------
    if (conversation.pendingClarification) {
        const pending = conversation.pendingClarification;

        if (now - pending.at > CLARIFY_TTL_MS) {
            conversation.pendingClarification = null;   // expired -> fall through
        } else if (wantsSame || wantsNew) {
            conversation.pendingClarification = null;

            if (wantsNew) {
                const kase = createCase(conversation, { coordinates: pending.coordinates || coordinates });
                return attach(kase, pending.imageUrl);
            }
            const kase = getActiveCase(conversation) || createCase(conversation, { coordinates });
            if (pending.coordinates) kase.coordinates = pending.coordinates;
            return attach(kase, pending.imageUrl);
        } else if (cmd !== null && (cmd.intent === 'list' || cmd.intent === 'switch')) {
            // Let the command handling below run; the parked question stays pending.
        } else {
            if (imageUrl) pending.imageUrl = imageUrl;          // farmer re-sent a photo
            if (coordinates) pending.coordinates = coordinates;
            conversation.pendingClarification = { ...pending, at: now };   // keep it alive — a reply is still owed
            return result({ case: getActiveCase(conversation), directResponse: s.retry });
        }
    }

    // ---------- 2. explicit commands ----------
    if (cmd !== null && cmd.intent === 'list') {
        // A photo riding along with a list command is never attached — delete.
        if (imageUrl) deleteParkedFile(imageUrl);
        return result({ case: getActiveCase(conversation), directResponse: formatCaseList(conversation), command: cmd });
    }
    if (cmd !== null && cmd.intent === 'switch') {
        const target = conversation.cases[cmd.index - 1];
        if (!target) {
            if (imageUrl) deleteParkedFile(imageUrl);
            return result({ case: getActiveCase(conversation), directResponse: formatCaseList(conversation), command: cmd });
        }
        switchCase(conversation, target.caseId);
        return result({ case: target, directResponse: s.switched(target.label), command: cmd });
    }
    if (wantsNew) {
        const kase = createCase(conversation, { coordinates });
        return imageUrl
            ? attach(kase, imageUrl, { command: cmd })
            : result({ case: kase, directResponse: s.newCase, command: cmd });
    }
    if (wantsSame) {
        const kase = getActiveCase(conversation) || createCase(conversation, { coordinates });
        if (coordinates) kase.coordinates = coordinates;
        return imageUrl ? attach(kase, imageUrl, { command: cmd }) : result({ case: kase, command: cmd });
    }

    // ---------- 3. no case yet ----------
    let kase = getActiveCase(conversation);
    if (!kase) {
        kase = createCase(conversation, { coordinates });
        return imageUrl ? attach(kase, imageUrl) : result({ case: kase });
    }

    // ---------- 4. finished case + a NEW photo => ask "same or new?" ----------
    const isFreshPhoto = imageUrl && !kase.photos.some((p) => p.url === imageUrl);
    if (isFreshPhoto && kase.status === 'completed') {
        // Compare against the coordinates captured BEFORE this message: a farmer
        // reporting from a different field is a strong "new problem" signal.
        const previousCoords = kase.coordinates;
        const gapDays = (now - (kase.updatedAt || kase.createdAt)) / 86400000;
        const moved = distanceKm(previousCoords, coordinates);

        // Unambiguous signals: a different field, or a long silence.
        if ((moved !== null && moved > NEW_CASE_DISTANCE_KM) || gapDays > NEW_CASE_GAP_DAYS) {
            const fresh = createCase(conversation, { coordinates, followUpOf: kase.caseId });
            return attach(fresh, imageUrl);
        }

        conversation.pendingClarification = { imageUrl, coordinates, at: now };
        return result({
            case: kase,
            needsClarification: { type: 'new_vs_same' },
            directResponse: s.clarify
        });
    }

    // ---------- 5. normal path ----------
    if (coordinates) kase.coordinates = coordinates;
    return imageUrl ? attach(kase, imageUrl) : result({ case: kase });
};