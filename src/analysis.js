import { Chess } from 'chess.js';

export const ANALYSIS_VERSION = 4;

export const CLASSES = {
  brilliant: { label: 'Genialny', symbol: '!!', color: '#1baca6' },
  great: { label: 'Świetny', symbol: '!', color: '#5c8bb0' },
  best: { label: 'Najlepszy', symbol: '★', color: '#81b64c' },
  excellent: { label: 'Doskonały', symbol: '✓', color: '#96bc4b' },
  good: { label: 'Dobry', symbol: '✓', color: '#96af8b' },
  forced: { label: 'Wymuszony', symbol: '□', color: '#96af8b' },
  inaccuracy: { label: 'Niedokładność', symbol: '?!', color: '#f7c631' },
  mistake: { label: 'Błąd', symbol: '?', color: '#e58f2a' },
  miss: { label: 'Przeoczenie', symbol: '✗', color: '#ff7769' },
  blunder: { label: 'Blunder', symbol: '??', color: '#ca3431' },
};

export const SUMMARY_CLASSES = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const BAD = new Set(['mistake', 'blunder', 'miss']);
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Winning chances (0-100) for the side the score belongs to (Lichess model).
 * `scale` < 1 flattens the curve: the same engine advantage converts less reliably at lower ratings.
 */
export function winPct({ cp, mate }, scale = 1) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * scale * cp)) - 1);
}

/** Curve scale for classifying moves: 0.6 for beginners, the plain Lichess curve from ~2300. */
export function ratingScale(rating) {
  if (!rating) return 1;
  return clamp(0.6 + (0.4 * (rating - 400)) / 1900, 0.6, 1);
}

/** Per-move accuracy from win% before/after, both from the mover's perspective (Lichess formula). */
export function moveAccuracy(winBefore, winAfter) {
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (winBefore - winAfter)) - 3.166924740191411;
  return clamp(raw + 1, 0, 100);
}

function stdDev(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

/**
 * Game accuracy per colour: average of a volatility-weighted mean and the harmonic mean
 * of move accuracies, so one blunder in a sharp position weighs more than in a dead one.
 */
export function gameAccuracy(whiteWins, moves) {
  const n = moves.length;
  const result = { white: null, black: null };
  if (!n) return result;
  const size = clamp(Math.floor(n / 10), 2, 8);
  const windows = [];
  for (let i = 0; i < size - 2; i++) windows.push(whiteWins.slice(0, size));
  for (let i = 0; i + size <= whiteWins.length; i++) windows.push(whiteWins.slice(i, i + size));
  const weights = windows.map((w) => clamp(stdDev(w), 0.5, 12));

  for (const color of ['w', 'b']) {
    let wSum = 0, wAcc = 0, invSum = 0, count = 0;
    moves.forEach((m, i) => {
      if (m.color !== color) return;
      const w = weights[i] ?? 1;
      wSum += w;
      wAcc += m.acc * w;
      invSum += 1 / Math.max(m.acc, 0.5);
      count++;
    });
    if (count) result[color === 'w' ? 'white' : 'black'] = (wAcc / wSum + count / invSum) / 2;
  }
  return result;
}

/** A piece left en prise (or traded down) where the opponent can legally win material. */
export function isSacrifice(move, fenAfter) {
  if (move.piece === 'p' || move.piece === 'k') return false;
  const chess = new Chess(fenAfter);
  const value = PIECE_VALUE[move.promotion || move.piece];
  const captured = move.captured ? PIECE_VALUE[move.captured] : 0;
  if (captured >= value) return false;
  const takers = chess.moves({ verbose: true }).filter((m) => m.to === move.to && m.captured);
  if (!takers.length) return false;
  const defended = chess.attackers(move.to, move.color).length > 0;
  if (!defended) return value - captured >= 2;
  const cheapest = Math.min(...takers.map((m) => (m.piece === 'k' ? 99 : PIECE_VALUE[m.piece])));
  return value - captured - cheapest >= 2;
}

function material(fen, color) {
  let sum = 0;
  for (const ch of fen.split(' ')[0]) {
    const p = ch.toLowerCase();
    if (!(p in PIECE_VALUE)) continue;
    sum += ((ch === p) === (color === 'b') ? 1 : -1) * PIECE_VALUE[p];
  }
  return sum;
}

/**
 * Material the mover is still down after the engine's best continuation settles, so desperado moves
 * (giving up a piece that was lost anyway) and sacrifices regained within two moves don't count.
 */
export function sacrificedMaterial(move, pvAfter) {
  const start = material(move.before, move.color);
  const chess = new Chess(move.after);
  let lastCapture = false;
  for (let i = 0; i < pvAfter.length && (i < 4 || (lastCapture && i < 6)); i++) {
    const uci = pvAfter[i];
    let m;
    try { m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
    lastCapture = !!m.captured;
  }
  return start - material(chess.fen(), move.color);
}

export function classifyMove({ move, prevMove, prevCls, winBefore, winAfter, isBest, legalCount, secondWin, fenAfter, pvAfter = [], matesAfter = false }) {
  const loss = Math.max(0, winBefore - winAfter);
  if (legalCount === 1) return 'forced';
  if (isBest || loss < 2) {
    if (winAfter >= 50 && isSacrifice(move, fenAfter) && sacrificedMaterial(move, pvAfter) >= 2) {
      // In an already won position a sacrifice only counts if it forces mate or clearly beats the alternatives.
      const crushing = winBefore >= 97;
      if (!crushing || (isBest && (matesAfter || secondWin === null || secondWin < 90))) return 'brilliant';
    }
    const recapture = move.captured && prevMove?.captured && prevMove.to === move.to;
    if (isBest && secondWin !== null && winBefore >= 40 && winBefore - secondWin >= 20 && !recapture) return 'great';
    return isBest ? 'best' : 'excellent';
  }
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  const cls = loss < 20 ? 'mistake' : 'blunder';
  if (BAD.has(prevCls) && winBefore >= 60 && winAfter >= 40) return 'miss';
  return cls;
}

export function sanFromUci(fen, uci) {
  if (!uci) return '';
  try {
    const c = new Chess(fen);
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}

export function pvToSan(fen, pv, max = 8) {
  const c = new Chess(fen);
  const out = [];
  for (const uci of pv.slice(0, max)) {
    try {
      out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

export function parseGame(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const moves = chess.history({ verbose: true });
  const fens = [moves.length ? moves[0].before : chess.fen(), ...moves.map((m) => m.after)];
  return { moves, fens, headers: chess.getHeaders() };
}

function terminalScore(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: null, mate: 0 };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, mate: null };
  return null;
}

/** Evaluates every position of a game with Stockfish and builds the full review. */
export async function analyzeGame(game, { engine, depth = 14, onProgress }) {
  const { moves, fens } = parseGame(game.pgn);
  await engine.newGame();

  const positions = [];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i];
    const turn = fen.split(' ')[1];
    let pos = terminalScore(fen);
    if (pos) {
      pos = { ...pos, best: null, pv: [], second: null };
    } else {
      const r = await engine.search(fen, { depth, multipv: 2 });
      const [l1, l2] = r.lines;
      pos = {
        cp: l1 ? l1.cp : 0,
        mate: l1 ? l1.mate : null,
        best: r.bestmove,
        pv: l1 ? l1.pv.slice(0, 10) : [],
        second: l2 ? { cp: l2.cp, mate: l2.mate, move: l2.pv[0] } : null,
      };
    }
    pos.win = winPct(pos);
    pos.whiteWin = turn === 'w' ? pos.win : 100 - pos.win;
    pos.turn = turn;
    positions.push(pos);
    onProgress?.((i + 1) / fens.length);
  }

  return buildReview(game, positions, { depth, createdAt: Date.now() });
}

/** Turns per-position engine scores into classified moves, accuracy and puzzles (no engine needed). */
export function buildReview(game, positions, { depth, createdAt }) {
  const { moves, fens } = parseGame(game.pgn);
  const ratings = [game.white?.rating, game.black?.rating].filter(Boolean);
  const scale = ratingScale(ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null);
  const analyzedMoves = [];
  moves.forEach((m, i) => {
    const before = positions[i];
    const winBefore = before.win;
    const winAfter = 100 - positions[i + 1].win;
    const isBest = m.lan === before.best;
    const cls = classifyMove({
      move: m,
      prevMove: moves[i - 1],
      prevCls: analyzedMoves[i - 1]?.cls,
      winBefore: winPct(before, scale),
      winAfter: 100 - winPct(positions[i + 1], scale),
      isBest,
      legalCount: new Chess(fens[i]).moves().length,
      secondWin: before.second ? winPct(before.second, scale) : null,
      fenAfter: fens[i + 1],
      pvAfter: positions[i + 1].pv || [],
      matesAfter: positions[i + 1].mate !== null && positions[i + 1].mate <= 0,
    });
    analyzedMoves.push({
      san: m.san,
      uci: m.lan,
      from: m.from,
      to: m.to,
      color: m.color,
      cls,
      winBefore,
      winAfter,
      loss: Math.max(0, winBefore - winAfter),
      acc: moveAccuracy(winBefore, winAfter),
      bestSan: sanFromUci(fens[i], before.best),
    });
  });

  const accuracy = gameAccuracy(positions.map((p) => p.whiteWin), analyzedMoves);
  const counts = { white: {}, black: {} };
  for (const m of analyzedMoves) {
    const side = counts[m.color === 'w' ? 'white' : 'black'];
    side[m.cls] = (side[m.cls] || 0) + 1;
  }

  const analysis = {
    gameId: game.id,
    version: ANALYSIS_VERSION,
    depth,
    createdAt,
    fens,
    positions,
    moves: analyzedMoves,
    accuracy,
    counts,
  };
  return { analysis, puzzles: extractPuzzles(game, analysis) };
}

/** Every mistake/blunder/miss of mine in a not-already-lost position becomes a puzzle. */
export function extractPuzzles(game, analysis) {
  const myColor = game.myColor === 'white' ? 'w' : 'b';
  const out = [];
  analysis.moves.forEach((m, i) => {
    const pos = analysis.positions[i];
    if (m.color !== myColor || !BAD.has(m.cls) || !pos.best || m.winBefore < 30) return;
    const prev = analysis.moves[i - 1];
    out.push({
      id: `${game.id}:${i}`,
      gameId: game.id,
      ply: i,
      fen: analysis.fens[i],
      color: game.myColor,
      lastMove: prev ? [prev.from, prev.to] : null,
      bestUci: pos.best,
      bestSan: m.bestSan,
      pv: pos.pv.slice(0, 8),
      mate: pos.mate,
      winBefore: m.winBefore,
      winAfter: m.winAfter,
      playedSan: m.san,
      playedUci: m.uci,
      cls: m.cls,
      opponent: game.myColor === 'white' ? game.black.username : game.white.username,
      endTime: game.endTime,
      createdAt: Date.now(),
      attempts: 0,
      successes: 0,
      streak: 0,
      due: 0,
      lastAttempt: null,
    });
  });
  return out;
}

/** Solution line the player must find: the whole forced mate if short, otherwise just the best move. */
export function puzzleSolution(puzzle) {
  if (puzzle.mate && puzzle.mate > 0 && puzzle.mate <= 3 && puzzle.pv.length >= puzzle.mate * 2 - 1) {
    return puzzle.pv.slice(0, puzzle.mate * 2 - 1);
  }
  return [puzzle.bestUci];
}

export function formatEval({ cp, mate }, turn) {
  const sign = turn === 'b' ? -1 : 1;
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return turn === 'w' ? '0-1' : '1-0';
    const m = mate * sign;
    return `${m > 0 ? '' : '-'}M${Math.abs(m)}`;
  }
  const v = (cp * sign) / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}
