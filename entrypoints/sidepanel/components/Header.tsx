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
        <span className="today-count">{todayCount} events today</span>
        <button className={paused ? 'btn btn-pause active' : 'btn btn-pause'} onClick={onTogglePause}>
          {paused ? 'Paused' : 'Pause'}
        </button>
      </div>
    </header>
  );
}
