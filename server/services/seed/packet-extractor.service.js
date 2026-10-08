/**
 * packet-extractor.service.js — Phase 3: packet field extraction contract.
 *
 * Contract (deterministic, schema-validated):
 *   input  { imageUrl, visionCall? } — visionCall is injectable so tests and
 *          offline runs never need a network key.
 *   output { status: 'clear'|'partial'|'unreadable'|'unavailable'|'no-image',
 *            fields: { brand,crop,variety,lot,mrp,mfgDate,expiryDate,
 *                      labelText,barcodeText } | null,
 *            unknownFields: string[], reason: string|null,
 *            source: 'model-packet-vision' | 'heuristic-unavailable' }
 *
 * Rules:
 * - Unreadable/missing fields stay null (never invented).
 * - No key / transport failure => 'unavailable', NOT 'unreadable' (we never
 *   looked). Downstream that is evidence UNKNOWN, never safe.
 * - Barcode/QR: NO decoder is configured (explicit non-requirement), so
 *   `getBarcodeCapability()` always reports unavailable and any barcode text
 *   comes only from the vision transcription, never from a fake verifier.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiWithRetry } from '../gemini-retry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKET_FIELDS = [
    'brand', 'crop', 'variety', 'lot', 'mrp', 'mfgDate', 'expiryDate', 'labelText', 'barcodeText',
];

const KEY_FIELDS = ['brand', 'crop', 'variety', 'lot'];

export const visionUnavailableError = () => {
    const err = new Error('packet vision unavailable');
    err.code = 'VISION_UNAVAILABLE';
    return err;
};

/** Never invent: coerce one transcribed field to string-or-null. */
const cleanField = (v, { numeric = false } = {}) => {
    if (v === null || v === undefined) return null;
    // Phase 8: objects/arrays/booleans are never valid field values. Without
    // this guard, String({}) === '[object Object]' would pass as "present".
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    if (numeric) {
        const n = Number(String(v).replace(/[₹,\s]/g, ''));
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const s = String(v).trim().slice(0, 200);
    return s ? s : null;
};

/**
 * Validates + normalizes a raw extraction (model output or test double).
 * Unknown/unparseable => 'unreadable'. Partial => 'partial'. Full => 'clear'.
 */
export const normalizePacketExtraction = (raw, { imageUrl = null } = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { status: 'unreadable', fields: null, unknownFields: [...PACKET_FIELDS], reason: 'invalid-payload', source: 'model-packet-vision', imageUrl };
    }
    const fields = {
        brand: cleanField(raw.brand),
        crop: cleanField(raw.crop),
        variety: cleanField(raw.variety),
        lot: cleanField(raw.lot),
        mrp: cleanField(raw.mrp, { numeric: true }),
        mfgDate: cleanField(raw.mfgDate || raw.mfg_date),
        expiryDate: cleanField(raw.expiryDate || raw.expiry_date),
        labelText: cleanField(raw.labelText || raw.label_text || raw.certification),
        barcodeText: cleanField(raw.barcodeText || raw.barcode_text || raw.qrText),
    };
    const present = KEY_FIELDS.filter((k) => fields[k]);
    const unknownFields = PACKET_FIELDS.filter((k) => !fields[k]);
    if (present.length === 0) {
        return { status: 'unreadable', fields: null, unknownFields, reason: 'no-key-fields', source: 'model-packet-vision', imageUrl };
    }
    return {
        status: present.length === KEY_FIELDS.length ? 'clear' : 'partial',
        fields,
        unknownFields,
        reason: present.length === KEY_FIELDS.length ? null : 'partial-fields',
        source: 'model-packet-vision',
        imageUrl,
    };
};

const resolvePacketImagePath = (imageUrl) => {
    if (!imageUrl || typeof imageUrl !== 'string') return null;
    const relative = imageUrl.replace(/^[/\\]+/, '');
    const abs = path.resolve(__dirname, '../..', relative);
    const serverRoot = path.resolve(__dirname, '../..');
    if (!abs.startsWith(serverRoot)) return null;
    return fs.existsSync(abs) ? abs : null;
};

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * Default vision call: existing Gemini setup, PACKET prompt (never the crop
 * disease prompt — crop semantics must not leak into seed extraction).
 * Throws VISION_UNAVAILABLE with no key/file; returns raw parsed JSON otherwise.
 */
export const defaultPacketVision = async (imageUrl) => {
    const key = (process.env.GEMINI_API_KEY || '').trim();
    if (!key) throw visionUnavailableError();
    const imagePath = resolvePacketImagePath(imageUrl);
    if (!imagePath) throw visionUnavailableError();
    const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    try {
        const mimeType = MIME_BY_EXT[path.extname(imagePath).toLowerCase()] || 'image/jpeg';
        const data = fs.readFileSync(imagePath).toString('base64');
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: modelName });
        const prompt = `You are transcribing a seed packet photo for a farmer. Read ONLY what is visibly printed.
Respond ONLY with raw JSON, no markdown fences:
{"brand": "<printed brand or null>", "crop": "<printed crop or null>", "variety": "<printed variety or null>", "lot": "<lot/batch code or null>", "mrp": "<printed MRP number or null>", "mfgDate": "<printed manufacturing/packing date or null>", "expiryDate": "<printed expiry/validity or null>", "labelText": "<certification/label text or null>", "barcodeText": "<human-readable number under barcode, or null if none visible>"}
Use null for anything not clearly readable. Never guess a value.`;
        const result = await geminiWithRetry(() => model.generateContent([
            { inlineData: { mimeType, data } },
            { text: prompt },
        ]));
        const raw = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(raw);
    } catch (err) {
        if (err && err.code === 'VISION_UNAVAILABLE') throw err;
        const transport = /4\d\d|5\d\d|network|timeout|fetch|overloaded|rate limit/i.test((err && err.message) || '');
        if (transport) {
            const wrapped = visionUnavailableError();
            wrapped.cause = err;
            throw wrapped;
        }
        return null; // parsed-but-garbage => unreadable downstream
    }
};

/**
 * Full extraction entry point. Never throws for normal inputs.
 * visionCall override: async (imageUrl) => rawFields (tests inject doubles).
 */
export const extractPacketData = async ({ imageUrl, visionCall } = {}) => {
    if (!imageUrl) {
        return { status: 'no-image', fields: null, unknownFields: [...PACKET_FIELDS], reason: 'no-image', source: 'heuristic-unavailable', imageUrl: null };
    }
    try {
        const call = visionCall || defaultPacketVision;
        const raw = await call(imageUrl);
        return normalizePacketExtraction(raw, { imageUrl });
    } catch (err) {
        if (err && err.code === 'VISION_UNAVAILABLE') {
            return { status: 'unavailable', fields: null, unknownFields: [...PACKET_FIELDS], reason: 'vision-unavailable', source: 'heuristic-unavailable', imageUrl };
        }
        return { status: 'unreadable', fields: null, unknownFields: [...PACKET_FIELDS], reason: 'extraction-error', source: 'model-packet-vision', imageUrl };
    }
};

/**
 * Barcode/QR capability contract. No decoding library is configured, so this
 * ALWAYS reports unavailable. Callers record evidence UNKNOWN
 * (reason 'capability-unavailable') and continue with the remaining evidence.
 * A future approved decoder plugs in here behind the same shape.
 */
export const getBarcodeCapability = () => ({ available: false, reason: 'no-decoder-configured' });
