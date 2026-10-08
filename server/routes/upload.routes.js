import express from 'express';
import { upload } from '../middlewares/multer.middleware.js';
import { handleImageUpload } from '../controllers/upload.controller.js';

const router = express.Router();

// NOTE: rate limiting is applied once at app level in server.js (`app.use('/api',
// rateLimit, ...)`) — it must NOT be repeated here. Double-mounting counts every
// request twice against the same bucket and silently halves the effective limit.
// 'image' is the only file field accepted — any other attachment is rejected
// by multer BEFORE the controller runs (and routed to the JSON error handler).
router.post('/upload', upload.single('image'), handleImageUpload);

export default router;
