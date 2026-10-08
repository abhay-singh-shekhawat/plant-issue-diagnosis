import React from 'react';

const STATUS_DOT = {
  completed: 'bg-green-400',
  evaluating_confidence: 'bg-amber-400',
  gathering_info: 'bg-gray-400'
};

/**
 * Horizontal strip of the farmer's open cases (crop problems).
 * Lets them jump between two diseases at once, or start a brand new problem.
 */
const CaseSwitcher = ({ conversation, busy = false, onSelectCase, onNewCase }) => {
  const cases = conversation?.cases || [];
  if (cases.length === 0) return null;

  return (
    <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex items-center gap-2 overflow-x-auto shrink-0">
      <span className="text-xs font-medium text-gray-500 shrink-0">Cases:</span>

      {cases.map((c, index) => {
        const isActive = c.caseId === conversation.activeCaseId;
        return (
          <button
            key={c.caseId}
            onClick={() => onSelectCase(c.caseId)}
            disabled={busy}
            title={`${c.label} (${c.status})`}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs whitespace-nowrap border transition-colors disabled:opacity-50 disabled:cursor-wait ${
              isActive
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
            }`}
          >
            <span className="font-semibold">{index + 1}</span>
            <span className="max-w-[140px] truncate">{c.label}</span>
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[c.status] || 'bg-gray-400'}`} />
          </button>
        );
      })}

      <button
        onClick={onNewCase}
        disabled={busy}
        className="ml-auto shrink-0 px-3 py-1 rounded-full text-xs border border-blue-600 text-blue-600 hover:bg-blue-50 whitespace-nowrap disabled:opacity-50 disabled:cursor-wait"
      >
        + New problem
      </button>
    </div>
  );
};

export default CaseSwitcher;