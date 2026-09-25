/**
 * "My workspace": saved objects, records, and SOQL queries, kept per org.
 * Pure functions so the rules (dedupe, validation, ordering) are testable.
 */

export type FavoriteKind = 'object' | 'record' | 'query';

export interface Favorite {
  id: string;
  kind: FavoriteKind;
  /** User-facing name. */
  label: string;
  /** Object API name, record ID, or SOQL text depending on kind. */
  value: string;
  /** Extra context, e.g. the record's object API name. */
  objectApiName?: string;
  createdAt: number;
}

export const MAX_FAVORITES = 200;
export const MAX_LABEL = 80;

export function favoriteKey(f: Pick<Favorite, 'kind' | 'value'>): string {
  return f.kind === 'query' ? `query:${f.value.trim().replace(/\s+/g, ' ')}` : `${f.kind}:${f.value.toLowerCase()}`;
}

export function isFavorite(list: Favorite[], kind: FavoriteKind, value: string): boolean {
  const key = favoriteKey({ kind, value });
  return list.some((f) => favoriteKey(f) === key);
}

/** Returns an error message for an invalid label, or undefined when valid. */
export function validateLabel(list: Favorite[], label: string, kind: FavoriteKind, ignoreId?: string): string | undefined {
  const t = label.trim();
  if (!t) return 'Enter a name.';
  if (t.length > MAX_LABEL) return `Use ${MAX_LABEL} characters or fewer.`;
  if (list.some((f) => f.kind === kind && f.id !== ignoreId && f.label.trim().toLowerCase() === t.toLowerCase())) {
    return 'You already have a saved item with this name.';
  }
  return undefined;
}

/** Adds (or moves to the top, when it already exists) a favorite. */
export function addFavorite(list: Favorite[], item: Omit<Favorite, 'id' | 'createdAt'>, now = Date.now(), id = `fav_${now.toString(36)}`): Favorite[] {
  const key = favoriteKey(item);
  const existing = list.find((f) => favoriteKey(f) === key);
  const next: Favorite = existing
    ? { ...existing, label: item.label.trim() || existing.label, ...(item.objectApiName ? { objectApiName: item.objectApiName } : {}) }
    : { ...item, label: item.label.trim(), id, createdAt: now };
  return [next, ...list.filter((f) => favoriteKey(f) !== key)].slice(0, MAX_FAVORITES);
}

export function removeFavorite(list: Favorite[], id: string): Favorite[] {
  return list.filter((f) => f.id !== id);
}

export function renameFavorite(list: Favorite[], id: string, label: string): Favorite[] {
  return list.map((f) => (f.id === id ? { ...f, label: label.trim() } : f));
}

export function groupFavorites(list: Favorite[]): Record<FavoriteKind, Favorite[]> {
  const out: Record<FavoriteKind, Favorite[]> = { object: [], record: [], query: [] };
  for (const f of list) out[f.kind].push(f);
  return out;
}
