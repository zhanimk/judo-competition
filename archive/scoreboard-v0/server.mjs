import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const routes = {
 '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
 '/style.css': ['style.css', 'text/css'], '/engine.js': ['../../packages/engine/src/match/index.ts', 'text/javascript']
};
createServer(async (req, res) => {
 const route = routes[new URL(req.url, 'http://localhost').pathname];
 if (!route || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
 try {
  let body = await readFile(new URL(route[0], import.meta.url), 'utf8');
  if (route[0].endsWith('.ts')) body = stripTypeScriptTypes(body);
  res.writeHead(200, {'Content-Type': route[1] + '; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}); res.end(body);
 } catch { res.writeHead(500); res.end('Unable to load prototype'); }
}).listen(4317, '127.0.0.1', () => console.log('Scoreboard: http://127.0.0.1:4317'));
