import { processMessage } from '../services/agent.service.js';
import { serializeConversation } from '../services/session.service.js';

/**
 * Text / action messages with no image attachment.
 * Used by the web UI for: switching cases, answering the "same problem or new
 * problem?" question, and (later) a plain text chat box.
 */
export const handleChatMessage = async (req, res) => {
    try {
        const {
            sessionId = 'web_guest_user',
            source = 'web',
            text = '',
            action = null,
            caseId = null,
            language = null
        } = req.body || {};

        const aiResult = await processMessage({
            sessionId,
            source,
            text: typeof text === 'string' ? text.slice(0, 2000) : '',
            action,
            caseId,
            language
        });

        res.status(200).json({
            success: true,
            ai_response: aiResult.text,
            diagnostic: aiResult.diagnosticResult,
            conversation: serializeConversation(aiResult.conversation),
            needsClarification: aiResult.needsClarification || null
        });
    } catch (error) {
        console.error('Message Error:', error);
        res.status(500).json({ error: 'Failed to process message' });
    }
};