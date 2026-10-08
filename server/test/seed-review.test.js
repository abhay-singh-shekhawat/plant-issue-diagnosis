/**
 * Phase 6 — complaint/review/reporting contract (deterministic, offline).
 *
 * Proves, without any API keys or network:
 *   - complaint creation files a RECORDED report (never a confirmation)
 *   - a complaint alone puts nobody on the watchlist and files no report
 *   - a HIGH assessment opens exactly one human-review task (flag → review)
 *   - reviewer dismissal ends the matter with no confirmed outcome
 *   - reviewer confirmation creates watchlist / report entries + audit trail
 *   - no direct AI enforcement: no path from assessment to watchlist/report
 *     except a human decision; AI/system identities cannot decide
 *
 *   node --test test/seed-review.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { processMessage } from '../services/agent.service.js';
import { resolveTargetCase, getConversation } from '../services/session.service.js';
import { setPurchaseMode } from '../services/seed/seed-slot.service.js';
import { runOpenStep } from '../services/seed/open-seed.workflow.js';
import { getLatestAssessment, clearAssessmentsForTest } from '../services/seed/assessment.service.js';
import { getEvidence, clearEvidenceForTest } from '../services/seed/seed-evidence.service.js';
import {
    ensureComplaint,
    getComplaint,
    listComplaintsByCase,
    countComplaintsBySubject,
    parseComplaintSubject,
    clearComplaintsForTest,
} from '../services/seed/complaint.service.js';
import {
    ensureReviewTaskForAssessment,
    decideReview,
    getReviewTask,
    listOpenReviews,
    listWatchlist,
    listReports,
    getAuditEvents,
    clearReviewsForTest,
    REVIEW_STATUS,
} from '../services/seed/review.service.js';
import { resetProviderAvailability } from '../services/seed/providers.js';

const uid = (p = 't-seed6') => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const resetAll = () => {
    clearEvidenceForTest();
    clearAssessmentsForTest();
    clearComplaintsForTest();
    clearReviewsForTest();
    resetProviderAvailability();
};

const openCase = (p = 'rvw') => {
    const cid = uid(p);
    const { case: kase } = resolveTargetCase({ conversationId: cid, imageUrl: '/seed.jpg', domain: 'SEED_VERIFICATION' });
    setPurchaseMode(kase, 'OPEN');
    return { cid, kase };
};

/** Drives an OPEN case to a HIGH assessment (scheme conflict, providers up). */
const driveHigh = async (kase) => {
    await runOpenStep({
        kase,
        text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    return getLatestAssessment(kase.caseId);
};

// --- complaint subject parsing -------------------------------------------------------
test('complaint subject parsing: marked input, prose stays null', () => {
    const s = parseComplaintSubject('seller: Ramesh Beej Bhandar, brand: Annapurna Seeds, crop: paddy, lot: AB123456, shikayat hai');
    assert.equal(s.seller, 'Ramesh Beej Bhandar');
    assert.equal(s.brand, 'Annapurna Seeds');
    assert.equal(s.crop, 'paddy');
    assert.equal(s.lot, 'AB123456');
    const empty = parseComplaintSubject('beej kharab nikla');
    assert.deepEqual(empty, { seller: null, brand: null, crop: null, variety: null, lot: null, scheme: null });
});

// --- complaint creation -----------------------------------------------------------------
test('complaint creation: record filed with id, status RECORDED', async () => {
    resetAll();
    const cid = uid('cmpl-new');
    const r = await processMessage({
        sessionId: cid,
        text: 'duplicate seed sold, complaint against seller: Ramesh Beej Bhandar, crop: paddy',
        imageUrl: '/proof.jpg',
    });
    assert.equal(r.state.caseType, 'SEED_COMPLAINT');
    assert.ok(r.text.includes('complaint recorded'));
    assert.ok(r.text.includes('ID: cmpl-'));
    const list = listComplaintsByCase(r.state.caseId);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'RECORDED');
    assert.equal(list[0].subject.seller, 'Ramesh Beej Bhandar');
    assert.ok(getComplaint(list[0].complaintId));
    assert.ok(r.state.seedContext.complaintIds.includes(list[0].complaintId));
});

// --- complaint is not confirmation -----------------------------------------------------------
test('complaint does not imply confirmation: no watchlist, no report', async () => {
    resetAll();
    const cid = uid('cmpl-noconf');
    const r = await processMessage({
        sessionId: cid,
        text: 'nakli beej becha, complaint, seller: Mystery Shop X',
        imageUrl: '/proof.jpg',
    });
    assert.ok(r.text.toLowerCase().includes('only a record'));
    assert.ok(r.text.includes('nothing is confirmed'));
    assert.equal(listWatchlist().length, 0);
    assert.equal(listReports().length, 0);
    assert.equal(listOpenReviews().length, 0, 'a bare complaint opens no review task by itself');
    const filed = getAuditEvents({ action: 'complaint-filed' });
    assert.equal(filed.length, 1);
    assert.equal(filed[0].actor, 'farmer');
});

// --- flag creates review task ----------------------------------------------------------------------
test('flag creates review task: HIGH opens exactly one OPEN task', async () => {
    resetAll();
    const { kase } = openCase('flag');
    const snap = await driveHigh(kase);
    assert.equal(snap.riskLevel, 'HIGH');
    const first = ensureReviewTaskForAssessment(kase, snap);
    assert.equal(first.fresh, true);
    assert.equal(first.task.status, 'OPEN');
    assert.equal(first.task.caseId, kase.caseId);
    assert.equal(first.task.assessmentId, snap.assessmentId);
    assert.deepEqual(first.task.signalCounts, snap.signalCounts);
    assert.equal(kase.seedContext.reviewId, first.task.reviewId);
    const second = ensureReviewTaskForAssessment(kase, snap);
    assert.equal(second.fresh, false);
    assert.equal(second.task.reviewId, first.task.reviewId);
    assert.equal(listOpenReviews().length, 1);
    // Non-HIGH assessments never flag.
    assert.equal(ensureReviewTaskForAssessment(kase, { ...snap, riskLevel: 'MEDIUM' }), null);
    assert.equal(ensureReviewTaskForAssessment(kase, null), null);
});

// --- agent wiring: HIGH turn surfaces the review line ---------------------------------------------------
test('agent: HIGH turn opens a review task and says a reviewer decides', async () => {
    resetAll();
    const cid = uid('agent-flag');
    await processMessage({ sessionId: cid, domain: 'SEED_VERIFICATION', imageUrl: '/seed.jpg' });
    await processMessage({ sessionId: cid, text: 'open hai' });
    const r = await processMessage({
        sessionId: cid,
        text: 'seller: Ramesh Beej Bhandar, crop: bajra, scheme: Sample Seed Subsidy Scheme, price: 500',
    });
    const kase = getConversation(cid).cases[0];
    assert.ok(kase.seedContext.reviewId, 'review linked to case');
    assert.ok(r.text.includes('human-review task'));
    assert.ok(r.text.includes('reviewer decides'));
    assert.equal(listOpenReviews().length, 1);
});

// --- reviewer dismisses ------------------------------------------------------------------------------------
test('reviewer dismisses: DISMISSED, no watchlist, no report, audit complete', async () => {
    resetAll();
    const { kase } = openCase('dismiss');
    const snap = await driveHigh(kase);
    const { task } = ensureReviewTaskForAssessment(kase, snap);
    const { task: done, outcome } = decideReview(task.reviewId, { decision: 'DISMISSED', reviewer: 'Asha Reviewer', note: 'sample data only' });
    assert.equal(done.status, REVIEW_STATUS.DISMISSED);
    assert.equal(outcome, null);
    assert.equal(listWatchlist().length, 0);
    assert.equal(listReports().length, 0);
    assert.equal(listOpenReviews().length, 0);
    const trail = getAuditEvents({ targetId: task.reviewId });
    assert.ok(trail.some((e) => e.action === 'review-opened' && e.actor === 'system-rule'));
    assert.ok(trail.some((e) => e.action === 'review-decided' && e.actor === 'reviewer:Asha Reviewer'));
});

// --- reviewer confirms → watchlist ------------------------------------------------------------------------------
test('reviewer confirms watchlist: entries listed, audit trailed', async () => {
    resetAll();
    const { kase } = openCase('confirm-wl');
    const snap = await driveHigh(kase);
    const { task } = ensureReviewTaskForAssessment(kase, snap);
    const { task: done, outcome } = decideReview(task.reviewId, { decision: 'CONFIRMED_WATCHLIST', reviewer: 'R. Officer' });
    assert.equal(done.status, REVIEW_STATUS.CONFIRMED_WATCHLIST);
    assert.ok(outcome.length >= 1);
    assert.ok(outcome.every((o) => o.store === 'watchlist'));
    assert.ok(listWatchlist().length >= 1);
    assert.ok(listWatchlist().some((e) => e.subject.toLowerCase().includes('ramesh')));
    assert.equal(listReports().length, 0);
    const added = getAuditEvents({ action: 'watchlist-added' });
    assert.equal(added.length, outcome.length);
    assert.ok(added.every((e) => e.actor === 'reviewer:R. Officer'));
});

// --- reviewer confirms → report --------------------------------------------------------------------------------------
test('reviewer confirms report: report filed with human attribution', async () => {
    resetAll();
    const { kase } = openCase('confirm-rpt');
    const snap = await driveHigh(kase);
    const { task } = ensureReviewTaskForAssessment(kase, snap);
    const { task: done, outcome } = decideReview(task.reviewId, { decision: 'CONFIRMED_REPORT', reviewer: 'R. Officer' });
    assert.equal(done.status, REVIEW_STATUS.CONFIRMED_REPORT);
    assert.ok(outcome.every((o) => o.store === 'report'));
    assert.ok(listReports().length >= 1);
    assert.equal(listWatchlist().length, 0);
    const filed = getAuditEvents({ action: 'report-filed' });
    assert.ok(filed.length >= 1);
});

// --- no direct AI enforcement -----------------------------------------------------------------------------------------------
test('no direct AI enforcement: HIGH alone changes nothing; AI cannot decide', async () => {
    resetAll();
    const { kase } = openCase('noenf');
    const snap = await driveHigh(kase);
    assert.equal(snap.riskLevel, 'HIGH');
    // Assessment exists but nobody decided: stores stay empty.
    assert.equal(listWatchlist().length, 0);
    assert.equal(listReports().length, 0);
    // AI/system identities are rejected as reviewers.
    const { task } = ensureReviewTaskForAssessment(kase, snap);
    for (const fake of ['ai', 'system', 'model', 'gemini', 'system-rule', '', '  ', null]) {
        assert.throws(() => decideReview(task.reviewId, { reviewer: fake, decision: 'CONFIRMED_WATCHLIST' }), /human reviewer/);
    }
    assert.equal(getReviewTask(task.reviewId).status, 'OPEN', 'still open after rejected attempts');
    assert.equal(listWatchlist().length, 0);
    // No audit actor is ever an AI/model identity.
    for (const e of getAuditEvents()) {
        assert.ok(!/^(ai|model|gemini|llm)(:|$)/i.test(e.actor), `no AI actor: ${e.actor}`);
    }
});

// --- decision guards ----------------------------------------------------------------------------------------------------------------
test('decision guards: unknown id, double decision, bad decision rejected', async () => {
    resetAll();
    const { kase } = openCase('guards');
    const snap = await driveHigh(kase);
    const { task } = ensureReviewTaskForAssessment(kase, snap);
    assert.throws(() => decideReview('rev-missing', { reviewer: 'R. Officer', decision: 'DISMISSED' }), /not found/);
    assert.throws(() => decideReview(task.reviewId, { reviewer: 'R. Officer', decision: 'MAYBE' }), /decision must be/);
    decideReview(task.reviewId, { reviewer: 'R. Officer', decision: 'DISMISSED' });
    assert.throws(() => decideReview(task.reviewId, { reviewer: 'R. Officer', decision: 'DISMISSED' }), /not open/);
});

// --- complaint aggregation context -------------------------------------------------------------------------------------------------------
test('complaints aggregate per subject as context (still no auto-flag)', async () => {
    resetAll();
    const mk = async (p) => processMessage({
        sessionId: uid(p),
        text: 'complaint, seller: Ramesh Beej Bhandar, crop: paddy',
        imageUrl: '/proof.jpg',
    });
    await mk('agg1');
    await mk('agg2');
    assert.equal(countComplaintsBySubject({ seller: 'Ramesh Beej Bhandar', crop: 'paddy' }), 2);
    assert.equal(countComplaintsBySubject({ seller: 'Nobody Else' }), 0);
    assert.equal(listOpenReviews().length, 0, 'accumulation alone never flags');
    assert.equal(listWatchlist().length, 0);
});
