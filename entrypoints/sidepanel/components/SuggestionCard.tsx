import type { ReactNode } from 'react';

export interface SuggestionCardProps {
  title: string;
  description?: ReactNode;
  acceptLabel?: string;
  onAccept: () => void;
  onNotNow: () => void;
  onNever: () => void;
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
