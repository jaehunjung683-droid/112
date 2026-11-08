/* IRON VEIL TACTICAL FRONT — 서버 권위형 멀티플레이 서버 (Node.js 20+ / ws)
 *  - HTTP: /health, /metrics, 그리고 public/ (또는 게임클라이언트 HTML)을 `/`에서 서빙
 *  - WebSocket: 같은 포트에서 게임 프로토콜 처리 (server/game.js)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
function need(name) {
  try { return require(name); }
  catch (err) {
    process.stderr.write(`[IRON VEIL] 필수 모듈을 불러오지 못했습니다: ${name}\n` +
      (name === 'ws' ? '  → "npm install" 로 의존성을 설치하세요.\n' : '  → server/ 폴더와 server.js 가 함께 업로드되었는지 확인하세요.\n') +
      `  원인: ${err.message}\n`);
    process.exit(1);
  }
}
const WebSocket = need('ws');
const cfg = need('./server/config');
const { Game } = need('./server/game');

const CLIENT_FILES = [
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, '게임클라이언트_V2.0.html')
];
const log = (event, data = {}) => {
  if (process.env.LOG_LEVEL === 'silent') return;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n');
};

const game = new Game({ log });
const startedAt = Date.now();
const ipCounts = new Map();

/* 프록시(Render 등) 뒤에서는 x-forwarded-for의 첫 주소를 실제 접속자로 본다. (접속 수 제한용이며 인증에는 쓰지 않음) */
function clientIp(req) {
  if (cfg.TRUST_PROXY !== false) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function serveClient(res) {
  const file = CLIENT_FILES.find(f => fs.existsSync(f));
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Game client not built. Run: npm run build:client'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
  if (pathname === '/health') {
    const stats = game.stats();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, service: 'IRON VEIL Server', version: '2.1.0', authoritative: true,
      clients: stats.connections, players: stats.players, rooms: stats.rooms, maxPlayers: cfg.MAX_PLAYERS,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), time: new Date().toISOString()
    }));
  }
  if (pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(game.stats()));
  }
  if (pathname === '/' || pathname === '/index.html') return serveClient(res);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({
  server, maxPayload: cfg.MAX_PAYLOAD_BYTES, perMessageDeflate: false,
  verifyClient: (info, done) => {
    const origin = info.origin;
    if (cfg.ALLOWED_ORIGINS.length && origin && !cfg.ALLOWED_ORIGINS.includes(origin)) return done(false, 403, 'Origin not allowed');
    const ip = clientIp(info.req);
    if ((ipCounts.get(ip) || 0) >= cfg.MAX_CONNECTIONS_PER_IP) return done(false, 429, 'Too many connections');
    done(true);
  }
});

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  ws.isAlive = true;
  let windowStart = Date.now(), windowCount = 0;

  const conn = {
    send(data) {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) return;
      try { ws.send(JSON.stringify(data)); } catch (_) { /* 연결이 끊긴 경우 무시 */ }
    },
    close(code, reason) { try { ws.close(code, reason); } catch (_) {} }
  };
  game.connect(conn);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const t = Date.now();
    if (t - windowStart >= 1000) { windowStart = t; windowCount = 0; }
    if (++windowCount > cfg.MAX_MESSAGES_PER_SECOND) { ws.close(1008, 'Message rate exceeded'); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return conn.send({ type: 'error', message: '메시지를 처리할 수 없습니다.' }); }
    try { game.handle(conn, msg); }
    catch (err) { log('handler_error', { type: msg && msg.type, message: err && err.message }); }
  });
  let closed = false;
  const onClose = () => {
    if (closed) return; closed = true;
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    try { game.disconnect(conn); } catch (err) { log('disconnect_error', { message: err.message }); }
  };
  ws.on('close', onClose);
  ws.on('error', onClose);
});

const tickTimer = setInterval(() => {
  try { game.tick(); } catch (err) { log('tick_error', { message: err.message, stack: err.stack }); }
}, cfg.TICK_MS);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);

process.on('uncaughtException', (err) => log('uncaught_exception', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (err) => log('unhandled_rejection', { message: String(err) }));

server.on('error', (err) => {
  process.stderr.write(`[IRON VEIL] 서버를 시작할 수 없습니다: ${err.message}\n` + (err.code === 'EADDRINUSE' ? `  → 포트 ${cfg.PORT} 가 이미 사용 중입니다. PORT 환경 변수를 바꿔보세요.\n` : ''));
  process.exit(1);
});
server.listen(cfg.PORT, '0.0.0.0', () => {
  process.stdout.write(`[IRON VEIL] listening on :${cfg.PORT} (node ${process.version})\n`);
  log('listening', { port: cfg.PORT, maxPlayers: cfg.MAX_PLAYERS });
});

function shutdown() {
  clearInterval(tickTimer); clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
