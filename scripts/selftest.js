// Runs a quick review of the sample game in the terminal and prints classes + explanations.
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { Engine } from '../server/engine.js';
import { reviewGame, gameAccuracy, CLASSES } from '../src/lib/review.js';
import { explainMove } from '../src/lib/explain.js';

const limit = { depth: +(process.argv[2] || 16), movetime: 700 };
const g = new Chess();
g.loadPgn(readFileSync(new URL('../src/sample.pgn', import.meta.url), 'utf8'));
const hist = g.history({ verbose: true });
const fens = [hist[0].before, ...hist.map((m) => m.after)];
const e = new Engine({ path: process.env.STOCKFISH_PATH || 'stockfish', threads: 8, hash: 256, name: 't' });
const analyses = [];
for (const fen of fens) {
  const c = new Chess(fen);
  if (c.isCheckmate()) { analyses.push({ lines: [{ multipv: 1, depth: 0, score: { mate: 0 }, pv: [] }] }); continue; }
  analyses.push({ lines: await e.search(fen, { multipv: 2, limit }) });
}
e.quit();
const moves = reviewGame(fens[0], hist.map((m) => m.lan), analyses);
for (const r of moves) {
  const x = explainMove(r);
  console.log(`${CLASSES[r.cls].icon.padEnd(3)} ${x.title}  [${x.eval}]`);
  for (const p of x.paras) console.log('     ' + p);
  if (x.better) console.log('     → ' + x.better.text);
}
console.log('accuracy', gameAccuracy(moves));
