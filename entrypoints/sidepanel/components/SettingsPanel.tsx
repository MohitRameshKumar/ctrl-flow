import { useEffect, useState } from 'react';
import { getLastAiRequest, type LastAiRequestRecord } from '@/lib/ai';

export interface SettingsPanelProps {
  calendarSource: 'demo' | 'google';
  demoMode: boolean;
  fallbackNotice: string | null;
  onChangeCalendarSource: (source: 'demo' | 'google') => void;
  onToggleDemoMode: () => void;
}

function LastAiRequestViewer() {
  const [record, setRecord] = useState<LastAiRequestRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getLastAiRequest().then(setRecord);
    const onChanged = () => getLastAiRequest().then(setRecord);
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  return (
    <div className="last-ai-request">
      <button className="btn btn-link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} last AI request
      </button>
      {open && (
        <pre className="ai-request-json">
          {record ? JSON.stringify(record, null, 2) : 'No AI calls made yet.'}
        </pre>
      )}
    </div>
  );
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

      <LastAiRequestViewer />

      <button className="btn btn-link" onClick={openDebugPage}>
        Open debug page
      </button>
    </section>
  );
}
