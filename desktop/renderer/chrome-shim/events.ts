/**
 * A stand-in for `chrome.events.Event`.
 *
 * The codebase uses `addListener` / `removeListener` and nothing else, but `hasListener` and
 * `hasListeners` are cheap and keep the shape honest.
 */
export class ShimEvent<Fn extends (...args: never[]) => void> {
  private readonly listeners = new Set<Fn>();

  addListener = (fn: Fn): void => {
    this.listeners.add(fn);
  };

  removeListener = (fn: Fn): void => {
    this.listeners.delete(fn);
  };

  hasListener = (fn: Fn): boolean => this.listeners.has(fn);

  hasListeners = (): boolean => this.listeners.size > 0;

  /**
   * Dispatches to every listener.
   *
   * Each call is isolated: Chrome does not let one listener's exception stop the others, and
   * several listeners here are independent features (the collector, Focus Flip, switch detection)
   * that must not be able to break each other.
   */
  emit(...args: Parameters<Fn>): void {
    for (const fn of [...this.listeners]) {
      try {
        (fn as (...a: Parameters<Fn>) => void)(...args);
      } catch (err) {
        console.error('[cadence] listener threw', err);
      }
    }
  }
}
