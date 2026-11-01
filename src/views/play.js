import { html, useState, useEffect, useRef } from 'preact-htm';
import { Chess } from 'chess.js';
import { db } from '../db.js';
import { getEngine } from '../engine.js';
import { useStore, settingsStore, bumpData } from '../store.js';
import { enqueueAnalysis } from '../services.js';
import { CLASSES, classifyMove, winPct, sanFromUci } from '../analysis.js';
import { Board, EvalBar, MoveList, ClassIcon } from '../components.js';
import { useLiveEval } from '../live.js';

const LIMITED = (elo) => ({ 'Skill Level': 20, UCI_LimitStrength: 'true', UCI_Elo: elo });
const SKILL = (skill) => ({ UCI_LimitStrength: 'false', 'Skill Level': skill });
const LEVELS = [
  { label: 'Poziom 1 (~500)', options: SKILL(0), depth: 1 },
  { label: 'Poziom 2 (~800)', options: SKILL(2), depth: 2 },
  { label: 'Poziom 3 (~1000)', options: SKILL(4), depth: 4 },
  { label: 'Poziom 4 (~1200)', options: SKILL(7), depth: 6 },
  { label: 'Poziom 5 (~1400)', options: LIMITED(1400), movetime: 600 },
  { label: 'Poziom 6 (~1700)', options: LIMITED(1700), movetime: 700 },
  { label: 'Poziom 7 (~2000)', options: LIMITED(2000), movetime: 800 },
  { label: 'Poziom 8 (~2300)', options: LIMITED(2300), movetime: 1000 },
  { label: 'Poziom 9 (~2700)', options: LIMITED(2700), movetime: 1200 },
  { label: 'Pełna siła Stockfisha', options: SKILL(20), movetime: 1500 },
];
const START = new Chess().fen();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = new Set(['brilliant', 'great', 'best', 'excellent', 'good', 'forced']);
const toEntry = (chess, mv) => ({ fen: chess.fen(), san: mv.san, from: mv.from, to: mv.to, lan: mv.lan, captured: mv.captured });

export function Play({ query }) {
  const settings = useStore(settingsStore);
  const startFen = query.get('fen') || START;
  const [setup, setSetup] = useState(() => ({
    color: new Chess(startFen).turn() === 'b' ? 'black' : 'white',
    level: Number(localStorage.getItem('chesspro.botLevel') || 3),
    coach: localStorage.getItem('chesspro.coach') !== 'false',
    showEval: false,
  }));
  const [game, setGame] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [hint, setHint] = useState(null);
  const [thinking, setThinking] = useState(false);
  const token = useRef(0);
  const evalCache = useRef(new Map());

  const history = game?.history || [];
  const fen = history.length ? history[history.length - 1].fen : game?.startFen || startFen;
  const live = useLiveEval(game ? fen : null, !!game && setup.showEval, { depth: 14, multipv: 1 });

  const coachEval = async (f) => {
    const terminal = new Chess(f);
    if (terminal.isCheckmate()) return { win: 0, mate: 0, best: null, secondWin: null };
    if (terminal.isGameOver()) return { win: 50, mate: null, best: null, secondWin: null };
    if (!evalCache.current.has(f)) {
      evalCache.current.set(f, getEngine('live').search(f, { depth: 12, multipv: 2, tag: 'coach' }).then((r) => {
        const [l1, l2] = r.lines;
        return {
          win: l1 ? winPct(l1) : 50,
          mate: l1 ? l1.mate : null,
          best: r.bestmove,
          secondWin: l2 ? winPct(l2) : null,
        };
      }));
    }
    return evalCache.current.get(f);
  };

  const status = (() => {
    if (!game) return null;
    const c = new Chess(fen);
    if (game.resigned) return { over: true, text: 'Poddałeś partię.', result: 'loss' };
    if (c.isCheckmate()) {
      const iLost = (c.turn() === 'w') === (game.color === 'white');
      return { over: true, text: iLost ? 'Mat — przegrana.' : 'Mat — wygrałeś!', result: iLost ? 'loss' : 'win' };
    }
    if (c.isDraw() || c.isStalemate()) return { over: true, text: 'Remis.', result: 'draw' };
    return { over: false, myTurn: (c.turn() === 'w') === (game.color === 'white') };
  })();

  // Bot's turn.
  useEffect(() => {
    if (!game || !status || status.over || status.myTurn) return;
    const my = ++token.current;
    const level = LEVELS[game.level];
    setThinking(true);
    (async () => {
      const [r] = await Promise.all([
        getEngine('bot').search(fen, { depth: level.depth, movetime: level.movetime, options: level.options }),
        sleep(350),
      ]);
      if (my !== token.current || !r.bestmove) return;
      const chess = new Chess(fen);
      const mv = chess.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] });
      setGame((g) => ({ ...g, history: [...g.history, toEntry(chess, mv)] }));
      setThinking(false);
    })();
  }, [fen, !!game]);

  // Coach pre-computes the position before my move so feedback is instant.
  useEffect(() => {
    if (game?.coach && status && !status.over && status.myTurn) coachEval(fen);
  }, [fen, game?.coach]);

  const start = () => {
    localStorage.setItem('chesspro.botLevel', setup.level);
    localStorage.setItem('chesspro.coach', setup.coach);
    token.current++;
    evalCache.current.clear();
    const color = setup.color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : setup.color;
    setGame({ startFen, color, level: setup.level, coach: setup.coach, history: [], resigned: false, saved: null });
    setFeedback(null);
    setHint(null);
    setThinking(false);
  };

  const onMove = async (from, to, promotion) => {
    if (!status?.myTurn) return;
    const before = fen;
    const chess = new Chess(before);
    let mv;
    try { mv = chess.move({ from, to, promotion }); } catch { return; }
    const ply = history.length;
    setHint(null);
    setFeedback(game.coach ? { pending: true } : null);
    setGame((g) => ({ ...g, history: [...g.history, toEntry(chess, mv)] }));
    if (!game.coach) return;

    const [eb, ea] = await Promise.all([coachEval(before), coachEval(chess.fen())]);
    const winBefore = eb.win;
    const winAfter = 100 - ea.win;
    const cls = classifyMove({
      move: mv,
      prevMove: history[ply - 1] || null,
      prevCls: null,
      winBefore,
      winAfter,
      isBest: mv.lan === eb.best,
      legalCount: new Chess(before).moves().length,
      secondWin: eb.secondWin,
      fenAfter: chess.fen(),
      matesAfter: chess.isCheckmate() || (ea.mate !== null && ea.mate <= 0),
    });
    setFeedback({ ply, cls, san: mv.san, bestSan: mv.lan === eb.best ? null : sanFromUci(before, eb.best), loss: winBefore - winAfter });
  };

  const undo = (toPly) => {
    token.current++;
    setThinking(false);
    setFeedback(null);
    setHint(null);
    setGame((g) => ({ ...g, history: g.history.slice(0, toPly) }));
  };

  const takeBack = () => {
    const myParity = (new Chess(game.startFen).turn() === 'w') === (game.color === 'white') ? 0 : 1;
    let n = history.length - 1;
    while (n >= 0 && n % 2 !== myParity) n--;
    if (n >= 0) undo(n);
  };

  const showHint = async () => {
    const e = await coachEval(fen);
    if (e.best) setHint(e.best);
  };

  const save = async () => {
    const chess = new Chess(game.startFen);
    history.forEach((h) => chess.move(h.san));
    const me = settings.username || 'Ja';
    const botRating = LEVELS[game.level].label.match(/~(\d+)/)?.[1] || '3000+';
    const bot = `Stockfish ${botRating}`;
    const result = status.over ? status.result : 'unfinished';
    const pgnResult = { unfinished: '*', draw: '1/2-1/2' }[result] || ((result === 'win') === (game.color === 'white') ? '1-0' : '0-1');
    chess.header('Event', 'ChessGoat vs bot', 'White', game.color === 'white' ? me : bot, 'Black', game.color === 'black' ? me : bot, 'Result', pgnResult);
    const id = `bot-${Date.now()}`;
    const side = (name) => ({ username: name, rating: name === me ? '?' : botRating, result: '' });
    await db.put('games', {
      id,
      source: 'bot',
      url: null,
      pgn: chess.pgn(),
      endTime: Date.now(),
      timeClass: 'bot',
      timeControl: '',
      rated: false,
      white: side(game.color === 'white' ? me : bot),
      black: side(game.color === 'black' ? me : bot),
      myColor: game.color,
      result,
      termination: game.resigned ? 'resigned' : '',
      eco: '',
      opening: '',
      analyzed: false,
    });
    bumpData();
    enqueueAnalysis([id], { front: true });
    location.hash = `#/game/${encodeURIComponent(id)}`;
  };

  if (!game) {
    return html`
      <div class="page narrow">
        <h1>Graj z botem</h1>
        <div class="card form">
          ${startFen !== START && html`<div class="muted small">Start z pozycji z analizy partii.</div>`}
          <label>Kolor
            <select value=${setup.color} onChange=${(e) => setSetup({ ...setup, color: e.target.value })}>
              <option value="white">Białe</option><option value="black">Czarne</option><option value="random">Losowo</option>
            </select></label>
          <label>Siła bota
            <select value=${setup.level} onChange=${(e) => setSetup({ ...setup, level: Number(e.target.value) })}>
              ${LEVELS.map((l, i) => html`<option value=${i}>${l.label}</option>`)}
            </select></label>
          <label class="check"><input type="checkbox" checked=${setup.coach} onChange=${(e) => setSetup({ ...setup, coach: e.target.checked })} />
            Tryb trenera — ocena każdego mojego ruchu, podpowiedzi i cofanie</label>
          <label class="check"><input type="checkbox" checked=${setup.showEval} onChange=${(e) => setSetup({ ...setup, showEval: e.target.checked })} />
            Pokazuj pasek oceny</label>
          <button class="btn primary" onClick=${start}>Rozpocznij partię</button>
        </div>
      </div>`;
  }

  const last = history[history.length - 1];
  const shapes = hint ? [{ orig: hint.slice(0, 2), dest: hint.slice(2, 4), brush: 'blue' }] : [];
  const badges = feedback?.cls && history[feedback.ply] ? [{ square: history[feedback.ply].to, cls: feedback.cls }] : [];
  const startPly = new Chess(game.startFen).turn() === 'b' ? 1 : 0;

  return html`
    <div class="layout">
      <div class="board-area">
        <div class="board-col">
          <div class="player-tag"><span class=${`color-dot ${game.color === 'white' ? 'black' : 'white'}`}></span>
            <b>Stockfish</b> <span class="muted">${LEVELS[game.level].label}</span> ${thinking && html`<span class="muted small">myśli…</span>`}</div>
          <div class="board-row">
            ${setup.showEval && html`<${EvalBar} whiteWin=${live ? live.whiteWin : 50} label=${live?.label || ''} orientation=${game.color} />`}
            <${Board} fen=${fen} orientation=${game.color} interactive=${!!status?.myTurn && !status.over}
              onMove=${onMove} lastMove=${last ? [last.from, last.to] : null} shapes=${shapes} badges=${badges} />
          </div>
          <div class="player-tag"><span class=${`color-dot ${game.color}`}></span><b>${settings.username || 'Ty'}</b></div>
        </div>
      </div>
      <div class="side-panel">
        ${status.over && html`<div class=${`card result-card ${status.result}`}>${status.text}</div>`}
        ${game.coach && html`<${CoachCard} feedback=${feedback} onUndo=${() => undo(feedback.ply)} />`}
        <${MoveList} moves=${history} index=${history.length} startPly=${startPly} />
        <div class="btn-row wrap">
          ${!status.over && html`
            ${game.coach && html`<button class="btn" disabled=${!status.myTurn} onClick=${showHint}>Podpowiedź</button>`}
            <button class="btn" disabled=${!history.length} onClick=${takeBack}>Cofnij</button>
            <button class="btn" onClick=${() => setGame({ ...game, resigned: true })}>Poddaj się</button>`}
          <button class="btn" onClick=${() => setSetup({ ...setup, showEval: !setup.showEval })}>${setup.showEval ? 'Ukryj ocenę' : 'Pokaż ocenę'}</button>
          ${history.length > 1 && html`<button class="btn primary" onClick=${save}>Zapisz i przeanalizuj</button>`}
          <button class="btn" onClick=${() => { token.current++; setGame(null); }}>Nowa partia</button>
        </div>
      </div>
    </div>`;
}

function CoachCard({ feedback, onUndo }) {
  if (!feedback) return html`<div class="card muted">Trener: graj — ocenię każdy Twój ruch.</div>`;
  if (feedback.pending) return html`<div class="card muted">Trener analizuje Twój ruch…</div>`;
  const c = CLASSES[feedback.cls];
  return html`
    <div class="card coach">
      <div class="comment-title"><${ClassIcon} cls=${feedback.cls} size=${22} />
        <span><b>${feedback.san}</b> — ${c.label.toLowerCase()}</span></div>
      ${feedback.bestSan && html`<div>Najlepsze było: <b>${feedback.bestSan}</b></div>`}
      ${!GOOD.has(feedback.cls) && html`<button class="btn small" onClick=${onUndo}>Cofnij i spróbuj lepiej</button>`}
    </div>`;
}
