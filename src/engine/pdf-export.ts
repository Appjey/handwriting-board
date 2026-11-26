import { BoardSurface } from '../types.js';
import { RenderedStroke } from './handwriting.js';
import { buildNoteshelfSegments, inkColorForPressure } from './renderer.js';

export type PdfBg = 'transparent' | 'white' | BoardSurface;

export interface VectorPdfOptions {
  strokes: RenderedStroke[];
  /** Bounding box in board coordinates to map onto the PDF page */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  bg: PdfBg;
  /** CSS px -> PDF pt multiplier (default 0.75 = 96dpi -> 72pt/in) */
  ptScale?: number;
  title?: string;
}

const NAMED_COLORS: Record<string, string> = {
  blue: '#1d31a8',
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

function parseColor01(input: string): [number, number, number] {
  const s = input.trim().toLowerCase();
  const hex = (NAMED_COLORS[s] ?? s).replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (m) {
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  }
  return [29 / 255, 49 / 255, 168 / 255];
}

function n(val: number): string {
  // Compact fixed precision without trailing noise
  const s = val.toFixed(2);
  return s === '-0.00' ? '0' : s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function c01(val: number): string {
  return Math.max(0, Math.min(1, val)).toFixed(3);
}

/** Emits a true vector circle path using 4 cubic Bezier segments + fill ('f'). */
function pdfCircleFill(cx: number, cy: number, r: number): string {
  const k = r * 0.55228475;
  return [
    `${n(cx + r)} ${n(cy)} m`,
    `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
    `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
    `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
    `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c f`,
  ].join('\n');
}

function escapePdfText(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, '\\$&');
}

/**
 * Generates a pure vector PDF 1.4 document (zero rasterization, zero external dependencies).
 * Works identically in browsers (Uint8Array -> Blob) and Node.js (Buffer).
 * Strokes are encoded as exact cubic Bezier curves with round caps/joins so zooming to 6400% stays razor-sharp.
 */
export function buildVectorPdf(opts: VectorPdfOptions): Uint8Array {
  const ptScale = opts.ptScale ?? 0.75;
  const pageW = Math.max(36, opts.srcW * ptScale);
  const pageH = Math.max(36, opts.srcH * ptScale);
  const mapX = (x: number) => (x - opts.srcX) * ptScale;
  const mapY = (y: number) => pageH - (y - opts.srcY) * ptScale;

  const cmds: string[] = [];

  // --- 1. Optional vector background surface ---
  if (opts.bg === 'white') {
    cmds.push(`1 1 1 rg 0 0 ${n(pageW)} ${n(pageH)} re f`);
  } else if (opts.bg === 'paper' || opts.bg === 'whiteboard') {
    const bgFill = opts.bg === 'paper' ? '0.992 0.992 0.992' : '1 1 1';
    cmds.push(`${bgFill} rg 0 0 ${n(pageW)} ${n(pageH)} re f`);

    const step = opts.bg === 'paper' ? 76 : 82;
    const dotR = (opts.bg === 'paper' ? 2.5 : 2.2) * ptScale;
    cmds.push('q /GS_DOT gs 0.608 0.627 0.667 rg');
    const startX = Math.floor(opts.srcX / step) * step + Math.floor(step * 0.55);
    const startY = Math.floor(opts.srcY / step) * step + Math.floor(step * 0.55);
    for (let x = startX; x < opts.srcX + opts.srcW; x += step) {
      if (x < opts.srcX) continue;
      for (let y = startY; y < opts.srcY + opts.srcH; y += step) {
        if (y < opts.srcY) continue;
        cmds.push(pdfCircleFill(mapX(x), mapY(y), dotR));
      }
    }
    cmds.push('Q');
  } else if (opts.bg === 'notebook') {
    cmds.push(`0.988 0.988 0.976 rg 0 0 ${n(pageW)} ${n(pageH)} re f`);
    const cell = 24;
    cmds.push(`q /GS_GRID gs 0.388 0.584 0.839 RG ${n(0.8 * ptScale)} w`);
    const sx = Math.ceil(opts.srcX / cell) * cell;
    for (let x = sx; x <= opts.srcX + opts.srcW; x += cell) {
      const px = mapX(x);
      cmds.push(`${n(px)} 0 m ${n(px)} ${n(pageH)} l S`);
    }
    const sy = Math.ceil(opts.srcY / cell) * cell;
    for (let y = sy; y <= opts.srcY + opts.srcH; y += cell) {
      const py = mapY(y);
      cmds.push(`0 ${n(py)} m ${n(pageW)} ${n(py)} l S`);
    }
    cmds.push('Q');
    const marginX = opts.srcX + opts.srcW - 108;
    if (marginX > opts.srcX + 80) {
      const mx = mapX(marginX);
      cmds.push(`q /GS_MARGIN gs 0.882 0.337 0.384 RG ${n(1.4 * ptScale)} w ${n(mx)} 0 m ${n(mx)} ${n(pageH)} l S Q`);
    }
  } else if (opts.bg === 'lined') {
    cmds.push(`0.992 0.980 0.945 rg 0 0 ${n(pageW)} ${n(pageH)} re f`);
    const gap = 36;
    cmds.push(`q /GS_GRID gs 0.431 0.596 0.784 RG ${n(0.9 * ptScale)} w`);
    const firstY = Math.max(56, Math.ceil((opts.srcY - 56) / gap) * gap + 56);
    for (let y = firstY; y < opts.srcY + opts.srcH; y += gap) {
      const py = mapY(y);
      cmds.push(`0 ${n(py)} m ${n(pageW)} ${n(py)} l S`);
    }
    cmds.push('Q');
    if (opts.srcW > 180) {
      const mx = mapX(opts.srcX + 76);
      cmds.push(`q /GS_MARGIN gs 0.863 0.345 0.373 RG ${n(1.4 * ptScale)} w ${n(mx)} 0 m ${n(mx)} ${n(pageH)} l S Q`);
    }
  } else if (opts.bg === 'chalkboard') {
    cmds.push(`0.114 0.196 0.169 rg 0 0 ${n(pageW)} ${n(pageH)} re f`);
  }
  // bg === 'transparent' -> omit background fill rectangle so the page is pure vector ink!

  // --- 2. Vector handwriting strokes (round caps & round joins!) ---
  cmds.push('q 1 J 1 j');

  let activeGs = '/GS1';
  cmds.push('/GS1 gs');

  const setOpacityForPen = (pen: RenderedStroke['pen'], alpha: number) => {
    const targetGs =
      pen === 'pencil'
        ? '/GS_PENCIL'
        : pen === 'marker'
          ? '/GS_MARKER'
          : alpha < 0.85
            ? '/GS_PENCIL'
            : '/GS1';
    if (targetGs !== activeGs) {
      cmds.push(`${targetGs} gs`);
      activeGs = targetGs;
    }
  };

  for (const stroke of opts.strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;

    setOpacityForPen(stroke.pen, stroke.alpha);

    if (stroke.isBlot || pts.length === 1) {
      const [r, g, b] = parseColor01(stroke.color);
      const rad = Math.max(1.1, stroke.blotRadius ?? stroke.baseWidth * 0.56) * ptScale;
      cmds.push(`${c01(r)} ${c01(g)} ${c01(b)} rg`);
      cmds.push(pdfCircleFill(mapX(pts[0].x), mapY(pts[0].y), rad));
      continue;
    }

    if (stroke.pen === 'fountain') {
      // Exact vector pressure-sensitive ribbon (convex quads + round joint circles)
      const segs = buildNoteshelfSegments(pts, stroke.baseWidth);
      if (segs.length > 0) {
        const first = segs[0];
        const [fr, fg, fb] = parseColor01(inkColorForPressure(stroke.color, first.p));
        cmds.push(`${c01(fr)} ${c01(fg)} ${c01(fb)} rg`);
        cmds.push(pdfCircleFill(mapX(first.x1), mapY(first.y1), first.r1 * ptScale));

        for (const s of segs) {
          const [sr, sg, sb] = parseColor01(inkColorForPressure(stroke.color, s.p));
          cmds.push(`${c01(sr)} ${c01(sg)} ${c01(sb)} rg`);
          cmds.push(
            `${n(mapX(s.quad[0]))} ${n(mapY(s.quad[1]))} m ` +
              `${n(mapX(s.quad[2]))} ${n(mapY(s.quad[3]))} l ` +
              `${n(mapX(s.quad[4]))} ${n(mapY(s.quad[5]))} l ` +
              `${n(mapX(s.quad[6]))} ${n(mapY(s.quad[7]))} l h f`,
          );
          cmds.push(pdfCircleFill(mapX(s.x2), mapY(s.y2), s.r2 * ptScale));
        }
      }
      continue;
    }

    // Crisp uniform monoline vector spline (ballpoint / marker / pencil / chalk)
    // Exact quadratic-to-cubic Bezier degree elevation: ZERO polygonal corners at any zoom!
    const [r, g, b] = parseColor01(stroke.color);
    const lw = Math.max(0.85, stroke.baseWidth * ptScale);
    cmds.push(`${c01(r)} ${c01(g)} ${c01(b)} RG ${n(lw)} w`);

    let curX = mapX(pts[0].x);
    let curY = mapY(pts[0].y);
    const segsOut: string[] = [`${n(curX)} ${n(curY)} m`];

    if (pts.length === 2) {
      segsOut.push(`${n(mapX(pts[1].x))} ${n(mapY(pts[1].y))} l`);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const q1x = mapX(pts[i].x);
        const q1y = mapY(pts[i].y);
        const q2x = (q1x + mapX(pts[i + 1].x)) * 0.5;
        const q2y = (q1y + mapY(pts[i + 1].y)) * 0.5;
        const c1x = curX + (2 / 3) * (q1x - curX);
        const c1y = curY + (2 / 3) * (q1y - curY);
        const c2x = q2x + (2 / 3) * (q1x - q2x);
        const c2y = q2y + (2 / 3) * (q1y - q2y);
        segsOut.push(`${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(q2x)} ${n(q2y)} c`);
        curX = q2x;
        curY = q2y;
      }
      const last = pts[pts.length - 1];
      segsOut.push(`${n(mapX(last.x))} ${n(mapY(last.y))} l`);
    }

    segsOut.push('S');
    cmds.push(segsOut.join('\n'));
  }

  cmds.push('Q');

  const streamText = cmds.join('\n') + '\n';
  const enc = new TextEncoder();
  const streamBytes = enc.encode(streamText);

  // --- 3. Assemble valid PDF 1.4 binary structure with exact UTF-8 byte offsets ---
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pushStr = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    offset += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };

  // Canonical binary marker comment after %PDF-1.4 per PDF 1.4 spec
  pushStr('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [0]; // obj 0 unused

  // 1: Catalog
  offsets.push(offset);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  offsets.push(offset);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // 3: Page
  offsets.push(offset);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] ` +
      `/Resources << /ExtGState << /GS1 5 0 R /GS_PENCIL 6 0 R /GS_MARKER 7 0 R /GS_DOT 8 0 R /GS_GRID 9 0 R /GS_MARGIN 10 0 R >> >> ` +
      `/Contents 4 0 R >>\nendobj\n`,
  );

  // 4: Content Stream
  offsets.push(offset);
  pushStr(`4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
  pushBytes(streamBytes);
  pushStr('endstream\nendobj\n');

  // 5..10: ExtGState objects for crisp vector alpha
  const gsDefs = [
    '<< /Type /ExtGState /CA 1 /ca 1 >>',
    '<< /Type /ExtGState /CA 0.78 /ca 0.78 >>',
    '<< /Type /ExtGState /CA 0.92 /ca 0.92 >>',
    '<< /Type /ExtGState /CA 0.45 /ca 0.45 >>',
    '<< /Type /ExtGState /CA 0.24 /ca 0.24 >>',
    '<< /Type /ExtGState /CA 0.44 /ca 0.44 >>',
  ];
  for (let i = 0; i < gsDefs.length; i++) {
    offsets.push(offset);
    pushStr(`${5 + i} 0 obj\n${gsDefs[i]}\nendobj\n`);
  }

  // 11: Info dictionary
  offsets.push(offset);
  const titleSafe = escapePdfText(opts.title || 'Handwriting Board');
  pushStr(`11 0 obj\n<< /Title (${titleSafe}) /Producer (Handwriting Board Vector PDF) >>\nendobj\n`);

  const xrefOffset = offset;
  pushStr(`xref\n0 ${offsets.length}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  pushStr(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 11 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
