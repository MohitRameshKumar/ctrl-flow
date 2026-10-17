// UI-5: the toolbar badge shows whether Cadence is recording or paused.
const RECORDING = { text: '●', color: '#2e7d32', title: 'Cadence: recording' };
const PAUSED = { text: 'II', color: '#9e9e9e', title: 'Cadence: paused' };

export async function updateBadge(): Promise<void> {
  if (!chrome.action) return;
  const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
  const state = paused === true ? PAUSED : RECORDING;
  await Promise.all([
    chrome.action.setBadgeText({ text: state.text }),
    chrome.action.setBadgeBackgroundColor({ color: state.color }),
    chrome.action.setTitle({ title: state.title }),
  ]);
}
