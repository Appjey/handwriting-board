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

function pickGlyph(ch: string, rng: RNG, lastVariantByChar: Map<string, number>, hurry: number): GlyphDef {
  const entry: GlyphEntry | undefined = GLYPHS[ch] ?? GLYPHS[ch.toLowerCase()];
  if (!entry) return FALLBACK_GLYPH;
  if (Array.isArray(entry)) {
    const prev = lastVariantByChar.get(ch);
    const neatIndices: number[] = [];
    const hurriedIndices: number[] = [];
    for (let i = 0; i < entry.length; i++) {
      if (entry[i].hurried) hurriedIndices.push(i);
      else neatIndices.push(i);
    }

    // At hurry < 0.20 keep 100% pure neat v4 allographs; above that mix in rushed variants proportionally
    let pool: number[];
    if (hurry >= 0.20 && hurriedIndices.length > 0 && rng.chance(Math.min(0.78, hurry * 0.76))) {
      pool = hurriedIndices;
    } else {
      pool = neatIndices.length > 0 ? neatIndices : entry.map((_, i) => i);
    }

    let idx = pool[Math.floor(rng.next() * pool.length)];
    // Avoid picking the exact same allograph twice in a row so repeated letters ALWAYS differ!
    if (pool.length > 1 && idx === prev) {
      const alt = pool.filter((k) => k !== prev);
      idx = alt[Math.floor(rng.next() * alt.length)];
    } else if (entry.length > 1 && idx === prev) {
      idx = (idx + 1 + Math.floor(rng.next() * (entry.length - 1))) % entry.length;
    }
    lastVariantByChar.set(ch, idx);
    return entry[idx] as GlyphDef;
  }
  return entry as GlyphDef;
}

const FLAT_BODY_CHARS = new Set(
  Array.from('aąàâceéèêęmnńoóôrsśuvwzxаеёиймнопрстухчшщъыьэюя'),
);

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
      return Math.max(1.15, s * 0.102);
    case 'fountain':
      return Math.max(1.5, s * 0.155);
    case 'pencil':
      return Math.max(1.05, s * 0.095);
    case 'marker':
      return Math.max(1.85, s * 0.165);
    case 'chalk':
      return Math.max(2.1, s * 0.19);
    default:
      return Math.max(1.15, s * 0.102);
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
  const hurry = Math.max(0, Math.min(1, item.hurry ?? 0.5));
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
  // Parallel line spacing calibrated to HW 12.4 / rodzina density with zero descender-ascender collisions
  const lineHeight = xHeight * (2.88 - hurry * 0.18);
  // Measured directly from vector PDF: hw12_4 (-0.054), rodzina (-0.059), calibrated cleanly (-0.032 neat .. -0.052 fast)
  const paraSlope = -0.032 - hurry * 0.020 + rng.gaussian() * (0.002 + hurry * 0.003);

  let lineIndex = 0;
  let globalCursorY = item.y;
  const lastVariantByChar = new Map<string, number>();

  // Autocorrelated hand-inertia state (AR(1)): Anton's real ~15-17 deg slant & relaxed 1.24:1 wider letters!
  let handSize = 1.0;
  let handSlant = slantBase + hurry * 0.045;
  let handAspectX = 1.22 + hurry * 0.09;
  let handRot = 0.0;

  for (const para of rawParagraphs) {
    const words = para.split(/(\s+)/);
    let cursorX = item.x + rng.gaussian() * (4.0 + hurry * 5.5);
    let baselineDrift = 0;
    // Keep lines strictly parallel within a paragraph (tiny ±0.0018 jitter) so long lines never converge!
    let lineSlope = paraSlope + rng.gaussian() * (0.0016 + hurry * 0.0018);
    const wavePhase = rng.range(0, Math.PI * 2);
    const waveFreq = rng.range(0.0045, 0.0085);

    if (para.trim().length === 0) {
      globalCursorY += lineHeight * 0.65;
      lineIndex++;
      continue;
    }

    let lastExitPt: [number, number] | null = null;
    let lastWasLower = false;
    let prevWordLen = 0;

    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      const token = words[wIdx];
      if (!token) continue;

      if (/^\s+$/.test(token)) {
        // Leading indentation spaces stay clean and predictable
        if (prevWordLen === 0) {
          cursorX += xHeight * 1.15 * token.length;
          continue;
        }
        const nextWord = wIdx + 1 < words.length ? words[wIdx + 1] : '';
        const isShortLink = (prevWordLen > 0 && prevWordLen <= 2) || (nextWord.length > 0 && nextWord.length <= 2);
        // Anton leaves generous airy word gaps (~1.75x xHeight), only slightly snugger on short connectors at high hurry
        const shortSnug = hurry >= 0.50 && isShortLink && rng.chance((hurry - 0.25) * 0.55) ? 0.68 : 1.0;
        const spaceW =
          xHeight *
          (1.78 - hurry * 0.16 + rng.gaussian() * (0.28 + hurry * 0.26)) *
          shortSnug *
          token.length;
        const minSpaceFloor = isShortLink && hurry >= 0.50 ? 0.65 : 1.10;
        cursorX += Math.max(xHeight * minSpaceFloor, spaceW);
        // Natural wrist reposition between words
        baselineDrift = baselineDrift * 0.52 + rng.gaussian() * xHeight * (0.07 + hurry * 0.10);
        handSize = handSize * 0.45 + (1.0 + rng.gaussian() * (0.08 + hurry * 0.065)) * 0.55;
        handSlant = handSlant * 0.48 + (slantBase + hurry * 0.045 + rng.gaussian() * (0.06 + hurry * 0.055)) * 0.52;
        handAspectX = handAspectX * 0.48 + (1.22 + hurry * 0.09 + rng.gaussian() * (0.10 + hurry * 0.09)) * 0.52;
        handRot = handRot * 0.40 + rng.gaussian() * (0.04 + hurry * 0.045) * 0.60;
        lastExitPt = null;
        lastWasLower = false;
        currentTime += (0.055 + rng.range(0, 0.025)) * (1 - hurry * 0.25);
        continue;
      }

      prevWordLen = token.length;

      let estWordW = 0;
      for (const ch of token) {
        const entry = GLYPHS[ch] ?? GLYPHS[ch.toLowerCase()];
        const gd = !entry ? FALLBACK_GLYPH : Array.isArray(entry) ? entry[0] : entry;
        estWordW += (gd.w * (1.24 + hurry * 0.08) + 0.19) * xHeight;
      }

      if (cursorX > item.x + 20 && cursorX + estWordW > item.x + maxLineWidth) {
        lineIndex++;
        globalCursorY += lineHeight * rng.range(0.96 - hurry * 0.03, 1.04 + hurry * 0.03);
        cursorX = item.x + rng.gaussian() * (4.5 + hurry * 6.5);
        baselineDrift = 0;
        lineSlope = paraSlope + rng.gaussian() * (0.0016 + hurry * 0.0018);
        lastExitPt = null;
        lastWasLower = false;
        currentTime += 0.12 * (1 - hurry * 0.22);
      }

      const chars = Array.from(token);
      for (let cIdx = 0; cIdx < chars.length; cIdx++) {
        const ch = chars[cIdx];
        const nextCh = cIdx + 1 < chars.length ? chars[cIdx + 1] : null;
        const glyph = pickGlyph(ch, rng, lastVariantByChar, hurry);
        const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
        const isLower = ch === ch.toLowerCase() && ch !== ch.toUpperCase();
        const nextIsLower = Boolean(nextCh && nextCh === nextCh.toLowerCase() && nextCh !== nextCh.toUpperCase());
        const nextIsPunct = Boolean(nextCh && ',.;:?!'.includes(nextCh));
        const isFlatChar = isLower && FLAT_BODY_CHARS.has(ch);

        // Subtle word-end momentum (authentic without crushing final letters!)
        const wordProg = chars.length >= 6 ? cIdx / (chars.length - 1) : 0;
        const wordEndRush = hurry * Math.max(0, wordProg - 0.45);

        // Lively AR(1) hand inertia + individual letter personality (kills "uniform computer font" look!)
        handSize = handSize * 0.62 + (1.0 + rng.gaussian() * (0.075 + hurry * 0.06)) * 0.38;
        handSlant = handSlant * 0.66 + (slantBase + hurry * 0.045 + rng.gaussian() * (0.055 + hurry * 0.05)) * 0.34;
        handAspectX = handAspectX * 0.62 + (1.22 + hurry * 0.09 + rng.gaussian() * (0.095 + hurry * 0.085)) * 0.38;
        handRot = handRot * 0.56 + rng.gaussian() * (0.038 + hurry * 0.042) * 0.44;

        baselineDrift = baselineDrift * 0.78 + rng.gaussian() * xHeight * (0.022 + hurry * 0.026);

        const dxFromMargin = cursorX - item.x;
        const swayY =
          Math.sin(dxFromMargin * waveFreq + wavePhase) * xHeight * (0.035 + hurry * 0.06) +
          noise.fbm(dxFromMargin * 0.0055 + lineIndex * 7.3, 2) * xHeight * (0.03 + hurry * 0.055);
        // Anton's unmistakable lively hand wobble along the line (±0.048..0.075 xHeight)
        const microBounce = rng.gaussian() * xHeight * (0.046 + hurry * 0.032);
        const charY = globalCursorY + dxFromMargin * lineSlope + baselineDrift + swayY + microBounce;

        const biasWeight = 0.55 + hurry * 0.30;
        const bias = (1 - biasWeight) + biasWeight * (glyph.scaleBias ?? 1.0);
        const sizeScale = Math.max(
          0.79,
          Math.min(1.20, handSize + rng.gaussian() * (0.055 + hurry * 0.045)),
        );
        const localSize = xHeight * bias * sizeScale * (1 - wordEndRush * 0.05);
        const localSlant = Math.max(
          0.08,
          Math.min(0.44, handSlant + wordEndRush * 0.055 + rng.gaussian() * (0.042 + hurry * 0.045)),
        );
        const localAspectX = Math.max(
          0.98,
          Math.min(1.48, (handAspectX + rng.gaussian() * (0.065 + hurry * 0.075)) * (1 + wordEndRush * 0.08)),
        );
        // Relaxed ~0.87 vertical aspect turns narrow glyphs into Anton's exact 1.22:1 wider-round letters!
        const localAspectY = Math.max(
          0.76,
          Math.min(1.04, 0.88 - hurry * 0.03 + rng.gaussian() * (0.048 + hurry * 0.042)),
        );
        const rotCap = 0.105 + hurry * 0.055;
        const localRot = Math.max(
          -rotCap,
          Math.min(rotCap, handRot + rng.gaussian() * (0.032 + hurry * 0.035)),
        );

        // Calibrated to vector PDF HW 12.4 + rodzina:
        // Lowercase body ~0.88-0.96, ascenders ~1.04 -> exact 2.05-2.25x ascender/x-height silhouette!
        const midBase = isUpper
          ? 1.0
          : isFlatChar
            ? 0.94 - hurry * 0.11 - wordEndRush * 0.05
            : 0.97 - hurry * 0.07 - wordEndRush * 0.04;
        const midScale =
          hurry <= 0.01
            ? Math.max(0.86, Math.min(1.10, 0.96 + rng.gaussian() * 0.045))
            : Math.max(0.75, Math.min(1.12, midBase + rng.gaussian() * (0.06 + hurry * 0.065)));
        const extScale =
          hurry <= 0.01
            ? 1.02
            : Math.max(0.92, Math.min(1.18, 1.02 + hurry * 0.05 + rng.gaussian() * (0.045 + hurry * 0.045)));

        const baselineY = charY + xHeight;
        const baselineAnchoredY = baselineY - localSize;

        // Anton writes airy detached letters — only very rare subtle skims at high hurry (>= 0.72)
        if (
          hurry >= 0.72 &&
          lastExitPt &&
          lastWasLower &&
          isLower &&
          glyph.strokes.length > 0 &&
          rng.chance((hurry - 0.55) * 0.22)
        ) {
          const firstPt = glyph.strokes[0][0];
          const mappedFirstY =
            firstPt[1] < 0
              ? 1 - midScale + firstPt[1] * extScale
              : firstPt[1] > 1
                ? 1 + (firstPt[1] - 1) * extScale
                : 1 - (1 - firstPt[1]) * midScale;
          const entryX =
            cursorX +
            (firstPt[0] * localAspectX + (1 - mappedFirstY * localAspectY) * localSlant) * localSize;
          const entryY = baselineAnchoredY + mappedFirstY * localAspectY * localSize;
          const dist = Math.hypot(entryX - lastExitPt[0], entryY - lastExitPt[1]);
          if (
            dist > 2 &&
            dist < xHeight * 0.52 &&
            entryX >= lastExitPt[0] - 1 &&
            Math.abs(entryY - lastExitPt[1]) < xHeight * 0.40 &&
            lastExitPt[1] >= baselineY - xHeight * 0.45
          ) {
            const midX = (lastExitPt[0] + entryX) * 0.5;
            const midY = (lastExitPt[1] + entryY) * 0.5 + xHeight * 0.04;
            const skim = buildInkStroke([lastExitPt, [midX, midY], [entryX, entryY]], {
              color: item.color,
              pen: item.pen,
              baseWidth: baseWidth * 0.70,
              noise,
              rng,
              startTime: currentTime,
              isFlow: true,
            });
            strokes.push(skim.stroke);
            currentTime = skim.endTime;
          }
        }

        const res = drawGlyphIntoStrokes(glyph, {
          x: cursorX,
          y: baselineAnchoredY,
          baselineY,
          xHeight,
          size: localSize,
          slant: localSlant,
          aspectX: localAspectX,
          aspectY: localAspectY,
          midScale,
          extScale,
          rotAngle: localRot,
          hurry,
          wordEndRush,
          color: item.color,
          pen: item.pen,
          baseWidth,
          noise,
          rng,
          startTime: currentTime,
          strokes,
          trackPoint,
        });

        currentTime = res.endTime + (0.012 + rng.range(0, 0.010)) * (1 - hurry * 0.25);
        lastExitPt = res.exitPt;
        lastWasLower = isLower;

        // Airy detached Anton letter rhythm (HW 12.2 / 12.4) with varied organic letter spacing
        const midWordPause =
          !nextIsPunct && chars.length >= 6 && cIdx >= 2 && cIdx < chars.length - 2 && rng.chance(0.06 + hurry * 0.08);
        const extraBreath = midWordPause ? xHeight * rng.range(0.08, 0.16 + hurry * 0.06) : 0;
        if (midWordPause) {
          lastExitPt = null;
        }
        const baseGap = nextIsPunct
          ? 0.14
          : (isUpper && nextIsLower ? 0.12 : 0.15) - hurry * 0.025 - wordEndRush * 0.015;
        const charGap = xHeight * (baseGap + rng.gaussian() * (0.045 + hurry * 0.032)) + extraBreath;
        const rightEdge = isUpper && nextIsLower ? res.lowerBandMaxX : res.bodyMaxX;
        const minFloor = nextIsPunct ? 0.12 : Math.max(0.065, 0.095 - hurry * 0.022);
        const safeRight = rightEdge + Math.max(xHeight * minFloor, charGap);
        cursorX = Math.max(cursorX + xHeight * 0.20, safeRight);
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
    aspectY: number;
    midScale: number;
    extScale: number;
    rotAngle: number;
    hurry: number;
    wordEndRush: number;
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
  const {
    x,
    y,
    baselineY,
    xHeight,
    size,
    slant,
    aspectX,
    aspectY,
    midScale,
    extScale,
    rotAngle,
    hurry,
    wordEndRush,
    rng,
    noise,
  } = opts;
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

  // Gentle speed slurring so loops (o, e, a, g, d) stay unmistakably round and never collapse into c/u!
  const slurStrength = Math.min(0.16, hurry * 0.12 + wordEndRush * 0.06);

  const mapZoneY = (gy: number): number => {
    if (gy < 0) return 1.0 - midScale + gy * extScale;
    if (gy > 1) return 1.0 + (gy - 1.0) * extScale;
    return 1.0 - (1.0 - gy) * midScale;
  };

  for (let sIdx = 0; sIdx < glyph.strokes.length; sIdx++) {
    const rawStroke = glyph.strokes[sIdx];
    const nPts = rawStroke.length;

    let slurred: Array<[number, number]> = rawStroke.map(([gx, gy]) => [gx, gy]);
    if (slurStrength > 0.02 && nPts >= 4) {
      const nextPass = slurred.map(([gx, gy]) => [gx, gy] as [number, number]);
      for (let pIdx = 1; pIdx < nPts - 1; pIdx++) {
        const prev = slurred[pIdx - 1];
        const cur = slurred[pIdx];
        const next = slurred[pIdx + 1];
        const avgX = (prev[0] + next[0]) * 0.5;
        const avgY = (prev[1] + next[1]) * 0.5;
        nextPass[pIdx] = [
          cur[0] + (avgX - cur[0]) * slurStrength,
          cur[1] + (avgY - cur[1]) * slurStrength,
        ];
      }
      slurred = nextPass;
    }

    // Per-stroke slight independent wrist angle & drift (second strokes like t-bar, r-shoulder, i-dot)
    const strokeRot = rotAngle + (sIdx > 0 ? rng.gaussian() * (0.025 + hurry * 0.045) : 0);
    const cosA = Math.cos(strokeRot);
    const sinA = Math.sin(strokeRot);
    const worldPts: Array<[number, number]> = [];
    const fieldSeed = rng.range(0, 100);
    const isShortDiacritic = sIdx > 0 && nPts <= 3;
    const strokeDx =
      sIdx > 0
        ? (isShortDiacritic ? hurry * rng.range(0.01, 0.09) : 0) +
          rng.gaussian() * (0.014 + hurry * 0.026)
        : 0;
    const strokeDy =
      sIdx > 0
        ? (isShortDiacritic ? -hurry * rng.range(0.0, 0.05) : 0) + rng.gaussian() * (0.016 + hurry * 0.032)
        : 0;
    const endStretchX = hurry * rng.range(-0.01, 0.06) + rng.gaussian() * (0.02 + hurry * 0.03);
    const endStretchY = rng.gaussian() * (0.02 + hurry * 0.03);

    const lastPtRaw = slurred[nPts - 1];
    const hasBaselineExit = sIdx === 0 && nPts >= 4 && lastPtRaw[1] >= 0.78 && hurry > 0.3;
    const exitDragX = hasBaselineExit && rng.chance(0.28 + hurry * 0.25) ? hurry * rng.range(0.02, 0.08) : 0;
    const exitLiftY = exitDragX > 0 ? -hurry * rng.range(0.0, 0.04) : 0;

    for (let pIdx = 0; pIdx < nPts; pIdx++) {
      const [gx, rawGy] = slurred[pIdx];
      const gy = mapZoneY(rawGy);
      const frac = nPts > 1 ? pIdx / (nPts - 1) : 0;
      const fieldAmp = 0.024 + hurry * 0.028;
      const tailFactor = Math.max(0, (frac - 0.75) / 0.25);
      const dxSmooth =
        noise.sample(fieldSeed + frac * 1.6) * fieldAmp + strokeDx + endStretchX * frac + exitDragX * tailFactor;
      const dySmooth =
        noise.sample(fieldSeed + 37.3 + frac * 1.6) * fieldAmp + strokeDy + endStretchY * frac + exitLiftY * tailFactor;

      const px = (gx + dxSmooth) * aspectX;
      const py = (gy + dySmooth) * aspectY;

      const rx = (px - cx) * cosA - (py - cy) * sinA + cx;
      const ry = (px - cx) * sinA + (py - cy) * cosA + cy;

      const sx = rx + (1 - ry) * slant;
      const wx = x + sx * size;
      const wy = y + ry * size;
      worldPts.push([wx, wy]);
    }

    // Subtle hurried tail-flick overshoot on longer strokes
    if (hurry > 0.35 && worldPts.length >= 4 && rng.chance(hurry * 0.32)) {
      const a = worldPts[worldPts.length - 2];
      const b = worldPts[worldPts.length - 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen > 1.5 && segLen < size * 0.85) {
        const ov = rng.range(0.05, 0.14) * hurry;
        worldPts.push([b[0] + (b[0] - a[0]) * ov, b[1] + (b[1] - a[1]) * ov]);
      }
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
    t = built.endTime + 0.016 * (1 - hurry * 0.25);
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
