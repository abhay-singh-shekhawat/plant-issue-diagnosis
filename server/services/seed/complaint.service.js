/**
 * complaint.service.js — Phase 6: post-purchase complaint intake + records.
 *
 * A complaint is a farmer's REPORT on file — status RECORDED — and must never
 * be read as confirmation of wrongdoing. Confirmation happens only through
 * human review (`review.service.js`). Complaints aggregate per subject for
 * future review context, but accumulation alone never auto-flags (no
 * threshold is approved for count-based flagging).
 */

import { parseBrandedSlots } from './branded-seed.workflow.js';
import { parseCropVarietyClaim } from './open-seed.workflow.js';
import {
    appendIfChanged, trackEvidence,
    SOURCE_TYPES, VERIFICATION_LEVELS, SIGNALS,
} from './seed-evidence.service.js';
import { recordAudit } from './review.service.js';

let seq = 0;
const complaints = new Map(); // complaintId -> Complaint

export const COMPLAINT_STATUS = { RECORDED: 'RECORDED' };

/** Brand/company name marker parsing for complaint subjects. */
const parseBrandMarker = (text) => {
    if (typeof text !== 'string') return null;
    const m = text.match(
        /(?:brand|company|कंपनी|ब्रांड)\s*(?:name)?\s*[:\-]?\s*([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F .&]{1,60})/i
    );
    if (!m) return null;
    const name = m[1].split(/\s+(is|hai|hain|se|from)\s+/i)[0].replace(/[,.!?।\n]+$/g, '').trim().slice(0, 60);
    return name.length >= 2 ? name : null;
};

/**
 * Extracts the complaint subject from free text. Missing fields stay null
 * (never guessed). Returns { seller, brand, crop, variety, lot, scheme }.
 */
export const parseComplaintSubject = (text = '') => {
    const slots = parseBrandedSlots(text);
    const claim = parseCropVarietyClaim(text);
    const lotM = typeof text === 'string'
        ? text.match(/(?:lot|batch|लॉट|बैच)\s*(?:no|number|नं)?\s*[:\-]?\s*([A-Za-z0-9]{2,30})/i)
        : null;
    return {
        seller: slots.sellerName,
        brand: parseBrandMarker(text),
        crop: claim.crop,
        variety: claim.variety,
        lot: lotM ? lotM[1].trim().slice(0, 30) : null,
        scheme: slots.schemeClaim,
    };
};

/** Normalized aggregation key for a complaint subject (order-stable). */
export const complaintSubjectKey = (subject = {}) => JSON.stringify(
    Object.entries({
        seller: (subject.seller || '').trim().toLowerCase(),
        brand: (subject.brand || '').trim().toLowerCase(),
        crop: (subject.crop || '').trim().toLowerCase(),
        variety: (subject.variety || '').trim().toLowerCase(),
        lot: (subject.lot || '').trim().toLowerCase(),
    }).filter(([, v]) => v)
);

/** How many recorded complaints share this subject (context, not a verdict). */
export const countComplaintsBySubject = (subject = {}) => {
    const key = complaintSubjectKey(subject);
    if (key === '[]') return 0;
    let n = 0;
    for (const c of complaints.values()) {
        if (complaintSubjectKey(c.subject) === key) n += 1;
    }
    return n;
};

/**
 * Files a complaint on a SEED_COMPLAINT case. First call creates the record;
 * follow-ups on the same case append statement evidence to the same record.
 * Never throws for normal inputs. Returns { record, isNew }.
 */
export const ensureComplaint = ({ kase, text = '', imageUrl = null } = {}) => {
    if (!kase || kase.caseType !== 'SEED_COMPLAINT') return null;
    const ctx = kase.seedContext || {};
    const existingId = Array.isArray(ctx.complaintIds) && ctx.complaintIds[0];
    const existing = existingId ? complaints.get(existingId) : null;

    const subject = parseComplaintSubject(text);
    const statement = {
        type: 'farmer-complaint',
        value: {
            signal: SIGNALS.UNKNOWN,
            summary: 'farmer complaint statement on file (recorded, not confirmed)',
            detail: { text: String(text || '').slice(0, 500) || null },
        },
        sourceType: SOURCE_TYPES.USER_INPUT,
        verificationLevel: VERIFICATION_LEVELS.UNVERIFIED,
        derivedFrom: { mediaIds: imageUrl ? [imageUrl] : [] },
    };

    if (existing) {
        const { record } = appendIfChanged(kase.caseId, 'farmer-complaint', statement);
        trackEvidence(ctx, record.evidenceId);
        if (imageUrl && !existing.photoUrls.includes(imageUrl)) existing.photoUrls.push(imageUrl);
        if (text && text.trim()) existing.updates += 1;
        return { record: existing, isNew: false };
    }

    const record = {
        complaintId: `cmpl-${Date.now()}-${(seq += 1)}`,
        caseId: kase.caseId,
        subject,
        description: String(text || '').slice(0, 1000) || null,
        photoUrls: imageUrl ? [imageUrl] : [],
        status: COMPLAINT_STATUS.RECORDED,
        updates: 0,
        createdAt: Date.now(),
    };
    complaints.set(record.complaintId, record);
    if (Array.isArray(ctx.complaintIds)) ctx.complaintIds.push(record.complaintId);
    const { record: ev } = appendIfChanged(kase.caseId, 'farmer-complaint', statement);
    trackEvidence(ctx, ev.evidenceId);
    recordAudit({
        actor: 'farmer', action: 'complaint-filed',
        targetType: 'complaint', targetId: record.complaintId,
        detail: { caseId: kase.caseId, subject },
    });
    return { record, isNew: true };
};

/** Complaint by id, or null. */
export const getComplaint = (complaintId) => complaints.get(complaintId) || null;

/** All complaints for a case. */
export const listComplaintsByCase = (caseId) =>
    [...complaints.values()].filter((c) => c.caseId === caseId);

/** Test-only reset. */
export const clearComplaintsForTest = () => {
    complaints.clear();
    seq = 0;
};
