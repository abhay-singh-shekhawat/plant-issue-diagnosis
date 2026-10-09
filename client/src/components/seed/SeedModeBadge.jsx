import React from 'react';
import { Package, ShoppingBasket, Plus } from 'lucide-react';

// Mode indicator for an active seed conversation.
// Labels the USER's own selection only. Never a backend-confirmed state:
// the DTO carries no purchaseMode, so nothing here claims verification.
const LABEL = {
  branded: 'Branded / packet',
  open: 'Open / loose',
};

const SeedModeBadge = ({ mode, disabled = false, onNewCheck }) => (
  <div className="flex flex-wrap items-center gap-2 py-2 shrink-0">
    <span className="inline-flex items-center gap-1.5 px-3 py-1 min-h-[44px] rounded-full text-xs font-medium bg-mist text-ink border border-line">
      {mode === 'branded'
        ? <Package size={14} strokeWidth={1.5} aria-hidden="true" />
        : <ShoppingBasket size={14} strokeWidth={1.5} aria-hidden="true" />}
      You selected: {LABEL[mode] || mode}
    </span>
    <button
      type="button"
      onClick={onNewCheck}
      disabled={disabled}
      title="Open a fresh seed case in this workspace"
      className="inline-flex items-center gap-1 px-3 py-1 min-h-[44px] rounded-full text-xs font-medium bg-surface text-accent border border-accent hover:bg-mist disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
    >
      <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
      New seed check
    </button>
  </div>
);

export default SeedModeBadge;
