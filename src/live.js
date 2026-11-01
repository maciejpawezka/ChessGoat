import { useState, useEffect, useRef } from 'preact-htm';
import { Chess } from 'chess.js';
import { getEngine } from './engine.js';
import { winPct, formatEval } from './analysis.js';

/** Continuous Stockfish evaluation of `fen` on the shared 'live' engine (throttled UI updates). */
export function useLiveEval(fen, enabled, { depth = 18, multipv = 3 } = {}) {
  const [state, setState] = useState(null);
  const latest = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    setState(null);
    if (!enabled || !fen) return undefined;
    const chess = new Chess(fen);
    if (chess.isGameOver()) {
      const score = chess.isCheckmate() ? { cp: null, mate: 0 } : { cp: 0, mate: null };
      setState(describe({ fen, turn: chess.turn(), lines: [{ ...score, pv: [], depth: 0 }] }));
      return undefined;
    }
    const engine = getEngine('live');
    engine.cancel('live');
    let alive = true;
    engine.search(fen, {
      depth,
      multipv,
      tag: 'live',
      onInfo: (lines, turn) => {
        latest.current = { fen, lines, turn };
        if (!timer.current) {
          timer.current = setTimeout(() => {
            timer.current = null;
            if (alive && latest.current?.fen === fen) setState(describe(latest.current));
          }, 150);
        }
      },
    }).then(() => {
      if (alive && latest.current?.fen === fen) setState(describe(latest.current));
    });
    return () => {
      alive = false;
      engine.cancel('live');
    };
  }, [fen, enabled]);

  return state;
}

function describe({ fen, lines, turn }) {
  const top = lines[0];
  if (!top) return null;
  const w = winPct(top);
  return {
    fen,
    turn,
    lines,
    depth: top.depth,
    whiteWin: turn === 'w' ? w : 100 - w,
    label: formatEval(top, turn),
    best: top.pv[0] || null,
  };
}
