import { html, render, useState, useEffect } from 'preact-htm';
import { useStore, settingsStore, saveSettings, syncStore, queueStore } from './store.js';
import { initSync } from './services.js';
import { startCursorField } from './cursorfx.js';
import { GoatKnight } from './components.js';
import { Dashboard } from './views/dashboard.js';
import { Games } from './views/games.js';
import { Review } from './views/review.js';
import { Puzzles } from './views/puzzles.js';
import { Play } from './views/play.js';
import { Settings } from './views/settings.js';

const NAV = [
  ['games', 'Partie'],
  ['puzzles', 'Puzzle'],
  ['play', 'Graj'],
  ['settings', 'Ustawienia'],
];
const NAV_ALIAS = { game: 'games', trainer: 'puzzles' };

function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs || '') };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Nav({ section }) {
  const sync = useStore(syncStore);
  const queue = useStore(queueStore);
  return html`
    <nav class="nav">
      <a class=${`logo ${section === '' ? 'active' : ''}`} href="#/" title="Mój profil" aria-label="Mój profil"><${GoatKnight} size=${22} /></a>
      <div class="nav-links">
        ${NAV.map(([key, label]) => html`<a class=${section === key ? 'active' : ''} href=${`#/${key}`}>${label}</a>`)}
      </div>
      ${(sync.syncing || queue.current) && html`
        <div class="nav-status" title=${sync.syncing ? sync.message : `Analiza ${Object.keys(queue.active || {}).length > 1 ? `${Object.keys(queue.active).length} partii naraz, ` : ''}${Math.round(queue.progress * 100)}%${queue.pending ? `, w kolejce ${queue.pending}` : ''}`}>
          <span class="spinner"></span>
        </div>`}
    </nav>`;
}

function Onboarding() {
  const [name, setName] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    saveSettings({ username: name.trim() });
    initSync();
  };
  return html`
    <div class="onboarding">
      <form class="card form" onSubmit=${submit}>
        <h1 class="row"><${GoatKnight} size=${30} /> ChessGoat</h1>
        <p>Podaj swój nick z Chess.com. Zapamiętam go — przy kolejnych wizytach partie będą pobierane automatycznie.</p>
        <input autofocus placeholder="nick na Chess.com" value=${name} onInput=${(e) => setName(e.target.value)} />
        <button class="btn primary" type="submit">Start</button>
        <p class="muted small">Możesz też wpisać nick na stałe w pliku <code>config.js</code>.</p>
      </form>
    </div>`;
}

function App() {
  const settings = useStore(settingsStore);
  const { parts, query } = useRoute();
  if (!settings.username) return html`<${Onboarding} />`;

  const [section, arg] = parts;
  let view;
  switch (section) {
    case 'games': view = html`<${Games} />`; break;
    case 'game': view = html`<${Review} key=${arg} id=${arg} query=${query} />`; break;
    case 'trainer': query.set('source', 'mine'); // falls through
    case 'puzzles': view = html`<${Puzzles} key=${query.toString()} query=${query} />`; break;
    case 'play': view = html`<${Play} key=${query.toString()} query=${query} />`; break;
    case 'settings': view = html`<${Settings} />`; break;
    default: view = html`<${Dashboard} />`;
  }
  return html`
    <div class="app">
      <${Nav} section=${NAV_ALIAS[section] || section || ''} />
      <main class="main">${view}</main>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
initSync();
startCursorField();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
