import { html, useState, useEffect } from 'preact-htm';
import { db } from '../db.js';
import { getEngine } from '../engine.js';
import { useStore, dataStore, bumpData } from '../store.js';
import { puzzleSolution, pvToSan, winPct } from '../analysis.js';
import { PuzzleBoard } from '../puzzle.js';
import { useAsync, fmtDate } from '../components.js';

const DAY = 24 * 3600 * 1000;
const INTERVALS = [1, 3, 7, 16, 35, 90];
const MISTAKE_TITLE = { blunder: 'Tu był Twój blunder', mistake: 'Tu był Twój błąd', miss: 'Tu było Twoje przeoczenie' };

export function pickNext(puzzles, mode, gameId, current) {
  const now = Date.now();
  if (mode === 'game') {
    const list = puzzles.filter((p) => p.gameId === gameId).sort((a, b) => a.ply - b.ply);
    const i = current ? list.findIndex((p) => p.id === current.id) : -1;
    return list[i + 1] || null;
  }
  const newestFirst = (a, b) => b.endTime - a.endTime || a.ply - b.ply;
  let pool = puzzles.filter((p) => p.id !== current?.id).sort(newestFirst);
  if (mode === 'due') return pool.find((p) => p.due <= now) || null;
  // Random, but skewed towards mistakes from recent games.
  return pool[Math.floor(Math.random() ** 2 * pool.length)] || null;
}

/** Spaced repetition: a solved puzzle comes back after a growing interval, a failed one in 10 minutes. */
export async function recordMistakeResult(id, success) {
  const p = await db.get('puzzles', id);
  if (!p) return;
  const streak = success ? p.streak + 1 : 0;
  await db.put('puzzles', {
    ...p,
    attempts: p.attempts + 1,
    successes: p.successes + (success ? 1 : 0),
    streak,
    due: success ? Date.now() + INTERVALS[Math.min(streak - 1, INTERVALS.length - 1)] * DAY : Date.now() + 10 * 60 * 1000,
    lastAttempt: Date.now(),
  });
  bumpData();
}

export function mistakeBoardPuzzle(current) {
  return { id: current.id, fen: current.fen, solution: puzzleSolution(current), orientation: current.color, lastMove: current.lastMove };
}

export function mistakeVerifier(current) {
  return async (fenBefore, uci, fenAfter) => {
    const r = await getEngine('live').search(fenAfter, { depth: 14 });
    const top = r.lines[0];
    if (!top) return false;
    const winAfter = 100 - winPct(top);
    return winAfter >= Math.min(current.winBefore - 4, 97);
  };
}

export function MistakeInfo({ current }) {
  return html`
    <div class="card">
      <div><b>${MISTAKE_TITLE[current.cls] || 'Tu był Twój błąd'}</b></div>
      <div class="muted small">Partia z ${current.opponent} · ${fmtDate(current.endTime)}</div>
    </div>`;
}

export function MistakeAfter({ current }) {
  return html`
    <div class="card">
      <div>Najlepszy ruch: <b>${current.bestSan}</b></div>
      <div class="muted small">Linia: ${pvToSan(current.fen, current.pv, 8).join(' ')}</div>
      <a class="btn small" href=${`#/game/${encodeURIComponent(current.gameId)}?ply=${current.ply + 1}`}>Zobacz w analizie partii</a>
    </div>`;
}

/** Puzzles built from my own mistakes; rendered inside the Puzzle page. */
export function Trainer({ gameId }) {
  const { version } = useStore(dataStore);
  const { data: puzzles } = useAsync(() => db.all('puzzles'), [version]);
  const [mode, setMode] = useState(gameId ? 'game' : 'due');
  const [current, setCurrent] = useState(null);
  const [session, setSession] = useState({ ok: 0, fail: 0 });

  useEffect(() => {
    if (puzzles && !current) setCurrent(pickNext(puzzles, mode, gameId, null));
  }, [puzzles, mode]);

  if (!puzzles) return html`<div class="card">Ładowanie…</div>`;

  const now = Date.now();
  const due = puzzles.filter((p) => p.due <= now).length;
  const mastered = puzzles.filter((p) => p.streak >= 3).length;

  const changeMode = (m) => {
    setMode(m);
    setCurrent(pickNext(puzzles, m, gameId, null));
  };
  const next = () => setCurrent(pickNext(puzzles, mode, gameId, current));

  const onResult = async (success) => {
    setSession((s) => (success ? { ...s, ok: s.ok + 1 } : { ...s, fail: s.fail + 1 }));
    await recordMistakeResult(current.id, success);
  };

  const modes = html`
    <div class="segmented">
      <button class=${mode === 'due' ? 'active' : ''} onClick=${() => changeMode('due')}>Do powtórki (${due})</button>
      <button class=${mode === 'random' ? 'active' : ''} onClick=${() => changeMode('random')}>Losowe (${puzzles.length})</button>
      ${gameId && html`<button class=${mode === 'game' ? 'active' : ''} onClick=${() => changeMode('game')}>Z tej partii</button>`}
    </div>`;

  if (!puzzles.length) {
    return html`<div class="card">Nie masz jeszcze zadań. Każdy błąd, blunder i przeoczenie z przeanalizowanych partii automatycznie staje się tu zadaniem — <a href="#/games">przeanalizuj partie</a>.</div>`;
  }
  if (!current) {
    return html`${modes}<div class="card">${mode === 'due' ? 'Wszystko powtórzone na dziś! 🎉 Wróć jutro albo przełącz na „Losowe”.' : 'Koniec zadań w tym trybie.'}</div>`;
  }

  return html`
    ${modes}
    <${PuzzleBoard}
      puzzle=${mistakeBoardPuzzle(current)}
      verify=${mistakeVerifier(current)}
      onResult=${onResult}
      onNext=${next}
      info=${html`<${MistakeInfo} current=${current} />`}
      after=${html`<${MistakeAfter} current=${current} />`}
    />
    <div class="card small muted">
      Sesja: ✓ ${session.ok} · ✗ ${session.fail} · Opanowane (seria ≥ 3): ${mastered}/${puzzles.length}
    </div>`;
}
