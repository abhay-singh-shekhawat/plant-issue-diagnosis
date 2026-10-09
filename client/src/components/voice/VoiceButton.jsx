import React from 'react';
import { Mic, Square, X } from 'lucide-react';

// Shared voice affordance for crop + seed workspaces.
// Idle mic, recording timer with stop/cancel, local preview with playback.
// Honest states only: denied / unsupported / local-not-sent. No uploads,
// no transcription claims, no fabricated assistant audio.
const VoiceButton = ({ recorder, disabled = false, compact = false, inlineMic = false }) => {
  const { status, elapsed, audioUrl, error, start, stop, cancel, discardPreview } = recorder;
  const busy = disabled;

  // Inline mode: mic button only, for embedding in the composer row.
  // Parent swaps the whole composer to the block states below when active.
  if (inlineMic) {
    if (status === 'recording' || status === 'requesting' || (status === 'preview' && audioUrl)) return null;
    return (
      <button
        type="button"
        onClick={start}
        disabled={busy}
        title={
          status === 'denied'
            ? 'Microphone was denied. Allow access in the browser, or use text and photo.'
            : status === 'unsupported'
              ? 'Recording is not supported in this browser. Use text and photo.'
              : 'Record a voice note locally. Nothing is uploaded.'
        }
        aria-label="Record voice note locally"
        className="inline-flex items-center justify-center p-2 min-w-[44px] min-h-[44px] rounded-full text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] bg-surface text-muted border border-line hover:text-accent hover:bg-mist shrink-0"
      >
        <Mic size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  }

  if (status === 'preview' && audioUrl) {
    return (
      <div className="flex flex-col gap-2 py-2 shrink-0" aria-label="Voice recording preview">
        <div className="flex items-center gap-2 p-2 rounded-input border border-line bg-surface">
          <span className="w-9 h-9 rounded-full bg-accent text-accent-ink flex items-center justify-center shrink-0" aria-hidden="true">
            <Mic size={16} strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink truncate">Local recording, not sent</p>
            <p className="text-[11px] text-muted font-mono-sc">{elapsed} • stays on this device</p>
          </div>
          <button
            type="button"
            onClick={discardPreview}
            aria-label="Discard local recording"
            className="inline-flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-full text-xs font-medium bg-surface text-ink border border-line hover:bg-mist active:scale-[0.98]"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
            Discard
          </button>
        </div>
        <audio controls src={audioUrl} className="w-full" aria-label="Play local recording preview" />
        {error && (
          <p role="alert" className="text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">{error}</p>
        )}
      </div>
    );
  }

  if (status === 'recording' || status === 'requesting') {
    const live = status === 'recording';
    return (
      <div className="flex flex-col gap-2 py-2 shrink-0" aria-label="Voice recording in progress" aria-live="polite">
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-60" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-danger" />
          </span>
          <p className="text-sm font-medium text-ink font-mono-sc" aria-label={`Recording ${elapsed}`}>
            {live ? elapsed : 'Starting…'}
          </p>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={stop}
              disabled={!live}
              aria-label="Stop recording"
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-xs font-medium bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
            >
              <Square size={13} strokeWidth={2} aria-hidden="true" />
              Stop
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel recording"
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-xs font-medium bg-surface text-ink border border-line hover:bg-mist active:scale-[0.98]"
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
              Cancel
            </button>
          </span>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={start}
          disabled={busy}
          title={
            status === 'denied'
              ? 'Microphone was denied. Allow access in the browser, or use text and photo.'
              : status === 'unsupported'
                ? 'Recording is not supported in this browser. Use text and photo.'
                : 'Record a voice note locally. Nothing is uploaded.'
          }
          aria-label="Record voice note locally"
          className={`inline-flex items-center ${compact ? 'justify-center p-2 min-w-[44px]' : 'gap-1.5 px-4'} py-2 min-h-[44px] rounded-full text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] bg-surface text-muted border border-line hover:text-accent hover:bg-mist`}
        >
          <Mic size={compact ? 20 : 16} strokeWidth={1.5} aria-hidden="true" />
          {!compact && 'Voice'}
        </button>
        {(status === 'denied' || status === 'unsupported') && (
          <p className="text-[11px] text-muted flex-1">
            {status === 'denied'
              ? 'Mic denied. Text and photo still work.'
              : 'Not supported here. Text and photo still work.'}
          </p>
        )}
      </div>
      {error && status !== 'preview' && (
        <p role="alert" className="text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">{error}</p>
      )}
    </div>
  );
};

export default VoiceButton;
