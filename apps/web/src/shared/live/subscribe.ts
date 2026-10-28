import { io } from 'socket.io-client';

export type LiveNotice = {
  kind: 'state' | 'result' | 'queue' | 'roster' | 'protocol' | 'access' | 'connected' | 'resync';
  tournamentId: string;
  tatamiId?: string;
  cursor?: string;
};
const kinds = new Set([
  'state',
  'result',
  'queue',
  'roster',
  'protocol',
  'access',
  'connected',
  'resync',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validLiveNotice(value: unknown, tournamentId: string): value is LiveNotice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const notice = value as Record<string, unknown>;
  return (
    notice.tournamentId === tournamentId &&
    typeof notice.kind === 'string' &&
    kinds.has(notice.kind) &&
    (notice.tatamiId === undefined ||
      (typeof notice.tatamiId === 'string' && uuid.test(notice.tatamiId))) &&
    (notice.cursor === undefined ||
      (typeof notice.cursor === 'string' &&
        /^(0|[1-9][0-9]{0,18})$/.test(notice.cursor) &&
        BigInt(notice.cursor) <= 9223372036854775807n))
  );
}

/** PostgreSQL cursor replay complements the existing 2/5-second HTTP repair. */
export function subscribeTournament(id: string, onNotice: (v: LiveNotice) => void) {
  let cursor: string | undefined;
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // The reverse proxy serves HTTPS, API and Socket.IO under the same origin.
  // A separate development/API origin can be configured at build time.
  const endpoint = new URL(process.env.NEXT_PUBLIC_LIVE_URL ?? location.origin, location.origin);
  const socket = io(endpoint.origin, {
    path: '/api/v1/live',
    addTrailingSlash: false,
    // Keep cookies on the web origin when an HTTPS rewrite fronts a separate API.
    transports: process.env.NEXT_PUBLIC_LIVE_TRANSPORT === 'polling' ? ['polling'] : ['websocket'],
    withCredentials: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 5000,
    auth: (callback) => callback({ tournamentId: id, ...(cursor ? { cursor } : {}) }),
  });
  const reconnect = () => {
    if (!active || retry || socket.active) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (active) socket.connect();
    }, 2000);
  };
  socket.on('connect_error', reconnect);
  socket.on('disconnect', reconnect);
  socket.on('notice', (value: unknown) => {
    if (!active || !validLiveNotice(value, id)) return;
    if (value.kind === 'resync') {
      // Backup restore can legitimately move the cursor backwards.
      cursor = value.cursor;
    } else if (value.cursor !== undefined) {
      if (
        value.kind !== 'connected' &&
        cursor !== undefined &&
        BigInt(value.cursor) <= BigInt(cursor)
      )
        return;
      if (cursor === undefined || BigInt(value.cursor) > BigInt(cursor)) cursor = value.cursor;
    }
    onNotice(value);
  });
  return () => {
    active = false;
    clearTimeout(retry);
    socket.removeAllListeners();
    socket.disconnect();
  };
}
