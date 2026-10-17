import { useCallback, useEffect, useState } from 'react';
import { addSpaceUrl, getSpaces, getSpaceUrls, moveSpaceUrl, renameSpace, setSpaceUrlAlwaysOpen } from '@/lib/db';
import {
  clearPendingSwitchSuggestion,
  closeAndSaveSpace,
  getPendingSwitchSuggestion,
  getUnassignedOpenTabs,
  neverSwitchForSpace,
  recomputeSpaces,
  restoreSpace,
  shelveSpace,
  type Candidate,
  type PendingSwitchSuggestion,
} from '@/lib/spaces';
import type { Space, SpaceUrl } from '@/lib/types';
import { SuggestionCard } from './SuggestionCard';

interface SpaceWithUrls extends Space {
  urls: SpaceUrl[];
}

function statusLabel(status: Space['status']): string {
  if (status === 'auto_offline') return 'auto (offline)';
  if (status === 'user') return 'user';
  return 'ai';
}

function SpaceNameInput({ space, onRename }: { space: Space; onRename: (name: string) => void }) {
  const [value, setValue] = useState(space.name);
  useEffect(() => setValue(space.name), [space.name]);

  return (
    <input
      className="space-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== space.name) onRename(trimmed);
      }}
    />
  );
}

function SpaceCard({
  space,
  allSpaces,
  onRefresh,
}: {
  space: SpaceWithUrls;
  allSpaces: Space[];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (space.id === undefined) return null;
  const spaceId = space.id;

  const rename = async (name: string) => {
    await renameSpace(spaceId, name);
    onRefresh();
  };

  const move = async (spaceUrlId: number, toSpaceId: number) => {
    await moveSpaceUrl(spaceUrlId, toSpaceId);
    onRefresh();
  };

  const toggleAlwaysOpen = async (spaceUrlId: number, checked: boolean) => {
    await setSpaceUrlAlwaysOpen(spaceUrlId, checked);
    onRefresh();
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-card">
      <div className="space-header">
        <SpaceNameInput space={space} onRename={rename} />
        <span className="space-status">{statusLabel(space.status)}</span>
      </div>

      {space.urls.length === 0 ? (
        <div className="ritual-empty">No tabs yet.</div>
      ) : (
        <ul className="tab-list">
          {space.urls.map((u) => {
            if (u.id === undefined) return null;
            const spaceUrlId = u.id;
            return (
              <li key={spaceUrlId}>
                <span className="tab-title" title={u.url}>
                  {u.title || u.url}
                </span>
                <label className="always-open-toggle">
                  <input
                    type="checkbox"
                    checked={u.alwaysOpen}
                    onChange={(e) => toggleAlwaysOpen(spaceUrlId, e.target.checked)}
                  />
                  always open
                </label>
                <select value={spaceId} onChange={(e) => move(spaceUrlId, Number(e.target.value))}>
                  {allSpaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-actions">
        <button className="btn" disabled={busy} onClick={() => runAction(() => shelveSpace(spaceId))}>
          Shelve
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => runAction(() => closeAndSaveSpace(spaceId))}
        >
          Close and save
        </button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => runAction(() => restoreSpace(spaceId))}>
          Restore
        </button>
      </div>
    </div>
  );
}

function UnassignedSection({
  unassigned,
  spaces,
  onRefresh,
}: {
  unassigned: Candidate[];
  spaces: Space[];
  onRefresh: () => void;
}) {
  const assign = async (url: string, title: string | undefined, spaceId: number) => {
    await addSpaceUrl({ spaceId, url, title, source: 'user', alwaysOpen: false });
    onRefresh();
  };

  return (
    <section className="unassigned-section">
      <h3>Unassigned</h3>
      {unassigned.length === 0 ? (
        <div className="ritual-empty">Nothing unassigned.</div>
      ) : (
        <ul className="tab-list">
          {unassigned.map((c) => (
            <li key={c.url}>
              <span className="tab-title" title={c.url}>
                {c.title || c.url}
              </span>
              {spaces.length > 0 && (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id) assign(c.url, c.title, id);
                  }}
                >
                  <option value="">Assign to…</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SwitchSuggestionBanner({
  pending,
  onRefresh,
}: {
  pending: PendingSwitchSuggestion;
  onRefresh: () => void;
}) {
  const accept = async () => {
    await shelveSpace(pending.fromSpaceId);
    await clearPendingSwitchSuggestion();
    onRefresh();
  };
  const notNow = async () => {
    await clearPendingSwitchSuggestion();
    onRefresh();
  };
  const never = async () => {
    await neverSwitchForSpace(pending.toSpaceId);
    await clearPendingSwitchSuggestion();
    onRefresh();
  };

  return (
    <SuggestionCard
      title={`Switch to ${pending.toName}?`}
      description={`Shelve ${pending.fromName} (${pending.fromTabCount} tab${pending.fromTabCount === 1 ? '' : 's'}).`}
      acceptLabel="Shelve"
      onAccept={accept}
      onNotNow={notNow}
      onNever={never}
    />
  );
}

export function SpacesTab() {
  const [spaces, setSpaces] = useState<SpaceWithUrls[]>([]);
  const [unassigned, setUnassigned] = useState<Candidate[]>([]);
  const [pending, setPending] = useState<PendingSwitchSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  const refresh = useCallback(async () => {
    const [allSpaces, allUrls, unassignedTabs, pendingSwitch] = await Promise.all([
      getSpaces(),
      getSpaceUrls(),
      getUnassignedOpenTabs(),
      getPendingSwitchSuggestion(),
    ]);
    const grouped: SpaceWithUrls[] = allSpaces.map((s) => ({
      ...s,
      urls: allUrls.filter((u) => u.spaceId === s.id),
    }));
    setSpaces(grouped);
    setUnassigned(unassignedTabs);
    setPending(pendingSwitch);
    setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      await recomputeSpaces();
      await refresh();
    })();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const recomputeNow = async () => {
    setRecomputing(true);
    try {
      await recomputeSpaces();
      await refresh();
    } finally {
      setRecomputing(false);
    }
  };

  if (loading) return <div className="loading">Loading spaces…</div>;

  return (
    <div className="spaces-tab">
      {pending && <SwitchSuggestionBanner pending={pending} onRefresh={refresh} />}

      <div className="spaces-toolbar">
        <button className="btn" disabled={recomputing} onClick={recomputeNow}>
          {recomputing ? 'Recomputing…' : 'Recompute now'}
        </button>
      </div>

      {spaces.length === 0 && (
        <div className="ritual-empty">No spaces yet. Open a few tabs, then recompute.</div>
      )}
      {spaces.map((s) => (
        <SpaceCard key={s.id} space={s} allSpaces={spaces} onRefresh={refresh} />
      ))}

      <UnassignedSection unassigned={unassigned} spaces={spaces} onRefresh={refresh} />
    </div>
  );
}
