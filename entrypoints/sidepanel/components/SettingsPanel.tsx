export interface SettingsPanelProps {
  calendarSource: 'demo' | 'google';
  demoMode: boolean;
  fallbackNotice: string | null;
  onChangeCalendarSource: (source: 'demo' | 'google') => void;
  onToggleDemoMode: () => void;
}

export function SettingsPanel({
  calendarSource,
  demoMode,
  fallbackNotice,
  onChangeCalendarSource,
  onToggleDemoMode,
}: SettingsPanelProps) {
  const openDebugPage = () => window.open(chrome.runtime.getURL('/debug.html'));

  return (
    <section className="settings">
      <h3>Settings</h3>

      <label className="settings-row">
        <span>Calendar source</span>
        <select
          value={calendarSource}
          onChange={(e) => onChangeCalendarSource(e.target.value as 'demo' | 'google')}
        >
          <option value="demo">Demo</option>
          <option value="google">Google</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={demoMode} onChange={onToggleDemoMode} />
        <span>Demo mode (lower detection thresholds)</span>
      </label>

      {fallbackNotice && <div className="notice">{fallbackNotice}</div>}

      <button className="btn btn-link" onClick={openDebugPage}>
        Open debug page
      </button>
    </section>
  );
}
