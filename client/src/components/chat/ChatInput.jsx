import React, { useState, useRef, useEffect } from 'react';

const ChatInput = ({ onSendMessage, onSendText, disabled }) => {
    const [image, setImage] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [draft, setDraft] = useState('');
    const [isLocating, setIsLocating] = useState(false);
    const [isSendingText, setIsSendingText] = useState(false);
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

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setImage(file);
            replacePreview(file);
            isSendingRef.current = false;
        }
    };

    const handleSend = async (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        if (!image || isSendingRef.current) return;

        isSendingRef.current = true;
        const imageToSend = image; // Take a snapshot and clear local state immediately
        const noteToSend = draft.trim(); // Optional caption typed next to the photo
        setIsLocating(true);
        
        let hasProcessed = false; // Ensures onSendMessage is strictly called once
        let fallbackStarted = false; // Protects against browser firing multiple error callbacks

        const sendWithFallback = async () => {
            if (fallbackStarted) return;
            fallbackStarted = true;

            try {
                // Fallback to IP-based location if browser geolocation fails
                const response = await fetch('https://ipapi.co/json/');
                const data = await response.json();
                if (data && data.latitude && data.longitude) {
                    if (!hasProcessed) {
                        hasProcessed = true;
                        onSendMessage(imageToSend, { lat: data.latitude, lon: data.longitude }, noteToSend);
                        resetInput();
                    }
                } else {
                    if (!hasProcessed) {
                        hasProcessed = true;
                        onSendMessage(imageToSend, null, noteToSend);
                        resetInput();
                    }
                }
            } catch (fallbackError) {
                console.error("Fallback location also failed", fallbackError);
                if (!hasProcessed) {
                    hasProcessed = true;
                    onSendMessage(imageToSend, null, noteToSend);
                    resetInput();
                }
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
                    onSendMessage(imageToSend, coordinates, noteToSend);
                    resetInput();
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

    const busy = isLocating || isSendingText || disabled;

    return (
        <div className="p-4 bg-white border-t border-gray-200 sticky bottom-0">
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
            <form onSubmit={(e) => (image ? handleSend(e) : handleTextSend(e))} className="flex items-center gap-2">
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
                    disabled={(image ? false : !draft.trim()) || isLocating || isSendingText}
                    className={`px-4 py-2 rounded-full font-medium ${(image ? false : !draft.trim()) || isLocating || isSendingText ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                >
                    {isLocating ? 'Sending...' : 'Send'}
                </button>
            </form>
        </div>
    );
};

export default ChatInput;
