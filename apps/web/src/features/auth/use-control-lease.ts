'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../tournaments/api';
import {
  applyControlReceipt,
  controlGrant,
  isControlSnapshot,
  isRevision,
  restoreControlPending,
  retainUncertainCommand,
  type ControlCommand,
  type ControlContext,
  type ControlReceipt,
  type PendingControl,
} from './control-model';
export function useControlLease(tatamiId: string, deviceId: string | null, enabled: boolean) {
  const [context, setContext] = useState<ControlContext | null>(null);
  const [connected, setConnected] = useState(false),
    [denied, setDenied] = useState(false);
  const [pending, setPending] = useState<PendingControl | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(!enabled),
    [corrupt, setCorrupt] = useState(false);
  const current = useRef<ControlContext | null>(null),
    pendingRef = useRef<PendingControl | null>(null);
  const writing = useRef(false),
    reading = useRef(false),
    generation = useRef(0);
  const key = 'judo.control.pending.' + tatamiId;
  const refresh = useCallback(async () => {
    if (!enabled || !deviceId || reading.current) return;
    reading.current = true;
    const gen = generation.current;
    try {
      const value = await request<ControlContext>(
        `/auth/tatamis/${tatamiId}/control?deviceId=${deviceId}`,
      );
      if (
        !isRevision(value.accessRevision) ||
        !isControlSnapshot(value.control) ||
        !['ADMIN', 'JUDGE'].includes(value.workRole)
      )
        throw new Error('INVALID_CONTROL_RECEIPT');
      if (gen !== generation.current) return;
      if (!current.current || value.accessRevision >= current.current.accessRevision) {
        current.current = value;
        setContext(value);
      }
      setConnected(true);
      setDenied(false);
    } catch (e) {
      if (gen !== generation.current) return;
      setConnected(false);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        current.current = null;
        setContext(null);
        setDenied(true);
      }
    } finally {
      reading.current = false;
    }
  }, [enabled, deviceId, tatamiId]);
  useEffect(() => {
    generation.current++;
    current.current = null;
    setContext(null);
    setConnected(false);
    setDenied(false);
    pendingRef.current = null;
    setPending(null);
    setCorrupt(false);
    setError('');
    setRestored(!enabled);
    if (!enabled) return;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const value = restoreControlPending(saved, tatamiId);
        pendingRef.current = value;
        setPending(value);
      }
    } catch {
      setCorrupt(true);
      setError('SAVED_CONTROL_INVALID');
    }
    setRestored(true);
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [enabled, key, tatamiId, refresh]);
  function remember(value: PendingControl | null) {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    pendingRef.current = value;
    setPending(value);
  }
  async function execute(value: PendingControl) {
    if (writing.current || !restored || corrupt) return;
    if (value.command.deviceId !== deviceId) {
      setError('CONTROL_DEVICE_CHANGED');
      return;
    }
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(value))
        throw new Error('CONTROL_PENDING');
      remember(structuredClone(value));
      generation.current++;
      const receipt = await request<ControlReceipt>(
        `/auth/tatamis/${tatamiId}/control`,
        value.command,
      );
      const next = applyControlReceipt(current.current, receipt);
      current.current = next;
      setContext(next);
      remember(null);
    } catch (e) {
      if (e instanceof ApiError && !retainUncertainCommand(e.status, e.message)) remember(null);
      setError(e instanceof Error ? e.message : 'CONTROL_FAILED');
    } finally {
      writing.current = false;
      setBusy(false);
      await refresh();
    }
  }
  function command(type: ControlCommand['type'], reason?: string) {
    if (!deviceId || !current.current || !connected || !restored || corrupt || pendingRef.current)
      return;
    void execute({
      tatamiId,
      command: {
        id: crypto.randomUUID(),
        expectedRevision: current.current.accessRevision,
        deviceId,
        type,
        ...(reason ? { reason } : {}),
      },
    });
  }
  function archivePending() {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      sessionStorage.setItem(key + '.archive.' + crypto.randomUUID(), raw);
      sessionStorage.removeItem(key);
      pendingRef.current = null;
      setPending(null);
      setCorrupt(false);
      setError('');
    } catch {
      setError('DEVICE_STORAGE_INVALID');
    }
  }
  return {
    deviceId,
    context,
    connected,
    denied,
    pending,
    corrupt,
    restored,
    error,
    busy,
    grant: controlGrant(context, deviceId),
    refresh,
    command,
    retry: () => pendingRef.current && void execute(pendingRef.current),
    archivePending,
  };
}
