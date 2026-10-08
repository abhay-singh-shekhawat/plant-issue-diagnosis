import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiWithRetry } from './gemini-retry.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Schema-correct fallback so the diagnostic engine always receives a complete
// visual_diagnosis object, even with no key / no file / an API failure.
const FALLBACK_VISUAL = {
    suspected_disease: 'Unidentified leaf damage (visual model unavailable)',
    visual_cues: 'No automated visual analysis was possible for this image.',
    confidence: 0,
    differential: [],
    source: 'fallback'
};

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
};

/**
 * Maps a stored image URL ("/user_img_web/xyz.jpg") to an absolute path inside
 * the server folder. The `../` prefix is resolved against the *server* dir so
 * the caller can never escape it via ../../ traversal.
 */
const resolveImagePath = (imageUrl) => {
    if (!imageUrl || typeof imageUrl !== 'string') return null;

    const relative = imageUrl.replace(/^[/\\]+/, '');
    const abs = path.resolve(__dirname, '..', relative);
    const serverRoot = path.resolve(__dirname, '..');

    if (!abs.startsWith(serverRoot)) {
        console.warn(`[Vision Service] Refusing path outside the server folder: ${imageUrl}`);
        return null;
    }
    return fs.existsSync(abs) ? abs : null;
};

/**
 * Track A — visual inference.
 * Sends the ACTUAL crop photo to Gemini as inline image data, so the diagnosis
 * is grounded in the picture instead of a hardcoded placeholder.
 */
export const getVisualDiagnosis = async (imageUrl) => {
    try {
        if (!GEMINI_API_KEY) return FALLBACK_VISUAL;

        const imagePath = resolveImagePath(imageUrl);
        if (!imagePath) return FALLBACK_VISUAL;

        const mimeType = MIME_BY_EXT[path.extname(imagePath).toLowerCase()] || 'image/jpeg';
        const data = fs.readFileSync(imagePath).toString('base64');

        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: VISION_MODEL });

        const prompt = `You are a plant pathologist examining a photo of a crop sent by a farmer.
Identify the most likely disease or disorder and describe the visual cues you ACTUALLY SEE in this specific image.
List 1-3 alternative possibilities in "differential".
Respond ONLY with raw JSON, no markdown fences:
{
  "suspected_disease": "<disease or disorder name>",
  "visual_cues": "<what is visibly wrong, e.g. colour, lesion shape, affected parts>",
  "confidence": <number 0-100>,
  "differential": ["<alternative 1>", "<alternative 2>"]
}`;

        const result = await geminiWithRetry(() => model.generateContent([
            { inlineData: { mimeType, data } },
            { text: prompt }
        ]));

        const raw = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(raw);

        const visual = {
            suspected_disease: parsed.suspected_disease || FALLBACK_VISUAL.suspected_disease,
            visual_cues: parsed.visual_cues || FALLBACK_VISUAL.visual_cues,
            confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
            differential: Array.isArray(parsed.differential) ? parsed.differential.filter(Boolean).slice(0, 3) : [],
            source: 'gemini-vision'
        };

        return visual;
    } catch (error) {
        return FALLBACK_VISUAL;
    }
};