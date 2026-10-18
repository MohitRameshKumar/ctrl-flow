import { IconButton } from './ui';

export interface HeaderProps {
  paused: boolean;
  todayCount: number;
  /** The tab in front is on an excluded site: ctrl-flow is not recording it. */
  excluded?: boolean;
  onTogglePause: () => void;
}

export function Header({ paused, todayCount, excluded = false, onTogglePause }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-logo" role="img" aria-label="ctrl-flow" />
      <div className="app-header-right">
        <span
          className={paused ? 'rec paused' : excluded ? 'rec excluded' : 'rec'}
          title={paused ? 'Recording is paused' : excluded ? "ctrl-flow isn't recording this site" : 'Recording your activity on this device'}
        >
          <span className="rec-dot" />
          <span className="today-count" title="Events recorded today">
            {todayCount}
          </span>
        </span>
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? 'Resume recording' : 'Pause recording'}
          active={paused}
          onClick={onTogglePause}
        />
      </div>
    </header>
  );
}
