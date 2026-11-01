import { useState, useEffect } from 'preact-htm';
import { CONFIG } from '../config.js';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      subs.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore(store) {
  const [state, setState] = useState(store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(setState);
  }, [store]);
  return state;
}

const SETTINGS_KEY = 'chesspro.settings';

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch { /* corrupted settings fall back to defaults */ }
  return {
    importMonths: CONFIG.importMonths,
    analysisDepth: CONFIG.analysisDepth,
    autoSync: true,
    autoAnalyze: true,
    showBestMove: false,
    ...saved,
    username: (saved.username || CONFIG.username || '').trim(),
  };
}

export const settingsStore = createStore(loadSettings());

export function saveSettings(patch) {
  settingsStore.set(patch);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsStore.get()));
}

// Bumped whenever games/analyses/puzzles change so views can reload from IndexedDB.
export const dataStore = createStore({ version: 0 });
export const bumpData = () => dataStore.set((s) => ({ version: s.version + 1 }));

export const syncStore = createStore({ syncing: false, message: '', error: '', lastSync: null });

export const queueStore = createStore({ current: null, progress: 0, pending: 0, queued: [] });
