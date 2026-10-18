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
import { SpaceLetterControl } from './SpaceLetterControl';
import { SuggestionCard } from './SuggestionCard';
import { Icon, IconButton, Keycap, Menu, SiteTile } from './ui';

interface SpaceWithUrls extends Space {
  urls: SpaceUrl[];
}

function SpaceNameInput({ space, onRename, onDone }: { space: Space; onRename: (name: string) => void; onDone: () => void }) {
  const [value, setValue] = useState(space.name);
  useEffect(() => setValue(space.name), [space.name]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== space.name) onRename(trimmed);
    onDone();
  };

  return (
    <input
      className="name-input"
      value={value}
      autoFocus
      aria-label="Space name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
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
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showLetter, setShowLetter] = useState(false);
  const [busy, setBusy] = useState(false);
  if (space.id === undefined) return null;
  const spaceId = space.id;

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
    <section className="mrow">
      <div className="row-line">
        <button className={open ? 'chev open' : 'chev'} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron" size={14} />
        </button>
        {renaming ? (
          <SpaceNameInput
            space={space}
            onRename={async (name) => {
              await renameSpace(spaceId, name);
              onRefresh();
            }}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <button className="row-title" title={space.name} onClick={() => setOpen((v) => !v)}>
            {space.name}
          </button>
        )}
        {space.letter && <Keycap title={`Leader + ${space.letter.toUpperCase()} switches here`}>{space.letter.toUpperCase()}</Keycap>}
        <span className="meta">{space.urls.length} {space.urls.length === 1 ? 'tab' : 'tabs'}</span>
        <IconButton icon="shelve" label="Shelve: close these tabs and keep them for later" disabled={busy} onClick={() => runAction(() => shelveSpace(spaceId))} />
        <IconButton icon="restore" label="Restore the shelved tabs" disabled={busy} onClick={() => runAction(() => restoreSpace(spaceId))} />
        <Menu
          items={[
            { label: 'Rename', onSelect: () => setRenaming(true) },
            { label: space.letter ? 'Change letter' : 'Set letter', onSelect: () => { setOpen(true); setShowLetter(true); } },
            { label: 'Close tabs and save', onSelect: () => runAction(() => closeAndSaveSpace(spaceId)) },
          ]}
        />
      </div>

      {open && (
        <div className="mrow-body">
          {showLetter && <SpaceLetterControl spaceId={spaceId} name={space.name} />}
          {space.urls.length === 0 ? (
            <div className="empty">No tabs in this space yet.</div>
          ) : (
            <ul className="step-list">
              {space.urls.map((u) => {
                if (u.id === undefined) return null;
                const spaceUrlId = u.id;
                const others = allSpaces.filter((x) => x.id !== undefined && x.id !== spaceId);
                return (
                  <li key={spaceUrlId}>
                    <SiteTile url={u.url} />
                    <span className="step-title" title={`${u.title || u.url}\n${u.url}`}>
                      {u.title || u.url}
                    </span>
                    {u.alwaysOpen && <span className="chip" title="Opens whenever this space is restored">always open</span>}
                    <Menu
                      label="Tab options"
                      items={[
                        {
                          label: 'Always open',
                          checked: u.alwaysOpen,
                          onSelect: async () => {
                            await setSpaceUrlAlwaysOpen(spaceUrlId, !u.alwaysOpen);
                            onRefresh();
                          },
                        },
                        ...(others.length > 0 ? [{ heading: 'Move to' } as const] : []),
                        ...others.map((x) => ({
                          label: x.name,
                          onSelect: async () => {
                            await moveSpaceUrl(spaceUrlId, x.id!);
                            onRefresh();
                          },
                        })),
                      ]}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
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

  if (unassigned.length === 0) return null;
  return (
    <section>
      <h3 className="sec-title">
        Unassigned <span className="count">{unassigned.length}</span>
      </h3>
      <ul className="step-list flush">
        {unassigned.map((c) => (
          <li key={c.url}>
            <SiteTile url={c.url} />
            <span className="step-title" title={`${c.title || c.url}\n${c.url}`}>
              {c.title || c.url}
            </span>
            {spaces.length > 0 && (
              <Menu
                label="Add to a space"
                items={[
                  { heading: 'Add to' },
                  ...spaces.map((s) => ({ label: s.name, onSelect: () => assign(c.url, c.title, s.id!) })),
                ]}
              />
            )}
          </li>
        ))}
      </ul>
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

      <div className="toolbar">
        <h3 className="sec-title flush">
          Spaces <span className="count">{spaces.length}</span>
        </h3>
        <span className="grow" />
        <IconButton icon="refresh" label={recomputing ? 'Recomputing…' : 'Recompute spaces now'} disabled={recomputing} onClick={recomputeNow} />
      </div>

      {spaces.length === 0 && (
        <div className="empty">No spaces yet. Open a few related tabs for a while, then press recompute.</div>
      )}
      {spaces.map((s) => (
        <SpaceCard key={s.id} space={s} allSpaces={spaces} onRefresh={refresh} />
      ))}

      <UnassignedSection unassigned={unassigned} spaces={spaces} onRefresh={refresh} />
    </div>
  );
}
