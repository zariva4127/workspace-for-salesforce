/**
 * Saved objects, records, and queries for the selected org, synced across open
 * windows via chrome.storage. Removing shows an Undo toast.
 */
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../state/workspace';
import { profiles } from '../services/platform';
import { useToast } from '../components/Toasts';
import { addFavorite, favoriteKey, removeFavorite, renameFavorite, type Favorite, type FavoriteKind } from '../../shared/workspace/favorites';

const KEY = 'favorites';

export function useFavorites() {
  const ws = useWorkspace();
  const toast = useToast();
  const orgKey = ws.org?.key;
  const store = useMemo(() => (orgKey ? profiles.scoped(orgKey) : null), [orgKey]);
  const [list, setList] = useState<Favorite[]>([]);

  useEffect(() => {
    setList([]);
    if (!store) return;
    const load = () => void store.get<Favorite[]>(KEY).then((l) => setList(l ?? []));
    load();
    const onChanged = (_c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [store]);

  const write = useCallback(
    async (next: Favorite[]) => {
      setList(next);
      await store?.set(KEY, next);
    },
    [store],
  );

  const add = useCallback(
    async (item: Omit<Favorite, 'id' | 'createdAt'>) => {
      await write(addFavorite(list, item, Date.now(), `fav_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`));
      toast({ message: `Saved “${item.label.trim()}” to your workspace.` });
    },
    [list, write, toast],
  );

  const remove = useCallback(
    async (fav: Favorite) => {
      const before = list;
      await write(removeFavorite(list, fav.id));
      toast({ kind: 'info', message: `Removed “${fav.label}”.`, action: { label: 'Undo', onClick: () => void write(before) } });
    },
    [list, write, toast],
  );

  const rename = useCallback(
    async (id: string, label: string) => {
      await write(renameFavorite(list, id, label));
      toast({ message: 'Name updated.' });
    },
    [list, write, toast],
  );

  const find = useCallback((kind: FavoriteKind, value: string) => {
    const key = favoriteKey({ kind, value });
    return list.find((f) => favoriteKey(f) === key);
  }, [list]);

  /** Drops a record that no longer exists (e.g. after it was deleted), without an Undo toast. */
  const forgetRecord = useCallback(
    async (id: string) => {
      const current = (await store?.get<Favorite[]>(KEY)) ?? list;
      const next = current.filter((f) => !(f.kind === 'record' && f.value.slice(0, 15) === id.slice(0, 15)));
      if (next.length !== current.length) await write(next);
    },
    [store, list, write],
  );

  return { list, add, remove, rename, find, forgetRecord, available: !!store };
}
