import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure user_img directory exists
const targetDir = path.join(__dirname, '..', 'user_img_web');
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, targetDir);
    },
    filename: function (req, file, cb) {
        // Cryptographically random so filenames cannot be guessed/enumerated.
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
        cb(null, 'web-' + file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    // Accept only image files
    if (file.mimetype && file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};

export const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 1,                   // one image per request
        fields: 10,                 // cap non-file form fields
        fieldSize: 10 * 1024        // cap each field (coordinates JSON etc.)
    }
});
