import { useEffect, useState } from 'react';

import { api, isAbort } from '../api/client';
import type { GeocodeResult } from '../api/types';

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

/** Debounced, cancellable place search (stale responses are discarded). */
export function usePlaceSearch(query: string, enabled: boolean, delayMs = 250) {
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus('loading');
      api
        .geocode(q, controller.signal)
        .then((r) => {
          setResults(r);
          setStatus('done');
        })
        .catch((error: unknown) => {
          if (isAbort(error)) return;
          setResults([]);
          setStatus('error');
        });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, delayMs]);

  return { results, status };
}
