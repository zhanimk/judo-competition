'use client';
import { useEffect, useRef, useState } from 'react';
import type { MatchState } from '@judo/engine/match';
import type { MatchAction } from '../scoreboard/model/types';
import type { View } from '../live/live-board';
import { ApiError, request } from '../tournaments/api';
import { readJournal, writeJournal, prepareOfflineShell } from './storage';
import { appendJournalCommand, canReleaseJournal, type Journal, type Packet } from './journal';
export function useOfflineMatch(tatamiId: string, enabled: boolean, onReleased: () => void) {
  const [journal, setJournal] = useState<Journal | null>(null),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [restored, setRestored] = useState(!enabled),
    [online, setOnline] = useState(false);
  const ref = useRef<Journal | null>(null),
    owned = useRef(false),
    chain = useRef(Promise.resolve()),
    anchor = useRef(0),
    syncing = useRef(false),
    releaseCallback = useRef(onReleased);
  releaseCallback.current = onReleased;
  const key = 'active:' + tatamiId;
  function mutate(fn: (j: Journal | null) => Journal | null | Promise<Journal | null>) {
    const next = chain.current.then(async () => {
      if (!owned.current) throw new Error('OFFLINE_TAB_LOCKED');
      const value = await fn(ref.current);
      try {
        await writeJournal(key, value);
      } catch (e) {
        owned.current = false;
        setReady(false);
        throw e;
      }
      ref.current = value;
      setJournal(value);
    });
    chain.current = next.catch((e) => {
      setError((e as Error).message);
    });
    return next;
  }
  function advance(j: Journal) {
    const at = performance.now(),
      ms = Math.max(0, Math.floor(at - anchor.current));
    anchor.current = at;
    return j.state.status === 'RUNNING' && ms
      ? appendJournalCommand(j, { type: 'ADVANCE', ms })
      : j;
  }
  useEffect(() => {
    if (!enabled) return;
    setRestored(false);
    setReady(false);
    let stopped = false,
      unlock: () => void = () => {};
    if (!navigator.locks) {
      setError('OFFLINE_BROWSER_UNSUPPORTED');
      setRestored(true);
      return;
    }
    void navigator.locks
      .request('judo-offline:' + tatamiId, { ifAvailable: true }, async (lock) => {
        if (!lock || stopped) {
          if (!stopped) {
            setError('OFFLINE_TAB_LOCKED');
            setRestored(true);
          }
          return;
        }
        owned.current = true;
        try {
          let saved = await readJournal<Journal>(key);
          if (saved && saved.state.status === 'RUNNING')
            saved = appendJournalCommand(saved, { type: 'RECOVER' });
          if (saved) await writeJournal(key, saved);
          if (stopped) return;
          ref.current = saved;
          setJournal(saved);
          setRestored(true);
          anchor.current = performance.now();
          setReady(true);
          await new Promise<void>((resolve) => {
            unlock = resolve;
          });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          owned.current = false;
        }
      })
      .catch((e: unknown) => {
        if (stopped) return;
        owned.current = false;
        setReady(false);
        setRestored(true);
        setError(e instanceof Error ? e.message : 'OFFLINE_BROWSER_UNSUPPORTED');
      });
    const timer = setInterval(() => {
      if (
        owned.current &&
        ref.current &&
        !ref.current.opening &&
        !ref.current.conflict &&
        ref.current.state.status === 'RUNNING'
      )
        void mutate((j) => (j ? advance(j) : j)).catch(() => {});
    }, 250);
    return () => {
      stopped = true;
      clearInterval(timer);
      owned.current = false;
      // Finish any transaction that already started before another tab can read the journal.
      void chain.current.then(unlock, unlock);
    };
  }, [enabled, tatamiId]);
  useEffect(() => {
    if (!journal || !enabled) return;
    let lock: WakeLockSentinel | undefined,
      stopped = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || !navigator.wakeLock || lock) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (stopped) {
          await next.release();
          return;
        }
        lock = next;
        next.addEventListener('release', () => {
          lock = undefined;
        });
      } catch {
        /* The board remains usable if the browser declines a wake lock. */
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [!!journal, enabled]);
  async function synchronize(release = false) {
    if (!owned.current || syncing.current || !ref.current || ref.current.conflict) return;
    if (release && !canReleaseJournal(ref.current)) return;
    syncing.current = true;
    try {
      let packet: Packet | undefined,
        id = '';
      await mutate((j) => {
        if (!j) return j;
        // Local commands may have entered the journal while this mutation waited its turn.
        if (release && !canReleaseJournal(j)) return j;
        id = j.view.currentMatch!.id;
        if (!j.packet && (j.events.length || release)) {
          j = {
            ...j,
            packet: {
              id: crypto.randomUUID(),
              sessionId: j.sessionId,
              expectedVersion: j.revision,
              type: release ? 'OFFLINE_RELEASE' : 'OFFLINE_SYNC',
              events: j.events.slice(0, 128),
            },
          };
        }
        packet = j.packet;
        return j;
      });
      if (!packet) return;
      const sent = packet;
      const response = await request<{ revision: number; status: string; state: MatchState }>(
        `/tatamis/${tatamiId}/live/${id}/command`,
        sent,
      );
      setOnline(true);
      await mutate(async (j) => {
        if (!j || j.packet?.id !== sent.id) return j;
        if (response.status === 'CONFIRMED' || sent.type === 'OFFLINE_RELEASE') {
          await writeJournal('archive:' + j.sessionId, {
            ...j,
            acknowledgedAt: new Date().toISOString(),
            response,
          });
          return null;
        }
        return {
          ...j,
          revision: response.revision,
          packet: undefined,
          opening: false,
          events: j.events.slice(sent.events?.length ?? 0),
        };
      });
      if (!ref.current) releaseCallback.current();
    } catch (e) {
      setOnline(false);
      if (e instanceof ApiError && e.status < 500)
        await mutate((j) => (j ? { ...j, conflict: e.message } : j)).catch(() => {});
    } finally {
      syncing.current = false;
    }
  }
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => void synchronize(), 1000);
    return () => clearInterval(id);
  }, [enabled, tatamiId]);
  async function arm(view: View) {
    if (!ready || !view.currentMatch || ref.current) return;
    try {
      await prepareOfflineShell();
      const sessionId = crypto.randomUUID(),
        match = view.currentMatch;
      await mutate(() => ({
        sessionId,
        view,
        state: match.state,
        revision: match.revision,
        events: [],
        opening: true,
        packet: {
          id: crypto.randomUUID(),
          sessionId,
          expectedVersion: match.revision,
          type: 'OFFLINE_OPEN',
        },
      }));
      anchor.current = performance.now();
      await synchronize();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send(action: MatchAction) {
    try {
      await mutate((j) => {
        if (!j || j.opening || j.conflict) return j;
        return appendJournalCommand(advance(j), action);
      });
      void synchronize();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function download() {
    if (!ref.current) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(ref.current, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `judo-journal-${ref.current.view.currentMatch!.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function archiveConflict() {
    if (!ref.current?.conflict) return;
    await mutate(async (j) => {
      if (j) await writeJournal('archive:' + j.sessionId, j);
      return null;
    });
    releaseCallback.current();
  }
  return {
    journal,
    ready,
    restored,
    error,
    online,
    arm,
    send,
    synchronize,
    download,
    archiveConflict,
    retry: () => mutate((j) => (j ? { ...j, conflict: undefined } : j)),
  };
}
