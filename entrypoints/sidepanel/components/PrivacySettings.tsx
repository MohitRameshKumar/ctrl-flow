import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BLOCKLIST, getBlocklist, normalizeDomainInput } from '@/lib/privacy';
import { DEFAULT_RETENTION, RETENTION_KEY, RETENTION_OPTIONS, isRetentionSetting, type RetentionSetting } from '@/lib/retention';
import type { BlocklistConfig, ExclusionMode } from '@/lib/types';

/** PRIV-5 retention and PRIV-7 excluded domains. */
export function PrivacySettings() {
  const [retention, setRetention] = useState<RetentionSetting>(DEFAULT_RETENTION);
  const [blocklist, setBlocklist] = useState<BlocklistConfig>(DEFAULT_BLOCKLIST);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [draftMode, setDraftMode] = useState<ExclusionMode>('never');

  const refresh = useCallback(async () => {
    const { [RETENTION_KEY]: r } = await chrome.storage.local.get<Record<string, unknown>>(RETENTION_KEY);
    setRetention(isRetentionSetting(r) ? r : DEFAULT_RETENTION);
    setBlocklist(await getBlocklist());
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const save = (next: BlocklistConfig) => chrome.storage.local.set({ blocklist: next });

  const visitOnly = blocklist.visitOnly ?? [];
  /** One row per excluded site, in either mode. "Never" wins if a site is somehow in both lists. */
  const sites: { domain: string; mode: ExclusionMode }[] = [
    ...blocklist.domains.map((domain) => ({ domain, mode: 'never' as const })),
    ...visitOnly.filter((d) => !blocklist.domains.includes(d)).map((domain) => ({ domain, mode: 'visit-only' as const })),
  ];

  const place = (domain: string, mode: ExclusionMode): BlocklistConfig => ({
    ...blocklist,
    domains: mode === 'never' ? [...blocklist.domains.filter((d) => d !== domain), domain] : blocklist.domains.filter((d) => d !== domain),
    visitOnly: mode === 'visit-only' ? [...visitOnly.filter((d) => d !== domain), domain] : visitOnly.filter((d) => d !== domain),
  });

  const add = async () => {
    const domain = normalizeDomainInput(draft);
    if (!domain) {
      setError('Enter a site like example.com.');
      return;
    }
    setError('');
    if (!sites.some((s) => s.domain === domain)) await save(place(domain, draftMode));
    setDraft('');
  };

  const remove = (domain: string) =>
    save({ ...blocklist, domains: blocklist.domains.filter((d) => d !== domain), visitOnly: visitOnly.filter((d) => d !== domain) });

  return (
    <div className="settings-block privacy-settings">
      <label className="settings-row">
        <span>Keep activity history for</span>
        <select
          value={retention}
          onChange={(e) => chrome.storage.local.set({ [RETENTION_KEY]: e.target.value })}
          aria-label="Retention"
        >
          {RETENTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">
        Older activity is deleted automatically; saved rituals, spaces and macros are kept. A short setting gives Rituals and Spaces less to learn from.
      </div>

      <div className="sub-title">Excluded sites</div>
      <div className="hint">
        <strong>Never record</strong> keeps nothing. <strong>Visit only</strong> notes that you opened the site (its front page, no title,
        path, clicks or typing), so a macro can open it. Neither is sent anywhere beyond the bare domain.
      </div>
      <ul className="excluded-list">
        {(showAll ? sites : sites.slice(0, 4)).map(({ domain, mode }) => (
          <li key={domain}>
            <span>{domain}</span>
            <select
              className="excluded-mode"
              value={mode}
              aria-label={`How to treat ${domain}`}
              onChange={(e) => save(place(domain, e.target.value as ExclusionMode))}
            >
              <option value="never">Never record</option>
              <option value="visit-only">Visit only</option>
            </select>
            <button className="btn btn-remove" onClick={() => remove(domain)} aria-label={`Remove ${domain}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {sites.length > 4 && (
        <button className="btn-link self-start" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${sites.length} sites`}
        </button>
      )}
      <div className="settings-row">
        <input
          className="excluded-input"
          placeholder="example.com"
          aria-label="Add excluded site"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <select className="excluded-mode" value={draftMode} aria-label="Mode for the new site" onChange={(e) => setDraftMode(e.target.value as ExclusionMode)}>
          <option value="never">Never record</option>
          <option value="visit-only">Visit only</option>
        </select>
        <button className="btn sm" onClick={add}>
          Add
        </button>
      </div>
      {error && <div className="letter-error">{error}</div>}
    </div>
  );
}
