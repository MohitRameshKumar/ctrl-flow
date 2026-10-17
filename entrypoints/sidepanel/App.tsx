import { useCallback, useEffect, useState } from 'react';
import { getEvents } from '@/lib/db';
import { consumeMacroPaletteRequest } from '@/lib/macros';
import { setAutoRunEnabled, setRunMode, setRunSpeed } from '@/lib/settings';
import type { RunMode, RunSpeed } from '@/lib/types';
import { MacroOfferBanner } from './components/MacroOfferBanner';
import { MacrosTab } from './components/MacrosTab';
import { Header } from './components/Header';
import { RitualsTab } from './components/RitualsTab';
import { SettingsPanel } from './components/SettingsPanel';
import { SpacesTab } from './components/SpacesTab';
import { Tabs, type TabName } from './components/Tabs';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function App() {
  const [tab, setTab] = useState<TabName>('Rituals');
  const [paused, setPaused] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [calendarSource, setCalendarSource] = useState<'demo' | 'google'>('demo');
  const [demoMode, setDemoMode] = useState(true);
  const [runMode, setRunModeState] = useState<RunMode>('guided');
  const [runSpeed, setRunSpeedState] = useState<RunSpeed>('normal');
  const [autoRun, setAutoRun] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [paletteNonce, setPaletteNonce] = useState(0);

  const refreshSettings = useCallback(async () => {
    const s = await chrome.storage.local.get<{
      paused?: boolean;
      calendarSource?: 'demo' | 'google';
      demoMode?: boolean;
      macroRunMode?: RunMode;
      macroRunSpeed?: RunSpeed;
      macroAutoRun?: boolean;
      calendarFallbackNotice?: string | null;
    }>([
      'paused',
      'calendarSource',
      'demoMode',
      'macroRunMode',
      'macroRunSpeed',
      'macroAutoRun',
      'calendarFallbackNotice',
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
  }, []);

  const refreshCount = useCallback(async () => {
    const events = await getEvents(startOfToday(), Date.now());
    setTodayCount(events.length);
  }, []);

  /** The keyboard shortcut leaves a note in session storage rather than messaging the panel,
   *  which may not have mounted yet when the shortcut opens it. */
  const consumePaletteRequest = useCallback(async () => {
    const request = await consumeMacroPaletteRequest();
    if (!request) return;
    setTab('Macros');
    setPaletteNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    refreshSettings();
    refreshCount();
    consumePaletteRequest();
    const interval = setInterval(refreshCount, 5000);
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'session') {
        if (changes.macroPaletteRequest?.newValue) consumePaletteRequest();
        return;
      }
      refreshSettings();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [refreshSettings, refreshCount, consumePaletteRequest]);

  const togglePause = () => {
    chrome.storage.local.set({ paused: !paused });
  };

  return (
    <div className="app">
      <Header paused={paused} todayCount={todayCount} onTogglePause={togglePause} />
      <Tabs active={tab} onChange={setTab} />

      <main className="content">
        {/* Above the tab content so an offer is visible whichever tab is open. */}
        <MacroOfferBanner />

        {tab === 'Rituals' && <RitualsTab />}
        {tab === 'Spaces' && <SpacesTab />}
        {tab === 'Macros' && <MacrosTab paletteNonce={paletteNonce} />}
        {tab === 'Standup' && <div className="coming-soon">{tab} — coming soon</div>}
      </main>

      <SettingsPanel
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
    </div>
  );
}
