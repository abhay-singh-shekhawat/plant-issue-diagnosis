import React, { useState, useRef } from 'react';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import CaseSwitcher from './CaseSwitcher';

const SESSION_KEY = 'sc_session_id';

// Stable per-browser identity so every visitor gets their own conversation (and
// therefore their own set of diagnosis cases) instead of sharing one globally.
// When localStorage is blocked (private mode, disabled cookies) the id falls
// back to per-tab memory — still unique per visitor, so two blocked-storage
// users can never share one server session.
let memorySessionId = null;
const newSessionId = () => (
  window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
const getSessionId = () => {
  try {
    let id = window.localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newSessionId();
      window.localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    if (!memorySessionId) memorySessionId = newSessionId();
    return memorySessionId;
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

  // Single in-flight request: starting a new send aborts the previous one, so
  // a slow first response can never overwrite the state of a newer turn
  // (last-response-wins race). Each request gets a sequence number; only the
  // latest may touch conversation/clarification state.
  const inFlightRef = useRef(null);
  const seqRef = useRef(0);

  const startRequest = () => {
    try { inFlightRef.current?.controller?.abort(); } catch { /* ignore */ }
    const controller = new AbortController();
    const state = { timedOut: false };
    const seq = ++seqRef.current;
    const timeoutId = setTimeout(() => { state.timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    inFlightRef.current = { controller, seq };
    return { controller, state, seq, timeoutId };
  };

  const isCurrent = (controller) => inFlightRef.current?.controller === controller;

  const finishRequest = (controller, timeoutId) => {
    clearTimeout(timeoutId);
    if (isCurrent(controller)) {
      inFlightRef.current = null;
      setLoading(false);
    }
  };

  // Appends the agent reply and refreshes the case list / clarification state.
  // `seq` gates shared state: a superseded (aborted) response still appends its
  // bubble for transcript honesty but never moves the case/clarification state.
  // Every bubble is stamped with its caseId (AUD-017): the message list is
  // rendered per active case, so switching cases never shows stale bubbles
  // from another case. Unstamped bubbles (optimistic temp) always render.
  const applyAgentResult = (result, seq) => {
    const current = seq === undefined || seq === seqRef.current;
    const replyCaseId = result?.conversation?.activeCaseId || conversation?.activeCaseId || null;
    if (result?.ai_response) {
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-bot`,
        sender: 'bot',
        type: 'text',
        text: result.ai_response,
        timestamp: new Date().toISOString(),
        caseId: replyCaseId
      }]);
    }
    if (!current) return;
    if (result?.conversation) setConversation(result.conversation);
    setNeedsClarification(result?.needsClarification || null);
  };

  // Text-only messages (typed answers, case commands via keyboard) — no photo.
  // This is what makes the Phase-3 follow-up loop answerable on the web channel.
  // Sends are serialized: a new send aborts the previous request. The loser of
  // that race keeps its optimistic user bubble but only the winner may move
  // conversation/clarification state (see applyAgentResult seq gate).
  const handleSendText = async (message, optimisticText) => {
    const userMsg = {
      message_id: `${Date.now()}-user`,
      sender: 'web',
      type: 'text',
      text: optimisticText || message,
      timestamp: new Date().toISOString(),
      caseId: conversation?.activeCaseId || null
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    const { controller, state, seq, timeoutId } = startRequest();
    try {
      const response = await fetch(`${BACKEND_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, source: 'web', text: message }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!isCurrent(controller)) return; // superseded by a newer send
      if (response.ok) {
        applyAgentResult(result, seq);
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
      // Superseded sends die by abort — silent, the newer send owns the UI now.
      if (!isCurrent(controller)) return;
      console.error('Error sending text:', error);
      const aborted = error?.name === 'AbortError';
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: aborted
          ? (state.timedOut
            ? 'The request timed out. A diagnosis can take a while on slow networks — please try again.'
            : 'Cancelled — a newer message took over.')
          : 'Network error. Check if the backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      finishRequest(controller, timeoutId);
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
      timestamp: new Date().toISOString(),
      caseId: conversation?.activeCaseId || null
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

    const { controller, state, seq, timeoutId } = startRequest();

    try {
      // 3. Send request to backend
      const response = await fetch(`${BACKEND_URL}/api/upload`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      const result = await response.json().catch(() => ({}));

      // A superseded upload keeps its optimistic bubble (harmless preview) but
      // must not move case state — and must not roll anything back either: the
      // bubble belongs to a still-visible preview, not to the winning request.
      if (!isCurrent(controller)) {
        try { URL.revokeObjectURL(tempUrl); } catch { /* ignore */ }
        return;
      }

      if (response.ok) {
        // Update the temp message with real URL from server
        if (result?.data?.image_url) {
          setMessages((prev) =>
            prev.map(msg =>
              msg.message_id === tempId
                ? { ...msg, image_url: `${BACKEND_URL}${result.data.image_url}` }
                : msg
            )
          );
        }

        // Add the agent's reply + refresh case state
        applyAgentResult(result, seq);

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
      if (!isCurrent(controller)) {
        try { URL.revokeObjectURL(tempUrl); } catch { /* ignore */ }
        return; // superseded — the newer send owns the UI now
      }
      console.error('Error uploading image:', error);
      // Roll back the optimistic bubble on network errors / timeouts too.
      setMessages((prev) => prev.filter((msg) => msg.message_id !== tempId));
      const aborted = error?.name === 'AbortError';
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: aborted
          ? (state.timedOut
            ? 'The request timed out. A diagnosis can take a while on slow networks — please try again.'
            : 'Cancelled — a newer message took over.')
          : 'Network error. Check if the backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      // The blob URL was only needed for the instant preview — the server now
      // owns the image (success) or the bubble was removed (failure).
      try { URL.revokeObjectURL(tempUrl); } catch { /* ignore */ }
      finishRequest(controller, timeoutId);
    }
  };

  // Case actions that carry no photo: switch case, start a new case, or answer
  // the "same problem or new problem?" question. Single-flight like the sends:
  // a newer action supersedes an older one, and only the winner moves state.
  const handleAction = async (action, caseId = null) => {
    setLoading(true);
    const { controller, state, seq, timeoutId } = startRequest();
    try {
      const response = await fetch(`${BACKEND_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, source: 'web', action, caseId }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));

      if (!isCurrent(controller)) return; // superseded — newer action owns the UI
      if (response.ok) {
        applyAgentResult(result, seq);
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
      if (!isCurrent(controller)) return; // superseded — silent
      console.error('Error sending action:', error);
      const aborted = error?.name === 'AbortError';
      setMessages((prev) => [...prev, {
        message_id: `${Date.now()}-err`,
        sender: 'bot',
        type: 'text',
        text: aborted
          ? (state.timedOut ? 'The request timed out. Please try again.' : 'Cancelled — a newer action took over.')
          : 'Network error. Check if backend is running.',
        timestamp: new Date().toISOString()
      }]);
    } finally {
      finishRequest(controller, timeoutId);
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

      {/* Case switcher: one chip per open crop problem.
          Buttons are inert while a request is in flight — double-clicks would
          otherwise queue two superseding actions (second aborts the first). */}
      <CaseSwitcher
        conversation={conversation}
        busy={loading}
        onSelectCase={(id) => handleAction('switch', id)}
        onNewCase={() => handleAction('new')}
      />

      {/* Messages Area — filtered to the active case (AUD-017). Unstamped
          bubbles (optimistic temp, pre-fix history) always render so nothing
          ever vanishes; stamped bubbles render only for the active case. */}
      <ChatMessages
        messages={messages.filter((m) => !m.caseId || !conversation?.activeCaseId || m.caseId === conversation.activeCaseId)}
      />

      {/* "Same problem or new problem?" answer buttons — inert while busy. */}
      {needsClarification?.type === 'new_vs_same' && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 flex flex-wrap items-center gap-2 shrink-0">
          <span className="text-xs text-amber-800 mr-auto">Is this the same problem?</span>
          <button
            onClick={() => handleAction('same')}
            disabled={loading}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-amber-400 text-amber-800 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-wait"
          >
            Same problem
          </button>
          <button
            onClick={() => handleAction('new')}
            disabled={loading}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
          >
            New problem
          </button>
        </div>
      )}

      {/* Input Area — parent loading state drives the busy guard. */}
      <ChatInput
        onSendMessage={handleSendMessage}
        onSendText={handleSendText}
        disabled={loading}
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
