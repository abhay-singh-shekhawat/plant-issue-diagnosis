import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Camera, MapPin } from 'lucide-react';

const ChatMessages = ({ messages }) => {
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto py-4 space-y-4 flex flex-col">
      {messages.length === 0 ? (
        <div className="m-auto text-muted flex flex-col items-center text-center px-6">
            <span className="w-14 h-14 rounded-full bg-mist flex items-center justify-center mb-3" aria-hidden="true">
              <Camera size={24} strokeWidth={1.5} className="text-muted" />
            </span>
            <p className="font-display text-lg font-semibold text-ink">Start with a photo</p>
            <p className="text-sm text-muted mt-1 max-w-[40ch]">Upload a photo of your crop to get started. Location is collected automatically for diagnosis.</p>
            <button
              type="button"
              onClick={() => document.getElementById('file-upload')?.click()}
              className="mt-4 inline-flex items-center gap-2 px-5 py-2 min-h-[44px] rounded-full text-sm font-medium bg-accent text-accent-ink hover:brightness-110 active:scale-[0.98]"
            >
              <Camera size={16} strokeWidth={1.75} aria-hidden="true" />
              Upload crop photo
            </button>
        </div>
      ) : (
        messages.map((msg, index) => (
          <div
            // Stable identity per bubble: index keys mis-associate bubbles with
            // timestamps after the optimistic filter-rollback on failed sends.
            key={msg.message_id || `msg-${index}`}
            className={`flex ${msg.sender === 'web' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[80%] rounded-2xl p-3 border border-line ${msg.sender === 'web' ? 'bg-mist rounded-tr-none' : 'bg-surface rounded-tl-none'}`}>

              {/* If it's an image message */}
              {msg.type === 'image' && (
                <div className="mb-2">
                  <img src={msg.image_url} alt="Crop" className="rounded-input w-full max-w-sm object-cover border border-line" />
                </div>
              )}

              {/* Show coordinates (if any exist) */}
              {msg.coordinates && msg.sender === 'web' &&
                Number.isFinite(Number(msg.coordinates.lat)) &&
                Number.isFinite(Number(msg.coordinates.lon)) && (
                  <div className="text-xs text-muted bg-paper mt-1 p-2 rounded-input border border-line flex items-center gap-1.5">
                      <MapPin size={12} strokeWidth={1.5} aria-hidden="true" />
                      <span className="font-mono-sc">
                        Lat: {Number(msg.coordinates.lat).toFixed(4)}, Lon: {Number(msg.coordinates.lon).toFixed(4)}
                      </span>
                  </div>
              )}

              {/* Text part of message if available (agent replies are Markdown).
                  Explicit urlTransform (same policy as react-markdown's default):
                  only http/https/mailto links and images load; javascript:/data:
                  URIs from model output render as plain text. Pinned here so the
                  guarantee survives library upgrades, not just today's default. */}
              {msg.text && (
                  <div className="text-sm text-ink whitespace-pre-wrap prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-headings:my-1">
                    <ReactMarkdown urlTransform={(url) => (/^(https?|mailto):/i.test(url) || url.startsWith('/') || url.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : '')}>{msg.text}</ReactMarkdown>
                  </div>
              )}

              <span className="text-[10px] text-muted mt-2 block text-right font-mono-sc">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatMessages;
