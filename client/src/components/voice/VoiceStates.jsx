import React from 'react';

// Presentation-only voice states for the future transport (Phase 3).
// These render ONLY with genuine state or real audio data. Nothing here
// fabricates transcription, processing success, or assistant audio.
// They are exported for reuse and are NOT mounted in production yet.

// Genuine processing indicator: mount only while a real STT/upload is in flight.
export const VoiceProcessing = ({ label = 'Processing voice…' }) => (
  <div className="flex items-center gap-2 py-2 shrink-0" role="status" aria-live="polite" aria-label={label}>
    <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex rounded-full h-3 w-3 bg-accent" />
    </span>
    <p className="text-xs text-muted">{label}</p>
  </div>
);

// Received assistant audio: mount only with a real audio URL from transport.
export const VoiceReply = ({ audioUrl, caption = 'Assistant voice reply' }) => {
  if (!audioUrl) return null;
  return (
    <div className="max-w-[80%] rounded-2xl p-3 border border-line bg-surface rounded-tl-none" aria-label={caption}>
      <audio controls src={audioUrl} className="w-full" aria-label={caption} />
    </div>
  );
};
