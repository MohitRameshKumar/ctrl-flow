import { useCallback, useEffect, useState } from 'react';
import { getEvents } from '@/lib/db';
import { FocusFlipSection } from './components/FocusFlipSection';
import { LeaderKeysSection } from './components/LeaderKeysSection';
import { PrivacySettings } from './components/PrivacySettings';
import { Header } from './components/Header';
import { RitualsTab } from './components/RitualsTab';
import { SettingsPanel } from './components/SettingsPanel';
import { SpacesTab } from './components/SpacesTab';
import { StandupTab } from './components/StandupTab';
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
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  const refreshSettings = useCallback(async () => {
    const s = await chrome.storage.local.get<{
      paused?: boolean;
      calendarSource?: 'demo' | 'google';
      demoMode?: boolean;
      calendarFallbackNotice?: string | null;
    }>(['paused', 'calendarSource', 'demoMode', 'calendarFallbackNotice']);
    setPaused(s.paused === true);
    setCalendarSource(s.calendarSource ?? 'demo');
    setDemoMode(s.demoMode ?? true);
    setFallbackNotice(s.calendarFallbackNotice ?? null);
  }, []);

  const refreshCount = useCallback(async () => {
    const events = await getEvents(startOfToday(), Date.now());
    setTodayCount(events.length);
  }, []);

  useEffect(() => {
    refreshSettings();
    refreshCount();
    const interval = setInterval(refreshCount, 5000);
    const onStorageChanged = () => refreshSettings();
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [refreshSettings, refreshCount]);

  const togglePause = () => {
    chrome.storage.local.set({ paused: !paused });
  };

  return (
    <div className="app">
      <Header paused={paused} todayCount={todayCount} onTogglePause={togglePause} />
      <Tabs active={tab} onChange={setTab} />

      <main className="content">
        {tab === 'Rituals' && <RitualsTab />}
        {tab === 'Spaces' && <SpacesTab />}
        {tab === 'Standup' && <StandupTab />}
        {tab !== 'Rituals' && tab !== 'Spaces' && tab !== 'Standup' && <div className="coming-soon">{tab} — coming soon</div>}
      </main>

      <FocusFlipSection />

      <LeaderKeysSection />

      <PrivacySettings />

      <SettingsPanel
        calendarSource={calendarSource}
        demoMode={demoMode}
        fallbackNotice={fallbackNotice}
        onChangeCalendarSource={(source) => chrome.storage.local.set({ calendarSource: source })}
        onToggleDemoMode={() => chrome.storage.local.set({ demoMode: !demoMode })}
      />
    </div>
  );
}
