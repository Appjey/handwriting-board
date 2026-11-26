import zlib from 'node:zlib';
import { RenderedStroke } from '../engine/handwriting.js';
import { inkColorForPressure } from '../engine/renderer.js';

export type ExportBg = 'transparent' | 'white' | 'paper' | 'notebook' | 'lined';

export interface RgbaCanvas {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parseColor(input: string): [number, number, number] {
  const s = input.trim().toLowerCase();
  const named: Record<string, string> = {
    blue: '#18349c',
    navy: '#1e3a8a',
    black: '#1e293b',
    ink: '#1e293b',
    red: '#dc2626',
    green: '#15803d',
    purple: '#7e22ce',
    orange: '#ea580c',
    gray: '#475569',
    white: '#f8fafc',
  };
  const hex = (named[s] ?? s).replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbMatch = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return [24, 52, 156];
}

export function createCanvas(width: number, height: number): RgbaCanvas {
  return {
    width,
    height,
    data: new Uint8Array(width * height * 4),
  };
}

function blendPixelOver(
  buf: Uint8Array,
  idx: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): void {
  if (sa <= 0.001) return;
  const da = buf[idx + 3] / 255;
  if (da <= 0.001) {
    buf[idx] = sr;
    buf[idx + 1] = sg;
    buf[idx + 2] = sb;
    buf[idx + 3] = Math.min(255, Math.round(sa * 255));
    return;
  }
  const outA = sa + da * (1 - sa);
  if (outA <= 0.001) return;
  const dr = buf[idx];
  const dg = buf[idx + 1];
  const db = buf[idx + 2];
  buf[idx] = Math.round((sr * sa + dr * da * (1 - sa)) / outA);
  buf[idx + 1] = Math.round((sg * sa + dg * da * (1 - sa)) / outA);
  buf[idx + 2] = Math.round((sb * sa + db * da * (1 - sa)) / outA);
  buf[idx + 3] = Math.min(255, Math.round(outA * 255));
}

export function fillBackground(
  canvas: RgbaCanvas,
  bg: ExportBg,
  scale: number,
): void {
  if (bg === 'transparent') return;
  const { width, height, data } = canvas;
  const fillRgb: [number, number, number] =
    bg === 'notebook' ? [252, 252, 249] : bg === 'lined' ? [253, 250, 241] : [255, 255, 255];

  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillRgb[0];
    data[i + 1] = fillRgb[1];
    data[i + 2] = fillRgb[2];
    data[i + 3] = 255;
  }

  if (bg === 'paper') {
    const step = 76 * scale;
    const dotR = 2.5 * scale;
    for (let x = step * 0.55; x < width; x += step) {
      for (let y = step * 0.55; y < height; y += step) {
        stampDiscOver(canvas, x, y, dotR, 155, 160, 170, 0.45);
      }
    }
  } else if (bg === 'notebook') {
    const cell = Math.max(8, Math.round(24 * scale));
    const lw = Math.max(1, Math.round(scale * 0.5));
    for (let x = 0; x < width; x += cell) {
      for (let dx = 0; dx < lw && x + dx < width; dx++) {
        for (let y = 0; y < height; y++) {
          blendPixelOver(data, (y * width + x + dx) * 4, 99, 149, 214, 0.22);
        }
      }
    }
    for (let y = 0; y < height; y += cell) {
      for (let dy = 0; dy < lw && y + dy < height; dy++) {
        for (let x = 0; x < width; x++) {
          blendPixelOver(data, ((y + dy) * width + x) * 4, 99, 149, 214, 0.22);
        }
      }
    }
  } else if (bg === 'lined') {
    const gap = Math.max(12, Math.round(36 * scale));
    const lw = Math.max(1, Math.round(scale * 0.5));
    for (let y = Math.round(56 * scale); y < height; y += gap) {
      for (let dy = 0; dy < lw && y + dy < height; dy++) {
        for (let x = 0; x < width; x++) {
          blendPixelOver(data, ((y + dy) * width + x) * 4, 110, 152, 200, 0.28);
        }
      }
    }
  }
}

function stampDiscOver(
  canvas: RgbaCanvas,
  cx: number,
  cy: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const { width, height, data } = canvas;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius + 1));
  for (let py = y0; py <= y1; py++) {
    const dy = py + 0.5 - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - cx;
      const dist = Math.hypot(dx, dy);
      const cov = Math.max(0, Math.min(1, radius + 0.65 - dist));
      if (cov > 0) {
        blendPixelOver(data, (py * width + px) * 4, r, g, b, cov * alpha);
      }
    }
  }
}

/**
 * Renders a batch of strokes with crisp analytical anti-aliasing.
 * Uses per-stroke local coverage max-compositing before blending onto the RGBA canvas
 * so overlapping capsule segments never double-darken or bloat joints.
 */
export function rasterizeStrokes(
  canvas: RgbaCanvas,
  strokes: RenderedStroke[],
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  const { width, height, data } = canvas;

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;

    const penAlpha =
      stroke.pen === 'pencil'
        ? 0.78
        : stroke.pen === 'marker'
          ? 0.92
          : Math.min(1.0, stroke.alpha);

    if (stroke.isBlot || pts.length === 1) {
      const [r, g, b] = parseColor(stroke.color);
      const rad = Math.max(1.2, stroke.blotRadius ?? stroke.baseWidth * 0.56) * scale;
      stampDiscOver(canvas, (pts[0].x - offsetX) * scale, (pts[0].y - offsetY) * scale, rad, r, g, b, penAlpha);
      continue;
    }

    // Compute tight pixel bounding box for this single stroke so we can use a tiny coverage buffer
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const isCalligraphic = stroke.pen === 'fountain';
    const maxR = stroke.baseWidth * (isCalligraphic ? 0.78 : 0.52) * scale + 1.5;

    for (const pt of pts) {
      const sx = (pt.x - offsetX) * scale;
      const sy = (pt.y - offsetY) * scale;
      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx > maxX) maxX = sx;
      if (sy > maxY) maxY = sy;
    }

    const bx0 = Math.max(0, Math.floor(minX - maxR));
    const by0 = Math.max(0, Math.floor(minY - maxR));
    const bx1 = Math.min(width - 1, Math.ceil(maxX + maxR));
    const by1 = Math.min(height - 1, Math.ceil(maxY + maxR));
    if (bx1 < bx0 || by1 < by0) continue;

    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const covBuf = new Uint8Array(bw * bh);
    const colBuf = isCalligraphic ? new Uint8Array(bw * bh * 3) : null;
    const [baseR, baseG, baseB] = parseColor(stroke.color);

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const ax = (a.x - offsetX) * scale;
      const ay = (a.y - offsetY) * scale;
      const bx = (b.x - offsetX) * scale;
      const by = (b.y - offsetY) * scale;

      const r1 = Math.max(0.55, stroke.baseWidth * (isCalligraphic ? a.p : 1.0) * 0.5 * scale);
      const r2 = Math.max(0.55, stroke.baseWidth * (isCalligraphic ? b.p : 1.0) * 0.5 * scale);
      const segMaxR = Math.max(r1, r2) + 1.1;

      const sx0 = Math.max(bx0, Math.floor(Math.min(ax, bx) - segMaxR));
      const sx1 = Math.min(bx1, Math.ceil(Math.max(ax, bx) + segMaxR));
      const sy0 = Math.max(by0, Math.floor(Math.min(ay, by) - segMaxR));
      const sy1 = Math.min(by1, Math.ceil(Math.max(ay, by) + segMaxR));

      const vx = bx - ax;
      const vy = by - ay;
      const lenSq = vx * vx + vy * vy;

      let segR = baseR;
      let segG = baseG;
      let segB = baseB;
      if (isCalligraphic) {
        const colStr = inkColorForPressure(stroke.color, (a.p + b.p) * 0.5);
        [segR, segG, segB] = parseColor(colStr);
      }

      for (let py = sy0; py <= sy1; py++) {
        const y = py + 0.5;
        const rowOff = (py - by0) * bw;
        for (let px = sx0; px <= sx1; px++) {
          const x = px + 0.5;
          let t = 0;
          if (lenSq > 1e-6) {
            t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / lenSq));
          }
          const projX = ax + vx * t;
          const projY = ay + vy * t;
          const dist = Math.hypot(x - projX, y - projY);
          const rad = r1 + (r2 - r1) * t;
          const cov = Math.max(0, Math.min(1, rad + 0.6 - dist));
          if (cov <= 0) continue;

          const covByte = Math.round(cov * 255);
          const cIdx = rowOff + (px - bx0);
          if (covByte > covBuf[cIdx]) {
            covBuf[cIdx] = covByte;
            if (colBuf) {
              colBuf[cIdx * 3] = segR;
              colBuf[cIdx * 3 + 1] = segG;
              colBuf[cIdx * 3 + 2] = segB;
            }
          }
        }
      }
    }

    // Composite this stroke's clean coverage onto the RGBA target canvas
    for (let ly = 0; ly < bh; ly++) {
      const py = by0 + ly;
      const dstRow = py * width;
      const srcRow = ly * bw;
      for (let lx = 0; lx < bw; lx++) {
        const covByte = covBuf[srcRow + lx];
        if (covByte === 0) continue;
        const sa = (covByte / 255) * penAlpha;
        const cIdx = srcRow + lx;
        const sr = colBuf ? colBuf[cIdx * 3] : baseR;
        const sg = colBuf ? colBuf[cIdx * 3 + 1] : baseG;
        const sb = colBuf ? colBuf[cIdx * 3 + 2] : baseB;
        blendPixelOver(data, (dstRow + bx0 + lx) * 4, sr, sg, sb, sa);
      }
    }
  }
}

// --- Pure-Node PNG encoder (zero external dependencies) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function encodePng(canvas: RgbaCanvas): Buffer {
  const { width, height, data } = canvas;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type None
    raw.set(data.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}
