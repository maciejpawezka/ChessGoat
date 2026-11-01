import { html, useState } from 'preact-htm';
import { db, STORES } from '../db.js';
import { useStore, settingsStore, saveSettings, syncStore, bumpData } from '../store.js';
import { runSync, exportData, importData, clearQueue } from '../services.js';

export function Settings() {
  const settings = useStore(settingsStore);
  const sync = useStore(syncStore);
  const [username, setUsername] = useState(settings.username);
  const [msg, setMsg] = useState('');

  const saveUser = () => {
    saveSettings({ username: username.trim() });
    setMsg('Zapisano.');
    runSync();
  };

  const doExport = async () => {
    const data = await exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `chessgoat-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await importData(JSON.parse(await file.text()));
      setMsg('Zaimportowano dane.');
    } catch (err) {
      setMsg(`Błąd importu: ${err.message}`);
    }
  };

  const wipe = async () => {
    if (!confirm('Usunąć wszystkie partie, analizy i zadania z tej przeglądarki?')) return;
    clearQueue();
    for (const s of STORES) await db.clear(s);
    bumpData();
    setMsg('Dane usunięte.');
  };

  return html`
    <div class="page narrow">
      <div class="page-head"><h1>Ustawienia</h1></div>
      ${msg && html`<div class="card">${msg}</div>`}
      <div class="card form">
        <h3>Konto Chess.com</h3>
        <label>Nick
          <div class="row"><input value=${username} onInput=${(e) => setUsername(e.target.value)} />
          <button class="btn primary" onClick=${saveUser}>Zapisz</button></div></label>
        <label class="check"><input type="checkbox" checked=${settings.autoSync} onChange=${(e) => saveSettings({ autoSync: e.target.checked })} />
          Synchronizuj automatycznie przy otwarciu aplikacji</label>
        <label class="check"><input type="checkbox" checked=${settings.autoAnalyze} onChange=${(e) => saveSettings({ autoAnalyze: e.target.checked })} />
          Automatycznie analizuj świeże partie (z ostatnich 2 dni, max 3 na synchronizację)</label>
        <label>Przy pierwszej synchronizacji pobierz
          <select value=${settings.importMonths} onChange=${(e) => saveSettings({ importMonths: Number(e.target.value) })}>
            <option value="1">ostatni miesiąc</option><option value="3">3 miesiące</option><option value="6">6 miesięcy</option>
            <option value="12">12 miesięcy</option><option value="0">całą historię</option>
          </select></label>
        <button class="btn" disabled=${sync.syncing} onClick=${() => runSync({ full: true })}>Pobierz całą historię partii</button>
      </div>

      <div class="card form">
        <h3>Analiza</h3>
        <label>Głębokość Stockfisha
          <select value=${settings.analysisDepth} onChange=${(e) => saveSettings({ analysisDepth: Number(e.target.value) })}>
            <option value="10">10 — bardzo szybko</option><option value="12">12 — szybko</option>
            <option value="14">14 — standard</option><option value="16">16 — dokładnie</option><option value="18">18 — bardzo dokładnie (wolno)</option>
          </select></label>
        <label class="check"><input type="checkbox" checked=${settings.showBestMove} onChange=${(e) => saveSettings({ showBestMove: e.target.checked })} />
          Pokazuj strzałką najlepszy ruch w analizie partii</label>
        <div class="muted small">Analiza działa lokalnie w przeglądarce (Stockfish 17.1) — nic nie jest wysyłane na żaden serwer. Na komputerze kolejka liczy kilka partii naraz (maks. 4). Na telefonie zawsze jedną, żeby aparat się nie grzał. Głębokość 12 jest kilka razy szybsza niż 14.</div>
      </div>

      <div class="card form">
        <h3>Dane</h3>
        <div class="muted small">Wszystko jest zapisane w tej przeglądarce (IndexedDB). Eksport pozwala przenieść dane np. na telefon.</div>
        <div class="btn-row wrap">
          <button class="btn" onClick=${doExport}>Eksportuj (JSON)</button>
          <label class="btn">Importuj<input type="file" accept="application/json" hidden onChange=${doImport} /></label>
          <button class="btn danger" onClick=${wipe}>Wyczyść wszystkie dane</button>
        </div>
      </div>
    </div>`;
}
