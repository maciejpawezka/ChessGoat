import { db } from './db.js';
import { getEngine } from './engine.js';
import { analyzeGame, buildReview, ANALYSIS_VERSION } from './analysis.js';
import { syncGames } from './chesscom.js';
import { settingsStore, syncStore, queueStore, bumpData } from './store.js';

// Only freshly played games are analysed automatically; older ones on demand.
const AUTO_ANALYZE_LIMIT = 3;
const AUTO_ANALYZE_WINDOW = 2 * 24 * 3600 * 1000;
let pending = [];
// Phones stay on one engine: several Stockfish workers will heat the device and drain the battery.
// Desktops use one worker per core, leaving one core for the page, and never more than four.
const phone = matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
const WORKER_LIMIT = phone ? 1 : Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const active = new Map();
let slotsRunning = 0;
let nextEngine = 0;
const freeEngines = [];
let publishTimer = 0;

function takeEngine() {
  return freeEngines.pop() || getEngine(`analysis-${nextEngine++}`, { hash: 16 });
}

function publishQueue(immediate = false) {
  const send = () => {
    publishTimer = 0;
    const ids = [...active.keys()];
    const progress = ids.length ? [...active.values()].reduce((a, b) => a + b, 0) / ids.length : 0;
    queueStore.set({
      current: ids[0] ?? null,
      progress,
      pending: pending.length,
      queued: pending.map((p) => p.id),
      active: Object.fromEntries(active),
    });
  };
  if (immediate) {
    clearTimeout(publishTimer);
    send();
    return;
  }
  if (!publishTimer) publishTimer = setTimeout(send, 200);
}

/** Re-classifies analyses made by an older version from their stored engine scores (no engine run). */
export async function migrateAnalyses() {
  const outdated = (await db.all('analyses')).filter((a) => (a.version || 1) < ANALYSIS_VERSION && a.positions);
  for (const a of outdated) {
    const game = await db.get('games', a.gameId);
    if (!game) continue;
    try {
      const { analysis, puzzles } = buildReview(game, a.positions, { depth: a.depth, createdAt: a.createdAt });
      await saveReview(game, analysis, puzzles);
    } catch (e) {
      console.error('Migracja analizy nie powiodła się', a.gameId, e);
    }
  }
  if (outdated.length) bumpData();
}

async function saveReview(game, analysis, puzzles) {
  const mine = game.myColor;
  const opp = mine === 'white' ? 'black' : 'white';
  const myCounts = analysis.counts[mine];

  await db.put('analyses', analysis);
  await db.put('games', {
    ...game,
    analyzed: true,
    accuracy: analysis.accuracy,
    myAccuracy: analysis.accuracy[mine],
    oppAccuracy: analysis.accuracy[opp],
    counts: analysis.counts,
    myBlunders: myCounts.blunder || 0,
    myMistakes: (myCounts.mistake || 0) + (myCounts.miss || 0),
    myInaccuracies: myCounts.inaccuracy || 0,
    myBrilliants: myCounts.brilliant || 0,
    myGreats: myCounts.great || 0,
  });

  // Keep training progress of puzzles that already existed for this game.
  const old = new Map((await db.byIndex('puzzles', 'gameId', game.id)).map((p) => [p.id, p]));
  for (const id of old.keys()) await db.del('puzzles', id);
  await db.putMany('puzzles', puzzles.map((p) => {
    const prev = old.get(p.id);
    return prev ? { ...p, attempts: prev.attempts, successes: prev.successes, streak: prev.streak, due: prev.due, lastAttempt: prev.lastAttempt } : p;
  }));
}

export function enqueueAnalysis(ids, { front = false, force = false } = {}) {
  const fresh = ids.filter((id) => !active.has(id));
  if (!fresh.length) return;
  const items = fresh.map((id) => ({ id, force }));
  const rest = pending.filter((p) => !fresh.includes(p.id));
  pending = front ? [...items, ...rest] : [...rest, ...items];
  publishQueue(true);
  ensureSlots();
}

/** Drops games waiting in the queue; the ones already being analysed finish. */
export function clearQueue() {
  pending = [];
  publishQueue(true);
}

function ensureSlots() {
  while (slotsRunning < WORKER_LIMIT && pending.length) {
    slotsRunning++;
    slot();
  }
}

async function slot() {
  const engine = takeEngine();
  try {
    while (pending.length) {
      const { id, force } = pending.shift();
      active.set(id, 0);
      publishQueue(true);
      try {
        const game = await db.get('games', id);
        if (game && (!game.analyzed || force)) {
          const depth = settingsStore.get().analysisDepth;
          const { analysis, puzzles } = await analyzeGame(game, {
            engine,
            depth,
            onProgress: (p) => {
              active.set(id, p);
              publishQueue();
            },
          });
          await saveReview(game, analysis, puzzles);
          bumpData();
        }
      } catch (e) {
        console.error('Analiza nie powiodła się', id, e);
      } finally {
        active.delete(id);
        publishQueue(true);
      }
    }
  } finally {
    freeEngines.push(engine);
    slotsRunning--;
    if (pending.length) ensureSlots();
  }
}

export async function runSync({ full = false } = {}) {
  const s = settingsStore.get();
  if (!s.username || syncStore.get().syncing) return;
  syncStore.set({ syncing: true, error: '', message: 'Łączenie z Chess.com…' });
  try {
    const { added, newIds } = await syncGames({
      username: s.username,
      importMonths: s.importMonths,
      full,
      onProgress: (message) => syncStore.set({ message }),
    });
    syncStore.set({ message: added ? `Pobrano ${added} nowych partii` : 'Brak nowych partii', lastSync: Date.now() });
    if (added) bumpData();
    if (added && s.autoAnalyze) {
      const games = await Promise.all(newIds.map((id) => db.get('games', id)));
      const fresh = games
        .filter((g) => Date.now() - g.endTime < AUTO_ANALYZE_WINDOW)
        .sort((a, b) => b.endTime - a.endTime)
        .slice(0, AUTO_ANALYZE_LIMIT);
      enqueueAnalysis(fresh.map((g) => g.id));
    }
  } catch (e) {
    syncStore.set({ error: e.message || String(e), message: '' });
  } finally {
    syncStore.set({ syncing: false });
  }
}

export async function initSync() {
  const s = settingsStore.get();
  if (!s.username) return;
  const last = await db.getKV(`lastSync:${s.username.toLowerCase()}`);
  syncStore.set({ lastSync: last });
  await migrateAnalyses();
  if (s.autoSync && (!last || Date.now() - last > 10 * 60 * 1000)) runSync();
}

export async function exportData() {
  const data = { app: 'chessgoat', exportedAt: Date.now(), settings: settingsStore.get() };
  for (const store of ['games', 'analyses', 'puzzles', 'puzzleLog', 'kv']) data[store] = await db.all(store);
  return data;
}

export async function importData(data) {
  if (data.app !== 'chessgoat' && data.app !== 'chesspro') throw new Error('To nie jest plik eksportu ChessGoat.');
  for (const store of ['games', 'analyses', 'puzzles', 'puzzleLog', 'kv']) {
    if (Array.isArray(data[store])) await db.putMany(store, data[store]);
  }
  bumpData();
}
