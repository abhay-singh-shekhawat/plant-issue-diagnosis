import express from 'express';
import { handleChatMessage } from '../controllers/message.controller.js';

const router = express.Router();

// NOTE: rate limiting lives at app level in server.js — not repeated here
// (see upload.routes.js; double-mounting would halve the effective limit).
// Text / case-action messages (no image attachment)
router.post('/message', handleChatMessage);

export default router;