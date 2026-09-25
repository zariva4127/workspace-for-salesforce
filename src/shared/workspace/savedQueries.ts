export interface SavedQuery { id: string; name: string; query: string; tooling: boolean; updatedAt: number }

export function saveQuery(list: SavedQuery[], input: Omit<SavedQuery, 'id' | 'updatedAt'>, now = Date.now(), id = `query_${now.toString(36)}`): SavedQuery[] {
  return [{ ...input, id, updatedAt: now }, ...list].slice(0, 100);
}
export function renameQuery(list: SavedQuery[], id: string, name: string, now = Date.now()): SavedQuery[] {
  return list.map((q) => q.id === id ? { ...q, name: name.trim(), updatedAt: now } : q);
}
export function duplicateQuery(list: SavedQuery[], id: string, now = Date.now(), newId = `query_${now.toString(36)}`): SavedQuery[] {
  const q = list.find((x) => x.id === id);
  return q ? [{ ...q, id: newId, name: `${q.name} copy`, updatedAt: now }, ...list] : list;
}
