import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  BoardItem,
  BoardState,
  BoardSurface,
  PenKind,
  UserStrokeItem,
} from '../types.js';
import {
  SynthesizedResult,
  synthesizeDoodle,
  synthesizeText,
} from '../engine/handwriting.js';
import {
  renderInkStroke,
  renderPenCursor,
  renderSurface,
  renderUserStroke,
} from '../engine/renderer.js';

const BOARD_W = 1200;
const BOARD_H = 800;

const canvas = document.getElementById('board-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const titleEl = document.getElementById('board-title') as HTMLElement;
const surfaceSelect = document.getElementById('surface-select') as HTMLSelectElement;
const statusPill = document.getElementById('status-pill') as HTMLElement;
const btnReplay = document.getElementById('btn-replay') as HTMLButtonElement;
const btnSpeed = document.getElementById('btn-speed') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnExport = document.getElementById('btn-export') as HTMLButtonElement;
const swatchWrap = document.getElementById('color-swatches') as HTMLElement;

// High-DPI canvas setup
const dpr = Math.min(2, window.devicePixelRatio || 1);
canvas.width = BOARD_W * dpr;
canvas.height = BOARD_H * dpr;

// Offscreen static cache (surface + already completed items)
const staticCanvas = document.createElement('canvas');
staticCanvas.width = BOARD_W * dpr;
staticCanvas.height = BOARD_H * dpr;
const staticCtx = staticCanvas.getContext('2d')!;

// Cache synthesized strokes per item id so re-renders are instant
const synthCache = new Map<string, SynthesizedResult>();

let boardState: BoardState = {
  version: 0,
  title: 'Доска',
  surface: 'whiteboard',
  width: BOARD_W,
  height: BOARD_H,
  cursorY: 90,
  items: [],
};

let animItemId: string | null = null;
let animElapsed = 0;
let animLastTs = 0;
let animRafId: number | null = null;
const SPEEDS = [1, 2, 4];
let speedIdx = 0;

// Freehand user drawing state
let drawColor = '#1e293b';
let isDrawing = false;
let activeUserPoints: Array<{ x: number; y: number; p: number }> = [];

// MCP App connection
const app = new App({ name: 'Handwriting Board', version: '1.0.0' }, {});
let mcpConnected = false;

function getSynth(item: BoardItem): SynthesizedResult | null {
  if (item.type === 'user_stroke') return null;
  let cached = synthCache.get(item.id);
  if (!cached) {
    cached = item.type === 'text' ? synthesizeText(item) : synthesizeDoodle(item);
    synthCache.set(item.id, cached);
  }
  return cached;
}

function statusLabel(state: BoardState): string {
  const last = [...state.items].reverse().find((it) => it.type === 'text');
  if (!last || last.type !== 'text') {
    return state.items.length === 0 ? 'Чистая доска • v4' : `Элементов: ${state.items.length} • v4`;
  }
  return `✍️ ${last.pen} • v4`;
}

function rebuildStaticLayer(excludeId: string | null): void {
  staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderSurface(staticCtx, boardState.surface, BOARD_W, BOARD_H);

  for (const item of boardState.items) {
    if (item.id === excludeId) continue;
    if (item.type === 'user_stroke') {
      renderUserStroke(staticCtx, item);
    } else {
      const synth = getSynth(item);
      if (synth) {
        for (const stroke of synth.strokes) {
          renderInkStroke(staticCtx, stroke, Infinity);
        }
      }
    }
  }
}

function paintFrame(animTime: number | null): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(staticCanvas, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (animItemId && animTime !== null) {
    const item = boardState.items.find((it) => it.id === animItemId);
    if (item && item.type !== 'user_stroke') {
      const synth = getSynth(item);
      if (synth) {
        let activeTip: [number, number] | undefined;
        let activeColor = item.color;
        let activePen: PenKind = item.pen;
        for (const stroke of synth.strokes) {
          const res = renderInkStroke(ctx, stroke, animTime);
          if (res.tip) {
            activeTip = res.tip;
            activeColor = stroke.color;
            activePen = stroke.pen;
          }
        }
        if (activeTip) {
          renderPenCursor(ctx, activeTip[0], activeTip[1], activeColor, activePen);
        }
      }
    }
  }

  // Live user stroke being drawn right now
  if (isDrawing && activeUserPoints.length > 1) {
    const preview: UserStrokeItem = {
      id: '__live__',
      type: 'user_stroke',
      points: activeUserPoints,
      color: drawColor,
      pen: boardState.surface === 'chalkboard' ? 'chalk' : 'marker',
      size: 3.6,
      createdAt: 0,
    };
    renderUserStroke(ctx, preview);
  }
}

function stopAnimation(): void {
  if (animRafId !== null) {
    cancelAnimationFrame(animRafId);
    animRafId = null;
  }
  animItemId = null;
}

function startAnimation(itemId: string): void {
  stopAnimation();
  const item = boardState.items.find((it) => it.id === itemId);
  if (!item || item.type === 'user_stroke') {
    rebuildStaticLayer(null);
    paintFrame(null);
    return;
  }

  const synth = getSynth(item);
  if (!synth || synth.duration <= 0.01) {
    rebuildStaticLayer(null);
    paintFrame(null);
    return;
  }

  animItemId = itemId;
  animElapsed = 0;
  animLastTs = performance.now();
  rebuildStaticLayer(itemId);
  statusPill.textContent = '✍️ Пишу от руки...';

  const tick = (now: number) => {
    const dt = Math.min(0.08, (now - animLastTs) / 1000) * SPEEDS[speedIdx];
    animLastTs = now;
    animElapsed += dt;

    if (animElapsed >= synth.duration) {
      stopAnimation();
      rebuildStaticLayer(null);
      paintFrame(null);
      statusPill.textContent = statusLabel(boardState);
      return;
    }

    paintFrame(animElapsed);
    animRafId = requestAnimationFrame(tick);
  };

  animRafId = requestAnimationFrame(tick);
}

function applyBoardState(next: BoardState, forceAnimateLast = false): void {
  const prevIds = new Set(boardState.items.map((it) => it.id));
  boardState = next;

  titleEl.textContent = next.title || 'Доска';
  surfaceSelect.value = next.surface;

  // Pick a visible default user pen color on dark chalkboard
  if (next.surface === 'chalkboard' && drawColor === '#1e293b') {
    setDrawColor('#f8fafc');
  } else if (next.surface !== 'chalkboard' && drawColor === '#f8fafc') {
    setDrawColor('#1e293b');
  }

  // Prune stale cache entries
  const validIds = new Set(next.items.map((it) => it.id));
  for (const id of synthCache.keys()) {
    if (!validIds.has(id)) synthCache.delete(id);
  }

  const newest = next.lastAddedId
    ? next.items.find((it) => it.id === next.lastAddedId)
    : next.items[next.items.length - 1];

  const shouldAnimate =
    newest &&
    newest.type !== 'user_stroke' &&
    newest.animate &&
    (forceAnimateLast || !prevIds.has(newest.id));

  if (shouldAnimate && newest) {
    startAnimation(newest.id);
  } else {
    stopAnimation();
    rebuildStaticLayer(null);
    paintFrame(null);
    statusPill.textContent = statusLabel(next);
  }
}

function setDrawColor(color: string): void {
  drawColor = color;
  swatchWrap.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

// --- Server bridge helpers ---
async function callServer(name: string, args: Record<string, unknown> = {}): Promise<BoardState | null> {
  if (!mcpConnected) return null;
  try {
    const res = await app.callServerTool({ name, arguments: args });
    const sc = (res as { structuredContent?: { state?: BoardState } }).structuredContent;
    if (sc?.state) return sc.state;
  } catch (err) {
    console.error('callServerTool failed:', name, err);
  }
  return null;
}

// --- Pointer drawing on the board ---
function clientToBoard(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * BOARD_W,
    y: ((ev.clientY - rect.top) / rect.height) * BOARD_H,
  };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  canvas.setPointerCapture(ev.pointerId);
  isDrawing = true;
  const pt = clientToBoard(ev);
  activeUserPoints = [{ x: pt.x, y: pt.y, p: ev.pressure > 0 ? ev.pressure * 1.4 : 1.0 }];
});

canvas.addEventListener('pointermove', (ev) => {
  if (!isDrawing) return;
  const pt = clientToBoard(ev);
  const last = activeUserPoints[activeUserPoints.length - 1];
  if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 2.2) {
    activeUserPoints.push({ x: pt.x, y: pt.y, p: ev.pressure > 0 ? ev.pressure * 1.4 : 1.0 });
    paintFrame(animItemId ? animElapsed : null);
  }
});

async function finishUserStroke(): Promise<void> {
  if (!isDrawing) return;
  isDrawing = false;
  const pts = activeUserPoints;
  activeUserPoints = [];
  if (pts.length < 2) return;

  const pen: PenKind = boardState.surface === 'chalkboard' ? 'chalk' : 'marker';
  const strokeItem: UserStrokeItem = {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'user_stroke',
    points: pts,
    color: drawColor,
    pen,
    size: 3.6,
    createdAt: Date.now(),
  };

  boardState.items.push(strokeItem);
  rebuildStaticLayer(animItemId);
  paintFrame(animItemId ? animElapsed : null);

  await callServer('app_save_user_stroke', {
    points: pts,
    color: drawColor,
    pen,
    size: 3.6,
  });
}

canvas.addEventListener('pointerup', finishUserStroke);
canvas.addEventListener('pointercancel', finishUserStroke);

// --- Toolbar actions ---
surfaceSelect.addEventListener('change', async () => {
  const surface = surfaceSelect.value as BoardSurface;
  boardState.surface = surface;
  rebuildStaticLayer(animItemId);
  paintFrame(animItemId ? animElapsed : null);
  await callServer('app_set_surface', { surface });
});

swatchWrap.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
  if (btn?.dataset.color) setDrawColor(btn.dataset.color);
});

btnReplay.addEventListener('click', () => {
  const lastAnim = [...boardState.items].reverse().find((it) => it.type !== 'user_stroke');
  if (lastAnim) startAnimation(lastAnim.id);
});

btnSpeed.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  btnSpeed.textContent = `${SPEEDS[speedIdx]}x`;
});

btnUndo.addEventListener('click', async () => {
  const next = await callServer('app_undo');
  if (next) {
    applyBoardState(next, false);
  } else if (boardState.items.length > 0) {
    boardState.items.pop();
    applyBoardState({ ...boardState }, false);
  }
});

btnClear.addEventListener('click', async () => {
  const next = await callServer('app_clear_board');
  if (next) {
    applyBoardState(next, false);
  } else {
    boardState.items = [];
    boardState.cursorY = 90;
    applyBoardState({ ...boardState }, false);
  }
});

btnExport.addEventListener('click', () => {
  stopAnimation();
  rebuildStaticLayer(null);
  paintFrame(null);
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `handwriting-board-${Date.now()}.png`;
  a.click();
});

// --- MCP App Lifecycle (register handlers BEFORE connect!) ---
app.ontoolinput = () => {
  statusPill.textContent = '✍️ Подготовка...';
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: { state?: BoardState } }).structuredContent;
  if (sc?.state) {
    applyBoardState(sc.state, false);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  // Initial blank board render
  rebuildStaticLayer(null);
  paintFrame(null);

  if (window.parent === window) {
    const demoState: BoardState = {
      version: 1,
      title: 'Доска',
      surface: 'paper',
      width: BOARD_W,
      height: BOARD_H,
      cursorY: 90,
      lastAddedId: 'demo-1',
      items: [
        {
          id: 'demo-1',
          type: 'text',
          text: '1.) On interesuje się francuskim sportem.\n2.) Bardzo lubię niemiecką kuchnię.',
          x: 72,
          y: 110,
          maxWidth: 1020,
          size: 30,
          color: '#1634b0',
          pen: 'ballpoint',
          slant: 0.12,
          seed: 101,
          animate: true,
          createdAt: 1,
        },
      ],
    };
    applyBoardState(demoState, true);
    return;
  }

  try {
    await app.connect();
    mcpConnected = true;
    const hostCtx = app.getHostContext();
    if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
    if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);

    // Fetch current state in case the view was reopened
    const state = await callServer('app_get_state');
    if (state) applyBoardState(state, false);
  } catch (err) {
    console.error('MCP App connect failed:', err);
  }
}

init();
