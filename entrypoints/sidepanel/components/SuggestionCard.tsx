import type { ReactNode } from 'react';

export interface SuggestionCardProps {
  title: string;
  description?: ReactNode;
  acceptLabel?: string;
  /** Every call site passes an async function; the old `() => void` quietly discarded the
   *  promise, so a rejected handler became an unhandled rejection. */
  onAccept: () => void | Promise<void>;
  onNotNow: () => void | Promise<void>;
  onNever: () => void | Promise<void>;
}

/** Reusable Accept / Not now / Never prompt — every Cadence feature suggestion uses this. */
export function SuggestionCard({
  title,
  description,
  acceptLabel = 'Accept',
  onAccept,
  onNotNow,
  onNever,
}: SuggestionCardProps) {
  return (
    <div className="suggestion-card">
      <div className="suggestion-title">{title}</div>
      {description && <div className="suggestion-description">{description}</div>}
      <div className="suggestion-actions">
        <button className="btn btn-accept" onClick={onAccept}>
          {acceptLabel}
        </button>
        <button className="btn btn-secondary" onClick={onNotNow}>
          Not now
        </button>
        <button className="btn btn-secondary" onClick={onNever}>
          Never
        </button>
      </div>
    </div>
  );
}
