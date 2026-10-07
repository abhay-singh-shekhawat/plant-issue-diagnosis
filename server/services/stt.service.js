import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import axios from 'axios';

// Deepgram needs the real container type; sending everything as audio/ogg made
// forwarded .wav/.mp3/.m4a notes fail.
const EXT_TO_MIME = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
    '.amr': 'audio/amr'
};

const detectMimeType = (filePath) => EXT_TO_MIME[path.extname(filePath).toLowerCase()] || 'audio/ogg';

export const transcribeAudio = async (filePath) => {
    try {
        // No key = can't transcribe. Return empty so the bot asks to re-record.
        // We never return fake text — a fake sentence could cause a wrong diagnosis.
        if (!process.env.DEEPGRAM_API_KEY) {
            return { text: '', language: '' };
        }

        if (!fs.existsSync(filePath)) {
            return { text: '', language: '' };
        }

        const audioBuffer = fs.readFileSync(filePath);
        const contentType = detectMimeType(filePath);

        const response = await axios.post(
            // nova-3 with detect_language + enhanced model for Indian languages.
            // We hint the most common Indian languages so Deepgram narrows its
            // search space — this prevents misdetection as Japanese/Chinese/Korean
            // which share similar phonetic patterns to some Indian languages at low
            // audio quality. detect_language still overrides the hint if confident.
            'https://api.deepgram.com/v1/listen?model=nova-3&detect_language=true' +
            '&language=hi&detect_language=true' +
            '&filler_words=false&smart_format=true',
            audioBuffer,
            {
                headers: {
                    'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
                    'Content-Type': contentType
                }
            }
        );

        const data = response.data;
        const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        const rawLang = data.results?.channels?.[0]?.detected_language || "hi";

        // Deepgram sometimes returns BCP-47 like "hi-Latn" or "gu-Deva" —
        // strip the script tag, keep only the base language code.
        const language = rawLang.split('-')[0].toLowerCase();

        return { text, language };
    } catch (error) {
        return { text: "", language: "" };
    }
};
