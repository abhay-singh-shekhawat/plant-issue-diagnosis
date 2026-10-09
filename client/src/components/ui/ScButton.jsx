import React from 'react';

// Pill button, two variants. Shape lock: buttons are always full-pill.
// Contrast: accent/white 7.1:1. Active press gives tactile feedback.
const ScButton = ({
  children,
  variant = 'primary',
  disabled = false,
  className = '',
  ...rest
}) => {
  const base =
    'inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' +
    'transition-transform transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
    'active:scale-[0.98] focus-visible:outline-none';
  const styles =
    variant === 'primary'
      ? 'bg-accent text-accent-ink hover:brightness-110'
      : 'bg-surface text-ink border border-line hover:bg-mist';
  return (
    <button disabled={disabled} className={`${base} ${styles} ${className}`} {...rest}>
      {children}
    </button>
  );
};

export default ScButton;
