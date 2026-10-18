/**
 * First-run setup.
 *
 * Four steps, and each one *does* the thing rather than describing it: the browser really launches,
 * the real hotkey has to be pressed, and the first macro is a real macro the user can run again
 * afterwards. That is deliberate — a tutorial that only narrates leaves the user at step one.
 *
 * It also has to be honest about the one genuine cost of the architecture: Cadence drives a Chrome
 * profile of its own (Chrome 136+ refuses a debugging port on the default profile), so the user is
 * signed out on first run. Saying so plainly here is much better than them discovering it on a
 * login wall mid-demo.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserStatusPayload } from '../../preload';

export const ONBOARDING_KEY = 'onboardingDone';

export interface OnboardingProps {
  status: BrowserStatusPayload;
  onDone: () => void;
}

type StepId = 'welcome' | 'browser' | 'hotkey' | 'macro';

const STEPS: StepId[] = ['welcome', 'browser', 'hotkey', 'macro'];

/** Matches the accelerator the main process actually registered (see desktop/main/overlay.ts). */
const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const HOTKEY_LABEL = IS_MAC ? '⌘ ⇧ Y' : 'Ctrl + Shift + Y';

export function Onboarding({ status, onDone }: OnboardingProps) {
  const [step, setStep] = useState<StepId>('welcome');
  const [hotkeySeen, setHotkeySeen] = useState(false);
  const [macroCount, setMacroCount] = useState(0);
  const [tabsOpened, setTabsOpened] = useState(0);

  const index = STEPS.indexOf(step);

  const finish = useCallback(() => {
    void chrome.storage.local.set({ [ONBOARDING_KEY]: true });
    onDone();
  }, [onDone]);

  /* The hotkey step advances only on a real press of the real shortcut. */
  useEffect(() => {
    if (step !== 'hotkey') return;
    const off = window.cadenceNative.onCommand((command) => {
      if (command === 'leader-key') setHotkeySeen(true);
    });
    return off;
  }, [step]);

  /* The macro step watches for a macro actually being saved, and for tabs actually being opened. */
  useEffect(() => {
    if (step !== 'macro') return;
    let alive = true;

    const poll = async () => {
      const { db } = await import('@/lib/db');
      const count = await db.macros.count();
      const tabs = await chrome.tabs.query({});
      if (!alive) return;
      setMacroCount(count);
      setTabsOpened(tabs.length);
    };

    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [step]);

  const launchBrowser = () => {
    void window.cadenceNative.storage
      .get('local', ['focusFlipEnabled'])
      .then((s) => window.cadenceNative.browser.launch(s));
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-progress" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span key={s} className={i <= index ? 'pip done' : 'pip'} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <h1>Cadence watches for the things you do twice.</h1>
            <p>
              Open the same three tabs every morning? Cadence notices, and gives you a key that does
              it for you.
            </p>
            <div className="onboarding-facts">
              <div className="fact">
                <strong>It stays on this machine.</strong> Pages you visit, clicks, and how long you
                spend are stored locally. Nothing is uploaded unless you ask for a standup draft.
              </div>
              <div className="fact">
                <strong>It never records what you type.</strong> Only that typing happened, and in
                which field — never the keystrokes.
              </div>
              <div className="fact">
                <strong>Sensitive sites are excluded by default.</strong> Banks, email, and password
                managers are on the blocklist before you start. You can add more in Settings.
              </div>
            </div>
            <div className="onboarding-actions">
              <button className="btn primary" onClick={() => setStep('browser')}>
                Get started
              </button>
            </div>
          </>
        )}

        {step === 'browser' && (
          <>
            <h1>Open the browser Cadence watches.</h1>
            <p>
              Cadence drives your installed Chrome. It opens a window using a profile of its own, so
              <strong> you will need to sign in to your sites once</strong> — after that the profile
              is remembered.
            </p>

            <div className={`onboarding-state ${status.state}`}>
              {status.state === 'connected' && <>Connected to {status.browserName}. </>}
              {status.state === 'launching' && <>Opening…</>}
              {status.state === 'idle' && <>Not open yet.</>}
              {status.state === 'disconnected' && <>The browser was closed.</>}
              {status.state === 'error' &&
                (status.error === 'NO_BROWSER_FOUND' ? (
                  <>
                    No Chrome-based browser found.{' '}
                    <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
                      Install Chrome
                    </a>{' '}
                    and try again.
                  </>
                ) : (
                  <>Could not start the browser ({status.error}).</>
                ))}
            </div>

            <div className="onboarding-actions">
              {status.state !== 'connected' && (
                <button className="btn primary" onClick={launchBrowser}>
                  Open my browser
                </button>
              )}
              <button
                className={status.state === 'connected' ? 'btn primary' : 'btn'}
                onClick={() => setStep('hotkey')}
                disabled={status.state !== 'connected'}
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === 'hotkey' && (
          <>
            <h1>Press the leader key.</h1>
            <p>
              This is how you reach everything in Cadence without leaving the page you are on. It
              works anywhere — even on a new tab, and even when your browser is not focused.
            </p>

            <div className="onboarding-key">
              <kbd>{HOTKEY_LABEL}</kbd>
            </div>

            <div className={hotkeySeen ? 'onboarding-state connected' : 'onboarding-state idle'}>
              {hotkeySeen ? 'Got it — the overlay is yours.' : 'Waiting for the key…'}
            </div>

            <div className="onboarding-actions">
              <button
                className={hotkeySeen ? 'btn primary' : 'btn'}
                onClick={() => setStep('macro')}
                disabled={!hotkeySeen}
              >
                Next
              </button>
              <button className="btn ghost" onClick={() => setStep('macro')}>
                Skip
              </button>
            </div>
          </>
        )}

        {step === 'macro' && (
          <>
            <h1>Make your first macro.</h1>
            <p>Do something worth repeating, then tell Cadence to keep it.</p>

            <ol className="onboarding-steps">
              <li className={tabsOpened >= 3 ? 'done' : ''}>
                Open three tabs you often open together.
                <span className="step-note">{tabsOpened} open now</span>
              </li>
              <li>
                Press <kbd>{HOTKEY_LABEL}</kbd>, then <kbd>R</kbd>.
              </li>
              <li>
                Cadence shows what it would repeat. Press <kbd>Enter</kbd> to save and run it.
              </li>
            </ol>

            <div className={macroCount > 0 ? 'onboarding-state connected' : 'onboarding-state idle'}>
              {macroCount > 0
                ? `${macroCount} macro${macroCount === 1 ? '' : 's'} saved. That key is yours now.`
                : 'No macros yet.'}
            </div>

            <div className="onboarding-actions">
              <button className="btn primary" onClick={finish}>
                {macroCount > 0 ? 'Done' : 'Skip for now'}
              </button>
            </div>
          </>
        )}

        {step !== 'welcome' && (
          <button className="onboarding-back" onClick={() => setStep(STEPS[index - 1] ?? 'welcome')}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}
