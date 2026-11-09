// Small chess helpers on top of chess.js: win chances, SEE, PV conversion, text names.
import { Chess } from 'chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const NOM = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' };
export const ACC = { p: 'пешку', n: 'коня', b: 'слона', r: 'ладью', q: 'ферзя', k: 'короля' };
export const FILES = 'abcdefgh';

// Win chance (0..100) for the side the score belongs to. Same curve lichess uses.
export function winPct(score) {
  if (!score) return 50;
  if (score.mate !== undefined) {
    if (score.mate === 0) return score.whiteWins ? 100 : 0; // mated side to move, unless flagged
    return score.mate > 0 ? 100 : 0;
  }
  const cp = Math.max(-2000, Math.min(2000, score.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export const turnOf = (fen) => fen.split(' ')[1];

// Flip a side-to-move score to White's point of view.
export function toWhite(score, fen) {
  if (!score) return null;
  if (turnOf(fen) === 'w') return score;
  if (score.mate === 0) return { mate: 0, whiteWins: true };
  return score.mate !== undefined ? { mate: -score.mate } : { cp: -score.cp };
}

export function fmtScore(scoreWhite) {
  if (!scoreWhite) return '…';
  if (scoreWhite.mate !== undefined) {
    if (scoreWhite.mate === 0) return '#';
    return (scoreWhite.mate > 0 ? '' : '−') + 'M' + Math.abs(scoreWhite.mate);
  }
  const v = scoreWhite.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}

export const bookKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

// Convert a UCI line to SAN moves (stops at the first illegal move).
export function pvToSan(fen, pv, max = 12) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try { out.push(c.move(uciToMove(u)).san); } catch { break; }
  }
  return out;
}

// SAN with move numbers, e.g. "12. Nf3 Nc6 13. Bb5" or "12... Nc6 13. Bb5".
export function numberedLine(fen, sans) {
  let [, side, , , , full] = fen.split(' ');
  let n = +full;
  const parts = [];
  sans.forEach((s, i) => {
    if (side === 'w') parts.push(`${n}. ${s}`);
    else { parts.push(i === 0 ? `${n}… ${s}` : s); n++; }
    side = side === 'w' ? 'b' : 'w';
  });
  return parts.join(' ');
}

export function moveLabel(fen, san) {
  const [, side, , , , full] = fen.split(' ');
  return side === 'w' ? `${full}. ${san}` : `${full}… ${san}`;
}

// Load a FEN, optionally with the other side to move (a "null move"). Returns null if impossible.
export function board(fen, flip = false) {
  try {
    if (!flip) return new Chess(fen);
    const p = fen.split(' ');
    p[1] = p[1] === 'w' ? 'b' : 'w';
    p[3] = '-';
    const c = new Chess(p.join(' '), { skipValidation: true });
    // The side that just "passed" must not be in check, or the position is nonsense.
    return c;
  } catch { return null; }
}

// Static exchange evaluation: material the side to move gains by starting captures on `square`
// with legal moves, always recapturing with the cheapest piece. 0 if capturing is not worth it.
export function see(c, square, depth = 0) {
  const target = c.get(square);
  if (!target || depth > 12) return 0;
  let caps;
  try { caps = c.moves({ verbose: true }).filter((m) => m.to === square && (!m.promotion || m.promotion === 'q')); } catch { return 0; }
  if (!caps.length) return 0;
  caps.sort((a, b) => VALUE[a.piece] - VALUE[b.piece]);
  const m = caps[0];
  c.move(m);
  const gain = VALUE[target.type] + (m.promotion ? VALUE.q - 1 : 0) - see(c, square, depth + 1);
  c.undo();
  return Math.max(0, gain);
}

// Pieces of `color` that the side to move in `c` can win material against (SEE > 0).
export function hangingPieces(c, color, minValue = 1) {
  const out = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== color || p.type === 'k' || VALUE[p.type] < minValue) continue;
    const g = see(c, p.square);
    if (g > 0) out.push({ square: p.square, type: p.type, gain: g });
  }
  return out.sort((a, b) => b.gain - a.gain);
}

export function material(c) {
  const m = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of c.board()) for (const p of row) if (p && p.type !== 'k') m[p.color][p.type]++;
  return m;
}
export const matValue = (side) => side.p + 3 * side.n + 3 * side.b + 5 * side.r + 9 * side.q;

export function legalCount(fen) {
  try { return new Chess(fen).moves().length; } catch { return 0; }
}
