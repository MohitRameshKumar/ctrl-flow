// Which notifications ctrl-flow may raise, and how often. Pure rules plus a thin storage layer.
//
//   - Three attention types, each with its own toggle (Settings -> General -> Notifications).
//   - At most one notification per type per 10 minutes, so a burst never turns into a pile.
//   - A save the user just asked for (K / R / M) is a reply, not an interruption: it ignores the
//     throttle but still honours the toggle. Snoozes live with their owners (suggestion snooze,
//     flip-pair "Not now"); callers check those before asking here.
export type NotifyType = 'flip-pair' | 'macro-suggestion' | 'macro-saved';

export const NOTIFY_TYPES: { type: NotifyType; label: string; hint: string }[] = [
  { type: 'flip-pair', label: 'Focus Flip pair found', hint: 'When two tabs you keep switching between while typing look like a writing / reference pair.' },
  { type: 'macro-suggestion', label: 'Macro suggestions', hint: 'When a routine you repeat is ready to save as a macro.' },
  { type: 'macro-saved', label: 'Macro saved', hint: 'After K, R or M saves a macro, with a button to assign it a letter.' },
];

export const NOTIFY_THROTTLE_MS = 10 * 60 * 1000;
export const NOTIFY_SETTINGS_KEY = 'notifySettings';
const NOTIFY_LAST_KEY = 'notifyLast';

export type NotifySettings = Record<NotifyType, boolean>;
export type NotifyLast = Partial<Record<NotifyType, number>>;

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { 'flip-pair': true, 'macro-suggestion': true, 'macro-saved': true };

export function notifySettingsFrom(raw: unknown): NotifySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<NotifyType, unknown>>;
  const pick = (t: NotifyType): boolean => (typeof r[t] === 'boolean' ? (r[t] as boolean) : DEFAULT_NOTIFY_SETTINGS[t]);
  return { 'flip-pair': pick('flip-pair'), 'macro-suggestion': pick('macro-suggestion'), 'macro-saved': pick('macro-saved') };
}

/** The whole decision, pure. */
export function mayNotify(
  type: NotifyType,
  settings: NotifySettings,
  last: NotifyLast,
  now: number,
  opts: { userInitiated?: boolean } = {},
): boolean {
  if (!settings[type]) return false;
  if (opts.userInitiated) return true;
  const prev = last[type];
  return prev === undefined || now - prev >= NOTIFY_THROTTLE_MS;
}

export async function getNotifySettings(): Promise<NotifySettings> {
  const { [NOTIFY_SETTINGS_KEY]: raw } = await chrome.storage.local.get<Record<string, unknown>>(NOTIFY_SETTINGS_KEY);
  return notifySettingsFrom(raw);
}

export async function setNotifyEnabled(type: NotifyType, enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [NOTIFY_SETTINGS_KEY]: { ...(await getNotifySettings()), [type]: enabled } });
}

/** Asks permission to raise a notification of this type and, when granted, counts it against the throttle. */
export async function allowNotification(type: NotifyType, opts: { userInitiated?: boolean } = {}): Promise<boolean> {
  const [settings, stored] = await Promise.all([
    getNotifySettings(),
    chrome.storage.session.get<Record<string, NotifyLast | undefined>>(NOTIFY_LAST_KEY),
  ]);
  const last = stored[NOTIFY_LAST_KEY] ?? {};
  const now = Date.now();
  if (!mayNotify(type, settings, last, now, opts)) return false;
  if (!opts.userInitiated) await chrome.storage.session.set({ [NOTIFY_LAST_KEY]: { ...last, [type]: now } });
  return true;
}
