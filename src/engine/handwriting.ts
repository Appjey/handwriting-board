import { DoodleItem, PenKind, TextItem } from '../types.js';
import { FALLBACK_GLYPH, GLYPHS, GlyphDef, GlyphEntry } from './glyphs.js';
import { Noise1D, RNG } from './rng.js';

export interface InkPoint {
  x: number;
  y: number;
  /** Noteshelf 3 stylus pressure/velocity width multiplier in [0.25 .. 1.45] */
  p: number;
  /** Cumulative animation time in seconds */
  t: number;
}

export interface RenderedStroke {
  points: InkPoint[];
  color: string;
  pen: PenKind;
  baseWidth: number;
  alpha: number;
  isBlot?: boolean;
  blotRadius?: number;
}

export interface SynthesizedResult {
  strokes: RenderedStroke[];
  duration: number;
  bounds: { x: number; y: number; width: number; height: number };
  endY: number;
}

function pickGlyph(ch: string, rng: RNG, lastVariantByChar: Map<string, number>): GlyphDef {
  const entry: GlyphEntry | undefined = GLYPHS[ch] ?? GLYPHS[ch.toLowerCase()];
  if (!entry) return FALLBACK_GLYPH;
  if (Array.isArray(entry)) {
    const prev = lastVariantByChar.get(ch);
    let idx = Math.floor(rng.next() * entry.length);
    // Avoid picking the exact same allograph twice in a row so repeated letters ALWAYS differ!
    if (entry.length > 1 && idx === prev) {
      idx = (idx + 1 + Math.floor(rng.next() * (entry.length - 1))) % entry.length;
    }
    lastVariantByChar.set(ch, idx);
    return entry[idx] as GlyphDef;
  }
  return entry as GlyphDef;
}

/**
 * Dense smooth Catmull-Rom spline sampling so Noteshelf 3 ribbon strokes
 * have silky curves with zero jagged corners.
 */
function sampleCatmullRom(pts: Array<[number, number]>, stepsPerSeg = 8): Array<[number, number]> {
  if (pts.length <= 1) return pts.slice();
  if (pts.length === 2) {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= stepsPerSeg; i++) {
      const t = i / stepsPerSeg;
      out.push([
        pts[0][0] + (pts[1][0] - pts[0][0]) * t,
        pts[0][1] + (pts[1][1] - pts[0][1]) * t,
      ]);
    }
    return out;
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const segSteps = Math.max(5, Math.min(14, Math.ceil(dist / 1.6)));
    const startJ = i === 0 ? 0 : 1;
    for (let j = startJ; j <= segSteps; j++) {
      const t = j / segSteps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Calibrated base stroke width for Noteshelf 3 stylus brush.
 */
function penBaseWidth(pen: PenKind, xHeight: number): number {
  const s = Math.max(10, xHeight);
  switch (pen) {
    case 'ballpoint':
      return Math.max(1.45, s * 0.142);
    case 'fountain':
      return Math.max(1.7, s * 0.185);
    case 'pencil':
      return Math.max(1.3, s * 0.12);
    case 'marker':
      return Math.max(2.1, s * 0.19);
    case 'chalk':
      return Math.max(2.4, s * 0.215);
    default:
      return Math.max(1.45, s * 0.142);
  }
}

/**
 * Noteshelf 3 velocity + direction + taper stroke physics:
 * - Downstrokes are richer & thicker (~1.22x)
 * - Fast upstrokes / rapid flicks thin down naturally (~0.52x)
 * - Starts with subtle stylus landing, ends with crisp tapered whip-tail!
 */
function buildInkStroke(
  rawPts: Array<[number, number]>,
  opts: {
    color: string;
    pen: PenKind;
    baseWidth: number;
    noise: Noise1D;
    rng: RNG;
    startTime: number;
    alpha?: number;
    isFlow?: boolean;
  },
): { stroke: RenderedStroke; endTime: number } {
  const dense = sampleCatmullRom(rawPts, 7);
  const points: InkPoint[] = [];
  let t = opts.startTime;
  const n = dense.length;
  const wristBow = opts.rng.gaussian() * 0.42;
  const noiseOffset = opts.rng.range(0, 200);
  const pxPerSec = 250 + opts.rng.range(-25, 35);

  // Pressure profile:
  // - Monoline crisp constant width for ballpoint/marker/pencil (matches user's Noteshelf 3 pen!)
  // - Expressive calligraphic pressure taper only when pen === 'fountain'
  const rawPressures: number[] = new Array(n);
  const isCalligraphic = opts.pen === 'fountain';

  if (!isCalligraphic) {
    for (let i = 0; i < n; i++) {
      rawPressures[i] = 1.0;
    }
  } else {
    const strokeLength = dense.reduce(
      (acc, pt, idx) => (idx === 0 ? 0 : acc + Math.hypot(pt[0] - dense[idx - 1][0], pt[1] - dense[idx - 1][1])),
      0,
    );
    const peakPos = opts.rng.range(0.28, 0.62);
    const strokePower = opts.rng.range(0.84, 1.2);

    for (let i = 0; i < n; i++) {
      const frac = n > 1 ? i / (n - 1) : 0;
      const prev = dense[Math.max(0, i - 1)];
      const next = dense[Math.min(n - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;

      const downFactor = dy / len;
      let p = 0.88 + downFactor * 0.34;
      p *= 1.08 - Math.abs(frac - peakPos) * 0.24;
      p += opts.noise.sample(noiseOffset * 1.3 + frac * 2.6) * 0.12;
      p *= strokePower;

      const isShortDot = strokeLength < opts.baseWidth * 3.2;
      if (!isShortDot) {
        const entry = Math.min(1, frac / 0.18);
        const exit = Math.min(1, (1 - frac) / 0.26);
        p *= (0.28 + 0.72 * Math.pow(entry, 0.72)) * (0.20 + 0.80 * Math.pow(exit, 0.82));
      } else {
        p *= 0.6 + 0.5 * Math.sin(frac * Math.PI);
      }

      rawPressures[i] = Math.max(0.18, Math.min(1.45, p));
    }
  }

  // 1-pass box smoothing on pressure so ribbon width transitions are ultra-silky
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    let [x, y] = dense[i];

    const prev = dense[Math.max(0, i - 1)];
    const next = dense[Math.min(n - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const env = Math.sin(frac * Math.PI);
    const smoothDrift = opts.noise.sample(noiseOffset + frac * 1.6) * 0.22 * env;
    const bow = wristBow * env;
    x += nx * (smoothDrift + bow);
    y += ny * (smoothDrift + bow);

    if (i > 0) {
      const segDist = Math.hypot(x - points[i - 1].x, y - points[i - 1].y);
      t += segDist / pxPerSec;
    }

    const pPrev = rawPressures[Math.max(0, i - 1)];
    const pCur = rawPressures[i];
    const pNext = rawPressures[Math.min(n - 1, i + 1)];
    const smoothP = pPrev * 0.25 + pCur * 0.5 + pNext * 0.25;

    points.push({ x, y, p: smoothP, t });
  }

  return {
    stroke: {
      points,
      color: opts.color,
      pen: opts.pen,
      baseWidth: opts.baseWidth,
      alpha: opts.alpha ?? (opts.isFlow ? 0.72 : 0.98),
    },
    endTime: t,
  };
}

/**
 * Synthesizes the user's real lively, slightly crooked Noteshelf 3 handwriting:
 * - Authentic allograph variants for common letters
 * - Natural uneven size/height/angle ("живое кривое письмо") WITHOUT polygonal jaggies
 * - Consistent upward-right line slope (-0.035) with gentle wrist-reposition micro-steps
 * - Authentic variable intra-word spacing (tight pairs + occasional tiny gap like "Bard zo")
 * - Occasional quick ligature flows (~22% of close pairs)
 */
export function synthesizeText(item: TextItem): SynthesizedResult {
  const rng = new RNG(item.seed);
  const noise = new Noise1D(rng);

  const slantBase = item.slant;
  const visualSize = Math.max(16, Math.min(100, item.size));
  const xHeight = visualSize * 0.50;
  const baseWidth = penBaseWidth(item.pen, xHeight);

  const strokes: RenderedStroke[] = [];
  let currentTime = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const trackPoint = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const rawParagraphs = item.text.replace(/\r\n/g, '\n').split('\n');
  const maxLineWidth = Math.max(160, item.maxWidth);
  // Tighter authentic notebook line rhythm matching user's full-page Noteshelf 3 sheets
  const lineHeight = xHeight * 2.85;
  const paraSlope = -0.036 + rng.gaussian() * 0.004;

  let lineIndex = 0;
  let globalCursorY = item.y;
  const lastVariantByChar = new Map<string, number>();

  // Autocorrelated hand-inertia state (AR(1)): consecutive letters in a word share
  // smooth wrist momentum in size, slant, stretch, and rotation instead of white noise!
  let handSize = 1.0;
  let handSlant = slantBase;
  let handAspectX = 1.14;
  let handRot = 0.0;

  for (const para of rawParagraphs) {
    const words = para.split(/(\s+)/);
    let cursorX = item.x + rng.gaussian() * 4.5;
    let baselineDrift = 0;
    let lineSlope = paraSlope + rng.gaussian() * 0.0025;
    const wavePhase = rng.range(0, Math.PI * 2);
    const waveFreq = rng.range(0.005, 0.010);

    if (para.trim().length === 0) {
      globalCursorY += lineHeight * 0.68;
      lineIndex++;
      continue;
    }

    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      const token = words[wIdx];
      if (!token) continue;

      if (/^\s+$/.test(token)) {
        const spaceW = xHeight * (1.35 + rng.gaussian() * 0.28) * token.length;
        cursorX += Math.max(xHeight * 0.65, spaceW);
        // Wrist reposition between words: partially relaxes hand inertia
        baselineDrift = baselineDrift * 0.65 + rng.gaussian() * xHeight * 0.06;
        handSize = handSize * 0.55 + (1.0 + rng.gaussian() * 0.075) * 0.45;
        handSlant = handSlant * 0.55 + (slantBase + rng.gaussian() * 0.055) * 0.45;
        handAspectX = handAspectX * 0.55 + (1.14 + rng.gaussian() * 0.09) * 0.45;
        handRot = handRot * 0.4 + rng.gaussian() * 0.03 * 0.6;
        currentTime += 0.055 + rng.range(0, 0.025);
        continue;
      }

      let estWordW = 0;
      for (const ch of token) {
        const entry = GLYPHS[ch] ?? GLYPHS[ch.toLowerCase()];
        const gd = !entry ? FALLBACK_GLYPH : Array.isArray(entry) ? entry[0] : entry;
        estWordW += (gd.w * 1.16 + 0.14) * xHeight;
      }

      if (cursorX > item.x + 20 && cursorX + estWordW > item.x + maxLineWidth) {
        lineIndex++;
        globalCursorY += lineHeight * rng.range(0.96, 1.04);
        cursorX = item.x + rng.gaussian() * 5.0;
        baselineDrift = 0;
        lineSlope = paraSlope + rng.gaussian() * 0.0025;
        currentTime += 0.13;
      }

      const chars = Array.from(token);
      for (let cIdx = 0; cIdx < chars.length; cIdx++) {
        const ch = chars[cIdx];
        const nextCh = cIdx + 1 < chars.length ? chars[cIdx + 1] : null;
        const glyph = pickGlyph(ch, rng, lastVariantByChar);
        const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
        const nextIsLower = Boolean(nextCh && nextCh === nextCh.toLowerCase() && nextCh !== nextCh.toUpperCase());

        // Smooth AR(1) hand inertia inside words (adjacent letters move with one hand!)
        handSize = handSize * 0.68 + (1.0 + rng.gaussian() * 0.07) * 0.32;
        handSlant = handSlant * 0.72 + (slantBase + rng.gaussian() * 0.05) * 0.28;
        handAspectX = handAspectX * 0.66 + (1.14 + rng.gaussian() * 0.085) * 0.34;
        handRot = handRot * 0.62 + rng.gaussian() * 0.032 * 0.38;

        baselineDrift = baselineDrift * 0.82 + rng.gaussian() * xHeight * 0.016;

        const dxFromMargin = cursorX - item.x;
        const swayY =
          Math.sin(dxFromMargin * waveFreq + wavePhase) * xHeight * 0.035 +
          noise.fbm(dxFromMargin * 0.006 + lineIndex * 7.3, 2) * xHeight * 0.03;
        const microBounce = rng.gaussian() * xHeight * 0.028;
        const charY = globalCursorY + dxFromMargin * lineSlope + baselineDrift + swayY + microBounce;

        const bias = 0.65 + 0.35 * (glyph.scaleBias ?? 1.0);
        const localSize = xHeight * bias * Math.max(0.88, Math.min(1.13, handSize + rng.gaussian() * 0.025));
        const localSlant = Math.max(0.10, Math.min(0.30, handSlant + rng.gaussian() * 0.018));
        const localAspectX = Math.max(1.0, Math.min(1.30, handAspectX + rng.gaussian() * 0.035));
        const localRot = Math.max(-0.06, Math.min(0.06, handRot + rng.gaussian() * 0.014));

        // Anchor bottom baseline evenly to charY so all letters sit coherently on the line
        const baselineY = charY + xHeight;
        const baselineAnchoredY = baselineY - localSize;

        const res = drawGlyphIntoStrokes(glyph, {
          x: cursorX,
          y: baselineAnchoredY,
          baselineY,
          xHeight,
          size: localSize,
          slant: localSlant,
          aspectX: localAspectX,
          rotAngle: localRot,
          color: item.color,
          pen: item.pen,
          baseWidth,
          noise,
          rng,
          startTime: currentTime,
          strokes,
          trackPoint,
        });

        currentTime = res.endTime + 0.012 + rng.range(0, 0.010);

        // Optical x-height band kerning:
        // - Keeps words cohesive and snug like rapid real handwriting
        // - Eliminates ugly gaps after capitals (P o, B o, T a, W s) by kerning against the lower x-height band!
        const extraBreath = rng.chance(0.06) ? xHeight * rng.range(0.05, 0.11) : 0;
        const baseGap = isUpper && nextIsLower ? 0.11 : 0.135;
        const charGap = xHeight * (baseGap + rng.gaussian() * 0.028) + extraBreath;
        const rightEdge = isUpper && nextIsLower ? res.lowerBandMaxX : res.bodyMaxX;
        const safeRight = rightEdge + Math.max(xHeight * 0.09, charGap);
        cursorX = Math.max(cursorX + xHeight * 0.22, safeRight);
      }
    }

    globalCursorY += lineHeight;
    lineIndex++;
  }

  if (!isFinite(minX)) {
    minX = item.x;
    minY = item.y;
    maxX = item.x + 20;
    maxY = item.y + xHeight;
  }

  return {
    strokes,
    duration: currentTime,
    bounds: {
      x: minX,
      y: minY,
      width: Math.max(10, maxX - minX),
      height: Math.max(xHeight, maxY - minY),
    },
    endY: Math.max(globalCursorY, maxY + xHeight * 1.2),
  };
}

function drawGlyphIntoStrokes(
  glyph: GlyphDef,
  opts: {
    x: number;
    y: number;
    baselineY: number;
    xHeight: number;
    size: number;
    slant: number;
    aspectX: number;
    rotAngle: number;
    color: string;
    pen: PenKind;
    baseWidth: number;
    noise: Noise1D;
    rng: RNG;
    startTime: number;
    strokes: RenderedStroke[];
    trackPoint: (x: number, y: number) => void;
  },
): { advance: number; endTime: number; bodyMaxX: number; lowerBandMaxX: number; exitPt: [number, number] | null } {
  const { x, y, baselineY, xHeight, size, slant, aspectX, rotAngle, rng, noise } = opts;
  const aspectY = Math.max(0.92, Math.min(1.08, 0.99 + rng.gaussian() * 0.038));
  const cosA = Math.cos(rotAngle);
  const sinA = Math.sin(rotAngle);
  const cx = glyph.w * 0.5;
  const cy = 0.5;

  let t = opts.startTime;
  let exitPt: [number, number] | null = null;
  const nominalMaxX = x + glyph.w * size * aspectX;
  const bodyTopY = baselineY - xHeight * 1.15;
  const lowerBandTopY = baselineY - xHeight * 0.85;
  const bodyBotY = baselineY + xHeight * 0.16;
  let foundBodyX = -Infinity;
  let foundLowerX = -Infinity;

  for (let sIdx = 0; sIdx < glyph.strokes.length; sIdx++) {
    const rawStroke = glyph.strokes[sIdx];
    const worldPts: Array<[number, number]> = [];
    const fieldSeed = rng.range(0, 100);
    const nPts = rawStroke.length;
    const strokeDx = sIdx > 0 ? rng.gaussian() * 0.018 : 0;
    const strokeDy = sIdx > 0 ? rng.gaussian() * 0.018 : 0;
    const endStretchX = rng.gaussian() * 0.025;
    const endStretchY = rng.gaussian() * 0.025;

    for (let pIdx = 0; pIdx < nPts; pIdx++) {
      const [gx, gy] = rawStroke[pIdx];
      const frac = nPts > 1 ? pIdx / (nPts - 1) : 0;
      const dxSmooth = noise.sample(fieldSeed + frac * 1.5) * 0.024 + strokeDx + endStretchX * frac;
      const dySmooth = noise.sample(fieldSeed + 37.3 + frac * 1.5) * 0.024 + strokeDy + endStretchY * frac;

      const px = (gx + dxSmooth) * aspectX;
      const py = (gy + dySmooth) * aspectY;

      const rx = (px - cx) * cosA - (py - cy) * sinA + cx;
      const ry = (px - cx) * sinA + (py - cy) * cosA + cy;

      const sx = rx + (1 - ry) * slant;
      const wx = x + sx * size;
      const wy = y + ry * size;
      worldPts.push([wx, wy]);
    }

    const built = buildInkStroke(worldPts, {
      color: opts.color,
      pen: opts.pen,
      baseWidth: opts.baseWidth,
      noise,
      rng,
      startTime: t,
    });
    opts.strokes.push(built.stroke);
    for (const pt of built.stroke.points) {
      opts.trackPoint(pt.x, pt.y);
      if (pt.y >= bodyTopY && pt.y <= bodyBotY && pt.x > foundBodyX) {
        foundBodyX = pt.x;
      }
      if (pt.y >= lowerBandTopY && pt.y <= bodyBotY && pt.x > foundLowerX) {
        foundLowerX = pt.x;
      }
    }
    if (built.stroke.points.length > 0) {
      const last = built.stroke.points[built.stroke.points.length - 1];
      exitPt = [last.x, last.y];
    }
    t = built.endTime + 0.016;
  }

  const bodyMaxX = isFinite(foundBodyX) ? foundBodyX : nominalMaxX;
  const lowerBandMaxX = isFinite(foundLowerX) ? foundLowerX : bodyMaxX;

  return {
    advance: glyph.w * size * aspectX,
    endTime: t,
    bodyMaxX,
    lowerBandMaxX,
    exitPt,
  };
}

export function synthesizeDoodle(item: DoodleItem): SynthesizedResult {
  const rng = new RNG(item.seed);
  const noise = new Noise1D(rng);
  const w = item.width ?? 140;
  const h = item.height ?? 60;
  const baseWidth = penBaseWidth(item.pen, 18);
  const rawStrokeList: Array<Array<[number, number]>> = [];

  switch (item.kind) {
    case 'underline': {
      const x1 = item.x;
      const x2 = item.x2 ?? item.x + w;
      const y1 = item.y;
      const y2 = item.y2 ?? item.y + rng.gaussian() * 2.5;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 7; i++) {
        const f = i / 7;
        pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f + Math.sin(f * Math.PI) * rng.range(-2, 3)]);
      }
      rawStrokeList.push(pts);
      break;
    }

    case 'line': {
      const x1 = item.x;
      const y1 = item.y;
      const x2 = item.x2 ?? item.x + w;
      const y2 = item.y2 ?? item.y;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]);
      }
      rawStrokeList.push(pts);
      break;
    }

    case 'arrow': {
      const x1 = item.x;
      const y1 = item.y;
      const x2 = item.x2 ?? item.x + w;
      const y2 = item.y2 ?? item.y + h * 0.2;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const midCurve = rng.range(-12, 12);
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      rawStrokeList.push([
        [x1, y1],
        [(x1 + x2) * 0.5 + nx * midCurve, (y1 + y2) * 0.5 + ny * midCurve],
        [x2, y2],
      ]);
      const headLen = Math.min(22, Math.max(10, Math.hypot(x2 - x1, y2 - y1) * 0.22));
      rawStrokeList.push([
        [x2 - Math.cos(angle - 0.5) * headLen, y2 - Math.sin(angle - 0.5) * headLen],
        [x2, y2],
        [x2 - Math.cos(angle + 0.52) * headLen, y2 - Math.sin(angle + 0.52) * headLen],
      ]);
      break;
    }

    case 'circle': {
      const cx = item.x + w * 0.5;
      const cy = item.y + h * 0.5;
      const rx = w * 0.5;
      const ry = h * 0.5;
      const pts: Array<[number, number]> = [];
      const steps = 18;
      const startA = rng.range(-0.5, 0.5);
      const totalA = Math.PI * 2 + rng.range(0.12, 0.35);
      for (let i = 0; i <= steps; i++) {
        const a = startA + (i / steps) * totalA;
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      rawStrokeList.push(pts);
      break;
    }

    case 'box': {
      const x1 = item.x;
      const y1 = item.y;
      const x2 = item.x + w;
      const y2 = item.y + h;
      rawStrokeList.push([
        [x1, y1],
        [(x1 + x2) * 0.5, y1],
        [x2, y1],
        [x2, (y1 + y2) * 0.5],
        [x2, y2],
        [(x1 + x2) * 0.5, y2],
        [x1, y2],
        [x1, (y1 + y2) * 0.5],
        [x1, y1],
      ]);
      break;
    }

    case 'star': {
      const cx = item.x + w * 0.5;
      const cy = item.y + h * 0.5;
      const r = Math.min(w, h) * 0.5;
      const order = [0, 2, 4, 1, 3, 0];
      const pts: Array<[number, number]> = order.map((idx) => {
        const a = -Math.PI / 2 + (idx * Math.PI * 2) / 5;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      });
      rawStrokeList.push(pts);
      break;
    }

    case 'heart': {
      const cx = item.x + w * 0.5;
      const cy = item.y + h * 0.45;
      const s = Math.min(w, h) * 0.032;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 20; i++) {
        const t = (i / 20) * Math.PI * 2;
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        pts.push([cx + hx * s, cy + hy * s]);
      }
      rawStrokeList.push(pts);
      break;
    }

    case 'crossout': {
      rawStrokeList.push([
        [item.x, item.y + h * 0.25],
        [item.x + w * 0.5, item.y + h * 0.5],
        [item.x + w, item.y + h * 0.75],
      ]);
      rawStrokeList.push([
        [item.x + w, item.y + h * 0.2],
        [item.x + w * 0.5, item.y + h * 0.5],
        [item.x, item.y + h * 0.8],
      ]);
      break;
    }

    case 'scribble':
    default: {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 12; i++) {
        const f = i / 12;
        pts.push([item.x + f * w, item.y + (i % 2 === 0 ? 0.15 : 0.85) * h]);
      }
      rawStrokeList.push(pts);
      break;
    }
  }

  const strokes: RenderedStroke[] = [];
  let t = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const raw of rawStrokeList) {
    const built = buildInkStroke(raw, {
      color: item.color,
      pen: item.pen,
      baseWidth,
      noise,
      rng,
      startTime: t,
    });
    strokes.push(built.stroke);
    for (const pt of built.stroke.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    t = built.endTime + 0.04;
  }

  return {
    strokes,
    duration: t,
    bounds: {
      x: isFinite(minX) ? minX : item.x,
      y: isFinite(minY) ? minY : item.y,
      width: isFinite(maxX) ? Math.max(10, maxX - minX) : w,
      height: isFinite(maxY) ? Math.max(10, maxY - minY) : h,
    },
    endY: (isFinite(maxY) ? maxY : item.y + h) + 20,
  };
}
