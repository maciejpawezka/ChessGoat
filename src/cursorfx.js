/**
 * Minimal particle field behind the UI: a ring of radially oriented dashes follows the cursor
 * and dims when it stops. The loop only runs while something moves, to keep the CPU free for Stockfish.
 */
const SPACING = 34;
const RADIUS = 210;
const PUSH = 9;
const REST_ENERGY = 0.2;

export function startCursorField() {
  if (!matchMedia('(pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'cursor-field';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let w = 0, h = 0, particles = [];
  const target = { x: -1e4, y: -1e4 };
  const pos = { ...target };
  let energy = 0;
  let lastMove = 0;
  let rest = 0;
  let raf = 0;

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth;
    h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    particles = [];
    for (let y = SPACING / 2; y < h + SPACING; y += SPACING) {
      for (let x = SPACING / 2; x < w + SPACING; x += SPACING) {
        particles.push({ x: x + (Math.random() - 0.5) * SPACING * 0.8, y: y + (Math.random() - 0.5) * SPACING * 0.8, s: 0.6 + Math.random() * 0.8 });
      }
    }
    draw();
  };

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (const p of particles) {
      const dx = p.x - pos.x, dy = p.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= RADIUS || energy < 0.01) {
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(p.x, p.y, 1.2, 1.2);
        continue;
      }
      const t = d / RADIUS;
      const ring = Math.sin(Math.PI * t) ** 1.6 * energy;
      const ux = d ? dx / d : 0, uy = d ? dy / d : 0;
      const push = PUSH * (1 - t) ** 2 * energy;
      const len = (1.5 + 4.5 * ring) * p.s;
      const cx = p.x + ux * push, cy = p.y + uy * push;
      // Shades of turquoise: deep teal on the left of the cursor, light aqua on the right.
      const side = 0.5 + ux / 2;
      const hue = 168 + 22 * side;
      ctx.strokeStyle = `hsla(${hue}, ${65 + 15 * side}%, ${42 + 26 * side}%, ${0.05 + 0.45 * ring})`;
      ctx.lineWidth = 1.1 + 0.4 * ring;
      ctx.beginPath();
      ctx.moveTo(cx - ux * len / 2, cy - uy * len / 2);
      ctx.lineTo(cx + ux * len / 2, cy + uy * len / 2);
      ctx.stroke();
    }
  };

  const tick = () => {
    const moving = performance.now() - lastMove < 120;
    const goal = moving ? 1 : rest;
    pos.x += (target.x - pos.x) * 0.14;
    pos.y += (target.y - pos.y) * 0.14;
    energy += (goal - energy) * (moving ? 0.08 : 0.03);
    draw();
    const settled = !moving && Math.abs(goal - energy) < 0.005 && Math.abs(target.x - pos.x) < 0.5 && Math.abs(target.y - pos.y) < 0.5;
    raf = settled ? 0 : requestAnimationFrame(tick);
  };

  const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (energy < 0.01) { pos.x = e.clientX; pos.y = e.clientY; }
    target.x = e.clientX;
    target.y = e.clientY;
    lastMove = performance.now();
    rest = REST_ENERGY;
    wake();
  }, { passive: true });
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget) return;
    rest = 0;
    wake();
  });
  addEventListener('resize', resize);
  resize();
}
