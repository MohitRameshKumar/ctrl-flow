// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { typeIntoSelector } from '@/lib/macro-injected';

/**
 * Exercises the function that is actually injected, for the same reason as the click tests: an
 * injected function cannot reference module scope, so any separate "typing helper" export would
 * be a second implementation free to drift.
 */
function render(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('typeIntoSelector', () => {
  it('sets the value of a text input', () => {
    render('<input id="q" />');
    expect(typeIntoSelector('#q', 'standup notes')).toEqual({ ok: true });
    expect(document.querySelector<HTMLInputElement>('#q')?.value).toBe('standup notes');
  });

  it('fills a textarea', () => {
    render('<textarea id="body"></textarea>');
    expect(typeIntoSelector('#body', 'line one')).toEqual({ ok: true });
    expect(document.querySelector<HTMLTextAreaElement>('#body')?.value).toBe('line one');
  });

  it('fires a bubbling input event, which is how React notices', () => {
    render('<div id="root"><input id="q" /></div>');
    const onInput = vi.fn();
    // React 17+ attaches at the root container rather than the element, so a non-bubbling
    // event would be invisible to it.
    document.getElementById('root')!.addEventListener('input', onInput);

    typeIntoSelector('#q', 'hello');

    expect(onInput).toHaveBeenCalledOnce();
    expect(onInput.mock.calls[0]?.[0]?.bubbles).toBe(true);
  });

  it('fires change as well as input', () => {
    render('<input id="q" />');
    const onChange = vi.fn();
    document.body.addEventListener('change', onChange);

    typeIntoSelector('#q', 'hello');

    expect(onChange).toHaveBeenCalledOnce();
  });

  it('goes through the native setter so a value tracker sees a real change', () => {
    render('<input id="q" />');
    const el = document.querySelector<HTMLInputElement>('#q')!;

    // Stand in for React's instance-level `value` setter: if the implementation assigned
    // through the element rather than the prototype, this spy would swallow the write and the
    // framework would never see an update.
    const instanceSetter = vi.fn();
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => '',
      set: instanceSetter,
    });

    typeIntoSelector('#q', 'hello');

    expect(instanceSetter).not.toHaveBeenCalled();
  });

  it('refuses a password field', () => {
    render('<input id="pw" type="password" />');
    expect(typeIntoSelector('#pw', 'hunter2')).toEqual({
      ok: false,
      reason: 'refused: credential field',
    });
    expect(document.querySelector<HTMLInputElement>('#pw')?.value).toBe('');
  });

  it('refuses a hidden field', () => {
    render('<input id="csrf" type="hidden" />');
    expect(typeIntoSelector('#csrf', 'x')).toMatchObject({ ok: false });
  });

  it('reports a miss rather than throwing', () => {
    render('<input id="q" />');
    expect(typeIntoSelector('#missing', 'x')).toEqual({ ok: false, reason: 'element not found' });
  });

  it('reports a malformed selector rather than throwing', () => {
    render('<input id="q" />');
    expect(typeIntoSelector('>>>bad', 'x')).toEqual({ ok: false, reason: 'malformed selector' });
  });

  it('declines an element that cannot be typed into', () => {
    render('<div id="plain">text</div>');
    expect(typeIntoSelector('#plain', 'x')).toEqual({ ok: false, reason: 'not a typable element' });
  });

  it('focuses the field before typing', () => {
    render('<input id="q" />');
    typeIntoSelector('#q', 'hello');
    expect(document.activeElement?.id).toBe('q');
  });
});
