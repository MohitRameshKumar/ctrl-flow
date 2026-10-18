/**
 * Finds the user's Chrome, launches it with a debugging port, and tells us when it goes away.
 *
 * ## Why a dedicated profile is mandatory
 *
 * Chrome 136+ refuses `--remote-debugging-port` when `--user-data-dir` points at the default
 * profile. This is a security fix and there is no flag to opt out, so Cadence must run Chrome on a
 * profile of its own. The user-visible consequence — they are signed out of their sites the first
 * time — is real and the onboarding owns it rather than hiding it. The profile *persists* across
 * runs, so it is a one-time cost.
 *
 * Do not try to copy the user's Default profile: cookies are encrypted with an OS-bound key, the
 * files are locked while Chrome runs, and it fails in confusing ways.
 *
 * ## Why port 0
 *
 * Asking for port 0 lets the OS pick a free port, and Chrome writes the real one to
 * `DevToolsActivePort` in the profile directory. Guessing a port and hoping it is free is the usual
 * source of "works on my machine" launcher bugs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BrowserCandidate {
  path: string;
  name: string;
}

/** Chrome first, then the other Chromium browsers — all speak the same protocol. */
export function findBrowsers(): BrowserCandidate[] {
  const found: BrowserCandidate[] = [];
  const add = (path: string, name: string) => {
    if (path && existsSync(path) && !found.some((f) => f.path === path)) found.push({ path, name });
  };

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'],
    ].filter((r): r is string => !!r);

    for (const root of roots) {
      add(join(root, 'Google/Chrome/Application/chrome.exe'), 'Google Chrome');
      add(join(root, 'Microsoft/Edge/Application/msedge.exe'), 'Microsoft Edge');
      add(join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'), 'Brave');
    }
  } else if (process.platform === 'darwin') {
    const apps = [
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
      [join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Google Chrome'],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge'],
      ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
    ] as const;
    for (const [path, name] of apps) add(path, name);
  } else {
    for (const path of [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ]) {
      add(path, 'Chrome');
    }
  }

  return found;
}

/**
 * Launch flags.
 *
 * The anti-throttling group is not cosmetic. `lib/macro-executor.ts` notes that "a hidden page
 * clamps its own timers, so an in-page poll is nearly useless in silent mode" — silent replay works
 * on background tabs, so timer throttling there directly degrades it. Disabling Memory Saver
 * additionally stops Chrome from discarding tabs, which matters twice over: a discarded tab's CDP
 * target is destroyed, which would otherwise look exactly like the user closing the tab and emit a
 * phantom `tab_closed` into the collector.
 */
export function launchFlags(userDataDir: string, port = 0): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=HighEfficiencyModeAvailable,BatterySaverModeAvailable,CalculateNativeWinOcclusion',
    // Deliberately NOT --enable-automation: it shows the "controlled by automated software"
    // infobar and turns on automation restrictions we do not want for a everyday browser.
  ];
}

export interface LaunchedBrowser {
  process: ChildProcess;
  webSocketDebuggerUrl: string;
  browserName: string;
  userDataDir: string;
}

/** Reads the port Chrome actually bound, polling because the file appears slightly after spawn. */
async function readDevToolsUrl(userDataDir: string, timeoutMs: number): Promise<string | null> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(portFile)) continue;
    try {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      /* mid-write; try again */
    }
  }
  return null;
}

export async function launchBrowser(options: {
  userDataDir: string;
  browserPath?: string;
  startUrl?: string;
  timeoutMs?: number;
}): Promise<LaunchedBrowser> {
  const candidates = findBrowsers();
  const chosen = options.browserPath
    ? { path: options.browserPath, name: 'Browser' }
    : candidates[0];

  if (!chosen) {
    throw new Error('NO_BROWSER_FOUND');
  }

  // A stale port file from a previous run would be read as the live port and every CDP call would
  // fail against a dead socket.
  try {
    rmSync(join(options.userDataDir, 'DevToolsActivePort'), { force: true });
  } catch {
    /* nothing to clean */
  }

  const args = launchFlags(options.userDataDir);
  if (options.startUrl) args.push(options.startUrl);

  const child = spawn(chosen.path, args, {
    stdio: 'ignore',
    // Survives the parent's own lifecycle quirks; we kill it explicitly on quit.
    detached: false,
  });

  const url = await readDevToolsUrl(options.userDataDir, options.timeoutMs ?? 20_000);
  if (!url) {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    throw new Error('NO_DEVTOOLS_PORT');
  }

  return {
    process: child,
    webSocketDebuggerUrl: url,
    browserName: chosen.name,
    userDataDir: options.userDataDir,
  };
}
