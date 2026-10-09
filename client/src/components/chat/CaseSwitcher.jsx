import React from 'react';
import { Plus } from 'lucide-react';
import StatusDot from '../ui/StatusDot';

// Maps case status to the StatusDot palette (dot never renders alone).
const STATUS_KEY = {
  completed: 'completed',
  evaluating_confidence: 'evaluating',
  gathering_info: 'gathering'
};

/**
 * Horizontal strip of the farmer's open cases (crop problems).
 * Lets them jump between two diseases at once, or start a brand new problem.
 */
const CaseSwitcher = ({ conversation, busy = false, onSelectCase, onNewCase }) => {
  const cases = conversation?.cases || [];
  if (cases.length === 0) return null;

  return (
    <div className="py-2 border-b border-line flex items-center gap-2 overflow-x-auto shrink-0" role="tablist" aria-label="Cases">
      <span className="text-xs font-medium text-muted shrink-0 font-mono-sc uppercase tracking-[0.14em]">Cases</span>

      {cases.map((c, index) => {
        const isActive = c.caseId === conversation.activeCaseId;
        return (
          <button
            key={c.caseId}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelectCase(c.caseId)}
            disabled={busy}
            title={`${c.label} (${c.status})`}
            className={`flex items-center gap-1.5 px-3 py-1 min-h-[44px] rounded-full text-xs whitespace-nowrap border transition-colors disabled:opacity-50 disabled:cursor-wait active:scale-[0.98] ${
              isActive
                ? 'bg-accent text-accent-ink border-accent'
                : 'bg-surface text-ink border-line hover:bg-mist'
            }`}
          >
            <span className="font-semibold font-mono-sc">{index + 1}</span>
            <span className="max-w-[140px] truncate">{c.label}</span>
            <StatusDot status={STATUS_KEY[c.status] || 'gathering'} label="" />
          </button>
        );
      })}

      <button
        onClick={onNewCase}
        disabled={busy}
        className="ml-auto shrink-0 inline-flex items-center gap-1 px-3 py-1 min-h-[44px] rounded-full text-xs border border-accent text-accent hover:bg-mist whitespace-nowrap disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
      >
        <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
        New problem
      </button>
    </div>
  );
};

export default CaseSwitcher;