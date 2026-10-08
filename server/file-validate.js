/**
 * file-validate.js — content-based upload validation for the web image door.
 *
 * The old gate trusted the client-supplied MIME header alone (`image/*`) and
 * copied the client-supplied filename extension verbatim. Both are attacker
 * controlled: a `.exe`/script renamed to `.jpg` with a spoofed
 * `Content-Type: image/jpeg` sailed through and was served back under
 * `/user_img_web`. This module validates the actual file BYTES:
 *
 *   1. extension allowlist (what the stored filename may end in),
 *   2. MIME allowlist (what the multipart header may claim),
 *   3. magic-byte signature check (what the content actually is), and
 *   4. cross-consistency: ext ↔ MIME ↔ signature must agree on ONE format.
 *
 * Supported formats: JPEG, PNG, WebP, GIF. HEIC/HEIF/BMP/TIFF are NOT accepted
 * on the web door — Gemini vision only maps jpg/png/webp/gif/bmp (see
 * vision.service.js MIME_BY_EXT) and phone browsers upload JPEG/PNG/WebP in
 * practice. Blocking the exotic formats shrinks the parser attack surface.
 */

import fs from 'node:fs';

/**
 * ext → { mime, variants[] }. Each variant is a list of (offset, bytes)
 * matchers that must ALL hold; a format matches when ANY variant matches.
 * (GIF needs OR across 87a/89a; WebP needs AND of RIFF-at-0 + WEBP-at-8.)
 */
const B = (arr) => Buffer.from(arr);
const S = (offset, bytes) => ({ offset, bytes });
export const IMAGE_FORMATS = {
    '.jpg': {
        mime: 'image/jpeg',
        variants: [[S(0, B([0xFF, 0xD8, 0xFF]))]]
    },
    '.jpeg': {
        mime: 'image/jpeg',
        variants: [[S(0, B([0xFF, 0xD8, 0xFF]))]]
    },
    '.png': {
        mime: 'image/png',
        variants: [[S(0, B([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))]]
    },
    '.webp': {
        mime: 'image/webp',
        // RIFF....WEBP — bytes 0-3 = RIFF, 8-11 = WEBP (size lives at 4-7).
        variants: [[S(0, B([0x52, 0x49, 0x46, 0x46])), S(8, B([0x57, 0x45, 0x42, 0x50]))]]
    },
    '.gif': {
        mime: 'image/gif',
        variants: [
            [S(0, Buffer.from('GIF87a', 'ascii'))],
            [S(0, Buffer.from('GIF89a', 'ascii'))]
        ]
    }
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Reads at most the first 12 bytes needed for all supported signatures.
 * Returns null when the file is missing/unreadable.
 */
const readHead = (filePath) => {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(12);
            const n = fs.readSync(fd, buf, 0, 12, 0);
            if (n < 4) return null; // not even a minimal header
            return buf.subarray(0, n);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
};

const matchesAt = (head, { offset, bytes }) =>
    Number.isInteger(offset) && Buffer.isBuffer(bytes)
    && head.length >= offset + bytes.length
    && head.subarray(offset, offset + bytes.length).equals(bytes);

/**
 * Detects the image format from magic bytes. Returns the canonical extension
 * (`.jpg`/`.png`/`.webp`/`.gif`) or null when no supported signature matches.
 */
export const detectImageFormat = (filePath) => {
    const head = readHead(filePath);
    if (!head) return null;
    for (const [ext, { variants }] of Object.entries(IMAGE_FORMATS)) {
        if (ext === '.jpeg') continue; // alias of .jpg — reported once as .jpg
        if (variants.some((variant) => variant.every((m) => matchesAt(head, m)))) return ext;
    }
    return null;
};

/**
 * Full validation of a multer-saved upload. Checks, in order:
 *   1. file present + non-empty (multer `limits` handles oversize first),
 *   2. extension allowlisted,
 *   3. MIME header allowlisted,
 *   4. magic bytes detect a supported format,
 *   5. ext ↔ MIME ↔ detected format all agree.
 *
 * Returns `{ ok: true, ext, mime }` or `{ ok: false, error }` where `error`
 * is a farmer-safe message (no internals, no paths).
 */
export const validateImageUpload = (file) => {
    if (!file || !file.path) return { ok: false, error: 'No image uploaded.' };
    let size = 0;
    try {
        size = fs.statSync(file.path).size;
    } catch {
        return { ok: false, error: 'Could not read the uploaded file.' };
    }
    if (size === 0) return { ok: false, error: 'The uploaded file is empty.' };
    if (size > MAX_IMAGE_BYTES) return { ok: false, error: 'Image is too large. Maximum size is 10MB.' };

    const ext = (file.originalname || '').toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0] || '';
    const format = IMAGE_FORMATS[ext];
    if (!format) {
        return { ok: false, error: 'Only JPG, PNG, WebP or GIF photos are allowed.' };
    }

    const claimedMime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (claimedMime !== format.mime) {
        return { ok: false, error: 'File type and extension do not match.' };
    }

    const detected = detectImageFormat(file.path);
    if (!detected) {
        return { ok: false, error: 'The file is not a valid image. Please upload a real photo.' };
    }
    const canonical = (ext, detected) => (ext === '.jpeg' ? '.jpg' : ext) === detected;
    if (!canonical(ext, detected)) {
        return { ok: false, error: 'File contents do not match its extension.' };
    }

    return { ok: true, ext, mime: format.mime };
};
