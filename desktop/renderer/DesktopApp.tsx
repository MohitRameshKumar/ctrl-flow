/**
 * The desktop shell.
 *
 * A window is a different shape from a 360px side panel, so the horizontal `<Tabs>` strip becomes a
 * persistent left sidebar and the content gets a readable measure instead of stretching to the full
 * width. Everything *inside* is the existing components, imported unchanged — this file is layout
 * and chrome only.
 *
 * It also owns the two things a window has and a side panel does not: the connection state of the
 * browser Cadence drives, and first-run onboarding.
 */

import { useCallback, useEffect, useState } from 'react';
import { getEvents } from '@/lib/db';
import { LEADER_PANEL_KEY } from '@/lib/leader';
import { consumeMacroPaletteRequest } from '@/lib/macros';
import { setAutoRunEnabled, setRunMode, setRunSpeed } from '@/lib/settings';
import type { RunMode, RunSpeed } from '@/lib/types';
import { MacroOfferBanner } from '@/entrypoints/sidepanel/components/MacroOfferBanner';
import { MacrosTab } from '@/entrypoints/sidepanel/components/MacrosTab';
import { RitualsTab } from '@/entrypoints/sidepanel/components/RitualsTab';
import { SettingsTab } from '@/entrypoints/sidepanel/components/SettingsTab';
import { SpacesTab } from '@/entrypoints/sidepanel/components/SpacesTab';
import { StandupTab } from '@/entrypoints/sidepanel/components/StandupTab';
import { TAB_NAMES, type TabName } from '@/entrypoints/sidepanel/components/Tabs';
import type { BrowserStatusPayload } from '../preload';
import { Onboarding, ONBOARDING_KEY } from './onboarding/Onboarding';
import { BrowserStatusBar } from './BrowserStatusBar';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** One glyph per tab. Deliberately simple shapes: they read at 16px and need no icon font. */
const TAB_ICONS: Record<TabName, string> = {
  Rituals: '◷',
  Spaces: '▣',
  Macros: '⟳',
  Standup: '✎',
  Settings: '⚙',
};

export default function DesktopApp() {
  const [tab, setTab] = useState<TabName>('Macros');
  const [paused, setPaused] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [calendarSource, setCalendarSource] = useState<'demo' | 'google'>('demo');
  const [demoMode, setDemoMode] = useState(true);
  const [runMode, setRunModeState] = useState<RunMode>('guided');
  const [runSpeed, setRunSpeedState] = useState<RunSpeed>('normal');
  const [autoRun, setAutoRun] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [paletteNonce, setPaletteNonce] = useState(0);
  const [status, setStatus] = useState<BrowserStatusPayload>({ state: 'idle' });
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  const refreshSettings = useCallback(async () => {
    const s = await chrome.storage.local.get<{
      paused?: boolean;
      calendarSource?: 'demo' | 'google';
      demoMode?: boolean;
      macroRunMode?: RunMode;
      macroRunSpeed?: RunSpeed;
      macroAutoRun?: boolean;
      calendarFallbackNotice?: string | null;
      [ONBOARDING_KEY]?: boolean;
    }>([
      'paused',
      'calendarSource',
      'demoMode',
      'macroRunMode',
      'macroRunSpeed',
      'macroAutoRun',
      'calendarFallbackNotice',
      ONBOARDING_KEY,
    ]);
    setPaused(s.paused === true);
    setCalendarSource(s.calendarSource ?? 'demo');
    setDemoMode(s.demoMode ?? true);
    setRunModeState(s.macroRunMode === 'silent' ? 'silent' : 'guided');
    setRunSpeedState(
      s.macroRunSpeed === 'slow' || s.macroRunSpeed === 'fast' ? s.macroRunSpeed : 'normal',
    );
    setAutoRun(s.macroAutoRun === true);
    setFallbackNotice(s.calendarFallbackNotice ?? null);
    setOnboarded(s[ONBOARDING_KEY] === true);
  }, []);

  const refreshCount = useCallback(async () => {
    const events = await getEvents(startOfToday(), Date.now());
    setTodayCount(events.length);
  }, []);

  /** The shortcut leaves a note in session storage rather than messaging a window that may not exist. */
  const consumePaletteRequest = useCallback(async () => {
    const request = await consumeMacroPaletteRequest();
    if (!request) return;
    setTab('Macros');
    setPaletteNonce((n) => n + 1);
  }, []);

  const consumeLeaderFallback = useCallback(async () => {
    const { [LEADER_PANEL_KEY]: at } =
      await chrome.storage.session.get<Record<string, number | undefined>>(LEADER_PANEL_KEY);
    if (typeof at === 'number' && Date.now() - at < 10_000) setTab('Settings');
  }, []);

  useEffect(() => {
    refreshSettings();
    refreshCount();
    consumePaletteRequest();
    consumeLeaderFallback();

    void window.cadenceNative.browser.status().then(setStatus);
    const offStatus = window.cadenceNative.browser.onStatus(setStatus);

    const interval = setInterval(refreshCount, 5000);
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'session') {
        if (changes.macroPaletteRequest?.newValue) consumePaletteRequest();
        if (changes[LEADER_PANEL_KEY]?.newValue) consumeLeaderFallback();
        return;
      }
      refreshSettings();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(onStorageChanged);
      offStatus();
    };
  }, [refreshSettings, refreshCount, consumePaletteRequest, consumeLeaderFallback]);

  // Avoid flashing the app before we know whether this is a first run.
  if (onboarded === null) return <div className="boot-blank" />;

  if (!onboarded) {
    return <Onboarding status={status} onDone={() => setOnboarded(true)} />;
  }

  return (
    <div className="desktop">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">
            ⟳
          </span>
          Cadence
        </div>

        <nav className="sidebar-nav">
          {TAB_NAMES.map((name) => (
            <button
              key={name}
              className={name === tab ? 'sidebar-item active' : 'sidebar-item'}
              onClick={() => setTab(name)}
            >
              <span className="sidebar-icon" aria-hidden="true">
                {TAB_ICONS[name]}
              </span>
              {name}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <BrowserStatusBar status={status} />
          {/* Onboarding is the fastest way to re-check the setup when something looks wrong. */}
          <button
            className="sidebar-replay"
            onClick={() => {
              void chrome.storage.local.set({ [ONBOARDING_KEY]: false });
              setOnboarded(false);
            }}
          >
            Replay setup
          </button>
          <div className="sidebar-stats">
            <span>{todayCount} events today</span>
            <button
              className={paused ? 'btn btn-pause active' : 'btn btn-pause'}
              onClick={() => chrome.storage.local.set({ paused: !paused })}
            >
              {paused ? 'Paused' : 'Pause'}
            </button>
          </div>
        </div>
      </aside>

      <main className="desktop-main">
        <div className="desktop-content">
          {/* Above the tab content so an offer is visible whichever tab is open. */}
          <MacroOfferBanner />

          {tab === 'Rituals' && <RitualsTab />}
          {tab === 'Spaces' && <SpacesTab />}
          {tab === 'Macros' && <MacrosTab paletteNonce={paletteNonce} />}
          {tab === 'Standup' && <StandupTab />}
          {tab === 'Settings' && (
            <SettingsTab
              calendarSource={calendarSource}
              demoMode={demoMode}
              runMode={runMode}
              runSpeed={runSpeed}
              autoRun={autoRun}
              fallbackNotice={fallbackNotice}
              onChangeCalendarSource={(source) => chrome.storage.local.set({ calendarSource: source })}
              onToggleDemoMode={() => chrome.storage.local.set({ demoMode: !demoMode })}
              onChangeRunMode={(mode) => void setRunMode(mode)}
              onChangeRunSpeed={(speed) => void setRunSpeed(speed)}
              onToggleAutoRun={() => void setAutoRunEnabled(!autoRun)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
