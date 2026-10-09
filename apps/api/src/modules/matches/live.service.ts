import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
export type LiveNotice = {
  tournamentId: string;
  tatamiId?: string;
  kind: 'state' | 'result' | 'queue' | 'connected';
};
@Injectable()
export class LiveService implements OnModuleDestroy {
  private sockets = new Map<
    WebSocket,
    { tournamentId: string; req: IncomingMessage; alive: boolean }
  >();
  private server?: WebSocketServer;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async allowed(id: string, req: IncomingMessage) {
    const t = await this.db.tournament.findUnique({ where: { id } });
    if (!t) return false;
    if (t.publishedAt) return true;
    const u = await this.auth.authenticate(req.headers.cookie);
    if (!u) return false;
    if (u.role === 'SUPER_ADMIN' || (u.role === 'ORGANIZER' && u.id === t.ownerId)) return true;
    return (
      u.role === 'OPERATOR' &&
      !!u.tatamiId &&
      !!(await this.db.tatami.findFirst({ where: { id: u.tatamiId, tournamentId: id } }))
    );
  }
  attach(http: Server) {
    const wss = (this.server = new WebSocketServer({ noServer: true, maxPayload: 1024 }));
    http.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      void (async () => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const id = url.searchParams.get('tournamentId') ?? '';
        if (
          url.pathname !== '/api/v1/live' ||
          !['http://localhost:4318', 'http://127.0.0.1:4318'].includes(req.headers.origin ?? '') ||
          !/^[a-f0-9-]{36}$/.test(id) ||
          !(await this.allowed(id, req))
        ) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.sockets.set(ws, { tournamentId: id, req, alive: true });
          ws.on('pong', () => {
            const client = this.sockets.get(ws);
            if (client) client.alive = true;
          });
          ws.on('error', () => {});
          ws.on('close', () => this.sockets.delete(ws));
          ws.on('message', () => ws.close(1008, 'Read only'));
          ws.send(JSON.stringify({ kind: 'connected', tournamentId: id }));
        });
      })().catch(() => socket.destroy());
    });
    this.timer = setInterval(() => void this.heartbeat(), 30000);
  }
  private async heartbeat() {
    await Promise.all(
      [...this.sockets].map(async ([ws, client]) => {
        if (!client.alive) {
          ws.terminate();
          return;
        }
        client.alive = false;
        try {
          if (!(await this.allowed(client.tournamentId, client.req))) ws.close(1008);
          else if (ws.readyState === WebSocket.OPEN) ws.ping();
        } catch {
          ws.close(1011);
        }
      }),
    );
  }
  notify(event: LiveNotice) {
    for (const [ws, v] of this.sockets)
      if (v.tournamentId === event.tournamentId && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 65536) ws.terminate();
        else ws.send(JSON.stringify(event));
      }
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    for (const ws of this.sockets.keys()) ws.terminate();
    this.server?.close();
  }
}
