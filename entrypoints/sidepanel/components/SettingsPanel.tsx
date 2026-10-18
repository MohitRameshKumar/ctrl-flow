import { useEffect, useState } from 'react';
import { getLastOutboundAny } from '@/lib/outbound-log';
import type { RunMode, RunSpeed } from '@/lib/types';

export interface SettingsPanelProps {
  calendarSource: 'demo' | 'google';
  demoMode: boolean;
  runMode: RunMode;
  runSpeed: RunSpeed;
  autoRun: boolean;
  fallbackNotice: string | null;
  onChangeCalendarSource: (source: 'demo' | 'google') => void;
  onToggleDemoMode: () => void;
  onChangeRunMode: (mode: RunMode) => void;
  onChangeRunSpeed: (speed: RunSpeed) => void;
  onToggleAutoRun: () => void;
}

function LastOutboundViewer() {
  const [last, setLast] = useState<Awaited<ReturnType<typeof getLastOutboundAny>>>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getLastOutboundAny().then(setLast);
    const onChanged = () => getLastOutboundAny().then(setLast);
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  return (
    <div className="last-ai-request">
      <button className="btn-link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} last outbound request
      </button>
      {open && (
        <>
          {last?.via === 'pdf-lookup' && (
            <p className="hint">Only the title you selected was sent, only to the sources listed, and only because you pressed the key.</p>
          )}
          {last?.via === 'cloud-sync' && (
            <p className="hint">A summary of the batch mirrored to TigerData. Only the fields listed were sent — no page URLs and no page content.</p>
          )}
          {last?.via === 'tts' && (
            <p className="hint">Your standup text was sent to ElevenLabs to be spoken. The text itself is not kept here, only its length. &quot;cache&quot; means nothing left the device.</p>
          )}
          <pre className="ai-request-json">{last ? JSON.stringify(last.record, null, 2) : 'Nothing has been sent off this device yet.'}</pre>
        </>
      )}
    </div>
  );
}

export function SettingsPanel({
  calendarSource,
  demoMode,
  runMode,
  runSpeed,
  autoRun,
  fallbackNotice,
  onChangeCalendarSource,
  onToggleDemoMode,
  onChangeRunMode,
  onChangeRunSpeed,
  onToggleAutoRun,
}: SettingsPanelProps) {
  const openDebugPage = () => window.open(chrome.runtime.getURL('/debug.html'));

  return (
    <div className="settings-block">
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

      <label className="settings-row">
        <span>Macro playback</span>
        <select value={runMode} onChange={(e) => onChangeRunMode(e.target.value as RunMode)}>
          <option value="guided">Guided — watch it work</option>
          <option value="silent">Silent — stay out of my way</option>
        </select>
      </label>
      <p className="settings-hint">
        {runMode === 'guided'
          ? 'Each tab comes to the front in turn, paced like you did it. You can pause or stop mid-run.'
          : 'Tabs open in the background and focus never moves. Some pages only finish loading when visible, and those steps will say so.'}
      </p>

      {/* Only shown for guided: silent mode has no audience, so pacing it would just be waiting. */}
      {runMode === 'guided' && (
        <>
          <label className="settings-row">
            <span>Step pacing</span>
            <select
              value={runSpeed}
              onChange={(e) => onChangeRunSpeed(e.target.value as RunSpeed)}
            >
              <option value="slow">Slow — easy to follow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast</option>
            </select>
          </label>
          <p className="settings-hint">
            Sets how long each step stays on screen. Where a macro recorded a longer pause of
            your own, that wins.
          </p>
        </>
      )}

      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={autoRun} onChange={onToggleAutoRun} />
        <span>Let trusted macros run themselves</span>
      </label>
      <p className="settings-hint">
        After five clean runs a macro can fire on its own, always silently, behind a 10-second
        countdown you can cancel. One cancel turns it back off.
      </p>

      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={demoMode} onChange={onToggleDemoMode} />
        <span>Demo mode (lower detection thresholds)</span>
      </label>

      {fallbackNotice && <div className="notice">{fallbackNotice}</div>}

      <LastOutboundViewer />

      <button className="btn-link" onClick={openDebugPage}>
        Open debug page
      </button>
    </div>
  );
}
