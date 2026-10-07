import express from 'express';
import { upload } from '../middlewares/multer.middleware.js';
import { handleImageUpload } from '../controllers/upload.controller.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';

const router = express.Router();

// 'image' is the only file field accepted — any other attachment is rejected
// by multer BEFORE the controller runs (and routed to the JSON error handler).
router.post('/upload', rateLimit, upload.single('image'), handleImageUpload);

export default router;
