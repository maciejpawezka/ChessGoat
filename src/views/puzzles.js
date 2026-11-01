import { html, useState, useEffect, useRef } from 'preact-htm';
import { Chess } from 'chess.js';
import { db } from '../db.js';
import { PuzzleBoard } from '../puzzle.js';
import { useAsync } from '../components.js';
import { Trainer, pickNext, recordMistakeResult, mistakeBoardPuzzle, mistakeVerifier, MistakeInfo, MistakeAfter } from './trainer.js';

export const THEME_LABEL = {
  mateIn1: 'Mat w 1', mateIn2: 'Mat w 2', mateIn3: 'Mat w 3',
  fork: 'Widełki', pin: 'Związanie', skewer: 'Rentgen (skewer)', discoveredAttack: 'Odsłonięty atak',
  hangingPiece: 'Wisząca figura', sacrifice: 'Poświęcenie', deflection: 'Odciągnięcie',
  attraction: 'Przyciągnięcie', backRankMate: 'Mat na ostatniej linii', trappedPiece: 'Złapana figura',
  quietMove: 'Cichy ruch', defensiveMove: 'Obrona', zugzwang: 'Zugzwang', promotion: 'Promocja',
  opening: 'Debiut', middlegame: 'Gra środkowa', endgame: 'Końcówki',
  rookEndgame: 'Końcówki wieżowe', pawnEndgame: 'Końcówki pionowe',
};
export const IGNORED_THEMES = new Set(['short', 'long', 'veryLong', 'oneMove', 'master', 'masterVsMaster', 'superGM', 'mate', 'advantage', 'crushing', 'equality']);

const SOURCES = [['lichess', 'Zadania'], ['mine', 'Moje błędy'], ['mixed', 'Mieszane z moimi błędami']];
const MIX_SHARE = 0.4;

async function fetchPuzzle() {
  const res = await fetch('https://lichess.org/api/puzzle/next', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Lichess API: HTTP ${res.status}`);
  const d = await res.json();
  const chess = new Chess();
  for (const san of d.game.pgn.split(' ').filter(Boolean)) chess.move(san);
  const last = chess.history({ verbose: true }).pop();
  return {
    id: d.puzzle.id,
    fen: chess.fen(),
    solution: d.puzzle.solution,
    orientation: chess.turn() === 'w' ? 'white' : 'black',
    lastMove: last ? [last.from, last.to] : null,
    rating: d.puzzle.rating,
    themes: d.puzzle.themes,
  };
}

async function pickMistake(last) {
  const all = await db.all('puzzles');
  return pickNext(all, 'due', null, last) || pickNext(all, 'random', null, last);
}

export function Puzzles({ query }) {
  const gameId = query.get('game');
  const [source, setSource] = useState(query.get('source') || localStorage.getItem('chesspro.puzzleSource') || 'lichess');
  const changeSource = (s) => {
    setSource(s);
    localStorage.setItem('chesspro.puzzleSource', s);
  };

  return html`
    <div class="page board-page">
      <div class="page-head">
        <h1>Puzzle</h1>
        <div class="segmented">
          ${SOURCES.map(([v, l]) => html`<button class=${source === v ? 'active' : ''} onClick=${() => changeSource(v)}>${l}</button>`)}
        </div>
      </div>
      ${source === 'mine' ? html`<${Trainer} gameId=${gameId} />` : html`<${LichessPuzzles} key=${source} mixed=${source === 'mixed'} />`}
    </div>`;
}

function LichessPuzzles({ mixed }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState(null);
  const [lastDelta, setLastDelta] = useState(null);
  const [logVersion, setLogVersion] = useState(0);
  const prefetch = useRef(null);
  const lastMistake = useRef(null);
  const { data: log } = useAsync(() => db.all('puzzleLog'), [logVersion]);

  useEffect(() => { db.getKV('puzzleRating', 1500).then(setRating); }, []);

  const load = async () => {
    setError('');
    setLastDelta(null);
    if (mixed && Math.random() < MIX_SHARE) {
      const mistake = await pickMistake(lastMistake.current);
      if (mistake) {
        lastMistake.current = mistake;
        return setItem({ kind: 'mine', record: mistake });
      }
    }
    try {
      const p = await (prefetch.current || fetchPuzzle());
      prefetch.current = fetchPuzzle().catch(() => null);
      if (!p) throw new Error('Nie udało się pobrać zadania');
      setItem({ kind: 'lichess', puzzle: p });
    } catch (e) {
      prefetch.current = null;
      setError(`${e.message}. Sprawdź połączenie z internetem.`);
    }
  };

  useEffect(() => { load(); }, []);

  const onLichessResult = async (puzzle, success) => {
    const r = rating ?? 1500;
    const expected = 1 / (1 + 10 ** ((puzzle.rating - r) / 400));
    const next = r + 24 * ((success ? 1 : 0) - expected);
    setRating(next);
    setLastDelta(next - r);
    await db.setKV('puzzleRating', next);
    await db.put('puzzleLog', { puzzleId: puzzle.id, rating: puzzle.rating, themes: puzzle.themes, success, ts: Date.now() });
    setLogVersion((v) => v + 1);
  };

  const recent = (log || []).slice(-20);
  const ratingCard = (puzzle) => html`
    <div class="card">
      <div class="row-between">
        <div>Twój ranking <b>${rating !== null ? Math.round(rating) : '…'}</b>
          ${lastDelta !== null && html` <span class=${lastDelta >= 0 ? 'win' : 'loss'}>${lastDelta >= 0 ? '+' : ''}${Math.round(lastDelta)}</span>`}</div>
        ${puzzle && html`<div class="muted small">Zadanie ${puzzle.rating}</div>`}
      </div>
      <div class="result-dots">${recent.map((l) => html`<span class=${l.success ? 'dot win' : 'dot loss'}></span>`)}</div>
    </div>`;

  if (error) return html`<div class="card error">${error} <button class="btn small" onClick=${load}>Spróbuj ponownie</button></div>`;
  if (!item) return html`<div class="card">Pobieranie zadania…</div>`;

  if (item.kind === 'mine') {
    const current = item.record;
    return html`
      <${PuzzleBoard}
        puzzle=${mistakeBoardPuzzle(current)}
        verify=${mistakeVerifier(current)}
        onResult=${(success) => recordMistakeResult(current.id, success)}
        onNext=${load}
        info=${html`<${MistakeInfo} current=${current} />`}
        after=${html`<${MistakeAfter} current=${current} />`}
      />`;
  }

  const { puzzle } = item;
  return html`
    <${PuzzleBoard}
      puzzle=${puzzle}
      onResult=${(success) => onLichessResult(puzzle, success)}
      onNext=${load}
      info=${ratingCard(puzzle)}
      after=${html`
        <div class="card">
          <div class="tags">${puzzle.themes.filter((t) => !IGNORED_THEMES.has(t)).map((t) => html`<span class="tag">${THEME_LABEL[t] || t}</span>`)}</div>
          <a class="btn small" href=${`https://lichess.org/training/${puzzle.id}`} target="_blank" rel="noopener">Otwórz na Lichess ↗</a>
        </div>`}
    />`;
}

export function ThemeStats({ log }) {
  const stats = {};
  for (const l of log) {
    for (const t of l.themes) {
      if (IGNORED_THEMES.has(t)) continue;
      stats[t] = stats[t] || { n: 0, ok: 0 };
      stats[t].n++;
      if (l.success) stats[t].ok++;
    }
  }
  const rows = Object.entries(stats).filter(([, s]) => s.n >= 3).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n);
  if (!rows.length) return html`<div class="muted small">Rozwiąż kilka zadań, a pokażę Twoje najsłabsze motywy.</div>`;
  return html`
    <div class="theme-stats">
      ${rows.slice(0, 12).map(([t, s]) => {
        const pct = Math.round((s.ok / s.n) * 100);
        return html`<div class="theme-row">
          <span>${THEME_LABEL[t] || t}</span>
          <div class="progress"><div style=${`width:${pct}%;background:${pct < 50 ? '#ff453a' : pct < 75 ? '#ffd60a' : '#30d158'}`}></div></div>
          <span class="muted small">${pct}% (${s.n})</span>
        </div>`;
      })}
    </div>`;
}
