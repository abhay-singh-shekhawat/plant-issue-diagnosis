/**
 * message.gateway.js — thin normalize/correlate layer (Phase 1).
 *
 * Channels (Web/WhatsApp) call processMessage(); this helper normalizes the
 * channel payload into the internal semantic message WITHOUT business logic.
 * Domain dispatch still happens inside agent.service.js after case resolution.
 * Pure + dependency-free so it is trivially testable.
 */

let corrSeq = 0;

/** Builds a correlation id when the channel did not supply one. */
const makeCorrelationId = () => `corr-${Date.now()}-${(corrSeq += 1)}`;

/**
 * Normalizes a raw inbound payload.
 * Never throws for normal inputs; trims text to the 2000-char brain limit.
 */
export const normalizeMessage = ({
    sessionId,
    source = 'web',
    text = '',
    imageUrl = null,
    coordinates = null,
    language = null,
    action = null,
    caseId = null,
    messageId = null,
    correlationId = null,
    domain = null,
    seedHints = [],
} = {}) => ({
    sessionId: typeof sessionId === 'string' ? sessionId.trim() : sessionId,
    source: source || 'web',
    text: typeof text === 'string' ? text.slice(0, 2000) : '',
    imageUrl: imageUrl || null,
    coordinates: coordinates || null,
    language: language ?? null,
    action: action || null,
    caseId: caseId || null,
    messageId:
        typeof messageId === 'string' && messageId.trim() ? messageId.trim().slice(0, 200) : null,
    correlationId:
        typeof correlationId === 'string' && correlationId.trim()
            ? correlationId.trim().slice(0, 200)
            : makeCorrelationId(),
    domain: typeof domain === 'string' && domain.trim() ? domain.trim() : null,
    seedHints: Array.isArray(seedHints) ? seedHints.filter((h) => typeof h === 'string') : [],
});
