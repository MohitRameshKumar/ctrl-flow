/** Shared reads of the settings that live in chrome.storage.local. */

import type { RunMode, RunSpeed } from './types';

export async function getDemoMode(): Promise<boolean> {
  const { demoMode = true } = await chrome.storage.local.get<{ demoMode?: boolean }>('demoMode');
  return demoMode;
}

/**
 * How a macro replays.
 *
 * Defaults to guided: the first time someone runs a macro they should be able to see what it
 * did, and silent is the mode you opt into once you trust it.
 */
export async function getRunMode(): Promise<RunMode> {
  const { macroRunMode } = await chrome.storage.local.get<{ macroRunMode?: RunMode }>(
    'macroRunMode',
  );
  return macroRunMode === 'silent' ? 'silent' : 'guided';
}

export async function setRunMode(mode: RunMode): Promise<void> {
  await chrome.storage.local.set({ macroRunMode: mode });
}

/**
 * How long guided mode dwells on each step.
 *
 * Defaults to normal. The floor exists for macros with no recorded rhythm, which is every
 * hand-authored one — at the original quarter-second nobody could follow what was happening.
 */
export async function getRunSpeed(): Promise<RunSpeed> {
  const { macroRunSpeed } = await chrome.storage.local.get<{ macroRunSpeed?: RunSpeed }>(
    'macroRunSpeed',
  );
  return macroRunSpeed === 'slow' || macroRunSpeed === 'fast' ? macroRunSpeed : 'normal';
}

export async function setRunSpeed(speed: RunSpeed): Promise<void> {
  await chrome.storage.local.set({ macroRunSpeed: speed });
}

/** Whether a trusted macro may fire on its own. Off until the user opts in. */
export async function getAutoRunEnabled(): Promise<boolean> {
  const { macroAutoRun } = await chrome.storage.local.get<{ macroAutoRun?: boolean }>(
    'macroAutoRun',
  );
  return macroAutoRun === true;
}

export async function setAutoRunEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ macroAutoRun: enabled });
}

/**
 * Whether activity metadata is mirrored to TigerData. Off until the user opts in: everything else
 * in this app stays on the device, so the one feature that does not has to be chosen deliberately.
 */
export async function getCloudSyncEnabled(): Promise<boolean> {
  const { cloudSync } = await chrome.storage.local.get<{ cloudSync?: boolean }>('cloudSync');
  return cloudSync === true;
}

export async function setCloudSyncEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ cloudSync: enabled });
}
