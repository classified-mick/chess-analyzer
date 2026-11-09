// Builds src/lib/openings.json from the lichess-org/chess-openings TSV files (CC0).
// Value 0 = book position without its own name.
// Key: position part of the FEN (pieces, side, castling, ep) -> [eco, name].
import { Chess } from 'chess.js';
import { writeFileSync } from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';
const out = {};
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const res = await fetch(BASE + f + '.tsv');
  if (!res.ok) throw new Error(`${f}.tsv: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split('\t');
    const ref = new Chess();
    try { ref.loadPgn(pgn); } catch { continue; }
    // Every prefix of a named line is a book position; only the full line carries the name.
    const c = new Chess();
    for (const san of ref.history()) {
      c.move(san);
      const key = c.fen().split(' ').slice(0, 4).join(' ');
      if (!(key in out)) out[key] = 0;
    }
    out[c.fen().split(' ').slice(0, 4).join(' ')] = [eco, name];
  }
}
writeFileSync(new URL('../src/lib/openings.json', import.meta.url), JSON.stringify(out));
console.log('positions:', Object.keys(out).length);
