import type { ContentMessage } from '@/lib/types';

const MODIFIER_ONLY_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Fn',
]);

function send(message: ContentMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Background worker may be asleep/unreachable momentarily; the event is dropped rather than retried.
  });
}

function trimLabel(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function getVisibleText(el: Element): string {
  return trimLabel(el.textContent ?? '');
}

function cssPath(el: Element, maxLevels = 4): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let i = 0; i < maxLevels && node; i++) {
    const tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    const classes = node.classList.length
      ? `.${Array.from(node.classList).slice(0, 2).join('.')}`
      : '';
    parts.unshift(`${tag}${classes}`);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function buildClickInfo(el: Element): { selector: string; label?: string } {
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) {
    return { selector: `[aria-label="${CSS.escape(ariaLabel)}"]`, label: trimLabel(ariaLabel) };
  }

  const testId = el.getAttribute('data-testid')?.trim();
  if (testId) {
    return {
      selector: `[data-testid="${CSS.escape(testId)}"]`,
      label: getVisibleText(el) || undefined,
    };
  }

  if (el.id) {
    return { selector: `#${CSS.escape(el.id)}`, label: getVisibleText(el) || undefined };
  }

  const text = getVisibleText(el);
  if (text) {
    return { selector: `text="${text}"`, label: text };
  }

  return { selector: cssPath(el), label: undefined };
}

function onClick(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const { selector, label } = buildClickInfo(target);
  send({ type: 'click', selector, label });
}

function onFieldChange(e: Event): void {
  const el = e.target;
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLSelectElement) &&
    !(el instanceof HTMLTextAreaElement)
  ) {
    return;
  }

  const fieldName =
    el.name ||
    el.id ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    undefined;
  const fieldType = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
  const autocomplete = el.getAttribute('autocomplete');

  send({ type: 'field_changed', fieldName, fieldType, autocomplete });
}

function createTypingTracker() {
  let keyCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    if (keyCount > 0) {
      send({ type: 'typing_burst', keyCount });
    }
    keyCount = 0;
    timer = undefined;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (MODIFIER_ONLY_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    keyCount++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 5000);
  }

  return { onKeydown };
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  // Covers about:/data:/blob: frames too (superset of matchAboutBlank), which some
  // rich editors use for their hidden input surfaces.
  matchOriginAsFallback: true,
  main() {
    const { onKeydown } = createTypingTracker();
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('change', onFieldChange, { capture: true });
    // Rich editors (Google Docs, custom contenteditable widgets) commonly call
    // stopImmediatePropagation() on keydown at the document level or below to own
    // their own keyboard handling. A capture-phase listener on `window` always runs
    // before `document`'s, regardless of registration order, so it sees the key
    // before any such handler can swallow it.
    window.addEventListener('keydown', onKeydown, { capture: true });
  },
});
