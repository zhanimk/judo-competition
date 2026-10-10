'use client';
import { useEffect, useRef, useState } from 'react';
import { request } from '../tournaments/api';
import {
  archiveAdminPending,
  clearAdminPending,
  deliverAdminPending,
  readAdminPending,
  saveAdminPending,
  type PendingAdminCommand,
} from './pending-command';

export function useAdminCommand(tournamentId: string) {
  const [pending, setPending] = useState<PendingAdminCommand | null>(null);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const [corrupt, setCorrupt] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const current = useRef<PendingAdminCommand | null>(null);
  const busy = useRef(false);
  const scope = useRef(tournamentId);
  scope.current = tournamentId;
  const restored = restoredFor === tournamentId;
  useEffect(() => {
    setRestoredFor(null);
    setCorrupt(false);
    setProblem(null);
    setSending(false);
    current.current = null;
    setPending(null);
    try {
      const saved = readAdminPending(sessionStorage, tournamentId);
      current.current = saved;
      setPending(saved);
    } catch (error) {
      setCorrupt(true);
      setProblem(error);
    }
    setRestoredFor(tournamentId);
  }, [tournamentId]);

  async function execute(value?: PendingAdminCommand) {
    if (busy.current || !restored || corrupt) return null;
    const saved = value ?? current.current;
    if (!saved || saved.tournamentId !== tournamentId) return null;
    busy.current = true;
    setSending(true);
    setProblem(null);
    try {
      // A failed write prevents the POST. An existing unknown command cannot be replaced.
      saveAdminPending(sessionStorage, saved);
      current.current = structuredClone(saved);
      setPending(current.current);
      const result = await deliverAdminPending(saved, (contestId, payload) =>
        request(`/tournaments/${tournamentId}/control/${contestId}/command`, payload),
      );
      if (scope.current !== tournamentId) return null;
      if (result.kind !== 'retry') {
        clearAdminPending(sessionStorage, saved);
        current.current = null;
        setPending(null);
      }
      if (result.kind !== 'success') setProblem(result.error);
      return result;
    } catch (error) {
      if (scope.current === tournamentId) {
        setProblem(error);
        try {
          const saved = readAdminPending(sessionStorage, tournamentId);
          current.current = saved;
          setPending(saved);
          // Storage is mandatory even when the failed save happened before any POST.
          if (!saved) setCorrupt(true);
        } catch {
          setCorrupt(true);
        }
      }
      return { kind: 'retry' as const, error };
    } finally {
      busy.current = false;
      if (scope.current === tournamentId) setSending(false);
    }
  }
  function archive(reason: string, checked: boolean) {
    if (busy.current || !restored) return;
    try {
      archiveAdminPending(sessionStorage, tournamentId, reason, checked, crypto.randomUUID());
      current.current = null;
      setPending(null);
      setCorrupt(false);
      setProblem(null);
    } catch (error) {
      setProblem(error);
    }
  }
  return {
    pending: pending?.tournamentId === tournamentId ? pending : null,
    restored,
    corrupt,
    sending,
    problem,
    execute,
    archive,
    blocked: !restored || corrupt || !!pending || sending,
    hasPending: () => !!current.current || busy.current,
  };
}
