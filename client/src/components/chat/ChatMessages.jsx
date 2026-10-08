import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

const ChatMessages = ({ messages }) => {
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50 flex flex-col">
      {messages.length === 0 ? (
        <div className="m-auto text-gray-400 flex flex-col items-center">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 mb-2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <p>Upload a photo of your crop to get started.</p>
        </div>
      ) : (
        messages.map((msg, index) => (
          <div
            // Stable identity per bubble: index keys mis-associate bubbles with
            // timestamps after the optimistic filter-rollback on failed sends.
            key={msg.message_id || `msg-${index}`}
            className={`flex ${msg.sender === 'web' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[75%] rounded-2xl p-3 shadow-sm ${msg.sender === 'web' ? 'bg-blue-100 rounded-tr-none' : 'bg-white border rounded-tl-none'}`}>
              
              {/* If it's an image message */}
              {msg.type === 'image' && (
                <div className="mb-2">
                  <img src={msg.image_url} alt="Crop" className="rounded-xl w-full max-w-sm object-cover" />
                </div>
              )}
              
              {/* Show coordinates (if any exist) */}
              {msg.coordinates && msg.sender === 'web' &&
                Number.isFinite(Number(msg.coordinates.lat)) &&
                Number.isFinite(Number(msg.coordinates.lon)) && (
                  <div className="text-xs text-blue-800 bg-blue-50 mt-1 p-2 rounded flex items-center gap-1 opacity-80">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                          <path fillRule="evenodd" d="m9.69 18.933.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 0 0 .281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.273 1.765 11.842 11.842 0 0 0 .976.544l.062.029.018.008.006.003ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" clipRule="evenodd" />
                      </svg>
                      Lat: {Number(msg.coordinates.lat).toFixed(4)}, Lon: {Number(msg.coordinates.lon).toFixed(4)}
                  </div>
              )}

              {/* Text part of message if available (agent replies are Markdown).
                  Explicit urlTransform (same policy as react-markdown's default):
                  only http/https/mailto links and images load; javascript:/data:
                  URIs from model output render as plain text. Pinned here so the
                  guarantee survives library upgrades, not just today's default. */}
              {msg.text && (
                  <div className="text-sm text-gray-800 whitespace-pre-wrap prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-headings:my-1">
                    <ReactMarkdown urlTransform={(url) => (/^(https?|mailto):/i.test(url) || url.startsWith('/') || url.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : '')}>{msg.text}</ReactMarkdown>
                  </div>
              )}

              <span className="text-[10px] text-gray-400 mt-2 block text-right">
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
