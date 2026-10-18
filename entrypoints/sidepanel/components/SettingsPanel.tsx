import { useEffect, useState } from 'react';
import { DEFAULT_NOTIFY_SETTINGS, NOTIFY_TYPES, getNotifySettings, setNotifyEnabled, type NotifySettings } from '@/lib/notify';
import { getOutboundHistory, type OutboundEntry, type OutboundKind } from '@/lib/outbound-history';
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

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const KIND_LABEL: Record<OutboundKind, string> = { ai: 'AI', 'pdf-lookup': 'Paper', tts: 'Voice', 'cloud-sync': 'Cloud' };

/** What each kind of entry sent, in plain words, shown when it is expanded. */
const KIND_NOTE: Record<OutboundKind, string> = {
  ai: 'The request and response exactly as exchanged with the ctrl-flow proxy.',
  'pdf-lookup': 'Only the title you selected was sent, only to the sources listed, and only because you pressed the key.',
  'cloud-sync': 'A summary of the batch mirrored to Tiger Data: the fields listed were sent, with no page URLs and no page content.',
  tts: 'Your standup text was sent to ElevenLabs to be spoken (cut to 300 characters here; the full length is noted). "cache" means nothing left the device.',
};

/** The last 10 things sent off this device, newest first; click one to see exactly what it was. */
function OutboundHistoryViewer() {
  const [history, setHistory] = useState<OutboundEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    const load = () => getOutboundHistory().then(setHistory);
    load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);

  return (
    <div className="last-ai-request">
      <button className="btn-link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} what was sent off this device
      </button>
      {open &&
        (history.length === 0 ? (
          <p className="hint">Nothing has been sent off this device yet.</p>
        ) : (
          <ul className="outbound-list">
            {history.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <button className="outbound-row" aria-expanded={expanded === i} onClick={() => setExpanded(expanded === i ? null : i)}>
                  <span className="chip">{KIND_LABEL[e.kind]}</span>
                  <span className="outbound-time">{clock(e.ts)}</span>
                  <span className="outbound-summary">{e.summary}</span>
                </button>
                {expanded === i && (
                  <>
                    <p className="hint">{KIND_NOTE[e.kind]}</p>
                    <pre className="ai-request-json">{JSON.stringify(e.detail, null, 2)}</pre>
                  </>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function NotificationSettings() {
  const [settings, setSettings] = useState<NotifySettings>(DEFAULT_NOTIFY_SETTINGS);

  useEffect(() => {
    const load = () => getNotifySettings().then(setSettings);
    load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);

  return (
    <div className="notify-settings">
      <div className="sub-title">Notifications</div>
      {NOTIFY_TYPES.map(({ type, label, hint }) => (
        <label key={type} className="settings-row checkbox-row" title={hint}>
          <input type="checkbox" checked={settings[type]} onChange={(e) => void setNotifyEnabled(type, e.target.checked)} />
          <span>{label}</span>
        </label>
      ))}
      <p className="settings-hint">At most one of each kind every 10 minutes. Replies to keys you press (like &quot;Saved&quot; after K) are never held back by that limit.</p>
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

      <NotificationSettings />

      <OutboundHistoryViewer />

      <button className="btn-link" onClick={openDebugPage}>
        Open debug page
      </button>
    </div>
  );
}
