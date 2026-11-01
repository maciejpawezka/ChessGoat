import { html, useState, useEffect, useRef } from 'preact-htm';
import { Chess } from 'chess.js';
import { Board } from './components.js';

const uciMove = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

/**
 * Interactive puzzle. `solution` is a UCI line starting with the player's move
 * (player moves at even indexes, forced replies at odd). Any checkmating move is accepted;
 * `verify(fenBefore, uci, fenAfter)` may accept other engine-approved alternatives.
 * `onResult(success)` fires once: false on the first wrong move or reveal.
 */
export function PuzzleBoard({ puzzle, verify, onResult, onNext, info, after }) {
  const [fen, setFen] = useState(puzzle.fen);
  const [lastMove, setLastMove] = useState(puzzle.lastMove || null);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState('play');
  const [message, setMessage] = useState('');
  const [shapes, setShapes] = useState([]);
  const [syncKey, setSyncKey] = useState(0);
  const reported = useRef(false);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    setFen(puzzle.fen);
    setLastMove(puzzle.lastMove || null);
    setStep(0);
    setStatus('play');
    setMessage('');
    setShapes([]);
    reported.current = false;
    return () => clearTimeout(timer.current);
  }, [puzzle.id]);

  const report = (success) => {
    if (reported.current) return;
    reported.current = true;
    onResult?.(success);
  };

  const finish = (text) => {
    setStatus('solved');
    setMessage(text);
    setShapes([]);
    report(true);
  };

  const wrong = (fenBefore, lastBefore) => {
    report(false);
    setStatus('wrong');
    setMessage('To nie to — spróbuj jeszcze raz.');
    timer.current = setTimeout(() => {
      setFen(fenBefore);
      setLastMove(lastBefore);
      setSyncKey((k) => k + 1);
      setStatus('play');
    }, 800);
  };

  const onMove = async (from, to, promotion) => {
    if (status !== 'play') return;
    const fenBefore = fen;
    const lastBefore = lastMove;
    const chess = new Chess(fen);
    let mv;
    try {
      mv = chess.move({ from, to, promotion });
    } catch {
      setSyncKey((k) => k + 1);
      return;
    }
    setFen(chess.fen());
    setLastMove([from, to]);
    setShapes([]);

    const expected = puzzle.solution[step];
    if (chess.isCheckmate()) return finish('Mat! Świetnie.');
    if (mv.lan === expected) {
      if (step + 1 >= puzzle.solution.length) return finish(reported.current ? 'Rozwiązane (z pomyłką).' : 'Brawo! To najlepszy ruch.');
      setStatus('opponent');
      setMessage('Dobrze! Kontynuuj…');
      timer.current = setTimeout(() => {
        const reply = chess.move(uciMove(puzzle.solution[step + 1]));
        setFen(chess.fen());
        setLastMove([reply.from, reply.to]);
        setStep(step + 2);
        setStatus('play');
      }, 450);
      return;
    }
    if (verify) {
      setStatus('checking');
      setMessage('Sprawdzam ruch silnikiem…');
      const ok = await verify(fenBefore, mv.lan, chess.fen());
      if (ok) return finish('Też bardzo dobry ruch! (silnik potwierdza)');
    }
    wrong(fenBefore, lastBefore);
  };

  const hint = () => {
    const uci = puzzle.solution[step];
    if (uci) setShapes([{ orig: uci.slice(0, 2), brush: 'yellow' }]);
  };

  const reveal = () => {
    const uci = puzzle.solution[step];
    report(false);
    setStatus('revealed');
    setMessage('Rozwiązanie zaznaczone strzałką.');
    if (uci) setShapes([{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }]);
  };

  const done = status === 'solved' || status === 'revealed';
  const turnText = puzzle.orientation === 'white' ? 'Ruch białych' : 'Ruch czarnych';

  return html`
    <div class="layout">
      <div class="board-area">
        <${Board}
          fen=${fen}
          orientation=${puzzle.orientation}
          interactive=${status === 'play'}
          onMove=${onMove}
          lastMove=${lastMove}
          shapes=${shapes}
          syncKey=${syncKey} />
      </div>
      <div class="side-panel">
        ${info}
        <div class=${`puzzle-status ${status}`}>
          <div class="turn-dot ${puzzle.orientation}"></div>
          <div>${message || `${turnText} — znajdź najlepszy ruch`}</div>
        </div>
        <div class="btn-row">
          ${!done && html`
            <button class="btn" onClick=${hint}>Podpowiedź</button>
            <button class="btn" onClick=${reveal}>Pokaż rozwiązanie</button>`}
          ${onNext && html`<button class=${`btn ${done ? 'primary' : ''}`} onClick=${onNext}>${done ? 'Następne zadanie →' : 'Pomiń'}</button>`}
        </div>
        ${done && after}
      </div>
    </div>`;
}
