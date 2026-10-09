import React, { useRef, useState } from 'react';
import { Package, ShoppingBasket, ArrowLeft, Camera, X } from 'lucide-react';

// Seed Verification entry: mode choice plus photo-first intake.
// Honest UI only. No verification claim is ever rendered here.
// The backend conversation carries the real reply; this panel only
// starts the flow with contract-safe values (domain + mode cue words).
const MODES = [
  {
    id: 'branded',
    icon: Package,
    title: 'Branded / packet seed',
    body: 'Seed bought in a sealed company packet. Works from the packet photo, then visible details like brand, variety, lot and MRP.',
    needs: 'Needs: clear packet photo. No location needed.',
    cue: 'branded',
  },
  {
    id: 'open',
    icon: ShoppingBasket,
    title: 'Open / loose seed',
    body: 'Seed bought loose from a shop or dealer. Works from the seed photo, then seller name and price you paid.',
    needs: 'Needs: clear seed photo. No location needed.',
    cue: 'open seed',
  },
];

const SeedEntry = ({ onStartSeed, onBack, disabled = false }) => {
  const [mode, setMode] = useState(null);
  const [fileError, setFileError] = useState('');
  const [photo, setPhoto] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileRef = useRef(null);

  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  const pickPhoto = (file) => {
    if (!file || disabled) return;
    if (!file.type || !file.type.startsWith('image/')) {
      setFileError('Please choose an image file (photo of the seed or packet).');
      return;
    }
    if (file.size === 0) {
      setFileError('That file is empty. Please choose another photo.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError('Photo is larger than 10 MB. Please choose a smaller one.');
      return;
    }
    setFileError('');
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch { /* ignore */ }
    }
    setPhoto(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const clearPhoto = () => {
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch { /* ignore */ }
    }
    setPhoto(null);
    setPreviewUrl(null);
    setFileError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const canStart = mode && photo && !disabled;

  const start = () => {
    if (!canStart) return;
    onStartSeed({ mode, photo });
  };

  return (
    <div className="py-4 space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={disabled}
          aria-label="Back to crop diagnosis"
          className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-xs font-medium bg-surface text-ink border border-line hover:bg-mist disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          Crop diagnosis
        </button>
        <p className="font-mono-sc text-[11px] uppercase tracking-[0.14em] text-muted ml-auto">
          Seed verification
        </p>
      </div>

      <div>
        <p className="font-display text-lg font-semibold text-ink">Check seed before sowing</p>
        <p className="text-sm text-muted mt-1 max-w-[60ch]">
          Send a photo of the seed or packet. The assistant notes what is visible
          and asks for the next detail. Nothing here is a verdict: an unchecked
          item stays unchecked until a reviewer decides.
        </p>
      </div>

      <div role="radiogroup" aria-label="Seed type" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MODES.map((m) => {
          const selected = mode === m.id;
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => setMode(m.id)}
              className={`text-left p-4 rounded-input border min-h-[44px] transition-colors disabled:opacity-50 disabled:cursor-wait active:scale-[0.98] ${
                selected ? 'bg-accent text-accent-ink border-accent' : 'bg-surface text-ink border-line hover:bg-mist'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                <span className="text-sm font-medium">{m.title}</span>
              </span>
              <span className={`block text-[13px] mt-1.5 leading-relaxed ${selected ? 'opacity-90' : 'text-muted'}`}>
                {m.body}
              </span>
              <span className={`block text-[12px] mt-2 font-mono-sc ${selected ? 'opacity-80' : 'text-muted'}`}>
                {m.needs}
              </span>
            </button>
          );
        })}
      </div>

      {fileError && (
        <div role="alert" className="text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">
          {fileError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="image/*"
          ref={fileRef}
          disabled={!mode || disabled}
          onChange={(e) => pickPhoto(e.target.files && e.target.files[0])}
          className="hidden"
          id="seed-photo-upload"
          aria-label="Attach seed or packet photo"
        />
        <label
          htmlFor="seed-photo-upload"
          className={`inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-full text-sm font-medium border transition-colors ${
            !mode || disabled
              ? 'bg-mist text-muted border-line opacity-50 cursor-not-allowed'
              : 'cursor-pointer bg-surface text-ink border-line hover:bg-mist'
          }`}
        >
          <Camera size={16} strokeWidth={1.5} aria-hidden="true" />
          {photo ? 'Change photo' : mode ? 'Attach seed photo' : 'Pick a seed type first'}
        </label>
        {previewUrl && (
          <span className="relative inline-block">
            <img src={previewUrl} alt="Seed preview" className="h-16 rounded-input object-cover border border-line" />
            <button
              type="button"
              onClick={clearPhoto}
              aria-label="Remove seed photo"
              className="absolute -top-2 -right-2 bg-danger text-white rounded-full w-6 h-6 flex items-center justify-center hover:brightness-110 active:scale-[0.98]"
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={start}
        disabled={!canStart}
        className={`inline-flex items-center justify-center gap-2 px-5 py-2 min-h-[44px] rounded-full text-sm font-medium w-full sm:w-auto active:scale-[0.98] ${
          canStart ? 'bg-accent text-accent-ink hover:brightness-110' : 'bg-mist text-muted cursor-not-allowed'
        }`}
      >
        {disabled ? 'Sending...' : 'Start seed check'}
      </button>

      <p className="text-[12px] text-muted max-w-[60ch]">
        What happens next: the photo opens a seed case in the shared workspace.
        The assistant replies in the conversation below. Reference checks use
        internal sample data only, never official records.
      </p>
    </div>
  );
};

export default SeedEntry;
export { MODES };
