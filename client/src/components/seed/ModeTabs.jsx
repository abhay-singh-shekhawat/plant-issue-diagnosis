import React from 'react';

// Workspace switcher: crop diagnosis vs seed verification.
// Default view is crop. Pure view state, no backend call.
const TABS = [
  { id: 'crop', label: 'Crop diagnosis', hint: 'Photo + location' },
  { id: 'seed', label: 'Seed verification', hint: 'Photo only' },
];

const ModeTabs = ({ view = 'crop', onChange, disabled = false }) => (
  <div role="tablist" aria-label="Workspace" className="flex gap-2 py-2 shrink-0">
    {TABS.map((t) => {
      const active = view === t.id;
      return (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active}
          disabled={disabled}
          onClick={() => onChange(t.id)}
          className={`flex-1 inline-flex flex-col items-start gap-0.5 px-4 py-2 min-h-[44px] rounded-input border text-left transition-colors disabled:opacity-50 disabled:cursor-wait active:scale-[0.98] ${
            active
              ? 'bg-accent text-accent-ink border-accent'
              : 'bg-surface text-ink border-line hover:bg-mist'
          }`}
        >
          <span className="text-sm font-medium leading-tight">{t.label}</span>
          <span className={`text-[11px] leading-tight font-mono-sc ${active ? 'opacity-80' : 'text-muted'}`}>
            {t.hint}
          </span>
        </button>
      );
    })}
  </div>
);

export default ModeTabs;
