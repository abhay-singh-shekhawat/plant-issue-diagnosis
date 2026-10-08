import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import uploadRoutes from './routes/upload.routes.js';
import messageRoutes from './routes/message.routes.js';
import { initializeWhatsAppClient, destroyWhatsAppClient } from './services/whatsapp.service.js';
import { startSessionSweeper } from './services/session.service.js';
import { startTempFileSweeper } from './services/cleanup.service.js';
import { rateLimit } from './middlewares/rateLimit.middleware.js';
import { notFound, errorHandler } from './middlewares/error.middleware.js';
import { envNum } from './env.js';
 
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Trust only an EXPLICIT number of proxy hops for req.ip (rate-limit key).
// Default 0 = direct client IP (safe for laptop/single-server runs; a shared
// proxy IP then shares one bucket — fail-closed, never fail-open). Set
// TRUST_PROXY_HOPS=1 behind one reverse proxy (nginx/Cloudflare) so real client
// IPs are keyed. Never blanket `trust proxy=true`: that lets any caller spoof
// X-Forwarded-For and dodge the limiter entirely.
{
    const hops = envNum('TRUST_PROXY_HOPS', 0);
    if (hops > 0) app.set('trust proxy', Math.floor(hops));
}

// Allowed origins (env-driven, backwards-compatible defaults)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://sc.sawinest.xyz,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Middleware
app.use(cors(
    {
        origin: CORS_ORIGINS, // Only these domains can access
        methods: 'GET,POST',
        optionsSuccessStatus: 200
    }
));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Important for form data

// Expose the user_img folders so frontend can load it
app.use('/user_img_web', express.static(path.join(__dirname, 'user_img_web')));
app.use('/user_img_whatsapp', express.static(path.join(__dirname, 'user_img_whatsapp')));

// Routes (rate-limited to protect paid API quotas).
// `rateLimit` runs BEFORE `uploadRoutes` so a rejected upload is refused at the
// rate-limit gate — multer never parses the multipart body and no orphan file
// lands on disk.
app.use('/api', rateLimit, uploadRoutes);
app.use('/api', rateLimit, messageRoutes);

app.get('/', (req, res) => {
    res.json({ message: 'Server is running' });
});

// 404 + terminal error handling (MUST come after all routes)
app.use(notFound);
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);

    // Background housekeeping: evict idle conversations + expired media files.
    startSessionSweeper();
    startTempFileSweeper();

    // Initialize WhatsApp Bot as soon as server starts
    // NOTE: This will log a QR code to your terminal that you must scan.
    // A WhatsApp/browser failure must NEVER take the HTTP API down, so this is
    // contained: on failure the server keeps running in WEB-ONLY mode.
    try {
        initializeWhatsAppClient();
    } catch (err) {
        console.error('[WhatsApp] Failed to start. Server will run in WEB-ONLY mode:', err.message);
    }
});

// Graceful shutdown so Chromium/Puppeteer children do not leak on restart.
let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);

    server.close(() => console.log('[Server] HTTP server closed.'));

    try {
        await destroyWhatsAppClient();
    } catch (err) {
        console.error('[Server] Error closing WhatsApp client:', err.message);
    }

    // Failsafe
    setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));