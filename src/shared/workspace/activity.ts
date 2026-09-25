import type { KVStore } from '../storage/kv';

export interface ActivityItem { id: string; time: number; action: string; status: 'success' | 'error'; detail?: string }
export const ACTIVITY_KEY = 'activity';

export async function addActivity(store: KVStore, item: Omit<ActivityItem, 'id' | 'time'>, now = Date.now()): Promise<ActivityItem[]> {
  const current = (await store.get<ActivityItem[]>(ACTIVITY_KEY)) ?? [];
  const next = [{ ...item, id: `activity_${now.toString(36)}`, time: now }, ...current].slice(0, 50);
  await store.set(ACTIVITY_KEY, next);
  return next;
}
