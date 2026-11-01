import { html, useState } from 'preact-htm';
import { db } from '../db.js';
import { useStore, dataStore, queueStore } from '../store.js';
import { enqueueAnalysis, clearQueue } from '../services.js';
import { useAsync, fmtDate, ClassIcon } from '../components.js';

const RESULT_LABEL = { win: 'W', loss: 'P', draw: 'R', unfinished: '–' };
export const TIME_CLASSES = [['all', 'Wszystkie'], ['bullet', 'Bullet'], ['blitz', 'Blitz'], ['rapid', 'Rapid'], ['daily', 'Daily']];

export async function loadGames() {
  const games = await db.all('games');
  return games.sort((a, b) => b.endTime - a.endTime);
}

/** Always three fixed slots: best highlight (brilliant, else great), mistakes, blunders. */
function MoveIcons({ game }) {
  const highlight = game.myBrilliants > 0 ? ['brilliant', game.myBrilliants] : game.myGreats > 0 ? ['great', game.myGreats] : null;
  const slot = (cls, n) => html`<span class=${`icon-slot ${n ? '' : 'zero'}`}><${ClassIcon} cls=${cls} size=${16} /><span>${n}</span></span>`;
  return html`
    <span class="move-icons">
      ${highlight ? slot(...highlight) : html`<span class="icon-slot empty"></span>`}
      ${slot('mistake', game.myMistakes || 0)}
      ${slot('blunder', game.myBlunders || 0)}
    </span>`;
}

export function GameRow({ game, selected, onToggle }) {
  const queue = useStore(queueStore);
  const opp = game.myColor === 'white' ? game.black : game.white;
  const open = () => { location.hash = `#/game/${encodeURIComponent(game.id)}`; };
  let acc;
  const live = queue.active?.[game.id];
  if (game.analyzed) acc = html`<b>${game.myAccuracy?.toFixed(1)}%</b>`;
  else if (live != null) acc = html`<span class="muted small">${Math.round(live * 100)}%</span>`;
  else if (queue.queued?.includes(game.id)) acc = html`<span class="muted small">w kolejce</span>`;
  else acc = html`<span class="muted small">—</span>`;

  return html`
    <div class=${`game-row ${selected ? 'selected' : ''} ${game.myBrilliants > 0 ? 'brilliant' : ''}`} onClick=${open}>
      ${onToggle && html`
        <label class="select-box" onClick=${(e) => e.stopPropagation()}>
          <input type="checkbox" checked=${selected} disabled=${game.analyzed} onChange=${() => onToggle(game.id)} />
        </label>`}
      <span class=${`result-badge ${game.result}`}>${RESULT_LABEL[game.result]}</span>
      <span class="game-opp">
        <span class=${`color-dot ${game.myColor}`}></span>
        <span class="opp-name">${opp.username}</span>
        <span class="muted small">${opp.rating}</span>
        ${game.source === 'bot' && html`<span class="tag">bot</span>`}
      </span>
      <span class="muted small hide-sm">${game.timeClass}</span>
      <span class="game-acc">${acc}</span>
      ${game.analyzed ? html`<${MoveIcons} game=${game} />` : html`<span class="move-icons hide-sm"></span>`}
      <span class="muted small game-date">${fmtDate(game.endTime)}</span>
    </div>`;
}

export function Games() {
  const { version } = useStore(dataStore);
  const queue = useStore(queueStore);
  const { data: games } = useAsync(loadGames, [version]);
  const [tc, setTc] = useState('all');
  const [res, setRes] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState(() => new Set());

  if (!games) return html`<div class="card">Ładowanie…</div>`;
  const filtered = games.filter((g) => (tc === 'all' || g.timeClass === tc)
    && (res === 'all' || g.result === res)
    && (status === 'all' || (status === 'analyzed') === !!g.analyzed)
    && (!q || `${g.white.username} ${g.black.username} ${g.opening}`.toLowerCase().includes(q.toLowerCase())));
  const visible = filtered.slice(0, limit);
  const activeIds = new Set(Object.keys(queue.active || {}));
  const pendingAll = filtered.filter((g) => !g.analyzed && !activeIds.has(g.id) && !queue.queued?.includes(g.id));

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const analyzeSelected = () => {
    enqueueAnalysis([...selected]);
    setSelected(new Set());
  };

  return html`
    <div class="page">
      <div class="page-head">
        <h1>Partie <span class="muted">${filtered.length}</span></h1>
        <div class="toolbar">
          ${activeIds.size > 0 && html`
            <span class="muted small">Analiza ${activeIds.size > 1 ? `${activeIds.size} partii naraz · ` : ''}${Math.round(queue.progress * 100)}%${queue.pending ? ` · w kolejce ${queue.pending}` : ''}</span>
            ${queue.pending > 0 && html`<button class="btn" onClick=${clearQueue}>Zatrzymaj kolejkę</button>`}`}
          ${selected.size > 0
            ? html`<button class="btn ghost" onClick=${() => setSelected(new Set())}>Odznacz</button>
                <button class="btn primary" onClick=${analyzeSelected}>Analizuj zaznaczone (${selected.size})</button>`
            : pendingAll.length > 0 && html`<button class="btn" onClick=${() => enqueueAnalysis(pendingAll.map((g) => g.id))}>Analizuj wszystkie (${pendingAll.length})</button>`}
        </div>
      </div>
      <div class="filters">
        <div class="segmented">
          ${TIME_CLASSES.map(([v, l]) => html`<button class=${tc === v ? 'active' : ''} onClick=${() => setTc(v)}>${l}</button>`)}
        </div>
        <select value=${res} onChange=${(e) => setRes(e.target.value)}>
          <option value="all">Każdy wynik</option><option value="win">Wygrane</option><option value="loss">Przegrane</option><option value="draw">Remisy</option>
        </select>
        <select value=${status} onChange=${(e) => setStatus(e.target.value)}>
          <option value="all">Wszystkie</option><option value="analyzed">Przeanalizowane</option><option value="pending">Bez analizy</option>
        </select>
        <input class="search" placeholder="Szukaj rywala lub debiutu" value=${q} onInput=${(e) => setQ(e.target.value)} />
      </div>
      <div class="card list">
        ${visible.map((g) => html`<${GameRow} key=${g.id} game=${g} selected=${selected.has(g.id)} onToggle=${toggle} />`)}
        ${!filtered.length && html`<div class="muted empty-state">Brak partii.</div>`}
      </div>
      ${filtered.length > limit && html`<button class="btn ghost center" onClick=${() => setLimit(limit + 50)}>Pokaż więcej</button>`}
    </div>`;
}
