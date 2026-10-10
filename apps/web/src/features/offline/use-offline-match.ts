'use client';
import { useEffect, useRef, useState } from 'react';
import type { MatchState } from '@judo/engine/match';
import type { MatchAction } from '../scoreboard/model/types';
import type { View } from '../live/live-board';
import { ApiError, request } from '../tournaments/api';
import { readJournal, writeJournal, prepareOfflineShell } from './storage';
import { appendJournalCommand, canReleaseJournal, type Journal, type Packet } from './journal';
import { journalControlError } from './journal';
import { sameGrant, type ControlGrant } from '../auth/control-model';
import { startJournalTabLock, type JournalTabLock } from './tab-lock';
export function useOfflineMatch(
  tatamiId: string,
  enabled: boolean,
  onReleased: () => void,
  grant: ControlGrant | null,
  controlKnown: boolean,
  deviceId: string | null,
) {
  const [journal, setJournal] = useState<Journal | null>(null),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [restored, setRestored] = useState(!enabled),
    [online, setOnline] = useState(false);
  const [arming, setArming] = useState(false),
    armingRef = useRef(false);
  const ref = useRef<Journal | null>(null),
    owned = useRef(false),
    chain = useRef(Promise.resolve()),
    anchor = useRef(0),
    syncing = useRef(false),
    releaseCallback = useRef(onReleased);
  const ownerToken = useRef<symbol | null>(null),
    tabLock = useRef<JournalTabLock | null>(null);
  const control = useRef({ grant, known: controlKnown, deviceId });
  control.current = { grant, known: controlKnown, deviceId };
  releaseCallback.current = onReleased;
  const key = 'active:' + tatamiId;
  function mutate(fn: (j: Journal | null) => Journal | null | Promise<Journal | null>) {
    const token = ownerToken.current;
    const next = chain.current.then(async () => {
      if (!token || ownerToken.current !== token || !owned.current)
        throw new Error('OFFLINE_TAB_LOCKED');
      const value = await fn(ref.current);
      try {
        await writeJournal(key, value);
      } catch (e) {
        if (ownerToken.current === token) {
          owned.current = false;
          setReady(false);
        }
        throw e;
      }
      if (ownerToken.current === token) {
        ref.current = value;
        setJournal(value);
      }
    });
    chain.current = next.catch((e) => {
      if (ownerToken.current === token) setError((e as Error).message);
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
    setError('');
    ref.current = null;
    setJournal(null);
    let stopped = false;
    const token = Symbol('offline-tab-owner');
    if (!navigator.locks) {
      setError('OFFLINE_BROWSER_UNSUPPORTED');
      void readJournal<Journal>(key)
        .then((saved) => {
          if (stopped) return;
          if (saved) {
            const retained = { ...saved, conflict: 'OFFLINE_BROWSER_UNSUPPORTED' };
            ref.current = retained;
            setJournal(retained);
          }
          setRestored(true);
        })
        .catch(() => {
          if (!stopped) setRestored(true);
        });
      return () => {
        stopped = true;
      };
    }
    const attempt = startJournalTabLock(
      navigator.locks,
      'judo-offline:' + tatamiId,
      {
        async acquired(active) {
          ownerToken.current = token;
          owned.current = true;
          try {
            let saved = await readJournal<Journal>(key);
            if (!active()) return;
            const controlError =
              saved &&
              journalControlError(
                saved,
                control.current.grant,
                control.current.known,
                control.current.deviceId,
              );
            if (saved && controlError) saved = { ...saved, conflict: controlError };
            if (saved && !saved.conflict && saved.state.status === 'RUNNING')
              saved = appendJournalCommand(saved, { type: 'RECOVER' });
            if (saved) await writeJournal(key, saved);
            if (!active()) return;
            ref.current = saved;
            setJournal(saved);
            setRestored(true);
            anchor.current = performance.now();
            setReady(true);
          } catch (e) {
            if (active()) {
              setError((e as Error).message);
              setRestored(true);
              setReady(false);
            }
          }
        },
        unavailable() {
          setError('OFFLINE_TAB_LOCKED');
          setRestored(true);
        },
        released() {
          if (ownerToken.current === token) {
            ownerToken.current = null;
            owned.current = false;
          }
        },
        failed(e) {
          if (ownerToken.current === token) {
            ownerToken.current = null;
            owned.current = false;
          }
          setReady(false);
          setRestored(true);
          setError(e instanceof Error ? e.message : 'OFFLINE_BROWSER_UNSUPPORTED');
        },
      },
      tabLock.current?.done,
    );
    tabLock.current = attempt;
    const timer = setInterval(() => {
      if (
        owned.current &&
        ref.current &&
        !ref.current.opening &&
        !ref.current.conflict &&
        ref.current.state.status === 'RUNNING'
      )
        void mutate((j) => {
          if (!j) return j;
          const problem = journalControlError(
            j,
            control.current.grant,
            control.current.known,
            control.current.deviceId,
          );
          return problem ? { ...j, conflict: problem } : advance(j);
        }).catch(() => {});
    }, 250);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (ownerToken.current === token) {
        ownerToken.current = null;
        owned.current = false;
      }
      attempt.cancel(chain.current);
    };
  }, [enabled, tatamiId]);
  useEffect(() => {
    if (!enabled || !restored || !ref.current || !owned.current) return;
    const problem = journalControlError(ref.current, grant, controlKnown, deviceId);
    if (problem && !ref.current.conflict)
      void mutate((j) => (j ? { ...j, conflict: problem } : j)).catch(() => {});
  }, [enabled, restored, grant?.deviceId, grant?.controlGeneration, controlKnown, deviceId]);
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
        const problem = journalControlError(
          j,
          control.current.grant,
          control.current.known,
          control.current.deviceId,
        );
        if (problem) return { ...j, conflict: problem };
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
              ...j.grant!,
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
    if (
      !ready ||
      armingRef.current ||
      !view.currentMatch ||
      ref.current ||
      !control.current.grant ||
      !control.current.known
    )
      return;
    const savedGrant = { ...control.current.grant };
    armingRef.current = true;
    setArming(true);
    try {
      await prepareOfflineShell();
      if (!control.current.known || !sameGrant(savedGrant, control.current.grant))
        throw new Error('CONTROL_GENERATION_STALE');
      const sessionId = crypto.randomUUID(),
        match = view.currentMatch;
      await mutate(() => ({
        sessionId,
        view,
        state: match.state,
        revision: match.revision,
        events: [],
        opening: true,
        grant: savedGrant,
        packet: {
          id: crypto.randomUUID(),
          sessionId,
          expectedVersion: match.revision,
          type: 'OFFLINE_OPEN',
          ...savedGrant,
        },
      }));
      anchor.current = performance.now();
      await synchronize();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      armingRef.current = false;
      setArming(false);
    }
  }
  async function send(action: MatchAction) {
    try {
      await mutate((j) => {
        if (!j || j.opening || j.conflict) return j;
        const problem = journalControlError(
          j,
          control.current.grant,
          control.current.known,
          control.current.deviceId,
        );
        if (problem) return { ...j, conflict: problem };
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
    arming,
    ready,
    restored,
    error,
    online,
    arm,
    send,
    synchronize,
    download,
    archiveConflict,
    retry: () =>
      mutate((j) =>
        j
          ? {
              ...j,
              conflict:
                journalControlError(
                  j,
                  control.current.grant,
                  control.current.known,
                  control.current.deviceId,
                ) ?? undefined,
            }
          : j,
      ),
  };
}
