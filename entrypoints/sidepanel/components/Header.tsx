import { IconButton } from './ui';

export interface HeaderProps {
  paused: boolean;
  todayCount: number;
  onTogglePause: () => void;
}

export function Header({ paused, todayCount, onTogglePause }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-title">Cadence</div>
      <div className="app-header-right">
        <span
          className={paused ? 'rec paused' : 'rec'}
          title={paused ? 'Recording is paused' : 'Recording your activity on this device'}
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
