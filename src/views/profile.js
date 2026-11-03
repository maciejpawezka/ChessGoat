import { html, useState } from 'preact-htm';
import { db } from '../db.js';
import { useStore, queueStore } from '../store.js';
import { enqueueAnalysis } from '../services.js';
import { ClassIcon, MiniBoard, fmtDate } from '../components.js';
import { ThemeStats } from './puzzles.js';

const DAY = 24 * 3600 * 1000;
const RATING_TYPES = [['rapid', 'Szybkie', '⏱'], ['blitz', 'Blitz', '⚡'], ['bullet', 'Bullet', '•'], ['daily', 'Daily', '☀']];
const BRILLIANT_PAGE = 24;

/** Profile data for the dashboard; `games` are the user's non-bot games, newest first. */
export async function loadProfile(games) {
  const [puzzleRating, log] = await Promise.all([db.getKV('puzzleRating', null), db.all('puzzleLog')]);
  const brilliants = [];
  for (const game of games.filter((g) => g.analyzed && g.myBrilliants > 0)) {
    const analysis = await db.get('analyses', game.id);
    if (!analysis) continue;
    const mine = game.myColor === 'white' ? 'w' : 'b';
    analysis.moves.forEach((m, i) => {
      if (m.color === mine && m.cls === 'brilliant') brilliants.push({ game, ply: i + 1, move: m, fen: analysis.fens[i + 1] });
    });
  }
  return { puzzleRating, log, brilliants };
}

/** Current rating per time class and its change over the last 30 days. */
function ratingStats(games, timeClass) {
  const rated = games.filter((g) => g.timeClass === timeClass && g.rated);
  if (!rated.length) return null;
  const rating = (g) => g[g.myColor].rating;
  const current = rating(rated[0]);
  const cutoff = Date.now() - 30 * DAY;
  const before = rated.find((g) => g.endTime < cutoff);
  const inWindow = rated.filter((g) => g.endTime >= cutoff);
  const base = before ? rating(before) : inWindow.length > 1 ? rating(inWindow[inWindow.length - 1]) : null;
  return { current, delta: base === null || !inWindow.length ? null : current - base, best: Math.max(...rated.map(rating)), count: rated.length };
}

const Delta = ({ v }) => (v === null || v === undefined
  ? html`<span class="muted">–</span>`
  : html`<span class=${v > 0 ? 'win' : v < 0 ? 'loss' : 'muted'}>${v > 0 ? '↑' : v < 0 ? '↓' : ''} ${Math.abs(Math.round(v))}</span>`);

export function ProfileStats({ games, profile }) {
  const { puzzleRating, log, brilliants } = profile;
  const analyzedCount = games.filter((g) => g.analyzed).length;
  const solvedPct = log.length ? Math.round((log.filter((l) => l.success).length / log.length) * 100) : null;
  const rows = RATING_TYPES.map(([tc, label, icon]) => ({ label, icon, s: ratingStats(games, tc) })).filter((r) => r.s);
  const toBrilliants = (e) => {
    e.preventDefault();
    document.getElementById('brilliants')?.scrollIntoView({ behavior: 'smooth' });
  };
  return html`
    <div class="card list profile-stats">
      <div class="stats-row head">
        <span>Twoje statystyki</span><span>Ranking</span><span class="hide-sm">Najwyższy</span><span class="hide-sm">Partie</span>
      </div>
      ${rows.map(({ label, icon, s }) => html`
        <div class="stats-row">
          <span class="stats-type"><span class="stats-icon">${icon}</span>${label}</span>
          <span class="stats-rating"><b>${s.current}</b><${Delta} v=${s.delta} /></span>
          <span class="hide-sm">${s.best}</span>
          <span class="hide-sm muted">${s.count}</span>
        </div>`)}
      <a class="stats-row link" href="#brilliants" onClick=${toBrilliants}>
        <span class="stats-type"><${ClassIcon} cls="brilliant" size=${22} />Genialne ruchy</span>
        <span class="stats-rating"><b>${brilliants.length}</b></span>
        <span class="hide-sm muted small">w ${analyzedCount} analizach</span>
        <span class="hide-sm"></span>
      </a>
      <a class="stats-row link" href="#/puzzles">
        <span class="stats-type"><span class="stats-icon">♞</span>Zadania</span>
        <span class="stats-rating"><b>${puzzleRating !== null ? Math.round(puzzleRating) : '–'}</b></span>
        <span class="hide-sm muted small">${solvedPct !== null ? `${solvedPct}% rozwiązanych` : ''}</span>
        <span class="hide-sm muted">${log.length}</span>
      </a>
    </div>`;
}

export function Brilliants({ games, profile }) {
  const queue = useStore(queueStore);
  const [limit, setLimit] = useState(BRILLIANT_PAGE);
  const { brilliants } = profile;
  const pending = games.filter((g) => !g.analyzed);
  const analyzing = queue.current || queue.pending > 0;
  return html`
    <div class="card" id="brilliants">
      <div class="row-between card-head">
        <h3>Genialne ruchy <span class="muted">${brilliants.length}</span></h3>
        ${pending.length > 0 && html`
          <div class="toolbar">
            <span class="muted small">${pending.length} ${pending.length === 1 ? 'partia' : 'partii'} bez analizy</span>
            ${!analyzing && html`<button class="btn small" onClick=${() => enqueueAnalysis(pending.map((g) => g.id))}>Analizuj wszystkie</button>`}
          </div>`}
      </div>
      ${brilliants.length ? html`
        <div class="brilliant-grid">
          ${brilliants.slice(0, limit).map((b) => html`<${BrilliantCard} key=${`${b.game.id}:${b.ply}`} item=${b} />`)}
        </div>
        ${brilliants.length > limit && html`<button class="btn ghost center-block" onClick=${() => setLimit(limit + BRILLIANT_PAGE)}>Pokaż więcej</button>`}
      ` : html`<div class="muted small">Brak genialnych ruchów w przeanalizowanych partiach.</div>`}
    </div>`;
}

export function PuzzleThemes({ profile }) {
  const { log } = profile;
  const solvedPct = log.length ? Math.round((log.filter((l) => l.success).length / log.length) * 100) : null;
  return html`
    <div class="card">
      <h3>Motywy w zadaniach ${solvedPct !== null ? html`<span class="muted small">· rozwiązane ${solvedPct}% z ${log.length}</span>` : ''}</h3>
      <${ThemeStats} log=${log} />
    </div>`;
}

function BrilliantCard({ item }) {
  const { game, ply, move, fen } = item;
  const opp = game.myColor === 'white' ? game.black : game.white;
  const no = Math.ceil(ply / 2);
  return html`
    <a class="brilliant-card" href=${`#/game/${encodeURIComponent(game.id)}?ply=${ply}`}>
      <${MiniBoard} fen=${fen} orientation=${game.myColor} highlight=${[move.from, move.to]} badge=${{ square: move.to, cls: 'brilliant' }} />
      <div class="brilliant-meta">
        <b>${no}${ply % 2 === 1 ? '.' : '...'} ${move.san}</b>
        <span class="muted small">vs ${opp.username} (${opp.rating}) · ${fmtDate(game.endTime)}</span>
      </div>
    </a>`;
}
