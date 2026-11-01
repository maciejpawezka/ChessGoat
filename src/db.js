const DB_NAME = 'chesspro';
const DB_VERSION = 1;
export const STORES = ['games', 'analyses', 'puzzles', 'puzzleLog', 'kv'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        const games = db.createObjectStore('games', { keyPath: 'id' });
        games.createIndex('endTime', 'endTime');
        db.createObjectStore('analyses', { keyPath: 'gameId' });
        const puzzles = db.createObjectStore('puzzles', { keyPath: 'id' });
        puzzles.createIndex('gameId', 'gameId');
        db.createObjectStore('puzzleLog', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('kv', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(t.objectStore(store));
  await done;
  return result;
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => req(s.get(key))),
  all: (store) => tx(store, 'readonly', (s) => req(s.getAll())),
  keys: (store) => tx(store, 'readonly', (s) => req(s.getAllKeys())),
  byIndex: (store, index, key) => tx(store, 'readonly', (s) => req(s.index(index).getAll(key))),
  put: (store, value) => tx(store, 'readwrite', (s) => req(s.put(value))),
  putMany: (store, values) => tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
  del: (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key))),
  clear: (store) => tx(store, 'readwrite', (s) => req(s.clear())),
  async getKV(key, fallback = null) {
    const row = await db.get('kv', key);
    return row ? row.value : fallback;
  },
  setKV: (key, value) => db.put('kv', { key, value }),
};
