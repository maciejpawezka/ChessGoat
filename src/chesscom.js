import { db } from './db.js';

const API = 'https://api.chess.com/pub/player';
const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url);
  if (res.status === 429 && attempt < 4) {
    await sleep(1500 * (attempt + 1));
    return fetchJson(url, attempt + 1);
  }
  if (res.status === 404) throw new Error('Nie znaleziono gracza na Chess.com — sprawdź nick w Ustawieniach.');
  if (!res.ok) throw new Error(`Chess.com API: HTTP ${res.status}`);
  return res.json();
}

function pgnHeader(pgn, name) {
  const m = pgn.match(new RegExp(`\\[${name} "([^"]*)"\\]`));
  return m ? m[1] : '';
}

function openingName(pgn) {
  const url = pgnHeader(pgn, 'ECOUrl');
  if (!url) return '';
  const slug = decodeURIComponent(url.split('/openings/')[1] || '');
  return slug.replace(/-/g, ' ').replace(/\s\d+\..*$/, '').trim();
}

const FAMILY_END = /^(Opening|Defense|Game|Gambit|Attack|System|Countergambit)$/;

export function openingFamily(name) {
  if (!name) return 'Nieznane';
  const words = name.split(' ');
  const end = words.findIndex((w) => FAMILY_END.test(w));
  return words.slice(0, end >= 0 ? end + 1 : 2).join(' ');
}

export function normalizeGame(g, username) {
  const myColor = g.white.username.toLowerCase() === username.toLowerCase() ? 'white' : 'black';
  const me = g[myColor];
  const opp = g[myColor === 'white' ? 'black' : 'white'];
  const result = me.result === 'win' ? 'win' : DRAW_RESULTS.has(me.result) ? 'draw' : 'loss';
  return {
    id: g.uuid || g.url,
    source: 'chesscom',
    url: g.url,
    pgn: g.pgn,
    endTime: g.end_time * 1000,
    timeClass: g.time_class,
    timeControl: g.time_control,
    rated: g.rated,
    white: { username: g.white.username, rating: g.white.rating, result: g.white.result },
    black: { username: g.black.username, rating: g.black.rating, result: g.black.result },
    myColor,
    result,
    termination: result === 'win' ? opp.result : me.result,
    eco: pgnHeader(g.pgn, 'ECO'),
    opening: openingName(g.pgn),
    chesscomAccuracy: g.accuracies || null,
    analyzed: false,
  };
}

/**
 * Pulls new games from the public Chess.com API. Completed months are remembered
 * so later syncs only re-download the current month.
 */
export async function syncGames({ username, importMonths = 6, full = false, onProgress }) {
  const user = username.toLowerCase();
  const syncedKey = `syncedArchives:${user}`;
  const { archives = [] } = await fetchJson(`${API}/${encodeURIComponent(user)}/games/archives`);
  const synced = new Set(await db.getKV(syncedKey, []));
  const lastSync = await db.getKV(`lastSync:${user}`);

  let todo = archives.filter((a) => !synced.has(a));
  if (!lastSync && !full && importMonths > 0) todo = todo.slice(-importMonths);

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const existing = new Set(await db.keys('games'));
  const newIds = [];

  for (let i = 0; i < todo.length; i++) {
    const url = todo[i];
    onProgress?.(`Pobieranie ${url.slice(-7)} (${i + 1}/${todo.length})…`);
    const data = await fetchJson(url);
    const games = (data.games || [])
      .filter((g) => g.rules === 'chess' && g.pgn)
      .map((g) => normalizeGame(g, username))
      .filter((g) => !existing.has(g.id));
    if (games.length) {
      await db.putMany('games', games);
      games.forEach((g) => { existing.add(g.id); newIds.push(g.id); });
    }
    if (!url.endsWith(currentMonth)) {
      synced.add(url);
      await db.setKV(syncedKey, [...synced]);
    }
  }
  await db.setKV(`lastSync:${user}`, Date.now());
  return { added: newIds.length, newIds };
}
