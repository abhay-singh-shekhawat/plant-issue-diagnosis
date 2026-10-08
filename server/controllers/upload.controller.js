import fs from 'fs';
import { processMessage } from '../services/agent.service.js';
import { serializeConversation, normalizeCoordinates } from '../services/session.service.js';
import { validateImageUpload } from '../file-validate.js';

// Multer writes the file to disk BEFORE this handler runs, so every early
// 400 / 500 return must delete the orphan or user_img_web/ grows forever.
const deleteOrphanUpload = (req) => {
    try {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch { /* ignore */ }
};

export const handleImageUpload = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        // Content validation on the saved bytes — the security boundary.
        // MIME headers and filename extensions are both attacker-controlled,
        // so neither is trusted: the magic bytes decide what the file is.
        const verdict = validateImageUpload(req.file);
        if (!verdict.ok) {
            deleteOrphanUpload(req);
            return res.status(400).json({ error: verdict.error });
        }

        const {
            source,
            coordinates: rawCoordinates,
            sessionId = null,
            action = null,
            caseId = null,
            text = ''
        } = req.body;

        // No shared guest bucket (see message.controller.js).
        if (typeof sessionId !== 'string' || !sessionId.trim()) {
            deleteOrphanUpload(req);
            return res.status(400).json({ error: 'sessionId is required' });
        }
        let coordinates = null;

        // since it might be stringified from multipart/form-data
        if (rawCoordinates) {
            try {
                coordinates = typeof rawCoordinates === 'string' ? JSON.parse(rawCoordinates) : rawCoordinates;
            } catch (e) {
                deleteOrphanUpload(req);
                return res.status(400).json({ error: 'Invalid coordinates format' });
            }
            // Malformed values (non-numeric, out-of-range) are rejected here so
            // they can never flow into weather URLs, soil math, or the LLM prompt.
            coordinates = normalizeCoordinates(coordinates);
            if (!coordinates) {
                deleteOrphanUpload(req);
                return res.status(400).json({ error: 'Invalid coordinates: lat must be -90..90, lon -180..180 (finite numbers)' });
            }
        }

        const fileUrl = `/user_img_web/${req.file.filename}`;

        console.log(JSON.stringify({
            source: source || 'web',
            has_text: typeof text === 'string' && text.trim().length > 0,
            has_coordinates: !!coordinates
        }));

        // Run the agent process for the Web user
        const aiResult = await processMessage({
            sessionId: sessionId,
            source: source || 'web',
            text: typeof text === 'string' ? text.slice(0, 2000) : '',
            imageUrl: fileUrl,
            coordinates: coordinates,
            action: action || null,
            caseId: caseId || null
        });

        // Creating response mimicking chat payload behavior (including the AI's intelligent text)
        const responsePayload = {
            success: true,
            data: {
                message_id: Date.now().toString(),
                sender: source || 'web',
                type: 'image',
                image_url: fileUrl,
                coordinates: coordinates,
                timestamp: new Date().toISOString()
            },
            message: 'Image successfully uploaded for chat',
            ai_response: aiResult.text,
            diagnostic: aiResult.diagnosticResult,
            conversation: serializeConversation(aiResult.conversation),
            needsClarification: aiResult.needsClarification || null
        };

        res.status(200).json(responsePayload);
    } catch (error) {
        console.error('Upload Error:', error);
        // The agent failed AFTER multer saved the file — it is NOT referenced by
        // any case (processMessage threw before attachImage), so delete it.
        deleteOrphanUpload(req);
        res.status(500).json({ error: 'Failed to process upload' });
    }
};
