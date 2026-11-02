import { Chess } from 'chess.js';

export const ANALYSIS_VERSION = 11;

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
 * Winning chances (0-100) for the side the score belongs to.
 * Formula: Win_Prob = 1 / (1 + 10^(-eval / 4))
 * where eval is Stockfish eval in pawns (cp / 100), scaled by player rating.
 */
export function winPct({ cp, mate }, scale = 1) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return 50;
    return mate > 0 ? 100 : 0;
  }
  const evalPawns = ((cp ?? 0) / 100) * scale;
  return clamp(100 / (1 + Math.pow(10, -evalPawns / 4)), 0, 100);
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

export function playUci(chess, uci) {
  if (!uci || uci.length < 4) return null;
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
  } catch {
    return null;
  }
}

/**
 * Static Exchange Evaluation (SEE): calculates the net material outcome (in points)
 * of a sequence of optimal captures on a target square.
 * Returns > 0 if the attacking side wins material.
 */
export function see(fenOrChess, square, attackerColor = null) {
  const chess = typeof fenOrChess === 'string' ? new Chess(fenOrChess) : new Chess(fenOrChess.fen());
  if (attackerColor && chess.turn() !== attackerColor) {
    chess.setTurn(attackerColor);
  }
  const target = chess.get(square);
  if (!target) return 0;

  const targetVal = PIECE_VALUE[target.type] || 0;
  const capturedValues = [targetVal];
  const maxCaptures = 32;

  for (let step = 0; step < maxCaptures; step++) {
    const captures = chess.moves({ verbose: true }).filter((m) => m.to === square && m.captured);
    if (!captures.length) break;

    captures.sort((a, b) => {
      const va = a.piece === 'k' ? 1000 : (PIECE_VALUE[a.piece] || 0);
      const vb = b.piece === 'k' ? 1000 : (PIECE_VALUE[b.piece] || 0);
      return va - vb;
    });

    const chosen = captures[0];
    const attVal = chosen.piece === 'k' ? 1000 : (PIECE_VALUE[chosen.piece] || 0);
    capturedValues.push(attVal);

    try {
      chess.move(chosen);
    } catch {
      break;
    }
  }

  const n = capturedValues.length - 1;
  if (n <= 0) return 0;

  const gain = new Array(n);
  gain[n - 1] = capturedValues[n - 1];

  for (let k = n - 2; k >= 1; k--) {
    gain[k] = Math.max(0, capturedValues[k] - gain[k + 1]);
  }

  return capturedValues[0] - (n > 1 ? gain[1] : 0);
}

/**
 * Detects if the move was an escape from a fork / double attack:
 * if before the move, two or more pieces were attacked simultaneously
 * and player moved one away leaving the other hanging, the loss was forced.
 */
export function isForkEscape(move, hangingSquare) {
  const chessBefore = new Chess(move.before);
  const oppColor = move.color === 'w' ? 'b' : 'w';

  const moverPiecesBefore = [];
  for (let r = 1; r <= 8; r++) {
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const sq = `${f}${r}`;
      const p = chessBefore.get(sq);
      if (p && p.color === move.color && p.type !== 'p' && p.type !== 'k') {
        moverPiecesBefore.push(sq);
      }
    }
  }

  // Fork by a single enemy piece
  for (let r = 1; r <= 8; r++) {
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const oppSq = `${f}${r}`;
      const oppP = chessBefore.get(oppSq);
      if (!oppP || oppP.color !== oppColor) continue;

      const forked = moverPiecesBefore.filter((sq) => {
        const attackers = chessBefore.attackers(sq, oppColor);
        return attackers.includes(oppSq);
      });

      if (forked.length >= 2 && forked.includes(move.from) && forked.includes(hangingSquare) && hangingSquare !== move.to) {
        return true;
      }
    }
  }

  // Multiple pieces with positive SEE before the move
  const hangingBefore = moverPiecesBefore.filter((sq) => see(move.before, sq, oppColor) > 0);
  if (hangingBefore.length >= 2 && hangingBefore.includes(move.from) && hangingBefore.includes(hangingSquare)) {
    return true;
  }

  return false;
}

/**
 * Detects if the hanging piece was already trapped before the move
 * with no safe escape squares (its loss was inevitable).
 */
export function isTrappedPiece(move, hangingSquare) {
  const chessBefore = new Chess(move.before);
  const oppColor = move.color === 'w' ? 'b' : 'w';
  const targetSqBefore = hangingSquare === move.to ? move.from : hangingSquare;
  const p = chessBefore.get(targetSqBefore);
  if (!p || p.color !== move.color) return false;

  const wasAttacked = chessBefore.attackers(targetSqBefore, oppColor).length > 0;
  if (!wasAttacked) return false;

  if (see(move.before, targetSqBefore, oppColor) <= 0) return false;

  const pieceMoves = chessBefore.moves({ verbose: true, square: targetSqBefore });
  if (!pieceMoves.length) return true;

  for (const m of pieceMoves) {
    const c = new Chess(move.before);
    try {
      c.move(m);
      if (m.captured && (PIECE_VALUE[m.captured] || 0) >= (PIECE_VALUE[p.type] || 0)) {
        return false;
      }
      if (see(c.fen(), m.to) <= 0) {
        return false;
      }
    } catch {
      // ignore
    }
  }

  return true;
}

/**
 * Detects if the move creates an overwhelming counter-threat (direct mate in 1-2,
 * attack on unshielded Queen) that prevents the opponent from objectively accepting the sacrifice.
 */
export function hasOverwhelmingCounterThreat(move, hangingPiece, fenAfter, pvAfter = [], matesAfter = false) {
  const chessAfter = new Chess(fenAfter);
  const oppColor = move.color === 'w' ? 'b' : 'w';
  const hangingVal = PIECE_VALUE[hangingPiece.type] || 3;

  if (matesAfter) {
    const topReply = pvAfter[0];
    if (topReply && topReply.slice(2, 4) !== hangingPiece.square) {
      return true;
    }
  }

  if (hangingVal <= 5) {
    for (let r = 1; r <= 8; r++) {
      for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const sq = `${f}${r}`;
        const p = chessAfter.get(sq);
        if (p && p.color === oppColor && p.type === 'q') {
          const attackers = chessAfter.attackers(sq, move.color);
          if (attackers.includes(move.to)) {
            const queenDefended = chessAfter.attackers(sq, oppColor).length > 0;
            const attackerVal = PIECE_VALUE[move.piece] || 1;
            if (!queenDefended || attackerVal < 9) {
              const topReply = pvAfter[0];
              if (topReply && topReply.slice(2, 4) !== hangingPiece.square) {
                return true;
              }
            }
          }
        }
      }
    }
  }

  return false;
}

/**
 * Calculates Brilliancy Score (0-100+) based on:
 * - Material sacrificed: Queen (90) > Rook (50) > Minor (30)
 * - Number of legal captures by opponent (+10 per taker)
 * - Additional motifs: Check (+25), Quiet move (+20), Forced mate (+35)
 */
export function calculateBrilliancyScore({ move, hangingPiece, fenAfter, pvAfter = [], matesAfter = false }) {
  let score = 0;

  const pieceVal = PIECE_VALUE[hangingPiece.type] || 3;
  if (pieceVal >= 9) score += 90;
  else if (pieceVal >= 5) score += 50;
  else score += 30;

  const chessAfter = new Chess(fenAfter);
  const takers = chessAfter.moves({ verbose: true }).filter((m) => m.to === hangingPiece.square && m.captured);
  score += takers.length * 10;

  if (chessAfter.inCheck()) {
    score += 25;
  }
  if (!move.captured) {
    score += 20;
  }
  if (matesAfter) {
    score += 35;
  }

  return score;
}

/** Expected-points bands and thresholds scaled by player rating. */
export function bands(rating) {
  const isBeginner = !rating || rating < 1200;
  const isMaster = Boolean(rating && rating >= 2000);

  return {
    maxLoss: isBeginner ? 5 : isMaster ? 1 : 2,
    sac: 2,
    okAfter: isBeginner ? 45 : 50,
    requireBestOrOnly: isMaster,
    crushing: isBeginner ? 95 : 85,
    losing: isBeginner ? 40 : 35,
    winning: isBeginner ? 62 : 75,
    gap: isBeginner ? 15 : 20,
    depth: isMaster ? 20 : 14,
  };
}

/**
 * Full sacrifice and brilliant move detection covering:
 * - Piece sacrifices (moved piece or piece left hanging) >= 3 pts (or 2 for exchange)
 * - SEE verification > 0
 * - Attacker vs defender relation
 * - False positive filters: trades/recaptures, fork escapes, trapped pieces, danger levels
 * - Brilliancy Score calculation
 */
export function detectBrilliantMove({
  move,
  prevMove,
  fenAfter,
  pvAfter = [],
  matesAfter = false,
  band,
  rating,
  secondWin,
  isBest,
}) {
  if (move.piece === 'k') return null;

  // Filter 1: Trades and recaptures
  if (move.captured) {
    const movingVal = PIECE_VALUE[move.promotion || move.piece] || 0;
    const capturedVal = PIECE_VALUE[move.captured] || 0;
    if (capturedVal >= movingVal) return null;
  }
  if (prevMove?.captured && prevMove.to === move.to) {
    const movingVal = PIECE_VALUE[move.promotion || move.piece] || 0;
    const capturedVal = move.captured ? (PIECE_VALUE[move.captured] || 0) : 0;
    if (capturedVal >= movingVal) return null;
  }

  // Position must not have been already completely crushing with any move
  const needed = secondWin === null || secondWin < band.crushing || matesAfter;
  if (!needed) return null;

  const chessAfter = new Chess(fenAfter);
  const oppColor = move.color === 'w' ? 'b' : 'w';
  const candidates = [];

  for (let r = 1; r <= 8; r++) {
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const sq = `${f}${r}`;
      const p = chessAfter.get(sq);
      if (!p || p.color !== move.color || p.type === 'p' || p.type === 'k') continue;

      const pieceVal = PIECE_VALUE[p.type] || 0;
      if (pieceVal < 3) continue;

      const takers = chessAfter.moves({ verbose: true }).filter((m) => m.to === sq && m.captured);
      if (!takers.length) continue;

      // Method 1: SEE verification
      const seeVal = see(fenAfter, sq);
      if (seeVal <= 0) continue;

      // Method 2: Attacker vs Defender relation
      const attackers = chessAfter.attackers(sq, oppColor).length;
      const defenders = chessAfter.attackers(sq, move.color).length;
      const minAttackerVal = Math.min(...takers.map((m) => PIECE_VALUE[m.piece] || 1));
      const hasRelationAdvantage = (attackers > defenders) || (minAttackerVal < pieceVal);
      if (!hasRelationAdvantage) continue;

      // Net sacrifice threshold
      const capturedVal = move.captured ? (PIECE_VALUE[move.captured] || 0) : 0;
      const netSac = Math.max(seeVal, pieceVal - (defenders > 0 ? minAttackerVal : 0)) - (sq === move.to ? capturedVal : 0);
      if (netSac < band.sac) continue;

      // Filter 2: Fork escape
      if (isForkEscape(move, sq)) continue;

      // Filter 3: Trapped pieces
      if (isTrappedPiece(move, sq)) continue;

      // Filter 4: Danger levels / counter-threats
      if (hasOverwhelmingCounterThreat(move, { ...p, square: sq }, fenAfter, pvAfter, matesAfter)) continue;

      // Filter 1 (PV follow-up): Check if immediate trade sequence on same square restores material
      if (pvAfter[0] && pvAfter[1]) {
        const cSim = new Chess(fenAfter);
        const reply = playUci(cSim, pvAfter[0]);
        if (reply && reply.to === sq && reply.captured) {
          const follow = playUci(cSim, pvAfter[1]);
          if (follow && follow.to === sq && follow.captured) {
            const netExchange = (PIECE_VALUE[follow.captured] || 0) + (sq === move.to && move.captured ? PIECE_VALUE[move.captured] || 0 : 0) - (PIECE_VALUE[reply.captured] || 0);
            if (netExchange >= 0) continue;
          }
        }
      }

      const score = calculateBrilliancyScore({
        move,
        hangingPiece: { ...p, square: sq },
        fenAfter,
        pvAfter,
        matesAfter,
      });

      candidates.push({
        hangingPiece: { ...p, square: sq },
        netSac,
        score,
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.netSac - a.netSac);
  return candidates[0];
}

export function sacrificeLoss(move, fenAfter, minLoss = 2) {
  const b = detectBrilliantMove({
    move,
    fenAfter,
    pvAfter: [],
    band: { sac: minLoss, crushing: 99 },
    secondWin: null,
    isBest: true,
  });
  return b ? b.netSac : 0;
}

export function isSacrifice(move, fenAfter) {
  return sacrificeLoss(move, fenAfter) > 0;
}

export function classifyMove({ move, prevMove, prevCls, winBefore, winAfter, isBest, legalCount, secondWin, fenAfter, pvAfter = [], matesAfter = false, rating = null }) {
  const loss = Math.max(0, winBefore - winAfter);
  const band = bands(rating);
  if (legalCount === 1) return { cls: 'forced', score: 0 };

  const isOnlyMove = isBest && secondWin !== null && (winBefore - secondWin >= band.gap);
  const nearBest = band.requireBestOrOnly
    ? (isBest || isOnlyMove) && loss <= band.maxLoss
    : (isBest || loss <= band.maxLoss);

  if (nearBest && winAfter >= band.okAfter) {
    const brilliantCandidate = detectBrilliantMove({
      move,
      prevMove,
      fenAfter,
      pvAfter,
      matesAfter,
      band,
      rating,
      secondWin,
      isBest,
    });
    if (brilliantCandidate) {
      return {
        cls: 'brilliant',
        score: brilliantCandidate.score,
        hangingPiece: brilliantCandidate.hangingPiece,
      };
    }
  }

  const recapture = move.captured && prevMove?.captured && prevMove.to === move.to;
  const swings = isBest && (
    (winBefore < band.losing && winAfter >= 50 && winAfter - winBefore >= 8)
    || (winBefore >= 50 && winBefore < band.winning && winAfter >= band.winning && winAfter - winBefore >= 6)
  );
  if (!recapture && (isOnlyMove || swings) && (isBest || loss <= 2)) {
    return { cls: 'great', score: 0 };
  }

  if (isBest || loss <= 2) {
    return { cls: isBest ? 'best' : 'excellent', score: 0 };
  }
  if (loss <= 5) return { cls: 'good', score: 0 };
  if (loss <= 10) return { cls: 'inaccuracy', score: 0 };
  const cls = loss <= 20 ? 'mistake' : 'blunder';
  if ((prevCls === 'mistake' || prevCls === 'blunder') && winBefore >= band.winning && winAfter < band.winning && loss >= 10) {
    return { cls: 'miss', score: 0 };
  }
  return { cls, score: 0 };
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

  const moverRating = Math.max(game.white?.rating || 0, game.black?.rating || 0);
  const actualDepth = moverRating >= 2000 ? Math.max(depth, 18) : depth;

  const positions = [];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i];
    const turn = fen.split(' ')[1];
    let pos = terminalScore(fen);
    if (pos) {
      pos = { ...pos, best: null, pv: [], second: null };
    } else {
      const r = await engine.search(fen, { depth: actualDepth, multipv: 2 });
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

  return buildReview(game, positions, { depth: actualDepth, createdAt: Date.now() });
}

/** Turns per-position engine scores into classified moves, accuracy and puzzles (no engine needed). */
export function buildReview(game, positions, { depth, createdAt }) {
  const { moves, fens } = parseGame(game.pgn);
  const analyzedMoves = [];
  moves.forEach((m, i) => {
    const before = positions[i];
    const moverRating = game[m.color === 'w' ? 'white' : 'black']?.rating || null;
    const scale = ratingScale(moverRating);
    const winBefore = before.win;
    const winAfter = 100 - positions[i + 1].win;
    const isBest = m.lan === before.best;
    const res = classifyMove({
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
      rating: moverRating,
    });
    const cls = typeof res === 'string' ? res : res.cls;
    analyzedMoves.push({
      san: m.san,
      uci: m.lan,
      from: m.from,
      to: m.to,
      color: m.color,
      cls,
      brilliancyScore: res.score || null,
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
