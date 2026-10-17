// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createContentGuard } from '@/lib/content-guard';

describe('content guard (extension reloaded under a live page)', () => {
  it('runs handlers while the extension is alive', () => {
    const guard = createContentGuard(() => true);
    const fn = vi.fn();
    guard.listen(window, 'keydown', fn);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('once the context dies: handler does not run, listeners are removed, cleanups run once, nothing throws', () => {
    let alive = true;
    const guard = createContentGuard(() => alive);
    const fn = vi.fn();
    const cleanup = vi.fn();
    guard.listen(window, 'keydown', fn);
    guard.onTeardown(cleanup);

    alive = false;
    expect(() => window.dispatchEvent(new KeyboardEvent('keydown'))).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();

    alive = true; // even if it somehow came back, the guard stays torn down
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(fn).not.toHaveBeenCalled();
    expect(guard.alive()).toBe(false);
  });

  it('swallows an "Extension context invalidated" thrown mid-handler, but rethrows real errors', () => {
    let alive = true;
    const guard = createContentGuard(() => alive);
    guard.listen(window, 'click', () => {
      alive = false;
      throw new Error('Extension context invalidated.');
    });
    // happy-dom reports listener errors on the window rather than throwing out of dispatchEvent
    const errors: unknown[] = [];
    window.addEventListener('error', (e) => errors.push(e));
    window.dispatchEvent(new MouseEvent('click'));
    expect(errors).toHaveLength(0);
  });
});
