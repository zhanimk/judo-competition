'use client';
import { useEffect, useRef, useState } from 'react';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { subscribeTournament } from '../../shared/live/subscribe';
import { ApiError, request } from '../tournaments/api';
import { validProtocolHistory, type ProtocolHistory } from './protocol-model';

export function useProtocolHistory(tournamentId: string, guest = false, beforeVersion?: number) {
  const [history, setHistory] = useState<ProtocolHistory | null>(null);
  const [error, setError] = useState('');
  const poll = useRef<ReturnType<typeof pollSnapshots> | null>(null);
  const failed = useRef(true);
  useEffect(() => {
    setHistory(null);
    setError('');
    failed.current = true;
    const poller = pollSnapshots(
      async () => {
        const data = await request<ProtocolHistory>(
          `${guest ? '/public' : ''}/tournaments/${tournamentId}/protocols${beforeVersion ? `?beforeVersion=${beforeVersion}` : ''}`,
        );
        if (!validProtocolHistory(data, tournamentId)) throw new Error('PROTOCOL_RESPONSE_INVALID');
        return data;
      },
      (data) => {
        setHistory((current) => (current && current.revision > data.revision ? current : data));
        setError('');
        failed.current = false;
      },
      (error) => {
        failed.current = true;
        setError(error instanceof Error ? error.message : 'LOAD_FAILED');
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setHistory(null);
      },
      5000,
    );
    poll.current = poller;
    const stop = subscribeTournament(tournamentId, (notice) => {
      if (notice.kind !== 'state') void poller.refresh();
    });
    void poller.refresh();
    return () => {
      stop();
      poller.stop();
      poll.current = null;
    };
  }, [tournamentId, guest, beforeVersion]);
  async function refresh() {
    if (!poll.current) throw new Error('LOAD_FAILED');
    await poll.current.refresh();
    if (failed.current) throw new Error('LOAD_FAILED');
  }
  return { history, error, refresh };
}
