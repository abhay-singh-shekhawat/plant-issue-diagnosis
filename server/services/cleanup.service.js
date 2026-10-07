import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const TTL_MS = Number(process.env.MEDIA_TTL_HOURS || 24) * 60 * 60 * 1000;
const SWEPT_DIRS = ['user_img_web', 'user_img_whatsapp', 'user_audio_whatsapp'];

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

/** Deletes files older than MEDIA_TTL_HOURS. Returns the number removed. */
export const sweepTempFiles = () => {
    const now = Date.now();
    let removed = 0;

    for (const dir of SWEPT_DIRS) {
        const abs = path.join(SERVER_ROOT, dir);
        if (!fs.existsSync(abs)) continue;

        walk(abs, (file) => {
            try {
                const stats = fs.statSync(file);
                if (now - stats.mtimeMs > TTL_MS) {
                    fs.unlinkSync(file);
                    removed += 1;
                }
            } catch {
                // File vanished or is locked — ignore and move on.
            }
        });
    }

    if (removed > 0) {
        console.log(`[Cleanup] Removed ${removed} expired media file(s) (TTL ${Math.round(TTL_MS / 3600000)}h).`);
    }
    return removed;
};

/** Starts the periodic media sweep. Unref'd so it never blocks process exit. */
export const startTempFileSweeper = (intervalMs = 60 * 60 * 1000) => {
    const timer = setInterval(sweepTempFiles, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    console.log(`[Cleanup] Media sweep every ${Math.round(intervalMs / 60000)} min.`);
    return timer;
};