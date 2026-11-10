// Move classification (chess.com style) and accuracy (lichess formula).
// An "analysis" is { lines: [{ multipv, depth, score, pv }] } with scores from the side to move.
import { Chess } from 'chess.js';
import OPENINGS from './openings.json' with { type: 'json' };
import { winPct, VALUE, bookKey, see, uciToMove, legalCount } from './chessutil.js';

export const CLASSES = {
  brilliant:  { ru: 'Бриллиант',    icon: '!!', color: '#1baca6' },
  great:      { ru: 'Сильный ход',  icon: '!',  color: '#5c8bb0' },
  best:       { ru: 'Лучший ход',   icon: '★',  color: '#81b64c' },
  excellent:  { ru: 'Отлично',      icon: '👍', color: '#7fa650' },
  good:       { ru: 'Хорошо',       icon: '✓',  color: '#95b776' },
  book:       { ru: 'Книжный ход',  icon: '📖', color: '#a88865' },
  forced:     { ru: 'Вынужденный',  icon: '⇥',  color: '#97a4a6' },
  inaccuracy: { ru: 'Неточность',   icon: '?!', color: '#f7c631' },
  mistake:    { ru: 'Ошибка',       icon: '?',  color: '#e58f2a' },
  miss:       { ru: 'Упущение',     icon: '✕',  color: '#ee6b55' },
  blunder:    { ru: 'Зевок',        icon: '??', color: '#ca3431' },
};
export const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
export const BAD = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);

export function openingOf(fen) {
  const v = OPENINGS[bookKey(fen)];
  return v === undefined ? undefined : v; // 0 = book position without own name
}

// Material the mover gives up with this move, after the opponent's best capture sequence.
// Positive = a real sacrifice (e.g. Bxf7+ Kxf7 gives 2, an exchange sac gives 2).
export function sacrificeValue(fenBefore, move) {
  const c = new Chess(fenBefore);
  const mv = c.move(move);
  if (c.isCheckmate()) return 0;
  const me = mv.color;
  const captured = mv.captured ? VALUE[mv.captured] : 0;
  let worst = 0;
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== me || p.type === 'k' || p.type === 'p') continue;
    worst = Math.max(worst, see(c, p.square));
  }
  // Pieces that were already hanging before the move are not a new sacrifice.
  const before = new Chess(fenBefore);
  const p = fenBefore.split(' '); p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
  let already = 0;
  try {
    const opp = new Chess(p.join(' '), { skipValidation: true });
    for (const row of before.board()) for (const q of row) {
      if (!q || q.color !== me || q.type === 'k' || q.type === 'p' || q.square === mv.from) continue;
      already = Math.max(already, see(opp, q.square));
    }
  } catch { /* ignore */ }
  if (worst <= already) return 0;
  return worst - captured;
}

// Classify one move.
//   before: analysis of the position before the move (multipv >= 2 helps "great")
//   after:  analysis of the position after the move (opponent to move)
//   ctx:    { prev: previous classified move or null, allBookSoFar: bool }
export function classifyMove(fenBefore, uci, before, after, ctx = {}) {
  const top = before.lines[0];
  const bestUci = top?.pv?.[0];
  const wBest = winPct(top?.score);
  const inLines = before.lines.find((l) => l.pv[0] === uci);
  // Prefer the score from the same search when the move is one of the engine's lines.
  const wAfterSearch = 100 - winPct(after.lines[0]?.score);
  const wAfter = inLines ? winPct(inLines.score) : wAfterSearch;
  const isBest = uci === bestUci || (inLines && winPct(inLines.score) >= wBest - 0.5);
  const loss = isBest ? 0 : Math.max(0, wBest - wAfter);

  const c = new Chess(fenBefore);
  const mv = c.move(uciToMove(uci));
  const fenAfter = c.fen();
  const res = { uci, san: mv.san, color: mv.color, fenBefore, fenAfter, wBefore: wBest, wAfter: isBest ? wBest : wAfter, loss, bestUci, before, after };

  let cls;
  if (isBest) cls = 'best';
  else if (loss <= 2) cls = 'excellent';
  else if (loss <= 5) cls = 'good';
  else if (loss <= 10) cls = 'inaccuracy';
  else if (loss <= 20) cls = 'mistake';
  else cls = 'blunder';

  // Win chances near 0% hide the difference between "losing" and "mated next move".
  // Allowing a forced mate when the best move avoided one is at least a mistake.
  const mateAgainst = after.lines[0]?.score?.mate > 0; // opponent mates
  const bestMated = top?.score?.mate !== undefined && top.score.mate < 0;
  if (!isBest && mateAgainst && !bestMated && !BAD.has(cls)) cls = wBest >= 10 ? 'blunder' : 'mistake';

  // Book: position is in the opening database and every earlier move was book too.
  const op = openingOf(fenAfter);
  if (ctx.allBookSoFar !== false && op !== undefined && loss < 10) { res.cls = 'book'; res.opening = op || null; return res; }
  if (op) res.opening = op;

  if (legalCount(fenBefore) === 1) { res.cls = 'forced'; return res; }

  // Brilliant: a good move that gives up material, in a position that is not already lost or trivially won.
  if ((cls === 'best' || cls === 'excellent') && res.wAfter >= 45 && wBest < 97) {
    const sac = sacrificeValue(fenBefore, uci);
    if (sac >= 2) { res.cls = 'brilliant'; res.sacrifice = sac; return res; }
  }

  // Great: the only good move. The second-best line is much worse, and it is not an obvious recapture.
  if (cls === 'best' && before.lines[1]) {
    const gap = wBest - winPct(before.lines[1].score);
    const recapture = ctx.prev && ctx.prev.captureSquare === mv.to;
    const trivial = winPct(before.lines[1].score) >= 85 || wBest <= 15;
    if (gap >= 12 && !recapture && !trivial) cls = 'great';
  }

  // Miss: the opponent just erred and this move throws the chance away (without making things worse than before).
  if (BAD.has(cls) && ctx.prev && ['mistake', 'blunder', 'miss'].includes(ctx.prev.cls)) {
    const myBeforeTheirError = 100 - ctx.prev.wBefore;
    const chance = wBest - myBeforeTheirError;
    if (chance >= 10 && loss >= 10 && res.wAfter >= myBeforeTheirError - 5) cls = 'miss';
  }
  res.cls = cls;
  return res;
}

// Classify a list of moves. analyses[i] is the analysis of the position before move i (length moves+1).
export function reviewGame(startFen, ucis, analyses) {
  const out = [];
  const c = new Chess(startFen);
  let allBook = true;
  let prev = null;
  for (let i = 0; i < ucis.length; i++) {
    if (!analyses[i] || !analyses[i + 1]) break;
    const fen = c.fen();
    const r = classifyMove(fen, ucis[i], analyses[i], analyses[i + 1], { prev, allBookSoFar: allBook });
    const mv = c.move(uciToMove(ucis[i]));
    r.captureSquare = mv.captured ? mv.to : null;
    r.ply = i + 1;
    if (r.cls !== 'book') allBook = false;
    out.push(r);
    prev = r;
  }
  return out;
}

// Per-move accuracy (lichess): 103.1668 * e^(-0.04354 * winDrop) - 3.1669.
export const moveAccuracy = (r) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, r.wBefore - r.wAfter)) - 3.1669));

// Game accuracy per side (lichess: average of volatility-weighted mean and harmonic mean).
export function gameAccuracy(moves) {
  const wins = [moves.length ? (moves[0].color === 'w' ? moves[0].wBefore : 100 - moves[0].wBefore) : 50];
  for (const m of moves) wins.push(m.color === 'w' ? m.wAfter : 100 - m.wAfter);
  const win = Math.max(2, Math.min(8, Math.floor(moves.length / 10)));
  const weights = moves.map((_, i) => {
    const lo = Math.max(0, i + 1 - win), part = wins.slice(lo, lo + win + 1);
    const mean = part.reduce((a, b) => a + b, 0) / part.length;
    const sd = Math.sqrt(part.reduce((a, b) => a + (b - mean) ** 2, 0) / part.length);
    return Math.max(0.5, Math.min(12, sd));
  });
  const res = {};
  for (const side of ['w', 'b']) {
    const idx = moves.map((m, i) => (m.color === side ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) { res[side] = null; continue; }
    const accs = idx.map((i) => moveAccuracy(moves[i]));
    const ws = idx.map((i) => weights[i]);
    const wmean = accs.reduce((a, v, k) => a + v * ws[k], 0) / ws.reduce((a, b) => a + b, 0);
    const hmean = accs.length / accs.reduce((a, v) => a + 1 / Math.max(v, 1), 0);
    res[side] = Math.round(((wmean + hmean) / 2) * 10) / 10;
  }
  return res;
}
