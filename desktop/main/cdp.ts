/**
 * A small Chrome DevTools Protocol client.
 *
 * Deliberately hand-rolled rather than pulling in puppeteer: we need perhaps fifteen CDP methods,
 * and puppeteer would bring its own browser download, its own lifecycle assumptions, and a much
 * larger install for the user to download.
 *
 * Uses **flat sessions** (`Target.attachToTarget({flatten: true})`): every message carries a
 * `sessionId` on one socket, instead of the older nested `Target.sendMessageToTarget` wrapping.
 * That is what makes auto-attach to out-of-process iframes tractable.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const CALL_TIMEOUT_MS = 10_000;

export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  private closed = false;

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const onError = (err: Error) => reject(err);
      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        this.ws = socket;
        resolve();
      });
    });

    const socket = this.ws;
    if (!socket) return;

    socket.on('message', (data: WebSocket.RawData) => this.onMessage(String(data)));
    socket.on('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('cdp socket closed'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    socket.on('error', (err) => this.emit('socket-error', err));
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result ?? {});
      return;
    }

    if (msg.method) {
      const event: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      };
      // Two shapes so callers can either filter themselves or subscribe to one method.
      this.emit('event', event);
      this.emit(msg.method, event);
    }
  }

  get connected(): boolean {
    return !!this.ws && !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Every call settles.
   *
   * The macro executor owns retries and the overall budget, and both are defeated by a call that
   * hangs — the same reasoning as `MACRO_INJECT_TIMEOUT_MS` in `lib/macro-host-chrome.ts`. A frozen
   * or discarded tab can swallow an evaluate forever, so the timeout is not optional.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('cdp not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
        timer,
      });

      try {
        this.ws?.send(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Never throws — for fire-and-forget calls where failure is acceptable. */
  async trySend<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T | null> {
    try {
      return await this.send<T>(method, params, sessionId);
    } catch {
      return null;
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
