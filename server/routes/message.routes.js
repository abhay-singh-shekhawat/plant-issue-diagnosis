import express from 'express';
import { handleChatMessage } from '../controllers/message.controller.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';

const router = express.Router();

// Text / case-action messages (no image attachment)
router.post('/message', rateLimit, handleChatMessage);

export default router;