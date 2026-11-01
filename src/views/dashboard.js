import { html, useState } from 'preact-htm';
import { db } from '../db.js';
import { useStore, dataStore, syncStore, queueStore } from '../store.js';
import { runSync, clearQueue } from '../services.js';
import { openingFamily } from '../chesscom.js';
import { LineChart, StackedBars, useAsync, fmtDate, fmtPct } from '../components.js';
import { GameRow, loadGames, TIME_CLASSES } from './games.js';
import { loadProfile, ProfileStats, Brilliants, PuzzleThemes } from './profile.js';

const RESULT_COLOR = { win: '#30d158', loss: '#ff453a', draw: '#8e8e93' };
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const open = (g) => { location.hash = `#/game/${encodeURIComponent(g.id)}`; };

async function loadDashboard() {
  const [all, puzzles] = await Promise.all([loadGames(), db.all('puzzles')]);
  const games = all.filter((g) => g.source !== 'bot');
  return { games, puzzles, profile: await loadProfile(games) };
}

export function Dashboard() {
  const { version } = useStore(dataStore);
  const sync = useStore(syncStore);
  const queue = useStore(queueStore);
  const { data } = useAsync(loadDashboard, [version]);
  const [tc, setTc] = useState('all');

  if (!data) return html`<div class="card">Ładowanie…</div>`;
  const games = data.games.filter((g) => tc === 'all' || g.timeClass === tc);
  const analyzed = games.filter((g) => g.analyzed && g.myAccuracy !== null && g.myAccuracy !== undefined);
  const last20 = analyzed.slice(0, 20);
  const wins = games.filter((g) => g.result === 'win').length;
  const draws = games.filter((g) => g.result === 'draw').length;
  const losses = games.length - wins - draws;
  const winPct = games.length ? Math.round((wins / games.length) * 100) : 0;
  const due = data.puzzles.filter((p) => p.due <= Date.now()).length;

  const accPoints = [...analyzed].reverse().slice(-100).map((g) => ({
    y: g.myAccuracy,
    color: RESULT_COLOR[g.result],
    title: `${fmtDate(g.endTime)} vs ${g.myColor === 'white' ? g.black.username : g.white.username}: ${g.myAccuracy.toFixed(1)}%`,
    game: g,
  }));

  const ratingTc = tc !== 'all' ? tc : mostPlayed(data.games);
  const ratingPoints = data.games
    .filter((g) => g.timeClass === ratingTc && g.rated)
    .reverse()
    .slice(-200)
    .map((g) => ({ y: g[g.myColor].rating, title: `${fmtDate(g.endTime)}: ${g[g.myColor].rating}`, game: g }));

  const errorItems = [...analyzed].slice(0, 40).reverse().map((g) => ({
    values: { inaccuracy: g.myInaccuracies, mistake: g.myMistakes, blunder: g.myBlunders },
    title: `${fmtDate(g.endTime)}: ${g.myBlunders} blunderów, ${g.myMistakes} błędów, ${g.myInaccuracies} niedokładności`,
    game: g,
  }));

  const syncLabel = sync.syncing ? sync.message
    : sync.lastSync ? `Zsynchronizowano ${new Date(sync.lastSync).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';

  return html`
    <div class="page">
      <div class="page-head">
        <h1>Mój profil</h1>
        <div class="toolbar">
          <span class="muted small">${syncLabel}</span>
          <button class=${`btn icon ${sync.syncing ? 'spinning' : ''}`} title="Synchronizuj z Chess.com" disabled=${sync.syncing} onClick=${() => runSync()}>⟳</button>
        </div>
      </div>
      ${sync.error && html`<div class="card error">${sync.error}</div>`}

      <${ProfileStats} games=${data.games} profile=${data.profile} />

      ${queue.current && html`
        <div class="card banner">
          <span>Analiza ${Object.keys(queue.active || {}).length > 1 ? `${Object.keys(queue.active).length} partii naraz · ` : 'Stockfish '}${Math.round(queue.progress * 100)}%${queue.pending ? ` · w kolejce ${queue.pending}` : ''}</span>
          <div class="progress"><div style=${`width:${queue.progress * 100}%`}></div></div>
          ${queue.pending > 0 && html`<button class="btn ghost small" onClick=${clearQueue}>Zatrzymaj</button>`}
        </div>`}

      <div class="segmented">
        ${TIME_CLASSES.map(([v, l]) => html`<button class=${tc === v ? 'active' : ''} onClick=${() => setTc(v)}>${l}</button>`)}
      </div>

      <div class="stat-grid">
        <${Stat} label="Wygrane" value=${`${winPct}%`} sub=${`${wins} · ${draws} · ${losses} z ${games.length} partii`} />
        <${Stat} label="Dokładność" value=${fmtPct(avg(last20.map((g) => g.myAccuracy)))} sub=${`średnia z ${last20.length} ost. analiz`} />
        <${Stat} label="Blundery na partię" value=${avg(last20.map((g) => g.myBlunders))?.toFixed(1) ?? '–'} sub=${`błędy: ${avg(last20.map((g) => g.myMistakes))?.toFixed(1) ?? '–'}`} />
        <${Stat} label="Do powtórki" value=${due} sub=${`z ${data.puzzles.length} zadań z Twoich błędów`} href="#/puzzles?source=mine" />
      </div>

      <div class="chart-grid">
        <div class="card">
          <h3>Dokładność</h3>
          <${LineChart} points=${accPoints} yMin=${0} yMax=${100} ticks=${[25, 50, 75, 100]} avg=${10} onPick=${(p) => open(p.game)} />
        </div>
        <div class="card">
          <h3>Ranking <span class="muted">${ratingTc || ''}</span></h3>
          <${LineChart} points=${ratingPoints} color="#0a84ff" onPick=${(p) => open(p.game)} />
        </div>
        <div class="card">
          <h3>Błędy na partię</h3>
          <${StackedBars} items=${errorItems} keys=${['inaccuracy', 'mistake', 'blunder']} onPick=${(it) => open(it.game)} />
        </div>
        <div class="card">
          <h3>Debiuty</h3>
          <${Openings} games=${games} />
        </div>
      </div>

      <${Brilliants} games=${data.games} profile=${data.profile} />
      <${PuzzleThemes} profile=${data.profile} />

      <div class="card list">
        <div class="list-head"><h3>Ostatnie partie</h3><a href="#/games">Wszystkie</a></div>
        ${games.slice(0, 6).map((g) => html`<${GameRow} key=${g.id} game=${g} />`)}
        ${!games.length && html`<div class="muted empty-state">Brak partii — zsynchronizuj z Chess.com.</div>`}
      </div>
    </div>`;
}

function Stat({ label, value, sub, href }) {
  const body = html`<div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="muted small">${sub}</div>`;
  return href ? html`<a class="card stat link" href=${href}>${body}</a>` : html`<div class="card stat">${body}</div>`;
}

function mostPlayed(games) {
  const counts = {};
  games.forEach((g) => { counts[g.timeClass] = (counts[g.timeClass] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function Openings({ games }) {
  const groups = new Map();
  for (const g of games) {
    const key = `${g.myColor}|${openingFamily(g.opening)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  if (!rows.length) return html`<div class="empty-chart">Brak danych</div>`;
  return html`
    <table class="table">
      <thead><tr><th>Debiut</th><th>Partie</th><th>W · R · P</th><th>Dokł.</th></tr></thead>
      <tbody>
        ${rows.map(([key, gs]) => {
          const [color, name] = key.split('|');
          const w = gs.filter((g) => g.result === 'win').length;
          const d = gs.filter((g) => g.result === 'draw').length;
          const acc = avg(gs.filter((g) => g.analyzed).map((g) => g.myAccuracy));
          return html`<tr>
            <td><span class=${`color-dot ${color}`}></span> ${name}</td>
            <td>${gs.length}</td>
            <td><span class="win">${w}</span> · <span class="muted">${d}</span> · <span class="loss">${gs.length - w - d}</span></td>
            <td>${fmtPct(acc)}</td>
          </tr>`;
        })}
      </tbody>
    </table>`;
}
