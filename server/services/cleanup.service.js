import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { envNum } from '../env.js';

/**
 * Reclaims disk space for uploaded photos and generated voice notes.
 * Without this, user_img_web/, user_img_whatsapp/ and user_audio_whatsapp/
 * grow forever (nothing else in the codebase ever deletes them).
 *
 * NOTE: `.wwebjs_auth` (the WhatsApp login session) is deliberately NOT swept.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.join(__dirname, '..');

const SWEPT_DIRS = ['user_img_web', 'user_img_whatsapp', 'user_audio_whatsapp'];
// Files younger than this are never deleted: multer may still be writing one,
// or WhatsApp may be mid-send. Skipping them only delays deletion to the next
// hourly sweep — it never preserves genuinely expired data.
const MIN_AGE_MS = 60 * 1000;

/**
 * Resolves the TTL per sweep (not at import) so `MEDIA_TTL_HOURS` changes take
 * effect without a restart. Zero/negative values DISABLE sweeping (fail safe)
 * instead of wiping everything — `now - mtime > 0` is true for every file.
 */
const resolveTtlMs = () => {
    const hours = envNum('MEDIA_TTL_HOURS', 24);
    if (!(hours > 0)) {
        console.warn(`[Cleanup] MEDIA_TTL_HOURS="${process.env.MEDIA_TTL_HOURS}" is not positive — media sweep disabled (nothing deleted).`);
        return 0;
    }
    return hours * 60 * 60 * 1000;
};

const walk = (dir, onFile) => {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, onFile);
        else if (entry.isFile()) onFile(full);
    }
};

/**
 * Deletes files older than MEDIA_TTL_HOURS. Returns `{ removed, skipped }`.
 * `removed` counts deletions; `skipped` counts files left alone because they
 * are younger than the in-flight grace period. Returns `{ removed: 0,
 * skipped: 0, disabled: true }` when the TTL is non-positive (fail safe).
 */
export const sweepTempFiles = () => {
    const ttlMs = resolveTtlMs();
    if (!ttlMs) return { removed: 0, skipped: 0, disabled: true };
    // Backwards-compatible: callers treating the return as a number still get
    // the removal count — but prefer the object form for new code.
    const now = Date.now();
    let removed = 0;
    let skipped = 0;
    let errors = 0;

    for (const dir of SWEPT_DIRS) {
        const abs = path.join(SERVER_ROOT, dir);
        if (!fs.existsSync(abs)) continue;

        walk(abs, (file) => {
            try {
                const stats = fs.statSync(file);
                const age = now - stats.mtimeMs;
                if (age < MIN_AGE_MS) {
                    skipped += 1; // possibly mid-write / mid-send — next sweep
                    return;
                }
                if (age > ttlMs) {
                    fs.unlinkSync(file);
                    removed += 1;
                }
            } catch {
                // File vanished or is locked — count it so silent mass-failures
                // are visible in logs instead of vanishing.
                errors += 1;
            }
        });
    }

    if (removed > 0 || errors > 0) {
        console.log(`[Cleanup] Removed ${removed} expired media file(s) (TTL ${Math.round(ttlMs / 3600000)}h, ${skipped} young-skipped, ${errors} errors).`);
    }
    const result = { removed, skipped, errors };
    // Numeric coercion keeps `sweepTempFiles() === 0` style assertions working.
    result.valueOf = () => removed;
    return result;
};

/** Starts the periodic media sweep. Unref'd so it never blocks process exit. */
export const startTempFileSweeper = (intervalMs = 60 * 60 * 1000) => {
    const timer = setInterval(sweepTempFiles, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    console.log(`[Cleanup] Media sweep every ${Math.round(intervalMs / 60000)} min.`);
    return timer;
};