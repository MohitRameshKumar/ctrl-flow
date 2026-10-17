// Content scripts outlive the extension that injected them: after a reload or update the old script
// stays in the page with a dead `chrome.runtime`, and every call into it throws "Extension context
// invalidated". This guard lets a script notice, stop quietly, and remove everything it registered.
export interface ContentGuard {
  /** False once the extension context is gone. */
  alive(): boolean;
  /** addEventListener whose handler tears everything down (silently) instead of throwing when the context died. */
  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  /** Registers cleanup to run once, when the context dies or `teardown` is called. */
  onTeardown(fn: () => void): void;
  teardown(): void;
}

export function runtimeAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export function createContentGuard(isAlive: () => boolean = runtimeAlive): ContentGuard {
  const cleanups: (() => void)[] = [];
  let done = false;

  const teardown = (): void => {
    if (done) return;
    done = true;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* the page may already be unloading */
      }
    }
  };

  const alive = (): boolean => {
    if (done) return false;
    if (isAlive()) return true;
    teardown();
    return false;
  };

  return {
    alive,
    listen(target: Window | Document, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) {
      const handler = (e: Event): void => {
        if (!alive()) return;
        try {
          (fn as (e: Event) => void)(e);
        } catch (err) {
          // A call that died mid-handler because the context was invalidated is expected, not an error.
          if (!alive()) return;
          throw err;
        }
      };
      target.addEventListener(type, handler, opts);
      cleanups.push(() => target.removeEventListener(type, handler, opts));
    },
    onTeardown: (fn) => {
      cleanups.push(fn);
    },
    teardown,
  };
}
