// Local server: static app + game import + Stockfish over WebSocket.
//   review engine: full-game analysis and quick checks of the user's own moves
//   live engine:   continuous analysis of whatever position is on the board
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Chess } from 'chess.js';
import { Engine } from './engine.js';
import { importUrl, chessComGames } from './sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'data', 'cache');
const PORT = +process.env.PORT || 5180;
const SF = process.env.STOCKFISH_PATH || 'stockfish';
const CORES = cpus().length;
const URL_ = `http://localhost:${PORT}`;
// Shut down by itself when no browser tab has been open for this many minutes (0 = never).
const IDLE_MIN = process.env.IDLE_EXIT_MIN != null ? +process.env.IDLE_EXIT_MIN : 10;

// Power modes: how many CPU cores the engines may use and how long live analysis thinks.
const POWER = {
  quiet:  { review: 2, live: 1, liveLimit: { depth: 20, movetime: 6000 } },
  normal: { review: Math.max(1, Math.min(4, CORES - 2)), live: 2, liveLimit: { depth: 24, movetime: 15000 } },
  max:    { review: Math.max(1, CORES - 2), live: Math.max(1, Math.min(4, CORES - 4)), liveLimit: { depth: 40, movetime: 60000 } },
};
let power = POWER[process.env.POWER] ? process.env.POWER : 'normal';

// Already running? Just open the browser instead of failing.
if (await fetch(`${URL_}/api/info`).then((r) => r.ok).catch(() => false)) {
  console.log(`\n  Уже запущено: ${URL_}\n`);
  openBrowser();
  process.exit(0);
}

const reviewEngine = new Engine({ path: SF, name: 'review', threads: POWER[power].review, hash: 512 });
const liveEngine = new Engine({ path: SF, name: 'live', threads: POWER[power].live, hash: 256 });
let engineId;
try {
  engineId = (await reviewEngine.ready).replace('id name ', '');
  await liveEngine.ready;
} catch {
  console.error(`\n  Не нашёл Stockfish ("${SF}"). Установи: brew install stockfish\n  или укажи путь: STOCKFISH_PATH=/путь/к/stockfish\n`);
  process.exit(1);
}
await mkdir(CACHE, { recursive: true });

function openBrowser() {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} ${URL_}`);
}

async function setPower(mode) {
  if (!POWER[mode] || mode === power) return;
  power = mode;
  // Stop the live search first so the new thread count applies right away;
  // the review engine picks it up between positions.
  liveEngine.stop();
  reviewEngine.setThreads(POWER[mode].review);
  await liveEngine.setThreads(POWER[mode].live);
  live.restart();
}

function shutdown(reason) {
  console.log(`\n  Выключаюсь${reason ? ` (${reason})` : ''}.\n`);
  try { reviewEngine.quit(); liveEngine.quit(); } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 150);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/info') return json(res, { engine: engineId, cores: CORES, power });
    if (url.pathname === '/api/shutdown' && req.method === 'POST') { json(res, { ok: true }); return shutdown('кнопка в приложении'); }
    if (url.pathname === '/api/import') return json(res, { pgn: await importUrl(url.searchParams.get('url') || '') });
    if (url.pathname === '/api/chesscom') return json(res, { games: await chessComGames(url.searchParams.get('user') || '') });
    // static
    let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(DIST)) return send(res, 403, 'forbidden');
    if (!existsSync(file) || url.pathname === '/') file = path.join(DIST, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
});
function json(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function send(res, code, text) { res.writeHead(code); res.end(text); }

// ---------- Analysis helpers ----------
// Terminal positions are answered without the engine.
function terminal(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { lines: [{ multipv: 1, depth: 0, score: { mate: 0 }, pv: [] }], terminal: 'checkmate' };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { lines: [{ multipv: 1, depth: 0, score: { cp: 0 }, pv: [] }], terminal: 'draw' };
  return null;
}

// Review presets: depth cap + time cap per position.
const PRESETS = { fast: { depth: 16, movetime: 700 }, normal: { depth: 20, movetime: 1600 }, deep: { depth: 26, movetime: 4500 } };

async function analyse(fen, limit, multipv) {
  const t = terminal(fen);
  if (t) return t;
  const lines = await reviewEngine.search(fen, { multipv, limit });
  return { lines: lines.map(slim) };
}
const slim = (l) => ({ multipv: l.multipv, depth: l.depth, score: l.score, pv: l.pv.slice(0, 14) });

// Quick requests (user's own moves) jump ahead of the remaining review positions.
let quickQueue = [];
let reviewJob = null;
const positionCache = new Map(); // in-memory, per server run

async function runReview(ws, { id, fens, preset }) {
  const limit = PRESETS[preset] || PRESETS.normal;
  const key = createHash('sha1').update(`${engineId}|${JSON.stringify(limit)}|${fens.join('|')}`).digest('hex');
  const cacheFile = path.join(CACHE, key + '.json');
  if (existsSync(cacheFile)) {
    const results = JSON.parse(await readFile(cacheFile, 'utf8'));
    results.forEach((analysis, index) => wsSend(ws, { type: 'reviewProgress', id, index, total: fens.length, analysis }));
    return wsSend(ws, { type: 'reviewDone', id, cached: true });
  }
  const job = { id, cancelled: false };
  if (reviewJob) reviewJob.cancelled = true;
  reviewJob = job;
  const drain = async () => { while (quickQueue.length) await quickQueue.shift()(); };
  try {
    const results = [];
    for (let i = 0; i < fens.length; i++) {
      await drain();
      if (job.cancelled || ws.readyState !== 1) return;
      // Positions already searched with the same settings (e.g. before a page reload) are reused.
      const pkey = `${JSON.stringify(limit)}|${fens[i]}`;
      const analysis = positionCache.get(pkey) || await analyse(fens[i], limit, 2);
      positionCache.set(pkey, analysis);
      results.push(analysis);
      wsSend(ws, { type: 'reviewProgress', id, index: i, total: fens.length, analysis });
    }
    await writeFile(cacheFile, JSON.stringify(results));
    wsSend(ws, { type: 'reviewDone', id });
  } finally {
    if (reviewJob === job) reviewJob = null;
    await drain();
  }
}

function wsSend(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ---------- Live analysis (one client at a time owns the live engine) ----------
class Live {
  constructor() { this.want = null; this.running = false; this.stopped = true; this.owner = null; this.last = null; }
  set(ws, fen, multipv) {
    this.want = { ws, fen, multipv };
    this.owner = ws; this.last = this.want;
    this.stopped = false;
    liveEngine.stop();
    if (!this.running) this.loop();
  }
  stop() { this.want = null; this.stopped = true; this.owner = null; liveEngine.stop(); }
  // Re-run the current position (e.g. after a power change).
  restart() { if (!this.stopped && this.last) this.set(this.last.ws, this.last.fen, this.last.multipv); }
  async loop() {
    this.running = true;
    while (this.want) {
      const w = this.want; this.want = null;
      const t = terminal(w.fen);
      if (t) { wsSend(w.ws, { type: 'live', fen: w.fen, lines: t.lines, terminal: t.terminal, done: true }); continue; }
      let last = 0;
      const lines = await liveEngine.search(w.fen, {
        multipv: w.multipv,
        limit: POWER[power].liveLimit,
        onInfo: (ls) => {
          if (this.want || this.stopped) { liveEngine.stop(); return; }
          const now = Date.now();
          if (now - last < 120) return;
          last = now;
          wsSend(w.ws, { type: 'live', fen: w.fen, lines: ls.map(slim) });
        },
      });
      if (!this.want && !this.stopped) wsSend(w.ws, { type: 'live', fen: w.fen, lines: lines.map(slim), done: true });
    }
    this.running = false;
  }
}
const live = new Live();

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsSend(ws, { type: 'hello', engine: engineId, power });
  clearTimeout(idleTimer);
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'review') runReview(ws, msg).catch((e) => wsSend(ws, { type: 'error', message: e.message }));
      else if (msg.type === 'cancelReview') { if (reviewJob) reviewJob.cancelled = true; }
      else if (msg.type === 'live') live.set(ws, msg.fen, Math.min(5, msg.multipv || 3));
      else if (msg.type === 'liveStop') { if (live.owner === ws) live.stop(); }
      else if (msg.type === 'power') { await setPower(msg.mode); broadcast({ type: 'power', mode: power }); }
      else if (msg.type === 'quick') {
        const task = async () => wsSend(ws, { type: 'quick', reqId: msg.reqId, fen: msg.fen, analysis: await analyse(msg.fen, { depth: 20, movetime: 1500 }, 2) });
        if (reviewJob) quickQueue.push(task); else await task();
      }
    } catch (e) {
      wsSend(ws, { type: 'error', message: e.message });
    }
  });
  ws.on('close', () => {
    if (live.owner === ws) live.stop();
    if (reviewJob && wss.clients.size === 0) reviewJob.cancelled = true;
    armIdle();
  });
});

function broadcast(msg) { for (const c of wss.clients) wsSend(c, msg); }

// Auto shutdown when every tab is closed for a while, so the engines never run forgotten.
let idleTimer = null;
function armIdle() {
  clearTimeout(idleTimer);
  if (!IDLE_MIN || wss.clients.size > 0) return;
  idleTimer = setTimeout(() => { if (wss.clients.size === 0) shutdown(`вкладка закрыта ${IDLE_MIN} мин`); }, IDLE_MIN * 60000);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} уже занят: приложение, скорее всего, уже запущено.`);
    console.error(`  Открой http://localhost:${PORT} или запусти на другом порту: PORT=5181 npm start\n`);
  } else console.error(e);
  reviewEngine.quit(); liveEngine.quit();
  process.exit(1);
});
wss.on('error', () => {}); // the same error is reported by the http server above
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ${engineId} готов. Режим: ${power}.`);
  console.log(`  Открыто в браузере: ${URL_}`);
  console.log(`  Выключить: кнопка ⏻ в приложении, Ctrl+C здесь, или само через ${IDLE_MIN} мин после закрытия вкладки.\n`);
  openBrowser();
  armIdle();
});
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
