'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createMatch, applyCommand, type Command, type Rules } from '@judo/engine/match';
import type { MatchAction } from './types';
export function useMatch(rules: Rules) {
  const ref = useRef(createMatch(rules));
  const anchor = useRef<number | null>(null);
  const [state, setState] = useState(ref.current);
  const [error, setError] = useState('');
  const dispatch = useCallback((action: MatchAction) => {
    ref.current = applyCommand(ref.current, {
      ...action,
      id: crypto.randomUUID(),
      expectedVersion: ref.current.version,
    } as Command);
  }, []);
  const sync = useCallback(() => {
    const now = performance.now();
    if (anchor.current === null) anchor.current = now;
    const ms = Math.floor(now - anchor.current);
    if (ref.current.status === 'RUNNING' && ms > 0) {
      dispatch({ type: 'ADVANCE', ms });
      anchor.current += ms;
    } else if (ref.current.status !== 'RUNNING') anchor.current = now;
  }, [dispatch]);
  useEffect(() => {
    const id = setInterval(() => {
      sync();
      setState(ref.current);
    }, 100);
    return () => clearInterval(id);
  }, [sync]);
  const send = useCallback(
    (action: MatchAction) => {
      try {
        sync();
        dispatch(action);
        anchor.current = performance.now();
        setError('');
      } catch {
        setError('Действие недоступно в текущем состоянии. Проверьте время и активное удержание.');
      }
      setState(ref.current);
    },
    [dispatch, sync],
  );
  const reset = useCallback(() => {
    ref.current = createMatch(rules);
    anchor.current = null;
    setState(ref.current);
    setError('');
  }, [rules]);
  return { state, send, reset, error };
}
