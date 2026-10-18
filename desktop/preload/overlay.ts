/**
 * Preload for the leader overlay window.
 *
 * Separate from the main preload because the overlay is deliberately tiny and has no business
 * reaching storage, Dexie, or the browser controller. It renders what it is told and reports key
 * presses back.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { LeaderShowMessage } from '@/lib/hotkeys';
import { OVERLAY } from '../shared/ipc';

contextBridge.exposeInMainWorld('cadenceOverlay', {
  onShow: (cb: (payload: LeaderShowMessage) => void) =>
    ipcRenderer.on(OVERLAY.show, (_e, payload) => cb(payload)),
  onPreview: (cb: (payload: { text: string; runnable: boolean }) => void) =>
    ipcRenderer.on(OVERLAY.preview, (_e, payload) => cb(payload)),
  onNotice: (cb: (text: string) => void) =>
    ipcRenderer.on(OVERLAY.notice, (_e, text) => cb(text)),
  send: (message: unknown) => ipcRenderer.send(OVERLAY.message, message),
  close: () => ipcRenderer.send(OVERLAY.close),
  resize: (height: number) => ipcRenderer.send(OVERLAY.resize, height),
});
