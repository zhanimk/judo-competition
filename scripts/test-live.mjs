import { io } from 'socket.io-client';

/** Rehearsal clients use the public Socket.IO wire protocol, never raw ws. */
export function liveSocket(base, tournamentId, { cookie, cursor, origin } = {}) {
  return io(new URL(base).origin, {
    path: '/api/v1/live',
    addTrailingSlash: false,
    transports: ['websocket'],
    auth: { tournamentId, ...(cursor === undefined ? {} : { cursor }) },
    extraHeaders: {
      Origin: origin ?? process.env.TEST_WEB_ORIGIN ?? 'http://127.0.0.1:4318',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    autoConnect: false,
    reconnection: false,
    timeout: 5000,
  });
}
export async function connectLive(socket) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('LIVE_CONNECT_TIMEOUT')), 6000);
    function done(error) {
      clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('connect_error', failed);
      if (error) reject(error);
      else resolve();
    }
    const connected = () => done();
    const failed = (error) => done(error);
    socket.once('connect', connected);
    socket.once('connect_error', failed);
    socket.connect();
  });
}
