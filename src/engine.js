const WORKER_URL = new URL('../vendor/stockfish/stockfish.js', import.meta.url);

function parseInfo(line) {
  const t = line.split(' ');
  const si = t.indexOf('score');
  const pi = t.indexOf('pv');
  if (si < 0 || pi < 0 || t.includes('lowerbound') || t.includes('upperbound')) return null;
  const at = (k) => {
    const i = t.indexOf(k);
    return i >= 0 ? t[i + 1] : null;
  };
  const value = parseInt(t[si + 2], 10);
  return {
    depth: Number(at('depth')),
    multipv: Number(at('multipv') || 1),
    cp: t[si + 1] === 'cp' ? value : null,
    mate: t[si + 1] === 'mate' ? value : null,
    pv: t.slice(pi + 1),
  };
}

/**
 * Thin UCI wrapper around the Stockfish WASM worker. Searches are serialized;
 * a search tagged e.g. 'live' can be cancelled when a newer one supersedes it.
 */
export class Engine {
  constructor({ hash = 32 } = {}) {
    this.hash = hash;
    this.worker = new Worker(WORKER_URL);
    this.handlers = new Set();
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      for (const h of [...this.handlers]) h(line);
    };
    this.chain = Promise.resolve();
    this.current = null;
    this.ready = this.init();
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(prefix) {
    return new Promise((resolve) => {
      const h = (line) => {
        if (line.startsWith(prefix)) {
          this.handlers.delete(h);
          resolve(line);
        }
      };
      this.handlers.add(h);
    });
  }

  async init() {
    const ok = this.waitFor('uciok');
    this.send('uci');
    await ok;
    this.send(`setoption name Hash value ${this.hash}`);
    await this.isReady();
  }

  async isReady() {
    const ok = this.waitFor('readyok');
    this.send('isready');
    await ok;
  }

  enqueue(job) {
    const run = this.chain.then(() => this.ready).then(job);
    this.chain = run.catch(() => {});
    return run;
  }

  newGame() {
    return this.enqueue(async () => {
      this.send('ucinewgame');
      await this.isReady();
    });
  }

  /** Cancels running and queued searches with the given tag (they resolve with whatever they found). */
  cancel(tag) {
    this.cancelledTag = { tag, at: performance.now() };
    if (this.current && this.current.tag === tag) this.send('stop');
  }

  search(fen, { depth, movetime, multipv = 1, options = {}, onInfo, tag = null } = {}) {
    const queuedAt = performance.now();
    return this.enqueue(async () => {
      const turn = fen.split(' ')[1];
      if (tag && this.cancelledTag?.tag === tag && this.cancelledTag.at > queuedAt) {
        return { bestmove: null, lines: [], turn, cancelled: true };
      }
      for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.isReady();

      const lines = [];
      const best = await new Promise((resolve) => {
        const h = (line) => {
          if (line.startsWith('info')) {
            const info = parseInfo(line);
            if (info) {
              lines[info.multipv - 1] = info;
              onInfo?.(lines.filter(Boolean), turn);
            }
          } else if (line.startsWith('bestmove')) {
            this.handlers.delete(h);
            resolve(line.split(' ')[1]);
          }
        };
        this.handlers.add(h);
        this.current = { tag };
        this.send(`position fen ${fen}`);
        this.send(depth ? `go depth ${depth}` : `go movetime ${movetime || 1000}`);
      });
      this.current = null;
      return { bestmove: best && best !== '(none)' ? best : null, lines: lines.filter(Boolean), turn };
    });
  }
}

const engines = {};

/** 'analysis' = background game review, 'live' = interactive eval/puzzles/coach, 'bot' = opponent. */
export function getEngine(name, opts) {
  if (!engines[name]) engines[name] = new Engine(opts);
  return engines[name];
}
