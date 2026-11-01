import { db } from './db.js';
import { getEngine } from './engine.js';
import { analyzeGame, buildReview, ANALYSIS_VERSION } from './analysis.js';
import { syncGames } from './chesscom.js';
import { settingsStore, syncStore, queueStore, bumpData } from './store.js';

// Only freshly played games are analysed automatically; older ones on demand.
const AUTO_ANALYZE_LIMIT = 3;
const AUTO_ANALYZE_WINDOW = 2 * 24 * 3600 * 1000;
let pending = [];
let running = false;

export async function analyzeAndSave(game, onProgress) {
  const depth = settingsStore.get().analysisDepth;
  const { analysis, puzzles } = await analyzeGame(game, { engine: getEngine('analysis'), depth, onProgress });
  await saveReview(game, analysis, puzzles);
  bumpData();
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
  const items = ids.map((id) => ({ id, force }));
  const rest = pending.filter((p) => !ids.includes(p.id));
  pending = front ? [...items, ...rest] : [...rest, ...items];
  queueStore.set({ pending: pending.length, queued: pending.map((p) => p.id) });
  if (!running) runQueue();
}

/** Drops games waiting in the queue; the one currently being analysed finishes. */
export function clearQueue() {
  pending = [];
  queueStore.set({ pending: 0, queued: [] });
}


async function runQueue() {
  running = true;
  while (pending.length) {
    const { id, force } = pending.shift();
    queueStore.set({ pending: pending.length, queued: pending.map((p) => p.id), current: id, progress: 0 });
    try {
      const game = await db.get('games', id);
      if (game && (!game.analyzed || force)) {
        await analyzeAndSave(game, (p) => queueStore.set({ progress: p }));
      }
    } catch (e) {
      console.error('Analiza nie powiodła się', id, e);
    }
  }
  queueStore.set({ current: null, progress: 0, pending: 0, queued: [] });
  running = false;
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
  const data = { app: 'chesspro', exportedAt: Date.now(), settings: settingsStore.get() };
  for (const store of ['games', 'analyses', 'puzzles', 'puzzleLog', 'kv']) data[store] = await db.all(store);
  return data;
}

export async function importData(data) {
  if (data.app !== 'chesspro') throw new Error('To nie jest plik eksportu ChessPro.');
  for (const store of ['games', 'analyses', 'puzzles', 'puzzleLog', 'kv']) {
    if (Array.isArray(data[store])) await db.putMany(store, data[store]);
  }
  bumpData();
}
