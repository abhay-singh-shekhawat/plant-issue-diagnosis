import React, { useState } from 'react';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import CaseSwitcher from './CaseSwitcher';

const SESSION_KEY = 'sc_session_id';

// Stable per-browser identity so every visitor gets their own conversation (and
// therefore their own set of diagnosis cases) instead of sharing one globally.
const getSessionId = () => {
  try {
    let id = window.localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return 'web_guest_user';
  }
};

// How long a diagnosis round-trip may take before the UI stops waiting.
// Gemini + weather + soil can take a while on slow networks, so this is
// generous. Reads VITE_REQUEST_TIMEOUT_MS when set (milliseconds).
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS) || 90000;

const ChatContainer = () => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [needsClarification, setNeedsClarification] = useState(null);
  const [sessionId] = useState(getSessionId);

  const BACKEND_URL = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:4000';

  // Appends the agent reply and refreshes the case list / clarification state.
  const applyAgentResult = (result) => {
    if (result?.ai_response) {
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-bot`,
        sender: 'bot',
        type: 'text',
        text: result.ai_response,
        timestamp: new Date().toISOString()
      }]);
    }
    if (result?.conversation) setConversation(result.conversation);
    setNeedsClarification(result?.needsClarification || null);
  };

  // Text-only messages (typed answers, case commands via keyboard) — no photo.
  // This is what makes the Phase-3 follow-up loop answerable on the web channel.
  const handleSendText = async (message, optimisticText) => {
    const userMsg = {
      message_id: `${Date.now()}-user`,
      sender: 'web',
      type: 'text',
      text: optimisticText || message,
      timestamp: new Date().toISOString()
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${BACKEND_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, source: 'web', text: message }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        applyAgentResult(result);
      } else if (response.status === 429) {
        // Rate-limited: surface the server's message instead of a generic error.
        setMessages((prev) => [...prev, {
          message_id: `${Date.now()}-err`,
          sender: 'bot',
          type: 'text',
          text: result?.error || 'Too many requests. Please wait a minute and try again.',
          timestamp: new Date().toISOString()
        }]);
      } else {
        setMessages((prev) => [...prev, {
          message_id: `${Date.now()}-err`,
          sender: 'bot',
          type: 'text',
          text: result?.error || 'Could not process that message.',
          timestamp: new Date().toISOString()
        }]);
      }
    } catch (error) {
      console.error('Error sending text:', error);
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: error?.name === 'AbortError'
          ? 'The request timed out. A diagnosis can take a while on slow networks — please try again.'
          : 'Network error. Check if the backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  const handleSendMessage = async (imageFile, coordinates, note = '') => {
    // 1. Optimistically add message to UI (without full URL yet)
    const tempId = Date.now().toString();
    const tempUrl = URL.createObjectURL(imageFile);

    const newMessage = {
      message_id: tempId,
      sender: 'web',
      type: 'image',
      image_url: tempUrl,
      coordinates: coordinates,
      text: typeof note === 'string' && note.trim() ? note.trim() : undefined,
      timestamp: new Date().toISOString()
    };

    setMessages((prev) => [...prev, newMessage]);
    setLoading(true);

    // 2. Prepare FormData
    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('source', 'web');
    formData.append('sessionId', sessionId);
    if (newMessage.text) {
      formData.append('text', newMessage.text);
    }
    if (coordinates) {
      formData.append('coordinates', JSON.stringify(coordinates));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // 3. Send request to backend
      const response = await fetch(`${BACKEND_URL}/api/upload`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        // Update the temp message with real URL from server
        setMessages((prev) =>
          prev.map(msg =>
            msg.message_id === tempId
              ? { ...msg, image_url: `${BACKEND_URL}${result.data.image_url}` }
              : msg
          )
        );

        // Add the agent's reply + refresh case state
        applyAgentResult(result);

      } else {
        console.error('Upload failed:', result.error);
        // Roll back the optimistic bubble so a failed upload leaves no phantom photo.
        setMessages((prev) => prev.filter((msg) => msg.message_id !== tempId));
        // Surface a specific message where we can, instead of a bare alert().
        setMessages((prev) => [...prev, {
          message_id: `${Date.now()}-err`,
          sender: 'bot',
          type: 'text',
          text: result?.error || 'Failed to upload image.',
          timestamp: new Date().toISOString()
        }]);
      }
    } catch (error) {
      console.error('Error uploading image:', error);
      // Roll back the optimistic bubble on network errors / timeouts too.
      setMessages((prev) => prev.filter((msg) => msg.message_id !== tempId));
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: error?.name === 'AbortError'
          ? 'The request timed out. A diagnosis can take a while on slow networks — please try again.'
          : 'Network error. Check if the backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      clearTimeout(timeoutId);
      // The blob URL was only needed for the instant preview — the server now
      // owns the image (success) or the bubble was removed (failure).
      try { URL.revokeObjectURL(tempUrl); } catch { /* ignore */ }
      setLoading(false);
    }
  };

  // Case actions that carry no photo: switch case, start a new case, or answer
  // the "same problem or new problem?" question.
  const handleAction = async (action, caseId = null) => {
    setLoading(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${BACKEND_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, source: 'web', action, caseId }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        applyAgentResult(result);
      } else {
        console.error('Action failed:', result.error);
        setMessages((prev) => [...prev, {
          message_id: `${Date.now()}-err`,
          sender: 'bot',
          type: 'text',
          text: result?.error || 'Could not process that action.',
          timestamp: new Date().toISOString()
        }]);
      }
    } catch (error) {
      console.error('Error sending action:', error);
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: error?.name === 'AbortError'
          ? 'The request timed out. Please try again.'
          : 'Network error. Check if backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  return (
    <div className="relative flex flex-col h-screen max-w-2xl mx-auto border-x border-gray-200 bg-white shadow-xl">
      {/* Header */}
      <div className="p-4 bg-blue-600 text-white font-semibold flex items-center gap-3 shrink-0 rounded-b-md shadow-sm z-10">
        <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center">
            <span className="text-xl">🌱</span>
        </div>
        <div>
            <h2>Crop Disease Detection</h2>
            <p className="text-xs text-blue-100">Upload a photo for diagnosis</p>
        </div>
      </div>

      {/* Case switcher: one chip per open crop problem */}
      <CaseSwitcher
        conversation={conversation}
        onSelectCase={(id) => handleAction('switch', id)}
        onNewCase={() => handleAction('new')}
      />

      {/* Messages Area */}
      <ChatMessages messages={messages} />

      {/* "Same problem or new problem?" answer buttons */}
      {needsClarification?.type === 'new_vs_same' && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 flex flex-wrap items-center gap-2 shrink-0">
          <span className="text-xs text-amber-800 mr-auto">Is this the same problem?</span>
          <button
            onClick={() => handleAction('same')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-amber-400 text-amber-800 hover:bg-amber-100"
          >
            Same problem
          </button>
          <button
            onClick={() => handleAction('new')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            New problem
          </button>
        </div>
      )}

      {/* Input Area */}
      <ChatInput
        onSendMessage={handleSendMessage}
        onSendText={handleSendText}
        disabled={false}
      />

      {loading && (
          <div className="absolute bottom-20 right-4 pointer-events-none">
            <span className="flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </span>
          </div>
      )}
    </div>
  );
};

export default ChatContainer;
