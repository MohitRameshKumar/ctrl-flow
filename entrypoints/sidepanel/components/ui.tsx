// Small shared building blocks for the side panel: icons, icon buttons, the keycap badge (the same
// monospace key shape the leader pie uses), an overflow menu, and a favicon-free site tile.
import { useEffect, useRef, useState, type ReactNode } from 'react';

const ICONS = {
  chevron: 'M9 6l6 6-6 6',
  play: 'M8 5v14l11-7z',
  pause: 'M8 5v14M16 5v14',
  more: 'M12 5.5v.01M12 12v.01M12 18.5v.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7',
  record: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  shelve: 'M4 7h16M5 7v12h14V7M9 11h6',
  restore: 'M4 12a8 8 0 1 1 2.3 5.7M4 19v-7h7',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12',
  check: 'M5 12l5 5 9-10',
  external: 'M14 5h5v5M19 5l-8 8M18 14v5H5V6h5',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = name === 'play';
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  tone,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: 'accent' | 'danger';
}) {
  const cls = ['ibtn', active ? 'on' : '', tone ?? ''].filter(Boolean).join(' ');
  return (
    <button className={cls} title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/** A key shown as a key: the same monospace cap as the leader pie's letter badges. */
export function Keycap({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <kbd className="keycap" title={title}>
      {children}
    </kbd>
  );
}

export interface MenuItemSpec {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
}

export type MenuEntry = MenuItemSpec | { heading: string };

export function Menu({ items, label = 'More actions' }: { items: MenuEntry[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <IconButton icon="more" label={label} active={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((item, i) =>
            'heading' in item ? (
              <div key={i} className="menu-heading">
                {item.heading}
              </div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={item.danger ? 'menu-item danger' : 'menu-item'}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="menu-check">{item.checked ? <Icon name="check" size={12} /> : null}</span>
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * A letter tile in a color derived from the site. Deliberately not a favicon: fetching one would send
 * every visited host to a third party, or need the `favicon` permission.
 */
export function SiteTile({ url }: { url: string }) {
  const host = hostOf(url);
  let hash = 0;
  for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="tile" style={{ ['--hue' as string]: hash }} aria-hidden="true">
      {(host[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A titled, collapsible group; used by Settings. */
export function Group({ title, children, defaultOpen = true, nested = false }: { title: string; children: ReactNode; defaultOpen?: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={nested ? 'group nested' : 'group'}>
      <button className="group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={open ? 'chev open' : 'chev'}>
          <Icon name="chevron" size={14} />
        </span>
        {title}
      </button>
      {open && <div className="group-body">{children}</div>}
    </section>
  );
}
