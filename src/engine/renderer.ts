import { BoardSurface, PenKind, UserStrokeItem } from '../types.js';
import { InkPoint, RenderedStroke } from './handwriting.js';
import { RNG } from './rng.js';

export interface RibbonSegment {
  x1: number;
  y1: number;
  r1: number;
  x2: number;
  y2: number;
  r2: number;
  /** Average pressure [0.16 .. 1.48] used to modulate ink richness/boldness */
  p: number;
  quad: [number, number, number, number, number, number, number, number];
}

function parseHexRgb(color: string): [number, number, number] | null {
  const m = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Noteshelf 3 pressure-to-ink-richness color modulation:
 * - Light touch / lift-off (p < 0.6): slightly lighter, airier ink (blended softly toward light paper)
 * - Medium pressure (p ~ 0.9): exact ink color
 * - Heavy press (p > 1.05): deeper, richer, slightly darker ink deposit!
 * Stays fully opaque (alpha=1) so overlapping segments NEVER cause joint-spotting!
 */
export function inkColorForPressure(baseColor: string, p: number): string {
  const rgb = parseHexRgb(baseColor);
  if (!rgb) return baseColor;
  const [r, g, b] = rgb;
  // Don't lighten white chalk on dark chalkboard
  if (r > 210 && g > 210 && b > 210) return baseColor;

  if (p < 0.72) {
    // Light stylus touch -> airier, slightly softer ink
    const lift = Math.max(0, Math.min(0.42, (0.72 - p) * 0.72));
    const nr = Math.round(r + (248 - r) * lift);
    const ng = Math.round(g + (250 - g) * lift);
    const nb = Math.round(b + (255 - b) * lift);
    return `rgb(${nr},${ng},${nb})`;
  }
  if (p > 1.02) {
    // Heavy stylus press -> deeper, bolder ink deposit
    const deepen = Math.max(0, Math.min(0.24, (p - 1.02) * 0.48));
    const nr = Math.round(r * (1 - deepen));
    const ng = Math.round(g * (1 - deepen));
    const nb = Math.round(b * (1 - deepen));
    return `rgb(${nr},${ng},${nb})`;
  }
  return baseColor;
}

/**
 * Draws realistic board surfaces (including Noteshelf 3 dot-grid paper!).
 */
export function renderSurface(
  ctx: CanvasRenderingContext2D,
  surface: BoardSurface,
  width: number,
  height: number,
): void {
  const rng = new RNG(90210);
  ctx.save();

  if (surface === 'whiteboard' || surface === 'paper') {
    ctx.fillStyle = surface === 'paper' ? '#fdfdfd' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const step = surface === 'paper' ? 76 : 82;
    ctx.fillStyle = surface === 'paper' ? 'rgba(155, 160, 170, 0.45)' : 'rgba(155, 165, 178, 0.34)';
    for (let x = Math.floor(step * 0.55); x < width; x += step) {
      for (let y = Math.floor(step * 0.55); y < height; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, surface === 'paper' ? 2.6 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (surface === 'chalkboard') {
    const grad = ctx.createRadialGradient(width * 0.5, height * 0.45, 50, width * 0.5, height * 0.5, width * 0.78);
    grad.addColorStop(0, '#233b32');
    grad.addColorStop(1, '#162822');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 16; i++) {
      const gx = rng.range(50, width - 50);
      const gy = rng.range(50, height - 50);
      const gr = rng.range(60, 190);
      const rg = ctx.createRadialGradient(gx, gy, 4, gx, gy, gr);
      rg.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
      rg.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = rg;
      ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
    }
  } else if (surface === 'notebook') {
    ctx.fillStyle = '#fcfcf9';
    ctx.fillRect(0, 0, width, height);

    const cell = 24;
    ctx.strokeStyle = 'rgba(99, 149, 214, 0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x += cell) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += cell) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(225, 86, 98, 0.44)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width - 108, 0);
    ctx.lineTo(width - 108, height);
    ctx.stroke();
  } else if (surface === 'lined') {
    ctx.fillStyle = '#fdfaf1';
    ctx.fillRect(0, 0, width, height);

    const lineGap = 36;
    ctx.strokeStyle = 'rgba(110, 152, 200, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 56; y < height; y += lineGap) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(220, 88, 95, 0.40)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(76, 0);
    ctx.lineTo(76, height);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Noteshelf 3 variable-width capsule-trapezoid ribbon builder.
 * Every segment is a guaranteed convex trapezoid + circular end-joints:
 * - ZERO self-intersection holes on hairpin turns (m, n, p, u, a, z)!
 * - Smooth variable-width pressure & velocity tapering!
 */
export function buildNoteshelfSegments(
  visible: InkPoint[],
  baseWidth: number,
): RibbonSegment[] {
  const segs: RibbonSegment[] = [];
  for (let i = 1; i < visible.length; i++) {
    const a = visible[i - 1];
    const b = visible[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;

    const nx = -dy / len;
    const ny = dx / len;
    const r1 = Math.max(0.22, baseWidth * a.p * 0.5);
    const r2 = Math.max(0.22, baseWidth * b.p * 0.5);

    segs.push({
      x1: a.x,
      y1: a.y,
      r1,
      x2: b.x,
      y2: b.y,
      r2,
      p: (a.p + b.p) * 0.5,
      quad: [
        a.x + nx * r1,
        a.y + ny * r1,
        b.x + nx * r2,
        b.y + ny * r2,
        b.x - nx * r2,
        b.y - ny * r2,
        a.x - nx * r1,
        a.y - ny * r1,
      ],
    });
  }
  return segs;
}

/**
 * Draws a single RenderedStroke using the Noteshelf 3 variable-width stylus brush.
 */
export function renderInkStroke(
  ctx: CanvasRenderingContext2D,
  stroke: RenderedStroke,
  maxTime = Infinity,
): { tip?: [number, number] } {
  const pts = stroke.points;
  if (pts.length === 0) return {};
  if (pts[0].t > maxTime) return {};

  ctx.save();

  if (stroke.isBlot || pts.length === 1) {
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(1.2, stroke.blotRadius ?? stroke.baseWidth * 0.56), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return { tip: [pts[0].x, pts[0].y] };
  }

  const visible: InkPoint[] = [pts[0]];
  let tip: [number, number] | undefined;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (b.t <= maxTime) {
      visible.push(b);
    } else {
      const denom = Math.max(1e-5, b.t - a.t);
      const frac = Math.max(0, Math.min(1, (maxTime - a.t) / denom));
      const bx = a.x + (b.x - a.x) * frac;
      const by = a.y + (b.y - a.y) * frac;
      const bp = a.p + (b.p - a.p) * frac;
      visible.push({ x: bx, y: by, p: bp, t: maxTime });
      tip = [bx, by];
      break;
    }
  }

  if (visible.length < 2) {
    ctx.restore();
    return { tip };
  }

  if (stroke.pen === 'chalk') {
    ctx.fillStyle = stroke.color;
    for (let i = 1; i < visible.length; i++) {
      const a = visible[i - 1];
      const b = visible[i];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / 1.8));
      const width = Math.max(1.2, stroke.baseWidth * (a.p + b.p) * 0.5);
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const cx = a.x + (b.x - a.x) * f;
        const cy = a.y + (b.y - a.y) * f;
        const h = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
        const g1 = h - Math.floor(h);
        ctx.globalAlpha = stroke.alpha * (0.42 + g1 * 0.45);
        ctx.beginPath();
        ctx.arc(
          cx + (g1 - 0.5) * width * 0.45,
          cy + (((g1 * 7) % 1) - 0.5) * width * 0.45,
          width * 0.46,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
  } else if (stroke.pen === 'fountain') {
    // Calligraphic pressure-sensitive brush for fountain pen
    const segs = buildNoteshelfSegments(visible, stroke.baseWidth);
    ctx.globalAlpha = 1.0;

    if (segs.length > 0) {
      const first = segs[0];
      ctx.fillStyle = inkColorForPressure(stroke.color, first.p);
      ctx.beginPath();
      ctx.arc(first.x1, first.y1, first.r1, 0, Math.PI * 2);
      ctx.fill();

      for (const s of segs) {
        ctx.fillStyle = inkColorForPressure(stroke.color, s.p);
        ctx.beginPath();
        ctx.moveTo(s.quad[0], s.quad[1]);
        ctx.lineTo(s.quad[2], s.quad[3]);
        ctx.lineTo(s.quad[4], s.quad[5]);
        ctx.lineTo(s.quad[6], s.quad[7]);
        ctx.closePath();
        ctx.moveTo(s.x2 + s.r2, s.y2);
        ctx.arc(s.x2, s.y2, s.r2, 0, Math.PI * 2);
        ctx.fill('nonzero');
      }
    }
  } else {
    // Crisp uniform monoline pen (matches user's Noteshelf 3 ballpoint/gel pen!)
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1.1, stroke.baseWidth);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha =
      stroke.pen === 'pencil'
        ? 0.76
        : stroke.pen === 'marker'
          ? 0.92
          : 1.0;

    ctx.beginPath();
    ctx.moveTo(visible[0].x, visible[0].y);
    if (visible.length === 2) {
      ctx.lineTo(visible[1].x, visible[1].y);
    } else {
      for (let i = 1; i < visible.length - 1; i++) {
        const midX = (visible[i].x + visible[i + 1].x) * 0.5;
        const midY = (visible[i].y + visible[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(visible[i].x, visible[i].y, midX, midY);
      }
      const last = visible[visible.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
  }

  ctx.restore();
  return { tip };
}

export function renderUserStroke(ctx: CanvasRenderingContext2D, item: UserStrokeItem): void {
  if (item.points.length < 2) return;
  const fakeStroke: RenderedStroke = {
    points: item.points.map((pt) => ({ x: pt.x, y: pt.y, p: pt.p, t: 0 })),
    color: item.color,
    pen: item.pen,
    baseWidth: item.size,
    alpha: 1.0,
  };
  renderInkStroke(ctx, fakeStroke, Infinity);
}

export function renderPenCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  pen: PenKind,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.55);

  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(2, 3, 3.5, 1.8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(4, -11);
  ctx.lineTo(-2.5, -9);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = pen === 'chalk' ? '#f8fafc' : '#334155';
  ctx.beginPath();
  ctx.roundRect(-3.5, -46, 8, 37, 2.5);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillRect(-3.5, -20, 8, 5);

  ctx.restore();
}
