// Game review UI: board, eval bar, coach comments, live engine, own variations.
import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles.css';
import { Chess } from 'chess.js';
import { CLASSES, CLASS_ORDER, BAD, classifyMove, gameAccuracy } from './lib/review.js';
import { explainMove, explainBest, threats } from './lib/explain.js';
import { winPct, toWhite, fmtScore, pvToSan, uciToMove, moveLabel, material, matValue } from './lib/chessutil.js';
import samplePgn from './sample.pgn?raw';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const NOTABLE = new Set(['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder', 'book']);
const GOODISH = new Set(['best', 'excellent', 'great', 'brilliant', 'book', 'forced']);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// A shared review file carries its data here and runs without a server or engine.
const SHARED = window.__CHESS_SHARED__ || null;

// ---------------- state ----------------
const S = {
  headers: {}, startFen: START_FEN,
  main: [],          // [{ uci, san, fen, fenBefore, color }]
  analyses: [],      // analyses[i] = position before main move i (i = 0..main.length)
  review: [],        // review[i] = classified main move i
  vars: [],          // [{ from, moves: [{ uci, san, fen, fenBefore, color, r }] }]
  cur: { v: -1, i: 0 },
  orientation: 'white',
  reviewId: 0, reviewDone: true, total: 0, done: 0,
  live: null,        // { fen, lines, done }
  liveOn: SHARED ? false : store.get('liveOn', true),
  arrowOn: store.get('arrowOn', true),
  threatOn: false,
  retry: null,       // { ply, result: null | 'ok' | 'no', tries }
};
const quickCache = new Map();   // fen -> analysis
const quickPending = new Set();

// ---------------- engine socket ----------------
const net = { ws: null, queue: [] };
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws = ws;
  ws.onopen = () => {
    for (const m of net.queue.splice(0)) ws.send(JSON.stringify(m));
    pushLive();
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.off) return;
    $('engineChip').textContent = 'движок не подключён…';
    setTimeout(connect, 1200);
  };
}
function send(msg) {
  if (SHARED) return; // view-only file: no engine
  if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(msg));
  else net.queue.push(msg);
}

function onMessage(m) {
  if (m.type === 'hello' || m.type === 'power') {
    if (m.engine) { $('engineChip').textContent = m.engine; $('engineName').textContent = m.engine; }
    S.power = m.power || m.mode;
    // Keep the mode the user picked last time.
    const want = store.get('power', null);
    if (m.type === 'hello' && want && want !== S.power) send({ type: 'power', mode: want });
    document.querySelectorAll('#power button').forEach((b) => b.classList.toggle('on', b.dataset.p === S.power));
  } else if (m.type === 'reviewProgress' && m.id === S.reviewId) {
    S.analyses[m.index] = m.analysis;
    quickCache.set(fenAt(m.index), m.analysis);
    S.done = Math.max(S.done, m.index + 1);
    classifyMainUpTo();
    scheduleRender();
  } else if (m.type === 'reviewDone' && m.id === S.reviewId) {
    S.reviewDone = true;
    scheduleRender();
  } else if (m.type === 'quick') {
    quickPending.delete(m.fen);
    quickCache.set(m.fen, m.analysis);
    updateVars();
    scheduleRender();
  } else if (m.type === 'live') {
    if (m.fen !== curFen()) return;
    S.live = { fen: m.fen, lines: m.lines, done: m.done };
    trackStable(m.fen, m.lines, m.done);
    renderLive();
    renderEval();
    renderShapes();
  } else if (m.type === 'error') {
    console.error(m.message);
  }
}

// ---------------- game model ----------------
function fenAt(i) { return i === 0 ? S.startFen : S.main[i - 1].fen; }

function curNode() {
  const { v, i } = S.cur;
  if (v < 0) {
    const m = i > 0 ? S.main[i - 1] : null;
    return { fen: fenAt(i), move: m, r: i > 0 ? S.review[i - 1] : null, inVar: false };
  }
  const V = S.vars[v];
  const m = V.moves[i - 1];
  return { fen: m.fen, move: m, r: m.r, inVar: true, V };
}
const curFen = () => curNode().fen;

function analysisOf(fen) { return quickCache.get(fen); }

// Classify main moves as their analyses arrive (in order).
function classifyMainUpTo() {
  for (let k = S.review.length; k < S.main.length; k++) {
    const a = S.analyses[k], b = S.analyses[k + 1];
    if (!a || !b) break;
    const prev = S.review[k - 1] || null;
    const m = S.main[k];
    const r = classifyMove(m.fenBefore, m.uci, a, b, { prev, allBookSoFar: !prev || prev.cls === 'book' });
    r.captureSquare = new Chess(m.fenBefore).move(uciToMove(m.uci)).captured ? m.uci.slice(2, 4) : null;
    S.review.push(r);
  }
}

// Ask for missing analyses of variation positions and classify what we can.
function updateVars() {
  for (const V of S.vars) {
    V.moves.forEach((m, k) => {
      for (const fen of [m.fenBefore, m.fen]) {
        if (!analysisOf(fen) && !quickPending.has(fen)) { quickPending.add(fen); send({ type: 'quick', fen }); }
      }
      if (m.r) return;
      const a = analysisOf(m.fenBefore), b = analysisOf(m.fen);
      if (!a || !b) return;
      const prev = k > 0 ? V.moves[k - 1].r : S.review[V.from - 1] || null;
      m.r = classifyMove(m.fenBefore, m.uci, a, b, { prev, allBookSoFar: !prev || prev.cls === 'book' });
      m.r.captureSquare = new Chess(m.fenBefore).move(uciToMove(m.uci)).captured ? m.uci.slice(2, 4) : null;
      if (S.retry && S.cur.v === S.vars.indexOf(V) && k === 0) settleRetry(m.r);
    });
  }
}

// Play a move from the current position (from the board, an engine line or a button).
function playMove(uci, { silent = false } = {}) {
  const fenBefore = curFen();
  const c = new Chess(fenBefore);
  let mv;
  try { mv = c.move(uciToMove(uci)); } catch { return false; }
  const node = { uci: mv.lan, san: mv.san, fen: c.fen(), fenBefore, color: mv.color, r: null };
  const { v, i } = S.cur;
  if (v < 0) {
    if (S.main[i] && S.main[i].uci === node.uci && !S.retry) { S.cur = { v: -1, i: i + 1 }; return afterMove(silent); }
    let vi = S.vars.findIndex((V) => V.from === i && V.moves[0].uci === node.uci);
    if (vi < 0 || S.retry) {
      if (vi >= 0) S.vars.splice(vi, 1);
      S.vars.push({ from: i, moves: [node] });
      vi = S.vars.length - 1;
    }
    S.cur = { v: vi, i: 1 };
  } else {
    const V = S.vars[v];
    if (V.moves[i] && V.moves[i].uci === node.uci) S.cur = { v, i: i + 1 };
    else { V.moves.length = i; V.moves.push(node); S.cur = { v, i: i + 1 }; }
  }
  return afterMove(silent);
}
function afterMove(silent) {
  updateVars();
  if (!silent) sound();
  render();
  return true;
}

function playLine(fen, pv, upto) {
  if (curFen() !== fen) return;
  for (const u of pv.slice(0, upto + 1)) playMove(u, { silent: true });
  sound();
}

function go(dir) {
  const { v, i } = S.cur;
  if (v < 0) {
    const n = dir === 'start' ? 0 : dir === 'end' ? S.main.length : i + (dir === 'next' ? 1 : -1);
    S.cur = { v: -1, i: Math.max(0, Math.min(S.main.length, n)) };
  } else {
    const V = S.vars[v];
    if (dir === 'start') S.cur = { v: -1, i: 0 };
    else if (dir === 'end') S.cur = { v, i: V.moves.length };
    else {
      const n = i + (dir === 'next' ? 1 : -1);
      if (n <= 0) S.cur = { v: -1, i: V.from };
      else S.cur = { v, i: Math.min(V.moves.length, n) };
    }
  }
  if (S.retry && (S.cur.v < 0 && S.cur.i !== S.retry.ply)) S.retry = null;
  render();
}
function backToGame() {
  if (S.cur.v >= 0) S.cur = { v: -1, i: S.vars[S.cur.v].from };
  S.retry = null;
  render();
}

// ---------------- retry a mistake ----------------
function startRetry(ply) {
  S.retry = { ply, result: null, tries: 0 };
  S.cur = { v: -1, i: ply };
  render();
}
function settleRetry(r) {
  if (!S.retry) return;
  S.retry.tries++;
  S.retry.result = GOODISH.has(r.cls) || r.cls === 'good' ? 'ok' : 'no';
  S.retry.r = r;
  if (S.retry.result === 'no') {
    setTimeout(() => {
      if (!S.retry || S.retry.result !== 'no') return;
      if (S.cur.v >= 0) S.vars.splice(S.cur.v, 1); // drop the failed attempt
      S.cur = { v: -1, i: S.retry.ply };
      S.retry.result = null;
      render();
    }, 1600);
  }
}

// ---------------- load ----------------
function loadPgn(pgn, preset, { shared = false } = {}) {
  const c = new Chess();
  c.loadPgn(pgn.trim());
  const hist = c.history({ verbose: true });
  S.headers = c.getHeaders();
  S.startFen = hist[0]?.before || c.fen();
  S.main = hist.map((m) => ({ uci: m.lan, san: m.san, fen: m.after, fenBefore: m.before, color: m.color }));
  S.pgn = pgn;
  S.analyses = []; S.review = []; S.vars = []; S.retry = null;
  S.cur = { v: -1, i: 0 };
  S.reviewId++; S.reviewDone = false; S.total = S.main.length + 1; S.done = 0;
  const me = (store.get('user', 'ClassifiedMicl') || '').toLowerCase();
  S.orientation = me && (S.headers.Black || '').toLowerCase() === me ? 'black' : 'white';
  if (shared) return;
  send({ type: 'review', id: S.reviewId, fens: [S.startFen, ...S.main.map((m) => m.fen)], preset });
  const title = `${S.headers.White || '?'} – ${S.headers.Black || '?'}`;
  const recent = store.get('recent', []).filter((g) => g.pgn !== pgn);
  recent.unshift({ title, pgn, date: S.headers.Date || '', result: S.headers.Result || '', preset });
  store.set('recent', recent.slice(0, 12));
  store.set('last', { pgn, preset });
  switchTab('review');
  render();
}

async function loadInput(text, preset) {
  const t = text.trim();
  if (!t) throw new Error('Вставь ссылку или PGN.');
  let pgn = t;
  if (/^https?:\/\//i.test(t)) {
    const r = await fetch('/api/import?url=' + encodeURIComponent(t)).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    pgn = r.pgn;
  }
  try { loadPgn(pgn, preset); } catch (e) { throw new Error('Не удалось прочитать PGN: ' + e.message); }
}

// ---------------- board ----------------
const cg = Chessground($('board'), {
  coordinates: true,
  animation: { enabled: true, duration: 180 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, showDests: true, events: { after: onBoardMove } },
  premovable: { enabled: false },
  drawable: { enabled: true, visible: true, defaultSnapToValidMove: true },
});

function dests(fen) {
  const c = new Chess(fen);
  const d = new Map();
  for (const m of c.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

function onBoardMove(from, to) {
  const c = new Chess(curFen());
  const p = c.get(from);
  if (p?.type === 'p' && (to[1] === '8' || to[1] === '1')) return askPromotion(from, to, p.color);
  if (!playMove(from + to)) renderBoard();
}

function askPromotion(from, to, color) {
  const ov = $('overlay');
  const box = document.createElement('div');
  box.className = 'promo';
  const glyph = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
  for (const k of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.textContent = glyph[k];
    b.onclick = () => { box.remove(); playMove(from + to + k); };
    box.appendChild(b);
  }
  box.onclick = (e) => { if (e.target === box) { box.remove(); renderBoard(); } };
  ov.appendChild(box);
}

function renderBoard() {
  const n = curNode();
  const c = new Chess(n.fen);
  const turn = c.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: n.fen,
    orientation: S.orientation,
    turnColor: turn,
    lastMove: n.move ? [n.move.uci.slice(0, 2), n.move.uci.slice(2, 4)] : undefined,
    check: c.inCheck() ? turn : false,
    movable: { color: c.isGameOver() || SHARED ? undefined : turn, dests: SHARED ? new Map() : dests(n.fen) },
  });
  renderBadge(n);
  renderShapes();
}

function squarePos(sq) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
  const x = S.orientation === 'white' ? f : 7 - f;
  const y = S.orientation === 'white' ? 7 - r : r;
  return { x, y };
}

function renderBadge(n) {
  const ov = $('overlay');
  ov.querySelectorAll('.badge').forEach((b) => b.remove());
  if (!n.move || !n.r) return;
  const meta = CLASSES[n.r.cls];
  const { x, y } = squarePos(n.move.uci.slice(2, 4));
  const b = document.createElement('div');
  b.className = 'badge';
  b.style.background = meta.color;
  b.style.left = `${(x + 1) * 12.5}%`;
  b.style.top = `${y * 12.5}%`;
  b.textContent = meta.icon;
  b.title = meta.ru;
  ov.appendChild(b);
}

function renderShapes() {
  const n = curNode();
  const shapes = [];
  // What should have been played instead of the move that led here.
  if (n.r && !GOODISH.has(n.r.cls) && n.r.bestUci && !S.retry) {
    shapes.push({ orig: n.r.bestUci.slice(0, 2), dest: n.r.bestUci.slice(2, 4), brush: 'green' });
  }
  // Engine's best move in the current position.
  if (S.arrowOn && !S.retry) {
    const u = stableBest(n.fen);
    if (u) {
      if (!shapes.some((s) => s.orig === u.slice(0, 2) && s.dest === u.slice(2, 4))) shapes.push({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'blue' });
    }
  }
  if (S.threatOn) for (const t of threats(n.fen)) shapes.push({ orig: t.from, dest: t.to, brush: 'red' });
  cg.setAutoShapes(shapes);
}

// Best available engine lines for a position: live search if it is deeper, else the stored analysis.
// One source for the whole engine panel (lines, arrow, "best move" text, eval bar):
// the stored analysis, until the live search is clearly deeper and has settled on its top move.
function bestLines(fen) {
  const stored = analysisOf(fen);
  const live = S.liveOn && S.live?.fen === fen ? uniqueLines(S.live.lines) : null;
  if (!live?.length) return stored?.lines || null;
  if (!stored) return live;
  const ld = live[0].depth || 0, sd = stored.lines[0]?.depth || 0;
  const settled = S.live.done || (stab.fen === fen && stab.move === live[0].pv[0]);
  return (settled && ld >= sd) || ld >= sd + 4 ? live : stored.lines;
}
// Multi-PV snapshots can briefly repeat the same first move in two slots; keep the first.
function uniqueLines(lines) {
  const seen = new Set();
  return (lines || []).filter((l) => l.pv?.length && !seen.has(l.pv[0]) && seen.add(l.pv[0]));
}

// ---------------- eval bar ----------------
function renderEval() {
  const fen = curFen();
  const line = bestLines(fen)?.[0];
  const sw = line ? toWhite(line.score, fen) : null;
  const pct = sw ? Math.max(4, Math.min(96, winPct(sw))) : 50;
  const bar = $('evalbar');
  bar.classList.toggle('flipped', S.orientation === 'black');
  $('evalFill').style.height = pct + '%';
  const txt = $('evalTxt');
  let label = sw ? fmtScore(sw).replace('+', '').replace('−', '') : '';
  if (sw && sw.mate !== undefined && sw.mate === 0) label = new Chess(fen).turn() === 'w' ? '0-1' : '1-0';
  txt.textContent = label;
  const whiteAhead = sw ? winPct(sw) >= 50 : true;
  const whiteBottom = S.orientation === 'white';
  const atBottom = whiteAhead === whiteBottom;
  txt.style.top = atBottom ? '' : '0';
  txt.style.bottom = atBottom ? '0' : '';
  txt.style.color = whiteAhead ? '#2b2926' : '#f4f4f2';
}

// ---------------- coach ----------------
function renderCoach() {
  const el = $('coach');
  const n = curNode();
  if (!S.main.length && !n.inVar && n.fen === START_FEN && !S.headers.White) {
    el.innerHTML = `<div class="head"><div class="ic" style="background:var(--accent)">♞</div><div class="ttl">Привет! Загрузи партию</div></div>
      <p>Вставь ссылку на партию с chess.com или lichess, PGN или выбери игру по нику. Можно и просто двигать фигуры: движок оценит каждый ход.</p>
      <div class="acts"><button class="btn primary" data-act="load">Загрузить партию</button><button class="btn" data-act="sample">Открыть пример</button></div>`;
    return;
  }

  // Retry mode
  if (S.retry) {
    const bad = S.review[S.retry.ply];
    const who = bad?.color === 'w' ? 'белых' : 'чёрных';
    let h = `<div class="tag">Попробуй ещё раз</div>`;
    if (!S.retry.result) {
      if (n.inVar && !n.r) h += `<p>Проверяю ход ${esc(n.move.san)}…</p>`;
      else h += `<p>В партии здесь было <b>${esc(bad?.san)}</b> (${CLASSES[bad?.cls]?.ru.toLowerCase()}). Найди ход лучше за ${who}: перетащи фигуру на доске.</p>`;
    } else if (S.retry.result === 'ok') {
      const ex = explainMove(S.retry.r);
      h += `<p class="ok">Верно! ${esc(S.retry.r.san)} — ${CLASSES[S.retry.r.cls].ru.toLowerCase()}.</p><p>${esc(ex.paras.join(' '))}</p>`;
    } else {
      h += `<p class="no">${esc(S.retry.r.san)} — ${CLASSES[S.retry.r.cls].ru.toLowerCase()}. Попробуй ещё раз.</p>`;
    }
    h += `<div class="acts">${S.retry.tries >= 2 || S.retry.result === 'ok' ? `<button class="btn" data-act="showbest" data-ply="${S.retry.ply}">Показать лучший ход</button>` : ''}<button class="btn" data-act="exitretry">Выйти</button></div>`;
    el.innerHTML = h;
    return;
  }

  if (!n.move) {
    const acc = S.review.length ? gameAccuracy(S.review) : null;
    el.innerHTML = `<div class="head"><div class="ic" style="background:var(--accent)">♞</div><div class="ttl">${esc(S.headers.White || 'Белые')} – ${esc(S.headers.Black || 'Чёрные')}</div></div>
      <p>${esc(openingName() || 'Начальная позиция')}${S.headers.Result ? ` · результат ${esc(S.headers.Result)}` : ''}</p>
      ${acc ? `<p>Точность: белые <b>${acc.w ?? '–'}</b>, чёрные <b>${acc.b ?? '–'}</b>.</p>` : ''}
      <p>${S.reviewDone ? 'Разбор готов.' : 'Движок разбирает партию, первые ходы уже можно смотреть.'} Жми <kbd>→</kbd> или кликай по ходам. Любую фигуру можно передвинуть: появится свой вариант с оценкой.</p>
      <div class="acts"><button class="btn primary" data-act="next">Начать разбор →</button>${keyMoments().length ? '<button class="btn" data-act="report">Ключевые моменты</button>' : ''}</div>`;
    return;
  }

  if (!n.r) {
    el.innerHTML = `<div class="head"><div class="ic" style="background:var(--surface-3)">…</div><div class="ttl">${esc(moveLabel(n.move.fenBefore, n.move.san))}</div></div>
      <p>${SHARED ? 'В этом файле нет оценки для этой позиции: движок работает только у автора разбора.' : 'Движок оценивает ход…'}</p>${n.inVar ? varActs() : ''}`;
    return;
  }

  const r = n.r;
  r.expl ||= explainMove(r);
  const ex = r.expl;
  const meta = CLASSES[r.cls];
  let h = '';
  if (n.inVar) h += `<div class="tag">Свой вариант</div>`;
  h += `<div class="head"><div class="ic" style="background:${meta.color}">${meta.icon}</div><div class="ttl">${esc(ex.title)}</div><div class="ev">${esc(ex.eval)}</div></div>`;
  for (const p of ex.paras) h += `<p>${esc(p)}</p>`;
  if (ex.refLine) h += `<div class="pv">Что дальше по мнению движка: ${esc(ex.refLine)}</div>`;
  if (ex.better) {
    h += `<div class="better"><p>${esc(ex.better.text).replace(esc(ex.better.san), `<b>${esc(ex.better.san)}</b>`)}</p>${ex.bestLine ? `<div class="pv">${esc(ex.bestLine)}</div>` : ''}</div>`;
  }
  const acts = [];
  if (ex.better) {
    acts.push(`<button class="btn" data-act="showbest">Показать лучший ход</button>`);
    acts.push(`<button class="btn" data-act="showline">Показать линию</button>`);
  }
  if (!n.inVar && BAD.has(r.cls) && !SHARED) acts.push(`<button class="btn primary" data-act="retry">Попробовать ещё раз</button>`);
  h += `<div class="acts">${acts.join('')}</div>`;
  if (n.inVar) h += varActs();
  el.innerHTML = h;
}
const varActs = () => `<div class="acts"><button class="btn" data-act="back">↩ Вернуться к партии</button></div>`;

$('coach').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const n = curNode();
  if (act === 'load') openLoad();
  else if (act === 'sample') loadPgn(samplePgn, $('presetSel').value);
  else if (act === 'next') go('next');
  else if (act === 'report') switchTab('report');
  else if (act === 'back') backToGame();
  else if (act === 'retry') startRetry(S.cur.i - 1);
  else if (act === 'exitretry') { const p = S.retry.ply; S.retry = null; S.cur = { v: -1, i: p + 1 }; render(); }
  else if (act === 'showbest' || act === 'showline') {
    let r = n.r, fen = n.move?.fenBefore;
    if (b.dataset.ply) { r = S.review[+b.dataset.ply]; fen = r.fenBefore; S.retry = null; S.cur = { v: -1, i: +b.dataset.ply }; }
    if (!r) return;
    goToFen(fen, n);
    const pv = r.before.lines[0].pv;
    playLine(fen, pv, act === 'showline' ? Math.min(pv.length, 6) - 1 : 0);
    if (act === 'showline') { S.cur.i = 1; render(); }
  }
});

// Step back to the position before the current move (so a line can be played from there).
function goToFen(fen, n) {
  if (curFen() === fen) return;
  if (n.inVar) {
    const k = S.cur.i - 1;
    S.cur = k <= 0 ? { v: -1, i: n.V.from } : { v: S.cur.v, i: k };
  } else S.cur = { v: -1, i: Math.max(0, S.cur.i - 1) };
}

function openingName() {
  let name = null;
  for (const r of S.review) if (r.opening) name = `${r.opening[1]} (${r.opening[0]})`;
  return name || (S.headers.ECO ? `Дебют ${S.headers.ECO}` : null);
}

// ---------------- stable best move ----------------
// The engine deepens step by step and may switch its top move between depths. To keep the arrow and
// the "best move" text calm, a move counts as best only once it stayed on top for 3 depths in a row
// (or the search finished). Until then the previous stable choice (or the stored analysis) is shown.
const stab = { fen: null, byDepth: new Map(), move: null };
function trackStable(fen, lines, done) {
  if (stab.fen !== fen) { stab.fen = fen; stab.byDepth = new Map(); stab.move = null; }
  const top = lines?.[0];
  if (!top?.pv?.[0]) return;
  stab.byDepth.set(top.depth, top.pv[0]);
  if (done) { stab.move = top.pv[0]; return; }
  const depths = [...stab.byDepth.keys()].sort((a, b) => b - a).slice(0, 3);
  if (depths.length === 3 && depths[0] >= 12 && depths.every((d) => stab.byDepth.get(d) === top.pv[0])) stab.move = top.pv[0];
}
function stableBest(fen) {
  const lines = bestLines(fen);
  if (!lines?.length) return null;
  const fromLive = S.live?.fen === fen && lines[0] === uniqueLines(S.live.lines)[0];
  if (fromLive && stab.fen === fen && stab.move) return stab.move;
  return lines[0].pv[0];
}

// ---------------- live engine panel ----------------
let lastIdeaKey = '';
function pushLive() {
  if (!S.liveOn || document.hidden) { send({ type: 'liveStop' }); return; }
  const fen = curFen();
  if (S.live?.fen !== fen) S.live = null;
  send({ type: 'live', fen, multipv: 3 });
}

function renderLive() {
  const fen = curFen();
  const lines = bestLines(fen) || [];
  const el = $('lines');
  const depth = lines[0]?.depth;
  $('engineDepth').textContent = SHARED ? (depth ? `глубина ${depth}, из разбора` : 'нет данных') : !S.liveOn ? 'выключен' : depth ? `глубина ${depth}${S.live?.fen === fen && !S.live.done ? '…' : ' ✓'}` : 'считаю…';
  if (new Chess(fen).isGameOver()) { el.innerHTML = '<div class="line"><span class="mvs">Партия окончена</span></div>'; $('bestIdea').innerHTML = ''; return; }
  el.innerHTML = lines.slice(0, 3).map((l, li) => {
    const sw = toWhite(l.score, fen);
    const sans = pvToSan(fen, l.pv, 12);
    let [, side, , , , full] = fen.split(' ');
    let num = +full;
    const parts = sans.map((s, k) => {
      let pre = '';
      if (side === 'w') pre = `<i>${num}.</i>`;
      else if (k === 0) pre = `<i>${num}…</i>`;
      if (side === 'b') num++;
      side = side === 'w' ? 'b' : 'w';
      return `${pre}<span data-l="${li}" data-k="${k}">${esc(s)}</span>`;
    });
    return `<div class="line"><span class="sc ${winPct(sw) >= 50 ? 'w' : 'b'}">${esc(fmtScore(sw))}</span><span class="mvs">${parts.join(' ')}</span></div>`;
  }).join('') || '<div class="line"><span class="mvs">…</span></div>';
  el.dataset.fen = fen;
  // Idea of the best move (recomputed only when the top line changes).
  const sb = stableBest(fen);
  const key = fen + (sb || '');
  if (key !== lastIdeaKey && sb) {
    lastIdeaKey = key;
    const line = lines.find((l) => l.pv[0] === sb) || analysisOf(fen)?.lines.find((l) => l.pv[0] === sb) || lines[0];
    const ex = explainBest(fen, line);
    $('bestIdea').innerHTML = ex ? `Лучший ход: <b>${esc(ex.san)}</b>. ${esc(ex.text)}` : '';
  } else if (!lines[0]) $('bestIdea').innerHTML = '';
  if (S.threatOn) {
    const t = threats(fen);
    $('bestIdea').innerHTML += `<div style="margin-top:4px;color:#ee6b55">Угроза соперника: ${t.length ? esc(t.map((x) => x.text).join('; ')) : 'ничего серьёзного'}.</div>`;
    lastIdeaKey = '';
  }
}
$('lines').addEventListener('click', (e) => {
  const s = e.target.closest('span[data-k]');
  if (!s) return;
  const fen = $('lines').dataset.fen;
  const line = bestLines(fen)?.[+s.dataset.l];
  if (line) playLine(fen, line.pv, +s.dataset.k);
});

// ---------------- move list ----------------
function moveBtn(label, cls, attrs, current) {
  const meta = cls && NOTABLE.has(cls) ? CLASSES[cls] : null;
  return `<button class="mv${current ? ' cur' : ''}" ${attrs}>${meta ? `<span class="i" style="background:${meta.color}" title="${meta.ru}">${meta.icon}</span>` : ''}${esc(label)}</button>`;
}
function renderMoves() {
  const el = $('moves');
  if (!S.main.length && !S.vars.length) { el.innerHTML = '<p class="hint" style="padding:10px 14px">Ходов пока нет.</p>'; return; }
  const startFull = +S.startFen.split(' ')[5];
  const blackFirst = S.startFen.split(' ')[1] === 'b';
  let h = '';
  const varsFrom = (i) => S.vars.map((V, vi) => ({ V, vi })).filter((x) => x.V.from === i);
  const varHtml = ({ V, vi }) => {
    const parts = V.moves.map((m, k) => {
      const lbl = m.color === 'w' || k === 0 ? moveLabel(m.fenBefore, m.san) : m.san;
      return moveBtn(lbl, m.r?.cls, `data-v="${vi}" data-i="${k + 1}"`, S.cur.v === vi && S.cur.i === k + 1);
    });
    return `<div class="var">${parts.join('')}<button class="del" data-del="${vi}" title="Удалить вариант">✕</button></div>`;
  };
  const total = S.main.length;
  let i = 0;
  let row = 0;
  while (i < total) {
    const num = startFull + row;
    let cells = '';
    const vs = [];
    if (row === 0 && blackFirst) { cells += '<span></span>'; }
    const take = row === 0 && blackFirst ? 1 : 2;
    for (let t = 0; t < take && i < total; t++, i++) {
      const m = S.main[i];
      cells += moveBtn(m.san, S.review[i]?.cls, `data-v="-1" data-i="${i + 1}"`, S.cur.v < 0 && S.cur.i === i + 1);
      vs.push(...varsFrom(i));
    }
    h += `<div class="mrow"><span class="n">${num}.</span>${cells}</div>`;
    for (const x of vs) h += varHtml(x);
    row++;
  }
  if (total === 0) for (const x of varsFrom(0)) h += varHtml(x);
  el.innerHTML = h;
  const cur = el.querySelector('.mv.cur');
  if (cur) {
    const r = cur.getBoundingClientRect(), br = el.getBoundingClientRect();
    if (r.top < br.top || r.bottom > br.bottom) el.scrollTop += r.top - br.top - br.height / 2;
  } else if (S.cur.v < 0 && S.cur.i === 0) el.scrollTop = 0;
}
$('moves').addEventListener('click', (e) => {
  const d = e.target.closest('[data-del]');
  if (d) {
    const vi = +d.dataset.del;
    if (S.cur.v === vi) S.cur = { v: -1, i: S.vars[vi].from };
    else if (S.cur.v > vi) S.cur.v--;
    S.vars.splice(vi, 1);
    render();
    return;
  }
  const b = e.target.closest('.mv');
  if (!b) return;
  S.retry = null;
  S.cur = { v: +b.dataset.v, i: +b.dataset.i };
  render();
});

// ---------------- graph ----------------
function renderGraph() {
  const g = $('graph');
  const N = S.main.length;
  if (!N) { g.innerHTML = ''; return; }
  const W = 600, H = 110;
  const X = (i) => (i * W) / N;
  const Y = (p) => H - (p / 100) * H;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const a = S.analyses[i];
    if (!a) break;
    pts.push([i, Math.max(2, Math.min(98, winPct(toWhite(a.lines[0]?.score, fenAt(i)))))]);
  }
  let h = '';
  if (pts.length) {
    const last = pts[pts.length - 1][0];
    h += `<polygon points="0,${H} ${pts.map(([i, p]) => `${X(i).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')} ${X(last).toFixed(1)},${H}" fill="#f4f4f2"/>`;
  }
  h += `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#8a867e" stroke-width="1" stroke-dasharray="4 4"/>`;
  if (S.cur.v < 0) h += `<line x1="${X(S.cur.i)}" y1="0" x2="${X(S.cur.i)}" y2="${H}" stroke="#81b64c" stroke-width="2"/>`;
  else h += `<line x1="${X(S.vars[S.cur.v].from)}" y1="0" x2="${X(S.vars[S.cur.v].from)}" y2="${H}" stroke="#81b64c" stroke-width="2" stroke-dasharray="3 3"/>`;
  S.review.forEach((r, k) => {
    if (!['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(r.cls)) return;
    const p = pts[k + 1];
    if (p) h += `<circle cx="${X(k + 1)}" cy="${Y(p[1])}" r="4.5" fill="${CLASSES[r.cls].color}" stroke="#fff" stroke-width="1.3" vector-effect="non-scaling-stroke"/>`;
  });
  g.innerHTML = h;
}
$('graph').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  S.retry = null;
  S.cur = { v: -1, i: Math.round(((e.clientX - r.left) / r.width) * S.main.length) };
  render();
});

// ---------------- players / report ----------------
function renderPlayers() {
  const acc = S.review.length ? gameAccuracy(S.review) : {};
  const c = new Chess(curFen());
  const mat = material(c);
  const diff = matValue(mat.w) - matValue(mat.b);
  const card = (side) => {
    const name = side === 'w' ? S.headers.White || 'Белые' : S.headers.Black || 'Чёрные';
    const elo = side === 'w' ? S.headers.WhiteElo : S.headers.BlackElo;
    const adv = side === 'w' ? diff : -diff;
    const a = acc[side];
    return `<span class="sw" style="background:${side === 'w' ? '#f4f4f2' : '#2b2926'}"></span>
      <span class="name">${esc(name)}</span>${elo ? `<span class="rt">(${esc(elo)})</span>` : ''}
      ${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}
      ${a != null ? `<span class="acc" title="Точность">${a}</span>` : ''}`;
  };
  const top = S.orientation === 'white' ? 'b' : 'w';
  const bot = top === 'w' ? 'b' : 'w';
  $('pTop').innerHTML = card(top);
  $('pBot').innerHTML = card(bot);
  $('pTop').classList.toggle('to-move', c.turn() === top);
  $('pBot').classList.toggle('to-move', c.turn() === bot);
}

function keyMoments() {
  return S.review.map((r, k) => ({ r, k })).filter(({ r }) => ['brilliant', 'great', 'miss', 'mistake', 'blunder'].includes(r.cls));
}

function renderReport() {
  const el = $('report');
  if (!S.main.length) { el.innerHTML = '<p class="hint">Загрузи партию, чтобы увидеть отчёт.</p>'; return; }
  const acc = gameAccuracy(S.review);
  const cnt = { w: {}, b: {} };
  for (const r of S.review) cnt[r.color][r.cls] = (cnt[r.color][r.cls] || 0) + 1;
  let h = `<div class="accs">
    <div class="accbox"><div class="nm">${esc(S.headers.White || 'Белые')}</div><div class="big">${acc.w ?? '–'}</div><div class="lbl2">точность</div></div>
    <div class="accbox"><div class="nm">${esc(S.headers.Black || 'Чёрные')}</div><div class="big">${acc.b ?? '–'}</div><div class="lbl2">точность</div></div></div>`;
  if (!S.reviewDone) h += `<p class="hint">Разбор ещё идёт: ${S.review.length} из ${S.main.length} ходов.</p>`;
  h += `<div class="ctable"><span></span><span class="h">Белые</span><span class="h">Чёрные</span>`;
  for (const k of [...CLASS_ORDER, 'forced']) {
    const w = cnt.w[k] || 0, b = cnt.b[k] || 0;
    if (k === 'forced' && !w && !b) continue;
    const m = CLASSES[k];
    h += `<span class="lab"><span class="dot" style="background:${m.color}">${m.icon}</span>${m.ru}</span><span class="num${w ? '' : ' zero'}">${w}</span><span class="num${b ? '' : ' zero'}">${b}</span>`;
  }
  h += `</div>`;
  const op = openingName();
  if (op) h += `<div><h3>Дебют</h3><p style="margin:6px 0 0">${esc(op)}</p></div>`;
  const km = keyMoments();
  if (km.length) {
    h += `<div><h3>Ключевые моменты</h3><div class="moments" style="margin-top:8px">`;
    for (const { r, k } of km) {
      const m = CLASSES[r.cls];
      h += `<button class="moment" data-ply="${k + 1}"><span class="dot" style="background:${m.color}">${m.icon}</span><b>${esc(moveLabel(r.fenBefore, r.san))}</b> ${m.ru.toLowerCase()}<span class="t">${esc(fmtScore(toWhite(r.after.lines[0]?.score, r.fenAfter)))}</span></button>`;
    }
    h += `</div></div>`;
  }
  if (S.headers.Link || S.headers.Site?.startsWith('http')) {
    const link = S.headers.Link || S.headers.Site;
    h += `<p class="hint">Партия: <a href="${esc(link)}" target="_blank" rel="noreferrer" style="color:var(--accent)">${esc(link)}</a></p>`;
  }
  el.innerHTML = h;
}
$('report').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ply]');
  if (!b) return;
  S.cur = { v: -1, i: +b.dataset.ply };
  switchTab('review');
  render();
});

function renderProgress() {
  const p = $('progress');
  if (S.reviewDone || !S.total) { p.hidden = true; return; }
  p.hidden = false;
  $('progressBar').style.width = `${(100 * S.done) / S.total}%`;
  $('progressTxt').textContent = `Stockfish разбирает партию: ${S.done} / ${S.total}`;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-review').hidden = name !== 'review';
  $('tab-report').hidden = name !== 'report';
  if (name === 'report') renderReport();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

// ---------------- render loop ----------------
let lastFen = null;
function render() {
  const fen = curFen();
  if (fen !== lastFen) { lastFen = fen; pushLive(); lastIdeaKey = ''; $('bestIdea').innerHTML = ''; }
  renderBoard();
  renderEval();
  renderCoach();
  renderLive();
  renderMoves();
  renderGraph();
  renderPlayers();
  renderProgress();
  if (!$('tab-report').hidden) renderReport();
  $('bArrow').classList.toggle('on', S.arrowOn);
  $('bThreat').classList.toggle('on', S.threatOn);
}
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = setTimeout(() => { raf = 0; render(); }, 16);
}

// ---------------- sound ----------------
let actx;
function sound() {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.value = 340;
    g.gain.setValueAtTime(0.12, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.08);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.09);
  } catch { /* no audio */ }
}

// ---------------- controls ----------------
$('bStart').onclick = () => go('start');
$('bPrev').onclick = () => go('prev');
$('bNext').onclick = () => go('next');
$('bEnd').onclick = () => go('end');
$('bFlip').onclick = () => { S.orientation = S.orientation === 'white' ? 'black' : 'white'; render(); };
$('liveToggle').checked = S.liveOn;
$('liveToggle').onchange = (e) => { S.liveOn = e.target.checked; store.set('liveOn', S.liveOn); S.live = null; pushLive(); render(); };
$('bArrow').onclick = () => { S.arrowOn = !S.arrowOn; store.set('arrowOn', S.arrowOn); render(); };
$('bThreat').onclick = () => { S.threatOn = !S.threatOn; render(); };
document.querySelectorAll('#power button').forEach((b) => (b.onclick = () => { store.set('power', b.dataset.p); send({ type: 'power', mode: b.dataset.p }); }));
$('btnOff').onclick = async () => {
  if (!confirm('Выключить приложение? Stockfish остановится.')) return;
  S.off = true;
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch { /* already down */ }
  $('offScreen').hidden = false;
};
// Pause the engine while the tab is hidden, resume when it is back.
document.addEventListener('visibilitychange', () => { S.live = null; pushLive(); });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || $('loadDlg').open) return;
  const k = e.key;
  if (k === 'ArrowRight') go('next');
  else if (k === 'ArrowLeft') go('prev');
  else if (k === 'Home' || k === 'ArrowUp') go('start');
  else if (k === 'End' || k === 'ArrowDown') go('end');
  else if (k === 'f' || k === 'F' || k === 'а' || k === 'А') $('bFlip').click();
  else if (k === 'a' || k === 'A' || k === 'ф' || k === 'Ф') $('bArrow').click();
  else if (k === 't' || k === 'T' || k === 'е' || k === 'Е') $('bThreat').click();
  else if (k === 'Escape') backToGame();
  else return;
  e.preventDefault();
});

// ---------------- load dialog ----------------
function openLoad() {
  $('loadErr').textContent = '';
  $('userInput').value = store.get('user', 'ClassifiedMicl');
  renderRecent();
  $('loadDlg').showModal();
}
$('btnLoad').onclick = openLoad;
$('btnAnalyze').onclick = async (e) => {
  e.preventDefault();
  $('loadErr').textContent = '';
  $('btnAnalyze').disabled = true;
  try {
    await loadInput($('pgnInput').value, $('presetSel').value);
    $('loadDlg').close();
  } catch (err) { $('loadErr').textContent = err.message; }
  $('btnAnalyze').disabled = false;
};
$('btnSample').onclick = () => { loadPgn(samplePgn, $('presetSel').value); $('loadDlg').close(); };
$('btnGames').onclick = async () => {
  const user = $('userInput').value.trim();
  if (!user) return;
  store.set('user', user);
  const list = $('gameList');
  list.innerHTML = '<p class="hint">Загружаю…</p>';
  try {
    const r = await fetch('/api/chesscom?user=' + encodeURIComponent(user)).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    if (!r.games.length) { list.innerHTML = '<p class="hint">Партий не найдено.</p>'; return; }
    window.__games = r.games;
    list.innerHTML = r.games.map((g, k) => {
      const meWhite = g.white.toLowerCase() === user.toLowerCase();
      const res = meWhite ? g.whiteResult : g.blackResult;
      const rc = res === 'win' ? 'win' : ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(res) ? '' : 'loss';
      const rl = rc === 'win' ? 'победа' : rc === 'loss' ? 'поражение' : 'ничья';
      const d = new Date(g.endTime * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      return `<button class="gitem" type="button" data-g="${k}"><span>${esc(g.white)} (${g.whiteRating}) – ${esc(g.black)} (${g.blackRating})</span><span class="r ${rc}">${rl}</span><span class="s">${esc(g.timeClass)} · ${d}</span></button>`;
    }).join('');
  } catch (err) { list.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
};
$('gameList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-g]');
  if (!b) return;
  loadPgn(window.__games[+b.dataset.g].pgn, $('presetSel').value);
  $('loadDlg').close();
});
function renderRecent() {
  const rec = store.get('recent', []);
  $('recentList').innerHTML = rec.length ? rec.map((g, k) => `<button class="gitem" type="button" data-r="${k}"><span>${esc(g.title)}</span><span class="r">${esc(g.result)}</span><span class="s">${esc(g.date)}</span></button>`).join('') : '<p class="hint">Пока пусто.</p>';
}
$('recentList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  const g = store.get('recent', [])[+b.dataset.r];
  if (g) { loadPgn(g.pgn, g.preset || $('presetSel').value); $('loadDlg').close(); }
});

// ---------------- share as a file ----------------
// Builds one self-contained HTML file: this page + its CSS/JS inlined + the review data.
// The friend opens it in any browser, offline, and sees the same review (no live engine).
async function exportShared() {
  if (!S.main.length) return alert('Сначала загрузи партию.');
  if (!S.reviewDone) return alert('Дождись, пока Stockfish закончит разбор, и нажми ещё раз.');
  const btn = $('btnShare');
  btn.disabled = true;
  try {
    const page = await fetch('/').then((r) => r.text());
    const jsSrc = page.match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/)[1];
    const cssHref = page.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/)[1];
    const [js, css] = await Promise.all([fetch(jsSrc).then((r) => r.text()), fetch(cssHref).then((r) => r.text())]);
    const varFens = new Set(S.vars.flatMap((V) => V.moves.flatMap((m) => [m.fenBefore, m.fen])));
    const data = {
      v: 1,
      pgn: S.pgn,
      analyses: S.analyses,
      quick: [...varFens].filter((f) => quickCache.has(f)).map((f) => [f, quickCache.get(f)]),
      vars: S.vars.map((V) => ({ from: V.from, moves: V.moves.map((m) => m.uci) })),
      orientation: S.orientation,
      cur: S.cur,
      by: store.get('user', 'ClassifiedMicl'),
      engine: $('engineName').textContent,
    };
    const title = `Разбор: ${S.headers.White || '?'} – ${S.headers.Black || '?'}`;
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    const html = page
      .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
      .replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/, () => `<script>window.__CHESS_SHARED__=${json}</script>\n<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`)
      .replace(/<link[^>]+rel="stylesheet"[^>]+href="[^"]+"[^>]*>/, () => `<style>${css}</style>`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '')}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    alert('Не получилось собрать файл: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}
$('btnShare').onclick = exportShared;

// Open a shared file: restore the game, its analysis and the author's variations.
function loadShared() {
  document.body.classList.add('shared');
  loadPgn(SHARED.pgn, null, { shared: true });
  S.analyses = SHARED.analyses;
  S.analyses.forEach((a, i) => a && quickCache.set(fenAt(i), a));
  for (const [f, a] of SHARED.quick || []) quickCache.set(f, a);
  S.done = S.total; S.reviewDone = true;
  classifyMainUpTo();
  for (const V of SHARED.vars || []) {
    S.cur = { v: -1, i: V.from };
    for (const u of V.moves) playMove(u, { silent: true });
  }
  S.orientation = SHARED.orientation || 'white';
  S.cur = SHARED.cur && (SHARED.cur.v < S.vars.length) ? SHARED.cur : { v: -1, i: 0 };
  const by = SHARED.by ? `Разбор от ${SHARED.by}` : 'Разбор';
  $('engineChip').textContent = `${by} · только просмотр`;
  $('engineName').textContent = SHARED.engine || 'Stockfish';
  render();
}

// ---------------- start ----------------
// First render after layout, so the board has its size before arrows are drawn.
// (setTimeout, not requestAnimationFrame: rAF never fires in a background tab.)
if (SHARED) {
  setTimeout(loadShared, 0);
} else {
  fetch('/api/info').then((r) => r.json()).then((i) => { $('engineChip').textContent = i.engine; $('engineName').textContent = i.engine; }).catch(() => {});
  connect();
  setTimeout(() => {
    const last = store.get('last', null);
    if (last?.pgn) { try { loadPgn(last.pgn, last.preset); } catch { render(); } }
    else render();
  }, 0);
}
