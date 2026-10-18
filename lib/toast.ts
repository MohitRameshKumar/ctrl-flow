// A small centered toast for leader-key feedback, in a closed shadow root so no page style leaks in or out.
// Used after K / R / M: the pie has already closed by then, so this is the only in-page place to answer.
export interface ToastOptions {
  title: string;
  message: string;
  /** A one-click button (e.g. "Assign K"). */
  action?: { label: string; run: () => void };
  /** ms before it fades on its own. */
  ttl?: number;
}

const HOST_ID = 'cadence-toast-host';

export function showToast(opts: ToastOptions): () => void {
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .toast { position: fixed; left: 50%; bottom: 18vh; transform: translateX(-50%); max-width: min(360px, 90vw);
      background: rgba(255,255,255,0.98); color: #14161b; border: 1px solid rgba(20,22,27,0.16); border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.28); padding: 10px 14px; pointer-events: auto;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; gap: 12px;
      animation: in 160ms ease-out both; }
    @media (prefers-color-scheme: dark) { .toast { background: rgba(24,26,32,0.98); color: #f2f4f8; border-color: rgba(255,255,255,0.14); } }
    @keyframes in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
    .t { font-weight: 600; } .m { opacity: 0.75; }
    button { all: unset; cursor: pointer; background: #2563eb; color: #fff; border-radius: 6px; padding: 4px 10px; font-weight: 600; }
    button:focus-visible { outline: 2px solid #93b4ff; outline-offset: 2px; }
  `;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('div');
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = opts.title;
  const m = document.createElement('div');
  m.className = 'm';
  m.textContent = opts.message;
  text.append(t, m);
  toast.append(text);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    host.remove();
  };
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      opts.action!.run();
      close();
    });
    toast.append(b);
  }
  shadow.append(style, toast);
  document.documentElement.append(host);
  timer = setTimeout(close, opts.ttl ?? 6000);
  return close;
}
