import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canHostOverlay } from '../../lib/hotkeys.ts';
import { formatShortcut } from '../../lib/shortcuts.ts';

test('overlay can run on ordinary http(s) pages', () => {
  for (const url of ['https://github.com/org/repo', 'http://localhost:3000/', 'https://docs.google.com/document/d/x']) {
    assert.equal(canHostOverlay(url), true, url);
  }
});

test('overlay cannot run on chrome://, extension, file, new-tab, Web Store or unknown pages', () => {
  for (const url of [
    'chrome://version',
    'chrome://newtab/',
    'chrome-extension://abc/debug.html',
    'file:///Users/x/a.html',
    'about:blank',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(canHostOverlay(url), false, String(url));
  }
});

test('shortcut label: a binding is shown as Chrome reports it', () => {
  assert.deepEqual(formatShortcut('⌘⇧Y'), { set: true, text: '⌘⇧Y' });
  assert.deepEqual(formatShortcut('  Ctrl+Shift+Y '), { set: true, text: 'Ctrl+Shift+Y' });
});

test('shortcut label: unset (empty, blank or missing) says where to set it', () => {
  for (const v of ['', '   ', undefined, null]) {
    const label = formatShortcut(v);
    assert.equal(label.set, false);
    assert.match(label.text, /Not set: set it in chrome:\/\/extensions\/shortcuts/);
  }
});
