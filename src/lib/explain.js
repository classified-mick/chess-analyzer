// Turns engine output into short Russian explanations: what a move does, why it is good or bad,
// and the idea behind the engine's best move. Pure chess.js, no network.
import { Chess } from 'chess.js';
import {
  VALUE, NOM, ACC, winPct, toWhite, fmtScore, uciToMove, pvToSan, numberedLine, moveLabel,
  see, hangingPieces, material, matValue,
} from './chessutil.js';
import { CLASSES } from './review.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const join = (arr) => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' и ' + arr[arr.length - 1];
const pieceAt = (p) => `${ACC[p.type]} ${p.square}`;

function flipped(fen) {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  try { return new Chess(p.join(' '), { skipValidation: true }); } catch { return null; }
}

// Enemy pieces a piece on `sq` attacks (by pseudo attack map), as board pieces.
function attackedBy(c, sq, color) {
  const enemy = color === 'w' ? 'b' : 'w';
  const out = [];
  for (const row of c.board()) for (const p of row) {
    if (p && p.color === enemy && c.attackers(p.square, color).includes(sq)) out.push(p);
  }
  return out;
}

// Mate-in-one moves for the side to move in c.
function mateInOne(c) {
  if (!c) return [];
  let moves;
  try { moves = c.moves({ verbose: true }); } catch { return []; }
  const out = [];
  for (const m of moves) {
    c.move(m);
    if (c.isCheckmate()) out.push(m.san);
    c.undo();
  }
  return out;
}

// Describe the material balance change along a line, from `color`'s point of view.
function materialSwing(fen, pv, color, maxPlies = 10) {
  const c = new Chess(fen);
  const start = material(c);
  let n = 0;
  for (const u of pv) {
    if (n >= maxPlies) {
      // finish an exchange that is still running
      const nxt = c.moves({ verbose: true }).find((m) => m.lan === u || m.from + m.to + (m.promotion || '') === u);
      if (!nxt || !nxt.captured || n >= maxPlies + 2) break;
    }
    try { c.move(uciToMove(u)); } catch { break; }
    n++;
  }
  const end = material(c);
  const opp = color === 'w' ? 'b' : 'w';
  const theyLost = {}, weLost = {};
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    theyLost[t] = start[opp][t] - end[opp][t];
    weLost[t] = start[color][t] - end[color][t];
  }
  const net = (matValue(start[opp]) - matValue(end[opp])) - (matValue(start[color]) - matValue(end[color]));
  return { net, theyLost, weLost };
}

function materialWords(diff) {
  const parts = [];
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    const k = diff[t];
    if (k <= 0) continue;
    if (t === 'p') parts.push(k === 1 ? 'пешку' : k < 5 ? `${k} пешки` : `${k} пешек`);
    else parts.push(k === 1 ? ACC[t] : `${k} × ${NOM[t]}`);
  }
  return join(parts);
}

const pawnsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'пешка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'пешки' : 'пешек');

function swingText(sw) {
  if (sw.net >= 1) {
    const exchange = sw.net === 2 && sw.theyLost.r >= 1 && (sw.weLost.n + sw.weLost.b) >= 1;
    if (exchange) return 'выигрывает качество';
    const allTheirs = Object.values(sw.weLost).every((v) => v <= 0);
    if (allTheirs) return `выигрывает ${materialWords(sw.theyLost)}`;
    const mine = materialWords(sw.weLost), theirs = materialWords(sw.theyLost);
    if (mine && theirs) return `забирает ${theirs}, отдав ${mine}`;
    return `выигрывает материал (+${sw.net} ${pawnsWord(sw.net)})`;
  }
  if (sw.net <= -1) {
    const exchange = sw.net === -2 && sw.weLost.r >= 1 && (sw.theyLost.n + sw.theyLost.b) >= 1;
    if (exchange) return 'теряет качество';
    const allOurs = Object.values(sw.theyLost).every((v) => v <= 0);
    if (allOurs) return `теряет ${materialWords(sw.weLost)}`;
    const mine = materialWords(sw.weLost), theirs = materialWords(sw.theyLost);
    if (mine && theirs) return `отдаёт ${mine} за ${theirs}`;
    return `теряет материал (−${-sw.net} ${pawnsWord(-sw.net)})`;
  }
  return null;
}

// What a single move does on the board. Returns phrases, most important first.
export function moveFeatures(fen, uci) {
  const c = new Chess(fen);
  const before = new Chess(fen);
  let mv;
  try { mv = c.move(uciToMove(uci)); } catch { return []; }
  const me = mv.color, opp = me === 'w' ? 'b' : 'w';
  const ply = +fen.split(' ')[5];
  const f = [];

  if (c.isCheckmate()) return ['ставит мат'];
  if (mv.flags.includes('k') || mv.flags.includes('q')) f.push('рокировка: король уходит в безопасное место, ладья включается в игру');
  if (mv.captured) {
    const lost = see(c, mv.to);
    const gain = VALUE[mv.captured] - lost;
    if (mv.flags.includes('e')) f.push('берёт пешку на проходе');
    else if (gain > 0 && lost === 0) f.push(`забирает ${ACC[mv.captured]} на ${mv.to}`);
    else if (gain > 0) f.push(`бьёт ${ACC[mv.captured]} на ${mv.to} с выгодой в размене`);
    else if (gain === 0) f.push(`берёт ${ACC[mv.captured]} на ${mv.to} в размен`);
    else f.push(`берёт ${ACC[mv.captured]} на ${mv.to}, но фигуру отыгрывают`);
  }
  if (mv.promotion) f.push(`проводит пешку в ${NOM[mv.promotion] === 'ферзь' ? 'ферзи' : NOM[mv.promotion]}`);

  // Attacks by the moved piece: fork or a single real threat.
  const targets = attackedBy(c, mv.to, me).filter((p) => {
    if (p.type === 'k') return true;
    const tmp = flipped(c.fen());
    return tmp && (VALUE[p.type] > VALUE[mv.promotion || mv.piece] || see(tmp, p.square) > 0);
  });
  const check = c.inCheck();
  const tag = (p) => (p.type === 'k' ? 'короля' : pieceAt(p) + (!check && isTrapped(c, p.square) ? ' (ему некуда уйти)' : ''));
  const big = targets.filter((p) => p.type === 'k' || VALUE[p.type] >= 3).sort((a, b) => VALUE[b.type] - VALUE[a.type]);
  if (big.length >= 2) {
    f.push(`вилка: ${NOM[mv.promotion || mv.piece]} нападает сразу на ${join(big.map(tag))}`);
  } else if (check) {
    f.push('шах');
  } else if (targets.length) {
    const t = big[0] || targets[0];
    f.push(`нападает на ${tag(t)}`);
  }

  // Discovered attacks: another of our pieces now hits something it did not before.
  if (!f.some((s) => s.startsWith('вилка'))) {
    const tmpAfter = flipped(c.fen());
    const tmpBefore = flipped(before.fen());
    if (tmpAfter && tmpBefore) {
      const newHang = hangingPieces(tmpAfter, opp, 3).filter((h) => !hangingPieces(tmpBefore, opp, 3).some((x) => x.square === h.square) && !c.attackers(h.square, me).every((s) => s === mv.to));
      if (newHang.length && !targets.some((t) => t.square === newHang[0].square)) {
        f.push(`открывает удар по ${{ p: 'пешке', n: 'коню', b: 'слону', r: 'ладье', q: 'ферзю' }[newHang[0].type]} ${newHang[0].square}`);
      }
    }
  }

  // Pin: a line piece now holds an enemy piece in front of the king or queen.
  if ('brq'.includes(mv.piece) && !mv.promotion) {
    const pin = findPin(c, mv.to, me);
    if (pin) f.push(`связывает ${pieceAt(pin.pinned)}${pin.behind.type === 'k' ? ' (за ним король)' : ` (за ним ${NOM[pin.behind.type]})`}`);
  }

  // Mate threat (if it were our move again).
  if (!check) {
    const mates = mateInOne(flipped(c.fen()));
    if (mates.length) f.push(`угрожает матом ${mates[0]}`);
  }

  // Defence: pieces the opponent could win before the move but not after.
  // Skipped when escaping check: the "threats" of a checking side are not meaningful there.
  const wasInCheck = before.inCheck();
  if (wasInCheck) f.push('уходит от шаха');
  const oppBefore = wasInCheck ? null : flipped(fen);
  if (oppBefore) {
    const was = hangingPieces(oppBefore, me, 1);
    const now = hangingPieces(c, me, 1);
    const freshTo = now.some((x) => x.square === mv.to);
    for (const h of was) {
      if (now.some((x) => x.square === h.square)) continue;
      if (h.square === mv.from) { if (!freshTo) f.push(`уводит ${ACC[h.type]} из-под удара`); break; }
      if (c.get(h.square)?.color === me) { f.push(`защищает ${ACC[h.type]} ${h.square}`); break; }
    }
    // Newly hanging pieces.
    const fresh = now.filter((x) => (!was.some((h) => h.square === x.square) || x.square === mv.to)
      && !(x.square === mv.to && mv.captured && VALUE[mv.captured] >= x.gain));
    if (fresh.length && !c.isCheck()) {
      const h = fresh[0];
      f.push(`оставляет ${ACC[h.type]} на ${h.square} под боем`);
    }
  }

  // Knight to a central outpost.
  if (mv.piece === 'n' && ['d4', 'e4', 'd5', 'e5'].includes(mv.to) && !mv.captured) f.push('ставит коня в центр');

  // Opening ideas.
  if (ply <= 12 && !mv.captured) {
    const homeRank = me === 'w' ? '1' : '8';
    if ((mv.piece === 'n' || mv.piece === 'b') && mv.from[1] === homeRank) f.push(`развивает ${ACC[mv.piece]}`);
    if (mv.piece === 'p' && 'de'.includes(mv.to[0]) && ['4', '5'].includes(mv.to[1])) f.push('занимает центр');
    if (mv.piece === 'k' && !mv.flags.includes('k') && !mv.flags.includes('q')) f.push('король лишается рокировки');
    if (mv.piece === 'q' && ply <= 6) f.push('рано выводит ферзя, его могут гонять');
  }
  return f;
}

// A piece of the side to move that is attacked with gain and has no safe square to go to.
function isTrapped(c, sq) {
  const p = c.get(sq);
  if (!p || p.type === 'k' || p.type === 'p' || p.color !== c.turn()) return false;
  const opp = flipped(c.fen());
  if (!opp || see(opp, sq) <= 0) return false;
  let moves;
  try { moves = c.moves({ square: sq, verbose: true }); } catch { return false; }
  for (const m of moves) {
    c.move(m);
    const lost = see(c, m.to) - (m.captured ? VALUE[m.captured] : 0);
    c.undo();
    if (lost <= 0) return false;
  }
  return true;
}

function findPin(c, sq, me) {
  const p = c.get(sq);
  const dirs = [];
  if ('rq'.includes(p.type)) dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
  if ('bq'.includes(p.type)) dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  const f0 = sq.charCodeAt(0) - 97, r0 = +sq[1] - 1;
  for (const [df, dr] of dirs) {
    let first = null;
    for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
      const s = String.fromCharCode(97 + f) + (r + 1);
      const q = c.get(s);
      if (!q) continue;
      if (q.color === me) break;
      if (!first) { first = { ...q, square: s }; continue; }
      if (VALUE[q.type] > VALUE[first.type] && VALUE[q.type] > VALUE[p.type] && first.type !== 'k' && first.type !== 'p') return { pinned: first, behind: q };
      break;
    }
  }
  return null;
}

// Plain-language summary of where an engine line leads, for `color`.
function lineOutcome(fen, line, color) {
  if (!line) return null;
  const sideToMove = fen.split(' ')[1];
  const s = line.score;
  if (s.mate !== undefined) {
    const winning = (s.mate > 0) === (sideToMove === color);
    const n = Math.abs(s.mate);
    if (winning) return n <= 1 ? 'ставит мат' : `ведёт к мату в ${n} ход${n < 5 ? 'а' : 'ов'}`;
    return `соперник ставит мат в ${n} ход${n < 5 ? 'а' : 'ов'}`;
  }
  // Only talk about material when the engine agrees the side really comes out ahead (or behind).
  const sw = materialSwing(fen, line.pv, color);
  const cpForColor = sideToMove === color ? s.cp : -s.cp;
  if (sw.net >= 1 && cpForColor >= Math.min(250, 70 * sw.net)) return swingText(sw);
  if (sw.net <= -1 && cpForColor <= -Math.min(250, 70 * -sw.net)) return swingText(sw);
  return null;
}

function evalWord(w) {
  if (w >= 97) return 'выигранная позиция';
  if (w >= 80) return 'большой перевес';
  if (w >= 62) return 'перевес';
  if (w > 38) return 'примерно равная игра';
  if (w > 20) return 'позиция хуже';
  if (w > 3) return 'тяжёлая позиция';
  return 'проигранная позиция';
}

// Full explanation for a classified move (see review.classifyMove).
export function explainMove(r) {
  const meta = CLASSES[r.cls];
  const out = { title: `${moveLabel(r.fenBefore, r.san)} — ${meta.ru.toLowerCase()}`, cls: r.cls, paras: [] };
  const evBefore = fmtScore(toWhite(r.before.lines[0]?.score, r.fenBefore));
  const evAfter = fmtScore(toWhite(r.after.lines[0]?.score, r.fenAfter));
  out.eval = evAfter;
  const feats = moveFeatures(r.fenBefore, r.uci);
  const bestSan = r.bestUci ? pvToSan(r.fenBefore, [r.bestUci])[0] : null;
  const bestLine = r.before.lines[0];
  // The played move's own line: from the multipv search, or rebuilt from the reply analysis.
  const reply = r.after.lines[0];
  const ownLine = r.before.lines.find((l) => l.pv[0] === r.uci)
    || (reply ? { pv: [r.uci, ...reply.pv], score: reply.score.mate !== undefined ? { mate: -reply.score.mate } : { cp: -reply.score.cp } } : null);
  const bestFeats = r.bestUci ? moveFeatures(r.fenBefore, r.bestUci).map((t) => t.replace(/^оставляет (.+) под боем$/, 'жертвует $1')) : [];
  const me = r.color;

  const GOOD = ['best', 'excellent', 'great', 'brilliant', 'book', 'forced'];
  const asSac = (arr) => arr.map((t) => t.replace(/^оставляет (.+) под боем$/, 'жертвует $1'));
  const shown = GOOD.includes(r.cls) ? asSac(feats) : feats;
  const what = shown.length ? cap(join(shown.slice(0, 3))) + '.' : '';

  switch (r.cls) {
    case 'book':
      out.paras.push(`Теоретический ход${r.opening ? `: ${r.opening[1]} (${r.opening[0]})` : ''}. ${what}`.trim());
      break;
    case 'forced':
      out.paras.push('Единственный возможный ход.');
      break;
    case 'brilliant':
      out.paras.push(`Жертва${r.sacrifice >= 5 ? ' крупного' : ''} материала, и она работает. ${what}`);
      pushIdea(out, r.fenBefore, ownLine, me, 'Идея');
      break;
    case 'great':
      out.paras.push(`Единственный сильный ход: остальные заметно хуже. ${what}`);
      pushIdea(out, r.fenBefore, ownLine, me, 'Идея');
      break;
    case 'best':
    case 'excellent':
    case 'good':
      out.paras.push(`${r.cls === 'best' ? 'Ход движка.' : r.cls === 'excellent' ? 'Почти так же хорошо, как лучший ход.' : 'Нормальный ход, но есть точнее.'} ${what}`.trim());
      if (r.cls === 'best') pushIdea(out, r.fenBefore, ownLine, me, 'Идея');
      break;
    default: { // inaccuracy, mistake, miss, blunder
      const ref = r.after.lines[0];
      const refSan = ref?.pv?.length ? pvToSan(r.fenAfter, ref.pv, 1)[0] : null;
      const why = [];
      if (what) why.push(what);
      if (refSan) {
        const refFeats = moveFeatures(r.fenAfter, ref.pv[0]);
        const outcome = lineOutcome(r.fenAfter, ref, me === 'w' ? 'b' : 'w');
        let s = `Соперник отвечает ${refSan}`;
        if (refFeats[0] === 'ставит мат') s = `Соперник сразу ставит мат: ${refSan}`;
        else {
          if (refFeats.length) s += `: ${join(refFeats.slice(0, 2))}`;
          if (outcome) s += `${refFeats.length ? ', и в итоге' : ' и'} ${outcome}`;
        }
        why.push(s + '.');
      }
      if (r.cls === 'miss') why.unshift('Соперник только что ошибся, а этот ход упускает шанс.');
      // The move looks good (fork, capture, check) but the engine disagrees: say so plainly.
      if (/^(вилка|забирает|бьёт|шах|нападает)/.test(feats[0] || '')) {
        why.push(outcomeIsGain(r.fenAfter, ref, me)
          ? 'Материал этот ход выигрывает, но позиция после него становится хуже, чем после лучшего хода.'
          : 'Ход выглядит сильным, но выгоды не даёт: соперник спокойно защищается, а был ход сильнее.');
      }
      if (ref?.pv?.length > 1) out.refLine = numberedLine(r.fenAfter, pvToSan(r.fenAfter, ref.pv, 7));
      why.push(`Оценка: ${evBefore} → ${evAfter} (${evalWord(r.wAfter)} для ${me === 'w' ? 'белых' : 'чёрных'}).`);
      out.paras.push(why.join(' '));
    }
  }

  // The better move and its idea, when the player did not find it.
  if (bestSan && !['best', 'book', 'forced', 'brilliant', 'great'].includes(r.cls)) {
    let s = `Лучше было ${bestSan}`;
    if (bestFeats.length) s += `: ${join(bestFeats.slice(0, 3))}`;
    const outcome = lineOutcome(r.fenBefore, bestLine, me);
    if (outcome && /^(выигрывает|забирает|ставит|ведёт)/.test(outcome)) s += `. В главной линии ${outcome}`;
    s += `. Оценка была бы ${fmtScore(toWhite(bestLine.score, r.fenBefore))}.`;
    out.better = { san: bestSan, uci: r.bestUci, text: s };
  }
  if (bestLine?.pv?.length) out.bestLine = numberedLine(r.fenBefore, pvToSan(r.fenBefore, bestLine.pv, 8));
  return out;
}

// Does the opponent's best line still leave `me` with a material gain?
function outcomeIsGain(fenAfter, ref, me) {
  if (!ref) return false;
  const sw = materialSwing(fenAfter, ref.pv, me);
  return sw.net >= 1;
}

function pushIdea(out, fen, line, me, label) {
  if (!line?.pv || line.pv.length < 2) return;
  const outcome = lineOutcome(fen, line, me);
  const sans = pvToSan(fen, line.pv, 5);
  const w = winPct(line.score);
  const tail = outcome && /^(выигрывает|забирает|ставит|ведёт)/.test(outcome) ? outcome : evalWord(w);
  out.paras.push(`${label}: ${numberedLine(fen, sans)} — ${tail}.`);
}

// Explanation of the engine's best move in any position (used for the live "best move" card).
export function explainBest(fen, line) {
  if (!line?.pv?.length) return null;
  const me = fen.split(' ')[1];
  const san = pvToSan(fen, line.pv, 1)[0];
  const feats = moveFeatures(fen, line.pv[0]).map((t) => t.replace(/^оставляет (.+) под боем$/, 'жертвует $1'));
  const outcome = lineOutcome(fen, line, me);
  const w = winPct(line.score);
  let text = feats.length ? cap(join(feats.slice(0, 3))) + '.' : 'Тихий позиционный ход.';
  text += outcome && /^(выигрывает|забирает|ставит|ведёт)/.test(outcome) ? ` Дальше ${outcome}.` : ` ${cap(evalWord(w))} для ${me === 'w' ? 'белых' : 'чёрных'}.`;
  return { san, uci: line.pv[0], text, line: numberedLine(fen, pvToSan(fen, line.pv, 8)) };
}

// What the opponent threatens right now (null-move idea, static).
// Returns [{ text, from, to }].
export function threats(fen) {
  const c = flipped(fen);
  if (!c || new Chess(fen).inCheck()) return [];
  const out = [];
  let moves = [];
  try { moves = c.moves({ verbose: true }); } catch { return []; }
  for (const m of moves) {
    c.move(m);
    const mate = c.isCheckmate();
    c.undo();
    if (mate) { out.push({ text: `мат ходом ${m.san}`, from: m.from, to: m.to }); break; }
  }
  const me = fen.split(' ')[1];
  for (const h of hangingPieces(c, me, 1).slice(0, 2)) {
    const cap = moves.filter((m) => m.to === h.square).sort((a, b) => VALUE[a.piece] - VALUE[b.piece])[0];
    if (cap) out.push({ text: `взять ${ACC[h.type]} ${h.square} (${cap.san})`, from: cap.from, to: cap.to });
  }
  return out;
}
