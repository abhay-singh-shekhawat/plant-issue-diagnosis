import React, { useId } from 'react';

// Text input primitive. Label above, error below, helper optional.
// Radius lock: inputs are 10px. Accent focus ring.
export const ScInput = ({
  label,
  helper,
  error,
  id,
  className = '',
  ...rest
}) => {
  const autoId = useId();
  const inputId = id || `sc-input-${autoId}`;
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className="w-full px-3 py-2 rounded-input border border-line bg-surface text-ink text-sm
          placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-mist"
        {...rest}
      />
      {helper && !error && <p className="text-xs text-muted">{helper}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
};

export default ScInput;
