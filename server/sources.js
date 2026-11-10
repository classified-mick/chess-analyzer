// Game import: chess.com and lichess links, and a chess.com player's recent games.
import { Chess } from 'chess.js';

const UA = { 'User-Agent': 'chess-review-local/1.0' };

// chess.com "TCN" move encoding: two chars per move (from, to); promotions encode piece + direction.
const TCN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
function sq(i) { return 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1); }
export function decodeTcn(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 2) {
    const f = TCN.indexOf(s[i]);
    let t = TCN.indexOf(s[i + 1]);
    let promo = '';
    if (t > 63) {
      promo = 'qnrbkp'[Math.floor((t - 64) / 3)];
      t = f + (f < 16 ? -8 : 8) + ((t - 1) % 3) - 1;
    }
    out.push({ from: sq(f), to: sq(t), promotion: promo || undefined });
  }
  return out;
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
}

// Each game type has its own endpoint. The same number can exist under several types
// (a computer game id may also be someone else's live game), so the type must match the link.
const CHESSCOM_API = {
  live: (id) => `https://www.chess.com/callback/live/game/${id}`,
  daily: (id) => `https://www.chess.com/callback/daily/game/${id}`,
  computer: (id) => `https://www.chess.com/computer/callback/game/${id}`,
};

async function fromChessCom(kind, id) {
  const d = await getJson(CHESSCOM_API[kind](id));
  const g = d.game;
  const h = g.pgnHeaders || {};
  const c = new Chess(h.FEN || undefined);
  for (const m of decodeTcn(g.moveList || '')) c.move(m);
  for (const k of ['Event', 'Site', 'Date', 'White', 'Black', 'Result', 'ECO', 'WhiteElo', 'BlackElo', 'TimeControl', 'Termination']) {
    if (h[k] != null) c.setHeader(k, String(h[k]));
  }
  c.setHeader('Link', `https://www.chess.com/game/${kind}/${id}`);
  return c.pgn();
}

async function fromLichess(id) {
  const r = await fetch(`https://lichess.org/game/export/${id.slice(0, 8)}?clocks=false&evals=false`, { headers: UA });
  if (!r.ok) throw new Error(`lichess: HTTP ${r.status}`);
  return r.text();
}

// Accepts a URL (chess.com / lichess) and returns a PGN string.
export async function importUrl(url) {
  let m = url.match(/chess\.com\/(?:analysis\/)?game\/(live|daily|computer)\/(\d+)/) || url.match(/chess\.com\/(live|daily|computer)\/game\/(\d+)/);
  if (m) return fromChessCom(m[1], m[2]);
  m = url.match(/chess\.com\/game\/(\d+)/);
  if (m) return fromChessCom('live', m[1]);
  m = url.match(/lichess\.org\/([A-Za-z0-9]{8,12})/);
  if (m) return fromLichess(m[1]);
  throw new Error('Не понял ссылку. Нужна ссылка на партию chess.com (обычную, по переписке или с ботом) или lichess.');
}

// Latest games of a chess.com player (newest first).
export async function chessComGames(user) {
  const u = encodeURIComponent(user.trim().toLowerCase());
  const { archives } = await getJson(`https://api.chess.com/pub/player/${u}/games/archives`);
  const games = [];
  for (const a of (archives || []).slice(-2).reverse()) {
    const { games: gs } = await getJson(a);
    games.push(...gs.reverse());
    if (games.length >= 30) break;
  }
  return games.filter((g) => g.rules === 'chess' && g.pgn).slice(0, 30).map((g) => ({
    url: g.url,
    pgn: g.pgn,
    white: g.white.username, whiteRating: g.white.rating, whiteResult: g.white.result,
    black: g.black.username, blackRating: g.black.rating, blackResult: g.black.result,
    timeClass: g.time_class, endTime: g.end_time,
  }));
}
