/**
 * Runs an async task with loading/error state and cancellation. Starting a new
 * run (or unmounting) aborts the previous one, so stale results never overwrite
 * newer ones when the user navigates quickly between records.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { isCancelled } from '../../shared/api/errors';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  run: () => void;
  cancel: () => void;
}

export function useAsync<T>(task: ((signal: AbortSignal) => Promise<T>) | null, deps: unknown[], opts: { auto?: boolean } = { auto: true }): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  // Start in the loading state when there is work to do, so the first render never shows an empty or fallback result.
  const [loading, setLoading] = useState(() => !!task && opts.auto !== false);
  const ctrlRef = useRef<AbortController | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    setLoading(false);
  }, []);

  const run = useCallback(() => {
    const t = taskRef.current;
    ctrlRef.current?.abort();
    if (!t) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(undefined);
    t(ctrl.signal).then(
      (d) => {
        if (ctrl.signal.aborted) return;
        setData(d);
        setLoading(false);
      },
      (e) => {
        if (ctrl.signal.aborted || isCancelled(e)) return;
        setError(e);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    if (opts.auto !== false) run();
    return () => ctrlRef.current?.abort();
  }, deps);

  return { data, error, loading, run, cancel };
}
