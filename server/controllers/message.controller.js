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
            sessionId = null,
            source = 'web',
            text = '',
            action = null,
            caseId = null,
            language = null,
            domain = null,
            messageId = null,
            seedHints = []
        } = req.body || {};

        // No shared guest bucket: every caller must identify its own session.
        // The web UI always sends a per-browser UUID; WhatsApp sends the JID.
        if (typeof sessionId !== 'string' || !sessionId.trim()) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        const aiResult = await processMessage({
            sessionId,
            source,
            text: typeof text === 'string' ? text.slice(0, 2000) : '',
            action,
            caseId,
            language,
            domain: typeof domain === 'string' && domain.trim() ? domain : null,
            messageId: typeof messageId === 'string' && messageId.trim() ? messageId : null,
            seedHints: Array.isArray(seedHints) ? seedHints : []
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