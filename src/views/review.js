import { html, useState, useEffect, useMemo } from 'preact-htm';
import { Chess } from 'chess.js';
import { db } from '../db.js';
import { useStore, dataStore, queueStore, settingsStore } from '../store.js';
import { enqueueAnalysis } from '../services.js';
import { CLASSES, SUMMARY_CLASSES, parseGame, formatEval, pvToSan } from '../analysis.js';
import { Board, EvalBar, EvalGraph, MoveList, ClassIcon, useAsync, fmtPct } from '../components.js';
import { useLiveEval } from '../live.js';

const VERDICT = {
  brilliant: 'to genialny ruch!',
  great: 'to świetny ruch — jedyny dobry w tej pozycji.',
  best: 'to najlepszy ruch.',
  excellent: 'to doskonały ruch.',
  good: 'to dobry ruch.',
  forced: 'to ruch wymuszony.',
  inaccuracy: 'to niedokładność.',
  mistake: 'to błąd.',
  miss: 'to przeoczenie — można było wykorzystać błąd rywala.',
  blunder: 'to poważny błąd (blunder).',
};

export function Review({ id, query }) {
  const { version } = useStore(dataStore);
  const queue = useStore(queueStore);
  const { data, loading } = useAsync(async () => ({
    game: await db.get('games', id),
    analysis: await db.get('analyses', id),
  }), [id, version]);

  const game = data?.game;
  const analysis = data?.analysis;
  const parsed = useMemo(() => (game ? parseGame(game.pgn) : null), [game?.pgn]);
  const [index, setIndex] = useState(Number(query.get('ply')) || 0);
  const [flip, setFlip] = useState(false);
  const [explore, setExplore] = useState(null);
  const settings = useStore(settingsStore);

  useEffect(() => {
    if (game && !analysis && queue.current !== id) enqueueAnalysis([id], { front: true });
  }, [game?.id, !!analysis]);

  const total = parsed ? parsed.moves.length : 0;
  const go = (i) => {
    setExplore(null);
    setIndex(Math.max(0, Math.min(total, i)));
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (explore) {
          if (explore.moves.length <= 1) setExplore(null);
          else setExplore({ ...explore, fens: explore.fens.slice(0, -1), moves: explore.moves.slice(0, -1) });
        } else go(index - 1);
      } else if (e.key === 'ArrowRight') { e.preventDefault(); if (!explore) go(index + 1); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(total);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exploreFen = explore ? explore.fens[explore.fens.length - 1] : null;
  const live = useLiveEval(exploreFen, !!explore);

  if (loading && !data) return html`<div class="card">Ładowanie…</div>`;
  if (!game) return html`<div class="card">Nie znaleziono partii. <a href="#/games">Wróć do listy</a></div>`;

  const orientation = (game.myColor === 'black') !== flip ? 'black' : 'white';
  const fen = exploreFen || parsed.fens[index];
  const lastGameMove = index > 0 ? parsed.moves[index - 1] : null;
  const lastExploreMove = explore ? explore.moves[explore.moves.length - 1] : null;
  const lastMove = lastExploreMove ? [lastExploreMove.from, lastExploreMove.to] : lastGameMove ? [lastGameMove.from, lastGameMove.to] : null;
  const moveInfo = analysis && index > 0 && !explore ? analysis.moves[index - 1] : null;
  const prevPos = analysis && index > 0 ? analysis.positions[index - 1] : null;
  const pos = analysis ? analysis.positions[index] : null;

  const badges = moveInfo ? [{ square: moveInfo.to, cls: moveInfo.cls }] : [];
  const bestUci = explore ? live?.best : pos?.best;
  const shapes = settings.showBestMove && bestUci ? [{ orig: bestUci.slice(0, 2), dest: bestUci.slice(2, 4), brush: 'blue' }] : [];

  const evalState = explore
    ? live && { whiteWin: live.whiteWin, label: live.label }
    : pos && { whiteWin: pos.whiteWin, label: formatEval(pos, pos.turn) };

  const onMove = (from, to, promotion) => {
    const chess = new Chess(fen);
    let mv;
    try { mv = chess.move({ from, to, promotion }); } catch { return; }
    if (!explore && parsed.moves[index]?.lan === mv.lan) return go(index + 1);
    const entry = { san: mv.san, from: mv.from, to: mv.to };
    setExplore(explore
      ? { ...explore, fens: [...explore.fens, chess.fen()], moves: [...explore.moves, entry] }
      : { baseIndex: index, fens: [fen, chess.fen()], moves: [entry] });
  };

  const analyzing = !analysis;
  const inQueue = queue.current === id;

  return html`
    <div class="layout">
      <div class="board-area">
        <div class="board-col">
          <${PlayerTag} game=${game} color=${orientation === 'white' ? 'black' : 'white'} />
          <div class="board-row">
            <${EvalBar} whiteWin=${evalState ? evalState.whiteWin : 50} label=${evalState?.label || ''} orientation=${orientation} />
            <${Board} fen=${fen} orientation=${orientation} interactive=${true} onMove=${onMove}
              lastMove=${lastMove} shapes=${shapes} badges=${badges} />
          </div>
          <${PlayerTag} game=${game} color=${orientation} />
          <div class="btn-row nav-buttons">
            <button class="btn" title="Początek" onClick=${() => go(0)}>⏮</button>
            <button class="btn" title="Wstecz (←)" onClick=${() => go(index - 1)}>◀</button>
            <button class="btn" title="Dalej (→)" onClick=${() => go(index + 1)}>▶</button>
            <button class="btn" title="Koniec" onClick=${() => go(total)}>⏭</button>
            <button class="btn" title="Obróć szachownicę" onClick=${() => setFlip(!flip)}>⇅</button>
          </div>
        </div>
      </div>

      <div class="side-panel aligned">
        <div class="card review-header">
          <div class="row-between">
            <div><b>${game.white.username}</b> (${game.white.rating}) – <b>${game.black.username}</b> (${game.black.rating})</div>
            ${game.url && html`<a class="btn small" href=${game.url} target="_blank" rel="noopener">Chess.com ↗</a>`}
          </div>
          <div class=${`result-text ${game.result}`}>${resultLabel(game)}</div>
        </div>

        ${analyzing && html`
          <div class="card">
            <div>${inQueue ? `Analiza Stockfish… ${Math.round(queue.progress * 100)}%` : 'Partia w kolejce do analizy…'}</div>
            <div class="progress"><div style=${`width:${inQueue ? queue.progress * 100 : 0}%`}></div></div>
            <div class="muted small">Możesz już przeglądać ruchy i analizować warianty na szachownicy.</div>
          </div>`}

        ${analysis && html`<${Summary} game=${game} analysis=${analysis} onReanalyze=${() => enqueueAnalysis([id], { front: true, force: true })} />`}
        ${analysis && html`<${EvalGraph} whiteWins=${analysis.positions.map((p) => p.whiteWin)} moves=${analysis.moves} index=${explore ? explore.baseIndex : index} onSelect=${go} />`}

        ${explore ? html`
          <div class="card">
            <div class="row-between">
              <b>Analiza wariantu</b>
              <button class="btn small" onClick=${() => setExplore(null)}>Wróć do partii</button>
            </div>
            <div class="variation">${explore.moves.map((m) => m.san).join(' ')}</div>
            ${live ? html`
              <div class="muted small">Stockfish, głębokość ${live.depth}</div>
              ${live.lines.map((l) => html`
                <div class="engine-line"><span class="eval-chip">${formatEval(l, live.turn)}</span> ${pvToSan(live.fen, l.pv, 8).join(' ')}</div>`)}
            ` : html`<div class="muted small">Liczenie…</div>`}
          </div>` : moveInfo && html`
          <div class="card move-comment">
            <div class="comment-title"><${ClassIcon} cls=${moveInfo.cls} size=${22} />
              <span><b>${moveNumber(index)} ${moveInfo.san}</b> ${VERDICT[moveInfo.cls]}</span></div>
            ${prevPos?.best && prevPos.best !== moveInfo.uci && html`<div>Najlepsze było: <b>${moveInfo.bestSan}</b></div>`}
          </div>`}

        <${MoveList} moves=${analysis ? analysis.moves : parsed.moves} index=${explore ? explore.baseIndex : index}
          startPly=${parsed.fens[0].split(' ')[1] === 'b' ? 1 : 0} onSelect=${go} />

        <div class="btn-row wrap">
          <a class="btn" href=${`#/play?fen=${encodeURIComponent(fen)}`}>Graj od tej pozycji</a>
          ${analysis && html`<a class="btn" href=${`#/puzzles?source=mine&game=${encodeURIComponent(id)}`}>Ćwicz błędy z tej partii</a>`}
        </div>
      </div>
    </div>`;
}

function moveNumber(ply) {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}.` : `${n}...`;
}

function resultLabel(game) {
  const map = { win: 'Wygrana', loss: 'Przegrana', draw: 'Remis', unfinished: 'Partia nieukończona' };
  const how = {
    checkmated: 'mat', resigned: 'poddanie', timeout: 'czas', abandoned: 'porzucenie', agreed: 'zgoda',
    repetition: 'powtórzenie', stalemate: 'pat', insufficient: 'brak materiału', '50move': 'reguła 50 ruchów',
    timevsinsufficient: 'czas vs brak materiału',
  };
  const t = how[game.termination];
  return `${map[game.result] || ''}${t ? ` (${t})` : ''}`;
}

function PlayerTag({ game, color }) {
  const p = game[color];
  return html`
    <div class="player-tag">
      <span class=${`color-dot ${color}`}></span>
      <b>${p.username}</b> <span class="muted">(${p.rating})</span>
    </div>`;
}

function Summary({ game, analysis, onReanalyze }) {
  const { accuracy, counts } = analysis;
  return html`
    <div class="card summary">
      <div class="summary-head">
        <div><button class="btn icon subtle" title="Analizuj ponownie" onClick=${onReanalyze}>⟳</button></div>
        <div class="summary-player">${game.white.username}</div>
        <div class="summary-player">${game.black.username}</div>
      </div>
      <div class="summary-row accuracy-row">
        <div>Dokładność</div>
        <div class="acc-box white">${fmtPct(accuracy.white)}</div>
        <div class="acc-box black">${fmtPct(accuracy.black)}</div>
      </div>
      ${SUMMARY_CLASSES.map((k) => html`
        <div class="summary-row">
          <div class="summary-label"><${ClassIcon} cls=${k} size=${16} /> ${CLASSES[k].label}</div>
          <div style=${`color:${CLASSES[k].color}`}>${counts.white[k] || 0}</div>
          <div style=${`color:${CLASSES[k].color}`}>${counts.black[k] || 0}</div>
        </div>`)}
    </div>`;
}
