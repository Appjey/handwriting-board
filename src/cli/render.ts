import fs from 'node:fs';
import path from 'node:path';
import { RenderedStroke, synthesizeText } from '../engine/handwriting.js';
import { PenKind, TextItem } from '../types.js';
import {
  ExportBg,
  createCanvas,
  encodePng,
  fillBackground,
  rasterizeStrokes,
} from './png-encoder.js';

interface CliOpts {
  text?: string;
  inFile?: string;
  out: string;
  hurry: number;
  size: number;
  color: string;
  pen: PenKind;
  bg: ExportBg;
  scale: number;
  width: number;
  padding: number;
  slant: number;
  seed: number;
  help: boolean;
}

const COLOR_ALIASES: Record<string, string> = {
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

function printHelp(): void {
  console.log(`Usage: node render.mjs [options]

Renders personal human handwriting to a transparent (or paper) PNG or crisp SVG.

Options:
  --text <string>       Text to write (supports \\n newlines; or pipe text via stdin)
  --in <path>           Read text from a UTF-8 text file
  --out <path>          Output .png or .svg path (default: handwriting.png)
  --hurry <0..1>        Writing speed: 0 = neat v4, 0.5 = everyday (default), 1 = rushed
  --size <16..96>       Base letter height in px (default: 28)
  --color <hex|name>    Ink color (default: #18349c; or blue, black, red, green)
  --pen <kind>          ballpoint (default) | fountain | marker | pencil
  --bg <kind>           transparent (default) | paper | white | notebook | lined
  --scale <1..4>        PNG retina scale factor (default: 3)
  --width <200..2400>   Max line width before wrapping (default: 1040)
  --padding <0..200>    Padding around cropped ink in px (default: 24)
  --slant <-0.4..0.5>   Slant lean (default: 0.19)
  --seed <int>          Random seed for reproducible handwriting
  -h, --help            Show this help message
`);
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    out: 'handwriting.png',
    hurry: 0.45,
    size: 28,
    color: '#1d31a8',
    pen: 'ballpoint',
    bg: 'transparent',
    scale: 3,
    width: 1040,
    padding: 24,
    slant: 0.24,
    seed: Math.floor(Math.random() * 1_000_000_000),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--text':
      case '-t':
        opts.text = next().replace(/\\n/g, '\n');
        break;
      case '--in':
      case '-i':
        opts.inFile = next();
        break;
      case '--out':
      case '-o':
        opts.out = next();
        break;
      case '--hurry':
        opts.hurry = Math.max(0, Math.min(1, Number(next())));
        break;
      case '--size':
        opts.size = Math.max(16, Math.min(96, Number(next())));
        break;
      case '--color': {
        const raw = next().trim();
        opts.color = COLOR_ALIASES[raw.toLowerCase()] ?? raw;
        break;
      }
      case '--pen': {
        const p = next() as PenKind;
        if (['ballpoint', 'fountain', 'marker', 'pencil', 'chalk'].includes(p)) opts.pen = p;
        break;
      }
      case '--bg': {
        const b = next() as ExportBg;
        if (['transparent', 'white', 'paper', 'notebook', 'lined'].includes(b)) opts.bg = b;
        break;
      }
      case '--scale':
        opts.scale = Math.max(1, Math.min(4, Number(next())));
        break;
      case '--width':
        opts.width = Math.max(200, Math.min(2400, Number(next())));
        break;
      case '--padding':
        opts.padding = Math.max(0, Math.min(200, Number(next())));
        break;
      case '--slant':
        opts.slant = Math.max(-0.4, Math.min(0.5, Number(next())));
        break;
      case '--seed':
        opts.seed = Math.floor(Number(next()));
        break;
      default:
        if (!arg.startsWith('-') && opts.text === undefined) {
          opts.text = arg.replace(/\\n/g, '\n');
        }
        break;
    }
  }
  return opts;
}

function readStdinIfPiped(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return undefined;
  }
}

function computeStrokeBounds(strokes: RenderedStroke[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    const r = Math.max(1.6, s.baseWidth * 0.9);
    for (const pt of s.points) {
      if (pt.x - r < minX) minX = pt.x - r;
      if (pt.y - r < minY) minY = pt.y - r;
      if (pt.x + r > maxX) maxX = pt.x + r;
      if (pt.y + r > maxY) maxY = pt.y + r;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  return { minX, minY, maxX, maxY };
}

function buildSvg(
  strokes: RenderedStroke[],
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  bg: ExportBg,
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(srcW)}" height="${Math.ceil(srcH)}" viewBox="0 0 ${srcW.toFixed(1)} ${srcH.toFixed(1)}">`,
  );

  if (bg === 'white' || bg === 'paper') {
    parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
    if (bg === 'paper') {
      const step = 76;
      const dots: string[] = [];
      for (let x = step * 0.55; x < srcW; x += step) {
        for (let y = step * 0.55; y < srcH; y += step) {
          dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="rgba(155,160,170,0.45)"/>`);
        }
      }
      parts.push(`<g>${dots.join('')}</g>`);
    }
  }

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;
    const opacity =
      stroke.pen === 'pencil' ? 0.78 : stroke.pen === 'marker' ? 0.92 : stroke.alpha;
    if (stroke.isBlot || pts.length === 1) {
      const cx = (pts[0].x - srcX).toFixed(2);
      const cy = (pts[0].y - srcY).toFixed(2);
      const r = Math.max(1.2, stroke.blotRadius ?? stroke.baseWidth * 0.56).toFixed(2);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${stroke.color}" opacity="${opacity.toFixed(2)}"/>`);
      continue;
    }

    let d = `M ${(pts[0].x - srcX).toFixed(2)} ${(pts[0].y - srcY).toFixed(2)}`;
    if (pts.length === 2) {
      d += ` L ${(pts[1].x - srcX).toFixed(2)} ${(pts[1].y - srcY).toFixed(2)}`;
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const px = pts[i].x - srcX;
        const py = pts[i].y - srcY;
        const mx = (px + (pts[i + 1].x - srcX)) * 0.5;
        const my = (py + (pts[i + 1].y - srcY)) * 0.5;
        d += ` Q ${px.toFixed(2)} ${py.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
      }
      const last = pts[pts.length - 1];
      d += ` L ${(last.x - srcX).toFixed(2)} ${(last.y - srcY).toFixed(2)}`;
    }

    parts.push(
      `<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${Math.max(1.1, stroke.baseWidth).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity.toFixed(2)}"/>`,
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let text = opts.text;
  if (opts.inFile) {
    text = fs.readFileSync(opts.inFile, 'utf8');
  } else if (text === undefined) {
    text = readStdinIfPiped();
  }

  if (!text || !text.trim()) {
    console.error('Error: No input text provided. Pass --text "...", --in file.txt, or pipe stdin.');
    process.exit(1);
  }

  const item: TextItem = {
    id: 'cli_text',
    type: 'text',
    text: text.trimEnd(),
    x: 40,
    y: 80,
    maxWidth: opts.width,
    size: opts.size,
    color: opts.color,
    pen: opts.pen,
    slant: opts.slant,
    hurry: opts.hurry,
    seed: opts.seed,
    animate: false,
    createdAt: Date.now(),
  };

  const synth = synthesizeText(item);
  const bounds = computeStrokeBounds(synth.strokes);
  const srcX = bounds.minX - opts.padding;
  const srcY = bounds.minY - opts.padding;
  const srcW = Math.max(24, bounds.maxX - bounds.minX + opts.padding * 2);
  const srcH = Math.max(24, bounds.maxY - bounds.minY + opts.padding * 2);

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ext = path.extname(outPath).toLowerCase();

  if (ext === '.svg') {
    const svg = buildSvg(synth.strokes, srcX, srcY, srcW, srcH, opts.bg);
    fs.writeFileSync(outPath, svg, 'utf8');
    console.log(
      JSON.stringify({
        out: outPath,
        format: 'svg',
        width: Math.ceil(srcW),
        height: Math.ceil(srcH),
        bg: opts.bg,
        hurry: opts.hurry,
        seed: opts.seed,
        strokes: synth.strokes.length,
      }),
    );
    return;
  }

  // Clamp scale so huge multi-page texts stay fast & within safe memory limits
  const maxEdge = Math.max(srcW, srcH);
  const effectiveScale = Math.max(1, Math.min(opts.scale, 4500 / maxEdge));
  const outW = Math.max(1, Math.round(srcW * effectiveScale));
  const outH = Math.max(1, Math.round(srcH * effectiveScale));

  const canvas = createCanvas(outW, outH);
  fillBackground(canvas, opts.bg, effectiveScale);
  rasterizeStrokes(canvas, synth.strokes, srcX, srcY, effectiveScale);
  const pngBuf = encodePng(canvas);
  fs.writeFileSync(outPath, pngBuf);

  console.log(
    JSON.stringify({
      out: outPath,
      format: 'png',
      width: outW,
      height: outH,
      scale: Number(effectiveScale.toFixed(2)),
      bg: opts.bg,
      hurry: opts.hurry,
      seed: opts.seed,
      strokes: synth.strokes.length,
      bytes: pngBuf.length,
    }),
  );
}

main();
