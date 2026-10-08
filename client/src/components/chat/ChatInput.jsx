import React, { useState, useRef, useEffect } from 'react';

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

    return (
        <div className="p-4 bg-white border-t border-gray-200 sticky bottom-0">
            {fileError && (
                <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {fileError}
                </div>
            )}
            {previewUrl && (
                <div className="mb-4 relative inline-block">
                    <img src={previewUrl} alt="Preview" className="h-32 rounded-lg object-cover border border-gray-300" />
                    <button
                        onClick={resetInput}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                    >
                        ×
                    </button>
                </div>
            )}
            <form onSubmit={guardedSend} className="flex items-center gap-2">
                <input
                    type="file"
                    accept="image/*"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                    id="file-upload"
                />
                <label
                    htmlFor="file-upload"
                    className="cursor-pointer p-2 text-gray-500 hover:text-blue-500 hover:bg-blue-50 rounded-full transition-colors"
                    title="Attach Image"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                    </svg>
                </label>

                <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleTextKeyDown}
                    placeholder={image ? 'Add a note (optional)…' : 'Type your answer or describe the problem…'}
                    disabled={busy}
                    className="flex-1 min-w-0 px-3 py-2 rounded-full border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                />

                <button
                    type="submit"
                    disabled={(image ? false : !draft.trim()) || busy}
                    className={`px-4 py-2 rounded-full font-medium ${(image ? false : !draft.trim()) || busy ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                >
                    {busy ? 'Sending...' : 'Send'}
                </button>
            </form>
        </div>
    );
};

export default ChatInput;
