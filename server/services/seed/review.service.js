/**
 * review.service.js — Phase 6: human review + confirmed outcomes + audit.
 *
 * The one hard rule of this module (PRD R6/R10):
 *   FLAG → REVIEW → HUMAN DECISION → confirmed watchlist/report.
 * There is NO code path from an assessment (or any AI output) to the
 * watchlist/report stores except through `decideReview()` with a verified
 * human reviewer identity. Automated callers create tasks; only humans decide.
 *
 * Stores are module-level Maps: restart loss is an explicit MVP limitation.
 * No reviewer UI is invented here — this is the backend contract only.
 */

let taskSeq = 0;
let auditSeq = 0;
let reportSeq = 0;

const tasks = new Map(); // reviewId -> ReviewTask
const watchlist = new Map(); // subjectKey -> WatchlistEntry
const reports = new Map(); // reportId -> Report
const auditEvents = []; // append-only AuditEvent[]

export const REVIEW_STATUS = {
    OPEN: 'OPEN',
    DISMISSED: 'DISMISSED',
    CONFIRMED_WATCHLIST: 'CONFIRMED_WATCHLIST',
    CONFIRMED_REPORT: 'CONFIRMED_REPORT',
};

export const REVIEW_POLICY_VERSION = 'review-policy-v1';

// Identities that can never count as a human reviewer (AI/system actors).
const NON_HUMAN_ACTORS = new Set(['ai', 'system', 'model', 'gemini', 'bot', 'agent', 'llm', 'system-rule', '']);

/** True for a plausible human reviewer identity (non-empty, non-automated). */
export const isHumanReviewer = (reviewer) => {
    if (typeof reviewer !== 'string') return false;
    const r = reviewer.trim().toLowerCase();
    if (r.length < 2) return false;
    return !NON_HUMAN_ACTORS.has(r);
};

/** Append-only audit trail. Never throws for normal inputs. */
export const recordAudit = ({ actor, action, targetType = null, targetId = null, detail = {} } = {}) => {
    if (!actor || !action) throw new Error('actor and action are required');
    const event = {
        auditId: `audit-${Date.now()}-${(auditSeq += 1)}`,
        actor,
        action,
        targetType,
        targetId,
        detail,
        at: Date.now(),
    };
    auditEvents.push(event);
    return event;
};

/** Audit events, oldest first. Optional filter {actor, action, targetId}. */
export const getAuditEvents = (filter = {}) => auditEvents.filter((e) => {
    if (filter.actor && e.actor !== filter.actor) return false;
    if (filter.action && e.action !== filter.action) return false;
    if (filter.targetId && e.targetId !== filter.targetId) return false;
    return true;
});

/**
 * Opens a human-review task for a HIGH assessment. Deterministic system rule,
 * not an AI decision: callers pass the already-computed assessment.
 * One OPEN task per case — repeats return the existing task (no duplicates).
 */
export const ensureReviewTaskForAssessment = (kase, assessment) => {
    if (!kase || !assessment) return null;
    if (assessment.riskLevel !== 'HIGH') return null;
    for (const t of tasks.values()) {
        if (t.caseId === kase.caseId && t.status === REVIEW_STATUS.OPEN) return { task: t, fresh: false };
    }
    const ctx = kase.seedContext || {};
    const task = {
        reviewId: `rev-${Date.now()}-${(taskSeq += 1)}`,
        caseId: kase.caseId,
        assessmentId: assessment.assessmentId,
        policyVersion: assessment.policyVersion || null,
        signalCounts: { ...assessment.signalCounts },
        evidenceRefs: [...assessment.evidenceRefs],
        complaintIds: Array.isArray(ctx.complaintIds) ? [...ctx.complaintIds] : [],
        subject: {
            seller: ctx.sellerRef?.name || null,
            brand: ctx.packetData?.fields?.brand || ctx.brandRef?.name || null,
            crop: ctx.seedSubject?.crop || ctx.packetData?.fields?.crop || null,
            variety: ctx.seedSubject?.variety || ctx.packetData?.fields?.variety || null,
            lot: ctx.packetData?.fields?.lot || null,
        },
        status: REVIEW_STATUS.OPEN,
        openedBy: 'system-rule',
        openedAt: Date.now(),
        decidedBy: null,
        decidedAt: null,
    };
    tasks.set(task.reviewId, task);
    if (kase.seedContext && !kase.seedContext.reviewId) kase.seedContext.reviewId = task.reviewId;
    recordAudit({
        actor: 'system-rule', action: 'review-opened',
        targetType: 'review', targetId: task.reviewId,
        detail: { caseId: kase.caseId, assessmentId: assessment.assessmentId, signalCounts: task.signalCounts },
    });
    return { task, fresh: true };
};

/** Open review tasks, oldest first. */
export const listOpenReviews = () => [...tasks.values()].filter((t) => t.status === REVIEW_STATUS.OPEN);

/** Task by id, or null. */
export const getReviewTask = (reviewId) => tasks.get(reviewId) || null;

/** All tasks for a case. */
export const listReviewsByCase = (caseId) => [...tasks.values()].filter((t) => t.caseId === caseId);

const subjectKey = (kind, subject) => `${kind}:${String(subject || '').trim().toLowerCase()}`;

/**
 * Human decision on an OPEN task. The ONLY path to confirmed outcomes.
 * @param {string} reviewId
 * @param {{decision: 'DISMISSED'|'CONFIRMED_WATCHLIST'|'CONFIRMED_REPORT', reviewer: string, note?: string}} args
 * @throws on unknown id, non-OPEN task, non-human reviewer, bad decision.
 */
export const decideReview = (reviewId, { decision, reviewer, note = '' } = {}) => {
    const task = tasks.get(reviewId);
    if (!task) throw new Error('review not found');
    if (task.status !== REVIEW_STATUS.OPEN) throw new Error('review is not open');
    if (!isHumanReviewer(reviewer)) throw new Error('a human reviewer identity is required');
    if (!Object.values(REVIEW_STATUS).includes(decision) || decision === REVIEW_STATUS.OPEN) {
        throw new Error('decision must be DISMISSED, CONFIRMED_WATCHLIST or CONFIRMED_REPORT');
    }
    task.status = decision;
    task.decidedBy = reviewer.trim();
    task.decidedAt = Date.now();
    if (note) task.decisionNote = String(note).slice(0, 500);

    recordAudit({
        actor: `reviewer:${task.decidedBy}`, action: 'review-decided',
        targetType: 'review', targetId: task.reviewId,
        detail: { decision, caseId: task.caseId },
    });

    if (decision === REVIEW_STATUS.DISMISSED) return { task, outcome: null };

    // Confirmed outcomes: subject entries derived from the reviewed task.
    const outcomes = [];
    const kinds = [];
    if (task.subject.seller) kinds.push(['seller', task.subject.seller]);
    if (task.subject.brand) kinds.push(['brand', task.subject.brand]);
    if (task.subject.lot) kinds.push(['lot', task.subject.lot]);
    if (kinds.length === 0 && (task.subject.crop || task.subject.variety)) {
        kinds.push(['seed', [task.subject.crop, task.subject.variety].filter(Boolean).join('/')]);
    }
    for (const [kind, subject] of kinds) {
        const key = subjectKey(kind, subject);
        if (decision === REVIEW_STATUS.CONFIRMED_WATCHLIST) {
            const entry = {
                subjectKey: key, kind, subject,
                reviewId: task.reviewId, listedBy: task.decidedBy, listedAt: Date.now(),
            };
            watchlist.set(key, entry);
            outcomes.push({ store: 'watchlist', entry });
            recordAudit({
                actor: `reviewer:${task.decidedBy}`, action: 'watchlist-added',
                targetType: 'watchlist', targetId: key, detail: { reviewId: task.reviewId },
            });
        } else {
            const reportId = `rpt-${Date.now()}-${(reportSeq += 1)}`;
            const report = {
                reportId, kind, subject,
                reviewId: task.reviewId, filedBy: task.decidedBy, filedAt: Date.now(),
                summary: `Confirmed ${kind} report from human review ${task.reviewId}.`,
            };
            reports.set(reportId, report);
            outcomes.push({ store: 'report', entry: report });
            recordAudit({
                actor: `reviewer:${task.decidedBy}`, action: 'report-filed',
                targetType: 'report', targetId: reportId, detail: { reviewId: task.reviewId },
            });
        }
    }
    return { task, outcome: outcomes };
};

/** Watchlist entries, oldest first. Empty until a human confirms. */
export const listWatchlist = () => [...watchlist.values()];

/** True when a subject is on the confirmed watchlist. */
export const isWatchlisted = (kind, subject) => watchlist.has(subjectKey(kind, subject));

/** Filed reports, oldest first. Empty until a human confirms. */
export const listReports = () => [...reports.values()];

/** Test-only reset. */
export const clearReviewsForTest = () => {
    tasks.clear();
    watchlist.clear();
    reports.clear();
    auditEvents.length = 0;
    taskSeq = 0;
    auditSeq = 0;
    reportSeq = 0;
};
