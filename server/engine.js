// Thin UCI wrapper around a native Stockfish process.
// Every engine runs one job at a time: jobs are chained through `this.queue`.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Engine {
  constructor({ path, threads, hash, name }) {
    this.name = name;
    this.proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.failed = new Promise((_, reject) => this.proc.on('error', reject));
    this.failed.catch(() => {});
    this.listeners = new Set();
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      for (const fn of [...this.listeners]) fn(line);
    });
    this.queue = Promise.resolve();
    this.ready = Promise.race([this.#init(threads, hash), this.failed]);
  }

  send(cmd) { this.proc.stdin.write(cmd + '\n'); }

  #waitFor(prefix) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith(prefix)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
    });
  }

  async #init(threads, hash) {
    const id = this.#waitFor('id name');
    const ok = this.#waitFor('uciok');
    this.send('uci');
    const idLine = await id;
    await ok;
    this.send(`setoption name Threads value ${threads}`);
    this.send(`setoption name Hash value ${hash}`);
    await this.isReady();
    return idLine;
  }

  async isReady() {
    const p = this.#waitFor('readyok');
    this.send('isready');
    await p;
  }

  // Run fn exclusively on this engine.
  exclusive(fn) {
    const run = this.queue.then(() => this.ready).then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Search one position. Calls onInfo(lines) as lines improve; resolves with the final lines.
  // limit: { depth?, movetime? } (whichever comes first) | { infinite: true } (stop with this.stop()).
  search(fen, { multipv = 1, limit, onInfo }) {
    return this.exclusive(async () => {
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.isReady();
      const lines = new Map();
      const collector = (line) => {
        if (!line.startsWith('info ') || !line.includes(' pv ')) return;
        const info = parseInfo(line);
        if (!info || info.bound) return; // skip lowerbound/upperbound noise
        lines.set(info.multipv, info);
        if (onInfo) onInfo(snapshot(lines));
      };
      this.listeners.add(collector);
      const done = this.#waitFor('bestmove');
      this.send(`position fen ${fen}`);
      if (limit.infinite) this.send('go infinite');
      else {
        const parts = ['go'];
        if (limit.depth) parts.push('depth', limit.depth);
        if (limit.movetime) parts.push('movetime', limit.movetime);
        this.send(parts.join(' '));
      }
      this.current = done;
      await done;
      this.current = null;
      this.listeners.delete(collector);
      return snapshot(lines);
    });
  }

  stop() { if (this.current) this.send('stop'); }

  // Change the thread count between searches.
  setThreads(n) {
    return this.exclusive(async () => {
      this.send(`setoption name Threads value ${n}`);
      await this.isReady();
    });
  }

  quit() { this.send('quit'); }
}

function snapshot(lines) {
  return [...lines.values()].sort((a, b) => a.multipv - b.multipv).map((l) => ({ ...l }));
}

// "info depth 20 seldepth 28 multipv 1 score cp 31 nodes ... pv e2e4 e7e5" -> object.
// Score is from the side to move's point of view, as UCI defines it.
export function parseInfo(line) {
  const t = line.split(' ');
  const out = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = +t[++i]; break;
      case 'seldepth': out.seldepth = +t[++i]; break;
      case 'multipv': out.multipv = +t[++i]; break;
      case 'nodes': out.nodes = +t[++i]; break;
      case 'nps': out.nps = +t[++i]; break;
      case 'score': {
        const kind = t[++i]; const v = +t[++i];
        out.score = kind === 'mate' ? { mate: v } : { cp: v };
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') { out.bound = true; i++; }
        break;
      }
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
    }
  }
  return out.score && out.pv && out.depth ? out : null;
}
