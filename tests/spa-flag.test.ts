// The two navigation listeners must set `spa` oppositely; swapping them silently breaks Leader R, and
// no behavioral test can reach the listeners (they run only inside the service worker).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

it('onCommitted records a normal navigation; onHistoryStateUpdated records an in-page (spa) one', () => {
  const committed = /onCommitted\.addListener\(\(details\) => \{[^}]*?recordNavigation\(([^)]*)\)/.exec(source);
  const history = /onHistoryStateUpdated\.addListener\(\(details\) => \{[^}]*?recordNavigation\(([^)]*)\)/.exec(source);
  expect(committed?.[1]).toBe('details.tabId, details.url');
  expect(history?.[1]).toBe('details.tabId, details.url, true');
});
