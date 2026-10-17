/**
 * Functions injected into the page by `chrome.scripting.executeScript`.
 *
 * Each one is serialized across the boundary, so it may not reference anything in module scope —
 * every helper it needs is declared inside, including the duplicated selector resolver. That
 * duplication is forced by the API, not an oversight.
 *
 * They are exported so the tests exercise the code that actually ships rather than a parallel
 * copy free to drift from it.
 *
 * Neither function reads page content back out. The click returns whether it found and clicked
 * one element; the type returns whether it succeeded. That is the entire privacy surface of
 * replay.
 */

export interface ClickResult {
  /** The element was located. Reported separately so `wait_for` can probe without clicking. */
  found: boolean;
  clicked: boolean;
  reason?: string;
}

export interface TypeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Locates an element and optionally clicks it. **Single attempt, no polling.**
 *
 * Retrying deliberately lives in the executor instead. A hidden page clamps `setTimeout` to
 * about a second, and to roughly once a minute after five minutes hidden, so an in-page poll is
 * close to useless in silent mode — and it could not honor Pause or Stop between attempts.
 */
export function clickBySelector(selector: string, probeOnly: boolean): ClickResult {
  const norm = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

  /** Walks open shadow roots, which `document.querySelector` does not pierce. */
  const deepQuery = (root: ParentNode, sel: string): Element | null => {
    const direct = root.querySelector(sel);
    if (direct) return direct;
    const hosts = root.querySelectorAll('*');
    for (const host of Array.from(hosts)) {
      const shadow = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!shadow) continue;
      const found = deepQuery(shadow, sel);
      if (found) return found;
    }
    return null;
  };

  const resolve = (): Element | null => {
    // The collector writes a Playwright-style `text="..."` pseudo-selector when an element has
    // no aria-label, data-testid or id. It is not valid CSS, so it is handled before any
    // querySelector call. Anchored and greedy because the label itself may contain quotes.
    const textMatch = /^text="([\s\S]*)"$/.exec(selector);
    if (textMatch) {
      // The recorder stores the deepest element under the cursor, so match the same
      // normalization and prefer the tightest element rather than an ancestor.
      const wanted = norm(textMatch[1]);
      const matches: Element[] = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (norm(el.textContent) === wanted) matches.push(el);
      }
      matches.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return matches[0] ?? null;
    }

    try {
      const el = deepQuery(document, selector);
      if (el) return el;
    } catch {
      /* malformed selector: fall through to the de-escaped attempt */
    }

    // The collector builds attribute selectors with CSS.escape, which escapes for identifier
    // context rather than quoted-string context. Retrying without the backslashes recovers
    // selectors like [aria-label="Add\ to\ cart"].
    try {
      return deepQuery(document, selector.replace(/\\(.)/g, '$1'));
    } catch {
      return null;
    }
  };

  const el = resolve();
  if (!el) return { found: false, clicked: false, reason: 'element not found' };
  if (probeOnly) return { found: true, clicked: false };

  try {
    el.scrollIntoView({ block: 'center' });
  } catch {
    /* not every element supports it; clicking still works */
  }
  (el as HTMLElement).click();
  return { found: true, clicked: true };
}

/**
 * Types text into a field.
 *
 * Only ever reached for a step the user authored by hand — the collector records keystroke
 * counts and never their content, so no recorded step carries text.
 */
export function typeIntoSelector(selector: string, text: string): TypeResult {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { ok: false, reason: 'malformed selector' };
  }
  if (!el) return { ok: false, reason: 'element not found' };

  // Refuse credential fields at the point of contact, so this can never be used to fill one
  // even if a macro were hand-edited to try.
  const inputType = (el as HTMLInputElement).type;
  if (inputType === 'password' || inputType === 'hidden') {
    return { ok: false, reason: 'refused: credential field' };
  }

  // Cadence-side: payment and one-time-code fields too. Inline because an injected function cannot
  // import; the pattern mirrors SENSITIVE_RE in lib/privacy.ts (a test keeps them in step).
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  const labelText = Array.from((el as HTMLInputElement).labels ?? [])
    .map((l) => l.textContent ?? '')
    .join(' ');
  const hint = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText]
    .filter(Boolean)
    .join(' ');
  const sensitiveHint =
    /pass|card|cvv|cvc|csc|ssn|pin|routing|account|expir|exp[-_ ]?(date|month|year|mm|yy)|ccnum|cc[-_ ]?(num|exp|csc|number)|iban|security[-_ ]?code|one[-_ ]?time|otp/i;
  if (
    ac.startsWith('cc-') ||
    ac === 'current-password' ||
    ac === 'new-password' ||
    ac === 'one-time-code' ||
    sensitiveHint.test(hint)
  ) {
    return { ok: false, reason: 'refused: payment or credential field' };
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    // The native setter is the whole trick. React installs its own `value` setter on the element
    // instance plus a value tracker; assigning through that path makes the tracker believe
    // nothing changed and the synthetic onChange never fires. Going via the prototype's setter
    // bypasses the instance override so the tracker sees a real delta.
    if (setter) setter.call(el, text);
    else el.value = text;

    // bubbles: React attaches at the root container, not the element.
    // composed: the listener may live outside a shadow root the input sits in.
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true };
  }

  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Deprecated, but still the only broadly supported way into a contenteditable editor.
    const ok = document.execCommand('insertText', false, text);
    return ok ? { ok: true } : { ok: false, reason: 'editor rejected the text' };
  }

  return { ok: false, reason: 'not a typable element' };
}
