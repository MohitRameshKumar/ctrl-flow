import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BLOCKLIST, getBlocklist, normalizeDomainInput } from '@/lib/privacy';
import { DEFAULT_RETENTION, RETENTION_KEY, RETENTION_OPTIONS, isRetentionSetting, type RetentionSetting } from '@/lib/retention';
import type { BlocklistConfig } from '@/lib/types';

/** PRIV-5 retention and PRIV-7 excluded domains. */
export function PrivacySettings() {
  const [retention, setRetention] = useState<RetentionSetting>(DEFAULT_RETENTION);
  const [blocklist, setBlocklist] = useState<BlocklistConfig>(DEFAULT_BLOCKLIST);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

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

  const add = async () => {
    const domain = normalizeDomainInput(draft);
    if (!domain) {
      setError('Enter a site like example.com.');
      return;
    }
    setError('');
    if (!blocklist.domains.includes(domain)) await save({ ...blocklist, domains: [...blocklist.domains, domain] });
    setDraft('');
  };

  const remove = (domain: string) => save({ ...blocklist, domains: blocklist.domains.filter((d) => d !== domain) });

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

      <div className="sub-title">Never record these sites</div>
      <ul className="excluded-list">
        {(showAll ? blocklist.domains : blocklist.domains.slice(0, 3)).map((d) => (
          <li key={d}>
            <span>{d}</span>
            <button className="btn btn-remove" onClick={() => remove(d)} aria-label={`Remove ${d}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {blocklist.domains.length > 3 && (
        <button className="btn-link self-start" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${blocklist.domains.length} sites`}
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
        <button className="btn sm" onClick={add}>
          Add
        </button>
      </div>
      {error && <div className="letter-error">{error}</div>}
    </div>
  );
}
