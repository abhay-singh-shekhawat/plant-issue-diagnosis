import React, { useState, useRef, useEffect } from 'react';
import { Camera, Send, X } from 'lucide-react';
import VoiceButton from '../voice/VoiceButton';
import useLocalRecorder from '../voice/useLocalRecorder';

const ChatInput = ({ onSendMessage, onSendText, disabled }) => {
    const [image, setImage] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [draft, setDraft] = useState('');
    const [isLocating, setIsLocating] = useState(false);
    const [isSendingText, setIsSendingText] = useState(false);
    const [fileError, setFileError] = useState('');
    // Mirrors isSendingRef (a non-rendering ref) in state so the Send button
    // reflects the guard during slow geolocation/IP fallback.
    const [sendingImage, setSendingImage] = useState(false);
    const fileInputRef = useRef(null);
    const isSendingRef = useRef(false);
    // M4 shared voice affordance: local recording only, never uploaded.
    // Same input serves crop + seed workspaces; location/photo rules unchanged.
    const recorder = useLocalRecorder();

    // Free the previous blob URL whenever the preview changes / unmounts —
    // otherwise every picked photo leaks blob memory for the tab lifetime.
    useEffect(() => {
        return () => {
            if (previewUrl) {
                try { URL.revokeObjectURL(previewUrl); } catch { /* ignore */ }
            }
        };
    }, [previewUrl]);

    const replacePreview = (file) => {
        setPreviewUrl((old) => {
            if (old) {
                try { URL.revokeObjectURL(old); } catch { /* ignore */ }
            }
            return file ? URL.createObjectURL(file) : null;
        });
    };

    // Client-side gate mirrors the server (multer: image/*, 10 MB). Rejecting
    // early avoids building an optimistic bubble that fails only after upload.
    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type || !file.type.startsWith('image/')) {
            setFileError('Please choose an image file (photo of the crop).');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        if (file.size === 0) {
            setFileError('That file is empty — please choose another photo.');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            setFileError('Photo is larger than 10 MB — please choose a smaller one.');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setFileError('');
        setImage(file);
        replacePreview(file);
        isSendingRef.current = false;
    };

    const handleSend = async (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        if (!image || isSendingRef.current) return;

        // Hold the send guard until the parent settles (not just fires):
        // releasing it synchronously after fire allowed double-click double
        // uploads. Visual state clears now; the guard releases in settleSend.
        isSendingRef.current = true;
        const imageToSend = image; // Take a snapshot and clear local state immediately
        const noteToSend = draft.trim(); // Optional caption typed next to the photo
        setIsLocating(true);
        setImage(null);
        replacePreview(null);
        setDraft('');
        if (fileInputRef.current) fileInputRef.current.value = '';

        const settleSend = () => {
            isSendingRef.current = false;
            setIsLocating(false);
        };

        const dispatchSend = (coordinates) => {
            try {
                const out = onSendMessage(imageToSend, coordinates, noteToSend);
                // Parent is async: release the guard when it settles so a second
                // pick+send during a long diagnosis is possible but never a
                // duplicate of THIS send (isSendingRef was true throughout).
                if (out && typeof out.finally === 'function') out.finally(settleSend);
                else settleSend();
            } catch (err) {
                console.error('Send dispatch failed:', err);
                settleSend();
            }
        };

        let hasProcessed = false; // Ensures onSendMessage is strictly called once
        let fallbackStarted = false; // Protects against browser firing multiple error callbacks

        const sendWithFallback = async () => {
            if (fallbackStarted) return;
            fallbackStarted = true;

            // IP fallback is best-effort with a hard timeout: a hung ipapi call
            // must never wedge the UI on "Sending...". Invalid payloads degrade
            // to null coords (the server asks for a location pin instead).
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            try {
                // Fallback to IP-based location if browser geolocation fails
                const response = await fetch('https://ipapi.co/json/', { signal: ctrl.signal });
                if (!response.ok) throw new Error(`ipapi HTTP ${response.status}`);
                const data = await response.json();
                const lat = Number(data && data.latitude);
                const lon = Number(data && data.longitude);
                if (!hasProcessed) {
                    hasProcessed = true;
                    dispatchSend(
                        Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
                    );
                }
            } catch (fallbackError) {
                console.error("Fallback location also failed", fallbackError);
                if (!hasProcessed) {
                    hasProcessed = true;
                    dispatchSend(null);
                }
            } finally {
                clearTimeout(timer);
            }
        };

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    if (hasProcessed) return;
                    hasProcessed = true;
                    const coordinates = {
                        lat: position.coords.latitude,
                        lon: position.coords.longitude
                    };
                    dispatchSend(coordinates);
                },
                (error) => {
                    console.warn(`Browser geolocation error (${error.code}): ${error.message}. Attempting fallback...`);
                    sendWithFallback();
                },
                { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
            );
        } else {
            console.warn("Geolocation not supported by browser. Attempting fallback...");
            sendWithFallback();
        }
    };

    const resetInput = () => {
        setImage(null);
        replacePreview(null);
        setIsLocating(false);
        setDraft('');
        setFileError('');
        isSendingRef.current = false;
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    // Plain-text follow-up answers (the confidence loop asks questions like
    // "what fertilizer did you use?" — previously unanswerable on web).
    const handleTextSend = async (e) => {
        if (e) e.preventDefault();
        const message = draft.trim();
        if (!message || isSendingText || isLocating || disabled) return;
        setIsSendingText(true);
        try {
            await onSendText(message);
            setDraft('');
        } finally {
            setIsSendingText(false);
        }
    };

    const handleTextKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleTextSend(e);
        }
    };

    const busy = isLocating || isSendingText || sendingImage || disabled;

    const guardedSend = (e) => {
        if (image) {
            if (isSendingRef.current) return;
            setSendingImage(true);
            Promise.resolve()
                .then(() => handleSend(e))
                .finally(() => setSendingImage(false));
        } else {
            handleTextSend(e);
        }
    };

    // M4 voice takeover: while recording/requesting/previewing, the composer
    // row is replaced by the full-width voice panel so nothing wraps on 390px.
    const voiceActive =
      recorder.status === 'recording' ||
      recorder.status === 'requesting' ||
      (recorder.status === 'preview' && recorder.audioUrl);

    // Acceptance fix: denied/unsupported are terminal states that never enter
    // the takeover panel, so their fallback must render as a visible line
    // under the composer. The text/photo form stays mounted and usable.
    const voiceBlocked =
      recorder.status === 'denied' || recorder.status === 'unsupported';

    return (
        <div className="py-3">
            {fileError && (
                <div role="alert" className="mb-2 text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">
                    {fileError}
                </div>
            )}
            {previewUrl && (
                <div className="mb-3 relative inline-block">
                    <img src={previewUrl} alt="Preview" className="h-32 rounded-input object-cover border border-line" />
                    <button
                        onClick={resetInput}
                        aria-label="Remove photo"
                        className="absolute -top-2 -right-2 bg-danger text-white rounded-full w-6 h-6 flex items-center justify-center hover:brightness-110 active:scale-[0.98]"
                    >
                        <X size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                </div>
            )}
            {voiceActive ? (
                <VoiceButton recorder={recorder} disabled={busy} />
            ) : (
            <form onSubmit={guardedSend} className="flex items-center gap-2">
                <input
                    type="file"
                    accept="image/*"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                    id="file-upload"
                    aria-label="Attach crop photo"
                />
                <label
                    htmlFor="file-upload"
                    className="cursor-pointer p-2 min-w-[44px] min-h-[44px] flex items-center justify-center shrink-0 text-muted hover:text-accent hover:bg-mist rounded-full transition-colors"
                    title="Attach Image"
                >
                    <Camera size={22} strokeWidth={1.5} aria-hidden="true" />
                </label>

                <label htmlFor="chat-draft" className="sr-only">Message</label>
                <input
                    id="chat-draft"
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleTextKeyDown}
                    placeholder={image ? 'Add a note…' : 'Type your answer…'}
                    disabled={busy}
                    className="flex-1 min-w-0 px-4 py-2 min-h-[44px] rounded-full border border-line bg-surface text-ink text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-mist disabled:text-muted"
                />

                {/* M4 shared voice affordance: inline mic, local recording only. */}
                <VoiceButton recorder={recorder} disabled={busy} inlineMic />

                <button
                    type="submit"
                    aria-label={busy ? 'Sending' : 'Send message'}
                    disabled={(image ? false : !draft.trim()) || busy}
                    className={`inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-sm font-medium shrink-0 active:scale-[0.98] ${(image ? false : !draft.trim()) || busy ? 'bg-mist text-muted cursor-not-allowed' : 'bg-accent text-accent-ink hover:brightness-110'}`}
                >
                    <Send size={15} strokeWidth={1.75} aria-hidden="true" />
                    {busy ? 'Sending...' : 'Send'}
                </button>
            </form>
            )}
            {voiceBlocked && recorder.error && (
                <p role="alert" className="mt-2 text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">
                    {recorder.error}
                </p>
            )}
        </div>
    );
};

export default ChatInput;
