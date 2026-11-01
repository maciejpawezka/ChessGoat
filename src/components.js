import { html, useEffect, useRef, useState } from 'preact-htm';
import { Chessground } from 'chessground';
import { Chess } from 'chess.js';
import { CLASSES } from './analysis.js';

export function legalDests(fen) {
  const dests = new Map();
  try {
    for (const m of new Chess(fen).moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
  } catch { /* invalid FEN: no moves */ }
  return dests;
}

function squarePos(square, orientation) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === 'white'
    ? { left: file * 12.5, top: (7 - rank) * 12.5 }
    : { left: (7 - file) * 12.5, top: rank * 12.5 };
}

/** Knight silhouette with goat horns and beard; keep in sync with icon.svg. */
export function GoatKnight({ size = 24 }) {
  return html`
    <svg class="goat-knight" width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
      <g fill="currentColor">
        <path d="M26 15C27 6 36 2 45 5c5 2 8 7 7 14-3-6-8-9-14-8-4 1-7 3-9 6z" />
        <path d="M22 47c0-6 3-10 7-14l-4-2c-4 1-8 1-11-1-3-1-4-4-2-6l9-9c3-3 6-4 10-4 9 0 15 7 15 17 0 8-3 12-3 19z" />
        <path d="M14 30l-1 9 6-8z" />
        <rect x="17" y="49" width="31" height="7" rx="2.5" />
      </g>
      <path class="cut" fill="none" stroke-width="2.4" stroke-linecap="round" d="M29 17c2-3 5-5 9-6" />
      <circle class="cut" cx="23" cy="20" r="2.4" />
    </svg>`;
}

const PROMO_PIECES = [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']];

/**
 * Chessground board. `interactive` lets the side to move play legal moves; `onMove(from, to, promotion)`.
 * Bump `syncKey` to force the board back to `fen` (e.g. after rejecting a move).
 */
export function Board({ fen, orientation = 'white', interactive = false, onMove, lastMove = null, shapes = [], badges = [], syncKey = 0 }) {
  const el = useRef();
  const cg = useRef();
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const [promo, setPromo] = useState(null);

  useEffect(() => {
    cg.current = Chessground(el.current, {
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      premovable: { enabled: false },
      drawable: { enabled: true, visible: true },
      movable: {
        free: false,
        showDests: true,
        events: {
          after: (orig, dest) => {
            const piece = cg.current.state.pieces.get(dest);
            if (piece?.role === 'pawn' && (dest[1] === '8' || dest[1] === '1')) setPromo({ orig, dest, color: piece.color });
            else onMoveRef.current?.(orig, dest);
          },
        },
      },
    });
    const onResize = () => document.body.dispatchEvent(new Event('chessground.resize'));
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cg.current.destroy();
    };
  }, []);

  const key = [fen, orientation, interactive, lastMove?.join('') || '', syncKey].join('|');
  useEffect(() => {
    const chess = new Chess(fen);
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    cg.current.set({
      fen,
      orientation,
      turnColor: turn,
      lastMove: lastMove || undefined,
      check: chess.inCheck() ? turn : false,
      movable: { color: interactive ? turn : undefined, dests: interactive ? legalDests(fen) : new Map() },
    });
    setPromo(null);
  }, [key]);

  const shapesKey = JSON.stringify(shapes);
  useEffect(() => cg.current.setAutoShapes(shapes), [shapesKey]);

  const pickPromo = (p) => {
    const { orig, dest } = promo;
    setPromo(null);
    onMoveRef.current?.(orig, dest, p);
  };

  return html`
    <div class="board-container">
      <div class="board" ref=${el}></div>
      ${badges.map((b) => {
        const pos = squarePos(b.square, orientation);
        const c = CLASSES[b.cls];
        return c && html`<div class="board-badge" style=${`left:calc(${pos.left + 12.5}% - 14px);top:calc(${pos.top}% - 6px);background:${c.color}`}>${c.symbol}</div>`;
      })}
      ${promo && html`
        <div class="promo-overlay cg-wrap" onClick=${() => { setPromo(null); cg.current.set({ fen }); }}>
          <div class="promo-box">
            ${PROMO_PIECES.map(([p, role]) => html`
              <button onClick=${(e) => { e.stopPropagation(); pickPromo(p); }}><piece class=${`${role} ${promo.color}`}></piece></button>`)}
          </div>
        </div>`}
    </div>`;
}

const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** Lightweight static board for thumbnails (no Chessground instance). */
export function MiniBoard({ fen, orientation = 'white', highlight = [], badge = null }) {
  const pieces = [];
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      pieces.push({ square: `${String.fromCharCode(97 + f)}${8 - r}`, role: ROLES[ch.toLowerCase()], color: ch === ch.toUpperCase() ? 'white' : 'black' });
      f++;
    }
  });
  const at = (sq) => squarePos(sq, orientation);
  const c = badge && CLASSES[badge.cls];
  return html`
    <div class="mini-board cg-wrap">
      ${highlight.map((sq) => html`<div class="mini-hl" style=${`left:${at(sq).left}%;top:${at(sq).top}%`}></div>`)}
      ${pieces.map((p) => html`<piece class=${`${p.role} ${p.color}`} style=${`left:${at(p.square).left}%;top:${at(p.square).top}%`}></piece>`)}
      ${c && html`<div class="mini-badge" style=${`left:calc(${at(badge.square).left + 12.5}% - 11px);top:calc(${at(badge.square).top}% - 4px);background:${c.color}`}>${c.symbol}</div>`}
    </div>`;
}

export function EvalBar({ whiteWin = 50, label = '', orientation = 'white' }) {
  const flipped = orientation === 'black';
  const whiteBetter = whiteWin >= 50;
  return html`
    <div class=${`eval-bar ${flipped ? 'flipped' : ''}`}>
      <div class="eval-white" style=${`height:${whiteWin}%`}></div>
      <span class=${`eval-label ${whiteBetter ? 'bottom dark' : 'top light'}`}>${label}</span>
    </div>`;
}

export function ClassIcon({ cls, size = 18 }) {
  const c = CLASSES[cls];
  if (!c) return null;
  return html`<span class="class-icon" title=${c.label} style=${`background:${c.color};width:${size}px;height:${size}px;font-size:${size * 0.55}px`}>${c.symbol}</span>`;
}

export function EvalGraph({ whiteWins, moves = [], index, onSelect }) {
  const n = Math.max(1, whiteWins.length - 1);
  const pts = whiteWins.map((w, i) => `${(i / n) * 1000},${100 - w}`).join(' ');
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSelect?.(Math.round(((e.clientX - r.left) / r.width) * n));
  };
  return html`
    <div class="eval-graph" onClick=${pick}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        <polygon points=${`0,100 ${pts} 1000,100`} fill="#f5f5f7" fill-opacity="0.92" />
        <line x1="0" y1="50" x2="1000" y2="50" stroke="rgba(255,255,255,0.25)" stroke-width="1" vector-effect="non-scaling-stroke" />
      </svg>
      ${moves.map((m, i) => ['brilliant', 'great', 'blunder', 'mistake', 'miss'].includes(m.cls) && html`
        <span class="graph-dot" style=${`left:${((i + 1) / n) * 100}%;top:${100 - whiteWins[i + 1]}%;background:${CLASSES[m.cls].color}`}></span>`)}
      <span class="graph-cursor" style=${`left:${(index / n) * 100}%`}></span>
    </div>`;
}

export function MoveList({ moves, index, onSelect, startPly = 0 }) {
  const ref = useRef();
  useEffect(() => {
    const box = ref.current;
    const active = box?.querySelector('.move.active');
    if (!active) return;
    const top = active.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (top + active.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + active.offsetHeight - box.clientHeight + 8;
  }, [index, moves.length]);
  const rows = [];
  const blackFirst = startPly % 2 === 1;
  const all = blackFirst ? [null, ...moves] : moves;
  for (let i = 0; i < all.length; i += 2) rows.push([all[i], all[i + 1], i]);
  const plyOf = (k) => (blackFirst ? k : k + 1);
  const cell = (m, k) => {
    if (!m) return html`<span class="move empty"></span>`;
    const ply = plyOf(k);
    return html`
      <span class=${`move ${ply === index ? 'active' : ''}`} onClick=${() => onSelect?.(ply)}>
        ${m.cls && html`<${ClassIcon} cls=${m.cls} size=${15} />`} ${m.san}
      </span>`;
  };
  return html`
    <div class="move-list" ref=${ref}>
      ${rows.map(([w, b, k]) => html`
        <div class="move-row">
          <span class="move-no">${Math.floor((startPly + k) / 2) + 1}.</span>
          ${cell(w, k)}${cell(b, k + 1)}
        </div>`)}
    </div>`;
}

/** Simple responsive SVG line chart with an optional moving average. */
export function LineChart({ points, yMin, yMax, height = 180, color = '#30d158', avg = 0, ticks = [], onPick }) {
  const W = 600, H = height, L = 34, B = 16, T = 8;
  if (!points.length) return html`<div class="empty-chart">Brak danych</div>`;
  const lo = yMin ?? Math.min(...points.map((p) => p.y));
  const hi = yMax ?? Math.max(...points.map((p) => p.y));
  const span = hi - lo || 1;
  const x = (i) => L + (points.length === 1 ? (W - L) / 2 : (i / (points.length - 1)) * (W - L - 6));
  const y = (v) => T + (1 - (v - lo) / span) * (H - T - B);
  const line = points.map((p, i) => `${x(i)},${y(p.y)}`).join(' ');
  let avgLine = '';
  if (avg > 1 && points.length > avg) {
    avgLine = points.map((_, i) => {
      const win = points.slice(Math.max(0, i - avg + 1), i + 1);
      return `${x(i)},${y(win.reduce((a, p) => a + p.y, 0) / win.length)}`;
    }).join(' ');
  }
  const tickVals = ticks.length ? ticks : [lo, lo + span / 2, hi].map(Math.round);
  return html`
    <svg class="chart" viewBox=${`0 0 ${W} ${H}`}>
      ${tickVals.map((t) => html`
        <line x1=${L} x2=${W} y1=${y(t)} y2=${y(t)} stroke="rgba(255,255,255,0.07)" />
        <text x=${L - 6} y=${y(t) + 4} text-anchor="end" class="chart-label">${t}</text>`)}
      <polyline points=${line} fill="none" stroke=${color} stroke-width="1.5" opacity=${avgLine ? 0.45 : 1} />
      ${avgLine && html`<polyline points=${avgLine} fill="none" stroke=${color} stroke-width="2.5" />`}
      ${points.map((p, i) => html`
        <circle cx=${x(i)} cy=${y(p.y)} r="3" fill=${p.color || color} class=${onPick ? 'clickable' : ''} onClick=${() => onPick?.(p)}>
          <title>${p.title}</title>
        </circle>`)}
    </svg>`;
}

export function StackedBars({ items, keys, height = 160, onPick }) {
  const W = 600, H = height, L = 24, B = 4, T = 6;
  if (!items.length) return html`<div class="empty-chart">Brak danych</div>`;
  const max = Math.max(1, ...items.map((it) => keys.reduce((a, k) => a + (it.values[k] || 0), 0)));
  const bw = (W - L) / items.length;
  const y = (v) => ((H - T - B) * v) / max;
  return html`
    <svg class="chart" viewBox=${`0 0 ${W} ${H}`}>
      ${[0, Math.ceil(max / 2), max].map((t) => html`
        <line x1=${L} x2=${W} y1=${H - B - y(t)} y2=${H - B - y(t)} stroke="rgba(255,255,255,0.07)" />
        <text x=${L - 6} y=${H - B - y(t) + 4} text-anchor="end" class="chart-label">${t}</text>`)}
      ${items.map((it, i) => {
        let acc = 0;
        return html`<g class=${onPick ? 'clickable' : ''} onClick=${() => onPick?.(it)}>
          <title>${it.title}</title>
          <rect x=${L + i * bw} y=${T} width=${bw} height=${H - T - B} fill="transparent" />
          ${keys.map((k) => {
            const v = it.values[k] || 0;
            const h = y(v);
            acc += h;
            return v ? html`<rect x=${L + i * bw + bw * 0.15} y=${H - B - acc} width=${bw * 0.7} height=${h} fill=${CLASSES[k].color} />` : null;
          })}
        </g>`;
      })}
    </svg>`;
}

export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ loading: false, data, error: null }),
      (error) => alive && setState({ loading: false, data: null, error }),
    );
    return () => { alive = false; };
  }, deps);
  return state;
}

export const fmtDate = (ts) => new Date(ts).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtPct = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(1)}%`);
