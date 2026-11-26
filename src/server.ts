import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { synthesizeDoodle, synthesizeText } from './engine/handwriting.js';
import { BoardStore } from './store.js';
import {
  BoardSurface,
  DoodleItem,
  PenKind,
  TextItem,
  UserStrokeItem,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArg(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const dataDir =
  parseArg('--data_dir=') ??
  parseArg('--data-dir=') ??
  process.env.HANDWRITING_BOARD_DATA_DIR ??
  path.resolve(__dirname, '../data');

const appHtmlPath =
  parseArg('--app-html=') ??
  process.env.HANDWRITING_BOARD_APP_HTML ??
  path.join(__dirname, 'app.html');

const store = new BoardStore(dataDir);

const APP_URI = 'ui://handwriting-board/app.html';
const APP_MIME = 'text/html;profile=mcp-app';

const INLINE_META = {
  ui: { resourceUri: APP_URI },
};

const PANE_META = {
  ui: { resourceUri: APP_URI },
  'com.google.antigravity/ui': {
    entrypoints: [
      { type: 'aux_pane', title: 'Handwriting Board' },
      { type: 'global', title: 'Handwriting Board' },
    ],
  },
};

const APP_ONLY_META = {
  ui: { visibility: ['app'] },
};

const COLOR_MAP: Record<string, string> = {
  black: '#1e293b',
  ink: '#1e293b',
  blue: '#1634b0',
  navy: '#1e3a8a',
  red: '#dc2626',
  crimson: '#b91c1c',
  green: '#15803d',
  purple: '#7e22ce',
  orange: '#ea580c',
  brown: '#78350f',
  white: '#f8fafc',
  yellow: '#fde047',
  pink: '#ec4899',
  gray: '#475569',
};

function resolveColor(input: string | undefined, surface: BoardSurface): string {
  if (!input) {
    return surface === 'chalkboard' ? '#f8fafc' : '#18349c';
  }
  const lower = input.trim().toLowerCase();
  return COLOR_MAP[lower] ?? input.trim();
}

function resolvePen(input: PenKind | undefined, surface: BoardSurface): PenKind {
  if (input) return input;
  if (surface === 'chalkboard') return 'chalk';
  return 'ballpoint';
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const server = new McpServer({
  name: 'handwriting-board',
  version: '1.0.0',
});

server.registerResource(
  'handwriting-board-app',
  APP_URI,
  {
    title: 'Handwriting Board App',
    description: 'Interactive whiteboard that renders natural human handwriting stroke-by-stroke.',
    mimeType: APP_MIME,
    _meta: { ui: { prefersBorder: false } },
  },
  async () => {
    const html = fs.readFileSync(appHtmlPath, 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME,
          text: html,
        },
      ],
    };
  },
);

server.registerTool(
  'open_board',
  {
    title: 'Open Handwriting Board',
    description:
      'Opens or displays the interactive handwriting whiteboard. Optionally changes the board surface (paper, whiteboard, chalkboard, notebook, lined) or title.',
    inputSchema: {
      surface: z
        .enum(['paper', 'whiteboard', 'chalkboard', 'notebook', 'lined'])
        .optional()
        .describe('Board surface style: paper (dot-grid), whiteboard, chalkboard, notebook (клетка), or lined'),
      title: z.string().max(60).optional().describe('Optional board title'),
    },
    _meta: PANE_META,
  },
  async ({ surface, title }) => {
    const state = surface || title
      ? store.setSurface(surface ?? store.getState().surface, title)
      : store.getState();

    return {
      content: [
        {
          type: 'text',
          text: `Opened handwriting board "${state.title}" (surface: ${state.surface}, items: ${state.items.length}, next cursorY: ${Math.round(state.cursorY)}).`,
        },
      ],
      structuredContent: { state },
    };
  },
);

server.registerTool(
  'write_handwritten_text',
  {
    title: 'Write Handwritten Text on Board',
    description:
      'Writes text by hand onto the interactive whiteboard using natural human handwriting (supports Russian Cyrillic, English Latin, Polish & French diacritics, digits, punctuation).',
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(1200)
        .describe('Text to handwrite on the board (supports newlines \\n).'),
      pen: z
        .enum(['ballpoint', 'marker', 'fountain', 'chalk', 'pencil'])
        .optional()
        .describe('Writing instrument: ballpoint (default), marker, fountain, chalk, or pencil.'),
      color: z
        .string()
        .optional()
        .describe('Ink color name (blue, black, red, green, purple, orange, white, yellow) or hex (#rrggbb).'),
      size: z
        .number()
        .min(16)
        .max(96)
        .optional()
        .describe('Base letter size in pixels (default 28).'),
      x: z
        .number()
        .min(20)
        .max(1100)
        .optional()
        .describe('Starting X coordinate on 1200x800 board (default 72).'),
      y: z
        .number()
        .min(30)
        .max(760)
        .optional()
        .describe('Starting Y coordinate on 1200x800 board (defaults to auto-flow below previous text).'),
      max_width: z
        .number()
        .min(160)
        .max(1120)
        .optional()
        .describe('Maximum line width before wrapping (default 1040).'),
      slant: z
        .number()
        .min(-0.4)
        .max(0.5)
        .optional()
        .describe('Handwriting lean (-0.4 left to +0.5 right, default 0.19).'),
      hurry: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Writing hurry/speed from 0.0 (neat careful writing) to 1.0 (fast rushed notes with corner-cutting, word-end flattening, rightward diacritic drift). Default 0.5.'),
      animate: z
        .boolean()
        .optional()
        .describe('Animate writing stroke-by-stroke in real time (default true).'),
      seed: z.number().int().optional().describe('Optional random seed for reproducible handwriting.'),
    },
    _meta: PANE_META,
  },
  async (args) => {
    const current = store.getState();
    const pen = resolvePen(args.pen, current.surface);
    const color = resolveColor(args.color, current.surface);
    const size = args.size ?? 29;
    const x = args.x ?? 65;
    const y = args.y ?? current.cursorY;
    const maxWidth = args.max_width ?? Math.max(200, current.width - x - 65);
    const seed = args.seed ?? Math.floor(Math.random() * 1_000_000_000);

    const item: TextItem = {
      id: makeId('txt'),
      type: 'text',
      text: args.text,
      x,
      y,
      maxWidth,
      size,
      color,
      pen,
      slant: args.slant ?? 0.19,
      hurry: args.hurry ?? 0.5,
      seed,
      animate: args.animate ?? true,
      createdAt: Date.now(),
    };

    const synth = synthesizeText(item);
    const nextCursorY = args.y === undefined ? synth.endY + size * 0.35 : undefined;
    const state = store.addItem(item, nextCursorY);

    return {
      content: [
        {
          type: 'text',
          text:
            `Wrote "${args.text}" on the board (pen: ${pen}, color: ${color}). ` +
            `Bounds: x=${Math.round(synth.bounds.x)}, y=${Math.round(synth.bounds.y)}, w=${Math.round(synth.bounds.width)}, h=${Math.round(synth.bounds.height)}. ` +
            `Next cursorY: ${Math.round(state.cursorY)}.`,
        },
      ],
      structuredContent: {
        state,
        itemId: item.id,
        bounds: synth.bounds,
      },
    };
  },
);

server.registerTool(
  'draw_doodle',
  {
    title: 'Draw Hand-Drawn Doodle on Board',
    description:
      'Draws a hand-drawn annotation or doodle (underline, circle, arrow, box, star, heart, scribble, crossout, line).',
    inputSchema: {
      kind: z.enum(['underline', 'circle', 'arrow', 'box', 'star', 'heart', 'scribble', 'crossout', 'line']),
      x: z.number().min(0).max(1200).describe('Start X coordinate (0..1200)'),
      y: z.number().min(0).max(800).describe('Start Y coordinate (0..800)'),
      width: z.number().min(10).max(1100).optional(),
      height: z.number().min(10).max(750).optional(),
      x2: z.number().min(0).max(1200).optional(),
      y2: z.number().min(0).max(800).optional(),
      color: z.string().optional(),
      pen: z.enum(['ballpoint', 'marker', 'fountain', 'chalk', 'pencil']).optional(),
      animate: z.boolean().optional(),
      seed: z.number().int().optional(),
    },
    _meta: INLINE_META,
  },
  async (args) => {
    const current = store.getState();
    const item: DoodleItem = {
      id: makeId('ddl'),
      type: 'doodle',
      kind: args.kind,
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height,
      x2: args.x2,
      y2: args.y2,
      color: resolveColor(args.color, current.surface),
      pen: resolvePen(args.pen, current.surface),
      seed: args.seed ?? Math.floor(Math.random() * 1_000_000_000),
      animate: args.animate ?? true,
      createdAt: Date.now(),
    };

    const synth = synthesizeDoodle(item);
    const state = store.addItem(item);

    return {
      content: [
        {
          type: 'text',
          text: `Drew hand-drawn ${args.kind} at (${Math.round(args.x)}, ${Math.round(args.y)}). Bounds: ${JSON.stringify(synth.bounds)}.`,
        },
      ],
      structuredContent: {
        state,
        itemId: item.id,
        bounds: synth.bounds,
      },
    };
  },
);

server.registerTool(
  'set_board_style',
  {
    title: 'Set Board Style or Clear Board',
    description: 'Changes the board surface (paper, whiteboard, chalkboard, notebook, lined), title, and/or clears all drawings.',
    inputSchema: {
      surface: z.enum(['paper', 'whiteboard', 'chalkboard', 'notebook', 'lined']).optional(),
      title: z.string().max(60).optional(),
      clear: z.boolean().optional().describe('If true, erases everything on the board.'),
    },
    _meta: INLINE_META,
  },
  async ({ surface, title, clear }) => {
    const state = clear
      ? store.clear(surface, title)
      : store.setSurface(surface ?? store.getState().surface, title);

    return {
      content: [
        {
          type: 'text',
          text: `${clear ? 'Cleared' : 'Updated'} board "${state.title}" (surface: ${state.surface}, items: ${state.items.length}).`,
        },
      ],
      structuredContent: { state },
    };
  },
);

server.registerTool(
  'get_board_state',
  {
    title: 'Get Board State',
    description: 'Returns a summary of what is currently written or drawn on the board, including coordinates and next cursorY.',
    inputSchema: {},
  },
  async () => {
    const state = store.getState();
    const summary = state.items.map((it) => {
      if (it.type === 'text') {
        return { id: it.id, type: 'text', text: it.text, x: it.x, y: it.y, color: it.color };
      }
      if (it.type === 'doodle') {
        return { id: it.id, type: 'doodle', kind: it.kind, x: it.x, y: it.y, color: it.color };
      }
      return { id: it.id, type: 'user_stroke', pointsCount: it.points.length, color: it.color };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              title: state.title,
              surface: state.surface,
              size: { width: state.width, height: state.height },
              cursorY: Math.round(state.cursorY),
              items: summary,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: { state },
    };
  },
);

server.registerTool(
  'app_get_state',
  {
    title: 'App Get State',
    description: 'Internal app tool to fetch current board state.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { state: store.getState() },
  }),
);

server.registerTool(
  'app_save_user_stroke',
  {
    title: 'App Save User Stroke',
    description: 'Internal app tool to persist a user freehand stroke.',
    inputSchema: {
      points: z.array(z.object({ x: z.number(), y: z.number(), p: z.number() })).min(2),
      color: z.string(),
      pen: z.enum(['ballpoint', 'marker', 'fountain', 'chalk', 'pencil']),
      size: z.number().min(1).max(30),
    },
    _meta: APP_ONLY_META,
  },
  async ({ points, color, pen, size }) => {
    const item: UserStrokeItem = {
      id: makeId('usr'),
      type: 'user_stroke',
      points,
      color,
      pen,
      size,
      createdAt: Date.now(),
    };
    return {
      content: [{ type: 'text', text: 'saved' }],
      structuredContent: { state: store.addItem(item) },
    };
  },
);

server.registerTool(
  'app_set_surface',
  {
    title: 'App Set Surface',
    description: 'Internal app tool to change board surface.',
    inputSchema: {
      surface: z.enum(['paper', 'whiteboard', 'chalkboard', 'notebook', 'lined']),
    },
    _meta: APP_ONLY_META,
  },
  async ({ surface }) => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { state: store.setSurface(surface) },
  }),
);

server.registerTool(
  'app_undo',
  {
    title: 'App Undo',
    description: 'Internal app tool to undo last item.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { state: store.undo() },
  }),
);

server.registerTool(
  'app_clear_board',
  {
    title: 'App Clear Board',
    description: 'Internal app tool to clear the board.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { state: store.clear() },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
