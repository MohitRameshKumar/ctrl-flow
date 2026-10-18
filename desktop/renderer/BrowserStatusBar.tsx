/**
 * Whether Cadence is actually attached to a browser.
 *
 * The desktop app has a failure mode the extension never had: Chrome may not be installed, may
 * have been closed, or may have refused the debugging port. Cadence silently recording nothing
 * would be the worst version of that, so the state is always on screen, and the error cases say
 * what to do rather than just reporting a code.
 */

import type { BrowserStatusPayload } from '../preload';

export interface BrowserStatusBarProps {
  status: BrowserStatusPayload;
}

export function BrowserStatusBar({ status }: BrowserStatusBarProps) {
  const relaunch = () => {
    void window.cadenceNative.storage
      .get('local', ['focusFlipEnabled'])
      .then((s) => window.cadenceNative.browser.launch(s));
  };

  if (status.state === 'connected') {
    return (
      <div className="browser-status ok">
        <span className="dot" aria-hidden="true" />
        Watching {status.browserName ?? 'your browser'}
      </div>
    );
  }

  if (status.state === 'launching') {
    return (
      <div className="browser-status pending">
        <span className="dot" aria-hidden="true" />
        Opening your browser…
      </div>
    );
  }

  if (status.state === 'error' && status.error === 'NO_BROWSER_FOUND') {
    return (
      <div className="browser-status bad">
        <span className="dot" aria-hidden="true" />
        No Chrome found
        <a className="link" href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
          Install Chrome
        </a>
      </div>
    );
  }

  return (
    <div className="browser-status bad">
      <span className="dot" aria-hidden="true" />
      {status.state === 'disconnected' ? 'Browser closed' : 'Not connected'}
      <button className="link" onClick={relaunch}>
        Reopen
      </button>
    </div>
  );
}
