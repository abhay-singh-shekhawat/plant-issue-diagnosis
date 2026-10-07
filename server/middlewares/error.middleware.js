import multer from 'multer';

/** 404 for unknown routes — JSON, never Express' HTML error page. */
export const notFound = (req, res) => {
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
};

/**
 * Terminal error handler.
 * Without this, multer rejections (and any thrown error) fall through to
 * Express' default handler, which returns an HTML page with a stack trace —
 * the browser then fails on `response.json()` and shows a bogus "network error".
 */
export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Image is too large. Maximum size is 10MB.'
            : `Upload rejected: ${err.code}`;
        return res.status(400).json({ error: message });
    }

    // Thrown by multer's fileFilter for non-image uploads
    if (err && typeof err.message === 'string' && /only image files/i.test(err.message)) {
        return res.status(400).json({ error: 'Only image files are allowed.' });
    }

    console.error('[Error]', err);
    res.status(err?.status || 500).json({ error: 'Internal Server Error' });
};