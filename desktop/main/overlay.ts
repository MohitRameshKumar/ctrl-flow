/**
 * The leader overlay window, and the global shortcut that opens it.
 *
 * Replaces the extension's injected content-script overlay. Because this is an OS window rather
 * than something living in the page, the hotkey works everywhere — including `chrome://` pages,
 * the new tab page, and while Chrome is not focused — which were all gaps in the extension.
 */

import { BrowserWindow, globalShortcut, screen } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERLAY } from '../shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));

const WIDTH = 380;
const DEFAULT_HEIGHT = 260;
const MARGIN = 16;

let overlayWindow: BrowserWindow | null = null;
let onMessage: ((message: unknown) => void) | null = null;

export function setOverlayMessageHandler(fn: (message: unknown) => void): void {
  onMessage = fn;
}

function create(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Not focusable:false — the overlay must take key input, which is its whole purpose.
    webPreferences: {
      preload: join(here, '../preload/overlay.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // Visible over full-screen apps too, so the hotkey is never swallowed by whatever is in front.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(`${devUrl}/overlay/index.html`);
  else void win.loadURL('app://cadence/overlay/index.html');

  win.on('closed', () => {
    overlayWindow = null;
  });

  return win;
}

function position(win: BrowserWindow, height: number): void {
  // Top-right of the display the cursor is on, matching where the injected overlay appeared.
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { x, y, width } = display.workArea;
  win.setBounds({
    x: Math.round(x + width - WIDTH - MARGIN),
    y: Math.round(y + MARGIN),
    width: WIDTH,
    height,
  });
}

export function overlayIsOpen(): boolean {
  return !!overlayWindow && overlayWindow.isVisible();
}

/** Shows the menu. `payload` is exactly the `leader_show` message `lib/leader.ts` builds. */
export function showOverlay(payload: unknown): void {
  if (!overlayWindow) overlayWindow = create();
  const win = overlayWindow;

  const send = () => {
    position(win, DEFAULT_HEIGHT);
    win.showInactive();
    // Focus after showing so key events land here rather than in the browser.
    win.focus();
    win.webContents.send(OVERLAY.show, payload);
  };

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

export function showOverlayPreview(payload: { text: string; runnable: boolean }): void {
  if (!overlayWindow) return;
  overlayWindow.webContents.send(OVERLAY.preview, payload);
}

export function showOverlayNotice(text: string): void {
  if (!overlayWindow) return;
  overlayWindow.webContents.send(OVERLAY.notice, text);
}

export function hideOverlay(): void {
  overlayWindow?.hide();
}

export function resizeOverlay(height: number): void {
  if (!overlayWindow) return;
  const bounds = overlayWindow.getBounds();
  overlayWindow.setBounds({ ...bounds, height: Math.max(80, Math.min(height, 620)) });
}

export function handleOverlayMessage(message: unknown): void {
  onMessage?.(message);
}

export interface RegisteredCommand {
  name: string;
  shortcut: string;
  description: string;
}

/**
 * Registers the global shortcuts.
 *
 * Returns what actually bound. `chrome.commands.getAll()` reports this verbatim, so the Settings
 * UI tells the truth when another app already owns the combo — better than the extension, where
 * Chrome owns the binding and Cadence can only link to `chrome://extensions/shortcuts`.
 */
export function registerShortcuts(
  bindings: { name: string; accelerator: string; description: string }[],
  onCommand: (name: string) => void,
): RegisteredCommand[] {
  globalShortcut.unregisterAll();
  const registered: RegisteredCommand[] = [];

  for (const binding of bindings) {
    let ok = false;
    try {
      ok = globalShortcut.register(binding.accelerator, () => onCommand(binding.name));
    } catch {
      ok = false;
    }
    registered.push({
      name: binding.name,
      // An empty shortcut is how `lib/shortcuts.ts` renders "not set", which is the honest answer
      // when the OS or another app refused the binding.
      shortcut: ok ? binding.accelerator : '',
      description: binding.description,
    });
    if (!ok) console.warn(`[cadence] could not register ${binding.accelerator}`);
  }

  return registered;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
