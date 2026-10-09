import React from 'react';

// Semantic dot is never alone: always paired with a text label.
// Colors come from the locked status palette.
const DOT = {
  completed: 'bg-accent',
  active: 'bg-accent',
  evaluating: 'bg-warn',
  gathering: 'bg-muted',
  danger: 'bg-danger',
};

const StatusDot = ({ status = 'gathering', label }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-muted">
    <span className={`w-1.5 h-1.5 rounded-full ${DOT[status] || DOT.gathering}`} aria-hidden="true" />
    {label && <span>{label}</span>}
  </span>
);

export default StatusDot;
