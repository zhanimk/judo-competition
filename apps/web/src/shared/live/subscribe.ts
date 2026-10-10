export type LiveNotice = {
  kind: 'state' | 'result' | 'queue' | 'roster' | 'connected';
  tournamentId: string;
  tatamiId?: string;
};
/** Notifications invalidate snapshots. Reconnect always reloads authoritative state. */
export function subscribeTournament(id: string, onNotice: (v: LiveNotice) => void) {
  let active = true,
    socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout>;
  function connect() {
    const url = new URL(
      process.env.NEXT_PUBLIC_LIVE_URL ??
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:4319/api/v1/live`,
    );
    url.searchParams.set('tournamentId', id);
    socket = new WebSocket(url);
    socket.onmessage = (e) => {
      try {
        const v = JSON.parse(e.data) as LiveNotice;
        if (v.tournamentId === id) onNotice(v);
      } catch {}
    };
    socket.onclose = () => {
      if (active) timer = setTimeout(connect, 2000);
    };
    socket.onerror = () => socket?.close();
  }
  connect();
  return () => {
    active = false;
    clearTimeout(timer);
    socket?.close();
  };
}
