import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Replace the cached value without a round trip, e.g. after a successful change. */
  setData: (value: T | ((current: T | undefined) => T)) => void;
}

/**
 * Loads data for a page. Stale responses are ignored when inputs change or the component unmounts,
 * so a slow earlier request never overwrites a newer one.
 */
export function useResource<T>(loader: () => Promise<T>, deps: DependencyList): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let active = true;
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (!active) return;
        setDataState(value);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // The caller decides when to reload by changing deps or calling reload().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const setData = useCallback((value: T | ((current: T | undefined) => T)) => {
    setDataState((current) => (typeof value === 'function' ? (value as (c: T | undefined) => T)(current) : value));
  }, []);

  return { data, error, loading, reload, setData };
}

/** Runs a callback on an interval while the component is mounted. */
export function usePolling(callback: () => void, intervalMs: number): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
