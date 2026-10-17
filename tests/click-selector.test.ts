// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { clickBySelector } from '@/lib/macro-injected';

/**
 * Exercises the function that is actually injected into the page, rather than a parallel copy of
 * its logic — an injected function cannot reference module scope, so a separate "resolver"
 * export would be a second implementation free to drift from the shipped one.
 *
 * It is single-shot by design. Retrying moved into the executor, where it can honor Pause and
 * Stop and is not subject to a hidden page's timer clamping; `macro-executor.test.ts` covers it.
 */
function render(html: string): void {
  document.body.innerHTML = html;
}

function clickedIds(): string[] {
  return [...document.querySelectorAll('[data-clicked="yes"]')].map((el) => el.id);
}

const MISS = { found: false, clicked: false, reason: 'element not found' };
const HIT = { found: true, clicked: true };

beforeEach(() => {
  document.body.innerHTML = '';
  // happy-dom dispatches a real click event, so recording it on the element is enough.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof Element) target.setAttribute('data-clicked', 'yes');
  });
});

describe('clickBySelector', () => {
  it('clicks a plain CSS selector', () => {
    render('<button id="go">Go</button>');
    expect(clickBySelector('#go', false)).toEqual(HIT);
    expect(clickedIds()).toEqual(['go']);
  });

  it('clicks an attribute selector', () => {
    render('<button id="go" data-testid="submit">Go</button>');
    expect(clickBySelector('[data-testid="submit"]', false)).toEqual(HIT);
    expect(clickedIds()).toEqual(['go']);
  });

  it('resolves the text="..." pseudo-selector the collector writes', () => {
    render('<button id="go">Create issue</button>');
    expect(clickBySelector('text="Create issue"', false)).toEqual(HIT);
    expect(clickedIds()).toEqual(['go']);
  });

  it('normalizes whitespace the way the collector does', () => {
    render('<button id="go">  Create\n   issue  </button>');
    expect(clickBySelector('text="Create issue"', false)).toEqual(HIT);
  });

  it('prefers the tightest match, never an ancestor', () => {
    // The collector records the deepest element under the cursor, so the span is the real target
    // even though the wrapping div has identical text.
    render('<div id="wrap"><span id="inner">Create issue</span></div>');
    clickBySelector('text="Create issue"', false);
    expect(clickedIds()).toEqual(['inner']);
  });

  it('handles a label containing quotes', () => {
    render('<button id="go">Delete "main" branch</button>');
    expect(clickBySelector('text="Delete "main" branch"', false)).toEqual(HIT);
  });

  it('matches a CSS.escape-d aria-label, backslashes and all', () => {
    render('<button id="go" aria-label="Add to cart">+</button>');
    expect(clickBySelector('[aria-label="Add\\ to\\ cart"]', false)).toEqual(HIT);
  });

  it('reaches into an open shadow root', () => {
    render('<div id="host"></div>');
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="inside">Go</button>';

    expect(clickBySelector('#inside', false)).toEqual(HIT);
  });

  it('returns a reason instead of throwing on a malformed selector', () => {
    render('<button id="go">Go</button>');
    expect(clickBySelector('>>>not a selector', false)).toEqual(MISS);
    expect(clickedIds()).toEqual([]);
  });

  it('reports a miss when nothing matches', () => {
    render('<button id="go">Go</button>');
    expect(clickBySelector('#missing', false)).toEqual(MISS);
  });

  it('probeOnly finds the element without clicking it', () => {
    render('<button id="go">Go</button>');
    expect(clickBySelector('#go', true)).toEqual({ found: true, clicked: false });
    expect(clickedIds()).toEqual([]);
  });

  it('probeOnly still reports a miss', () => {
    render('<button id="go">Go</button>');
    expect(clickBySelector('#missing', true)).toEqual(MISS);
  });
});
