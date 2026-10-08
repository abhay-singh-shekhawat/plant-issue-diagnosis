/**
 * R1 regression: content-based upload validation (AUD-007).
 * Fully offline — synthetic fixtures with real magic bytes, no network, no keys.
 * Covers: valid file / wrong ext / wrong MIME / ext-MIME mismatch / renamed
 * unsupported / malformed contents / empty / oversized / rejection cleanup /
 * downstream-failure cleanup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    detectImageFormat,
    validateImageUpload,
    MAX_IMAGE_BYTES
} from '../file-validate.js';
import { handleImageUpload } from '../controllers/upload.controller.js';

// --- fixture builders (real magic bytes) ---------------------------------------
const HEADS = {
    jpg: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]),
    png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]),
    webp: Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')]),
    gif89: Buffer.from('GIF89a12345678', 'ascii'),
    gif87: Buffer.from('GIF87a12345678', 'ascii'),
    exe: Buffer.from('MZ\x90\x00garbage-bytes!!', 'ascii'),
    text: Buffer.from('just some plain text, not an image at all.........', 'ascii')
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-upload-'));
// Suite hygiene: remove the fixture dir at process exit (tests delete files,
// but the dir itself would otherwise accumulate across runs).
process.on('exit', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const mkFile = (name, bytes) => {
    const p = path.join(tmpDir, `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${name}`);
    fs.writeFileSync(p, bytes);
    return p;
};

const asMulterFile = (p, originalname, mimetype) => ({
    path: p,
    originalname,
    mimetype,
    size: fs.existsSync(p) ? fs.statSync(p).size : 0
});

const mockRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.body = obj; return res; };
    return res;
};

// --- 1. valid supported files ----------------------------------------------------
test('R1-1: valid JPG/PNG/WebP/GIF87a/GIF89a bytes validate', () => {
    const cases = [
        ['photo.jpg', 'image/jpeg', HEADS.jpg],
        ['photo.jpeg', 'image/jpeg', HEADS.jpg],
        ['photo.png', 'image/png', HEADS.png],
        ['photo.webp', 'image/webp', HEADS.webp],
        ['photo.gif', 'image/gif', HEADS.gif89],
        ['photo.gif', 'image/gif', HEADS.gif87]
    ];
    for (const [name, mime, bytes] of cases) {
        const r = validateImageUpload(asMulterFile(mkFile(name, bytes), name, mime));
        assert.equal(r.ok, true, `${name} must validate`);
    }
});

test('R1-detect: detectImageFormat identifies each format from bytes', () => {
    assert.equal(detectImageFormat(mkFile('a.jpg', HEADS.jpg)), '.jpg');
    assert.equal(detectImageFormat(mkFile('a.png', HEADS.png)), '.png');
    assert.equal(detectImageFormat(mkFile('a.webp', HEADS.webp)), '.webp');
    assert.equal(detectImageFormat(mkFile('a.gif', HEADS.gif89)), '.gif');
    assert.equal(detectImageFormat(mkFile('a.gif', HEADS.gif87)), '.gif');
    assert.equal(detectImageFormat(mkFile('a.exe', HEADS.exe)), null);
    assert.equal(detectImageFormat(mkFile('a.txt', HEADS.text)), null);
    assert.equal(detectImageFormat('/nonexistent/file.jpg'), null);
});

// --- 2. wrong extension ------------------------------------------------------------
test('R1-2: disallowed extension rejected even with image MIME', () => {
    const p = mkFile('evil.exe', HEADS.jpg); // real JPEG bytes, bad ext
    const r = validateImageUpload(asMulterFile(p, 'evil.exe', 'image/jpeg'));
    assert.equal(r.ok, false);
    assert.match(r.error, /JPG, PNG, WebP or GIF/);
    fs.unlinkSync(p);
});

// --- 3. wrong MIME ------------------------------------------------------------------
test('R1-3: non-image MIME rejected', () => {
    const p = mkFile('photo.jpg', HEADS.jpg);
    const r = validateImageUpload(asMulterFile(p, 'photo.jpg', 'application/octet-stream'));
    assert.equal(r.ok, false);
    assert.match(r.error, /do not match/);
    fs.unlinkSync(p);
});

// --- 4. MIME/extension mismatch -------------------------------------------------------
test('R1-4: PNG bytes with .jpg ext + jpeg MIME rejected on contents', () => {
    const p = mkFile('photo.jpg', HEADS.png);
    const r = validateImageUpload(asMulterFile(p, 'photo.jpg', 'image/jpeg'));
    assert.equal(r.ok, false);
    assert.match(r.error, /do not match its extension/);
    fs.unlinkSync(p);
});

test('R1-4b: matching ext but wrong MIME rejected', () => {
    const p = mkFile('photo.png', HEADS.png);
    const r = validateImageUpload(asMulterFile(p, 'photo.png', 'image/jpeg'));
    assert.equal(r.ok, false);
    assert.match(r.error, /do not match/);
    fs.unlinkSync(p);
});

// --- 5. renamed unsupported file -------------------------------------------------------
test('R1-5: EXE bytes renamed to .jpg with spoofed MIME rejected', () => {
    const p = mkFile('payload.jpg', HEADS.exe);
    const r = validateImageUpload(asMulterFile(p, 'payload.jpg', 'image/jpeg'));
    assert.equal(r.ok, false, 'magic bytes decide, not ext+MIME');
    assert.match(r.error, /not a valid image/);
    assert.ok(fs.existsSync(p), 'validator never deletes — caller owns cleanup');
    fs.unlinkSync(p);
});

// --- 6. malformed contents --------------------------------------------------------------
test('R1-6: truncated and garbage contents rejected', () => {
    const tiny = mkFile('tiny.jpg', Buffer.from([0xFF, 0xD8]));
    assert.equal(validateImageUpload(asMulterFile(tiny, 'tiny.jpg', 'image/jpeg')).ok, false);
    fs.unlinkSync(tiny);
    const garbage = mkFile('garbage.png', HEADS.text);
    const r = validateImageUpload(asMulterFile(garbage, 'garbage.png', 'image/png'));
    assert.equal(r.ok, false);
    fs.unlinkSync(garbage);
});

// --- 7. empty file -----------------------------------------------------------------------
test('R1-7: empty file rejected with a clear message', () => {
    const p = mkFile('empty.jpg', Buffer.alloc(0));
    const r = validateImageUpload(asMulterFile(p, 'empty.jpg', 'image/jpeg'));
    assert.equal(r.ok, false);
    assert.match(r.error, /empty/);
    fs.unlinkSync(p);
});

// --- 8. oversized file --------------------------------------------------------------------
test('R1-8: files over the 10 MB cap are rejected without reading contents', () => {
    // Multer `limits.fileSize` rejects oversize uploads before the controller
    // runs (error.middleware maps LIMIT_FILE_SIZE → 400). The validator's own
    // size gate is belt-and-suspenders for direct callers: exercise it with a
    // sparse file (no 10 MB write) carrying valid JPEG bytes.
    const p = path.join(tmpDir, `sparse-${Date.now()}.jpg`);
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, HEADS.jpg, 0, HEADS.jpg.length, 0);
    fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1); // sparse: no blocks allocated
    fs.closeSync(fd);
    const r = validateImageUpload(asMulterFile(p, 'big.jpg', 'image/jpeg'));
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
    fs.unlinkSync(p);
});

// --- 9. rejection cleanup (controller deletes the orphan) ------------------------------------
test('R1-9: controller deletes the file when content validation rejects', async () => {
    const p = mkFile('payload.jpg', HEADS.exe);
    const req = {
        file: { path: p, originalname: 'payload.jpg', mimetype: 'image/jpeg' },
        body: { sessionId: 't-r1-reject', source: 'web' }
    };
    const res = mockRes();
    await handleImageUpload(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /not a valid image/);
    assert.ok(!fs.existsSync(p), 'rejected upload must not leave an orphan');
});

test('R1-9b: controller deletes the file when sessionId is missing', async () => {
    const p = mkFile('photo.jpg', HEADS.jpg);
    const req = {
        file: { path: p, originalname: 'photo.jpg', mimetype: 'image/jpeg' },
        body: { source: 'web' }
    };
    const res = mockRes();
    await handleImageUpload(req, res);
    assert.equal(res.statusCode, 400);
    assert.ok(!fs.existsSync(p), 'missing-sessionId upload must not leave an orphan');
});

// --- 10. downstream-failure cleanup -------------------------------------------------------------
test('R1-10: controller deletes the file when the agent throws after save', async () => {
    // Valid image + valid session + INVALID coordinates shape: JSON parse throws
    // inside the controller AFTER multer saved the file (processMessage never runs).
    const p = mkFile('photo.jpg', HEADS.jpg);
    const req = {
        file: { path: p, originalname: 'photo.jpg', mimetype: 'image/jpeg' },
        body: { sessionId: 't-r1-downstream', source: 'web', coordinates: '{not-json' }
    };
    const res = mockRes();
    await handleImageUpload(req, res);
    assert.equal(res.statusCode, 400);
    assert.ok(!fs.existsSync(p), 'downstream-failure upload must not leave an orphan');
});
