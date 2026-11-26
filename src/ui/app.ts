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
  TextItem,
  UserStrokeItem,
} from '../types.js';
import {
  RenderedStroke,
  SynthesizedResult,
  synthesizeDoodle,
  synthesizeText,
} from '../engine/handwriting.js';
import { buildVectorPdf, PdfBg } from '../engine/pdf-export.js';
import {
  renderInkStroke,
  renderPenCursor,
  renderSurface,
  renderUserStroke,
} from '../engine/renderer.js';

const BOARD_W = 1200;
const BASE_BOARD_H = 800;
let currentBoardH = BASE_BOARD_H;

const canvas = document.getElementById('board-canvas') as HTMLCanvasElement;
const stageWrap = document.getElementById('stage-wrap') as HTMLElement;
const ctx = canvas.getContext('2d')!;
const titleEl = document.getElementById('board-title') as HTMLElement;
const surfaceSelect = document.getElementById('surface-select') as HTMLSelectElement;
const statusPill = document.getElementById('status-pill') as HTMLElement;
const hurrySlider = document.getElementById('hurry-slider') as HTMLInputElement;
const hurryVal = document.getElementById('hurry-val') as HTMLElement;
const btnReplay = document.getElementById('btn-replay') as HTMLButtonElement;
const btnSpeed = document.getElementById('btn-speed') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnCopyPng = document.getElementById('btn-copy-png') as HTMLButtonElement;
const btnExportTransparent = document.getElementById('btn-export-transparent') as HTMLButtonElement;
const btnExportPdf = document.getElementById('btn-export-pdf') as HTMLButtonElement;
const btnExportPdfClean = document.getElementById('btn-export-pdf-clean') as HTMLButtonElement;
const btnExportBg = document.getElementById('btn-export-bg') as HTMLButtonElement;
const btnToggleComposer = document.getElementById('btn-toggle-composer') as HTMLButtonElement;
const swatchWrap = document.getElementById('color-swatches') as HTMLElement;

// Local text composer controls
const composerPanel = document.getElementById('composer-panel') as HTMLElement;
const textInput = document.getElementById('text-input') as HTMLTextAreaElement;
const sizeSlider = document.getElementById('size-slider') as HTMLInputElement;
const sizeVal = document.getElementById('size-val') as HTMLElement;
const penSelect = document.getElementById('pen-select') as HTMLSelectElement;
const btnShuffle = document.getElementById('btn-shuffle') as HTMLButtonElement;
const btnPullText = document.getElementById('btn-pull-text') as HTMLButtonElement;
const btnAppendBlock = document.getElementById('btn-append-block') as HTMLButtonElement;

// Transparent PNG export preview toast
const exportToast = document.getElementById('export-toast') as HTMLElement;
const exportToastTitle = document.getElementById('export-toast-title') as HTMLElement;
const exportToastHint = document.getElementById('export-toast-hint') as HTMLElement;
const exportPreviewImg = document.getElementById('export-preview-img') as HTMLImageElement;
const btnCloseToast = document.getElementById('btn-close-toast') as HTMLButtonElement;
const btnToastCopy = document.getElementById('btn-toast-copy') as HTMLButtonElement;
const btnToastDownload = document.getElementById('btn-toast-download') as HTMLAnchorElement;

// High-DPI canvas setup
const dpr = Math.min(2, window.devicePixelRatio || 1);
const staticCanvas = document.createElement('canvas');
const staticCtx = staticCanvas.getContext('2d')!;

function resizeCanvases(targetH: number): void {
  const clampedH = Math.max(BASE_BOARD_H, Math.min(2400, Math.ceil(targetH)));
  if (clampedH === currentBoardH && canvas.width === BOARD_W * dpr && canvas.height === clampedH * dpr) {
    return;
  }
  currentBoardH = clampedH;
  canvas.width = BOARD_W * dpr;
  canvas.height = currentBoardH * dpr;
  canvas.style.aspectRatio = `${BOARD_W} / ${currentBoardH}`;
  const isTall = currentBoardH > BASE_BOARD_H + 20;
  canvas.classList.toggle('tall-mode', isTall);
  stageWrap.classList.toggle('tall-mode', isTall);
  staticCanvas.width = BOARD_W * dpr;
  staticCanvas.height = currentBoardH * dpr;
}

resizeCanvases(BASE_BOARD_H);

// Cache synthesized strokes per item id so re-renders are instant
const synthCache = new Map<string, SynthesizedResult>();

let boardState: BoardState = {
  version: 0,
  title: 'Доска',
  surface: 'paper',
  width: BOARD_W,
  height: BASE_BOARD_H,
  cursorY: 76,
  items: [],
};

let animItemId: string | null = null;
let animElapsed = 0;
let animLastTs = 0;
let animRafId: number | null = null;
const SPEEDS = [1, 2, 4];
let speedIdx = 0;

// Shared ink color (default: exact measured Noteshelf 3 blue #1d31a8) & freehand drawing state
let drawColor = '#1d31a8';
let isDrawing = false;
let activeUserPoints: Array<{ x: number; y: number; p: number }> = [];

// Local composer state (renders instantly without AI!)
const LIVE_TEXT_ID = '__composer_live__';
let composerSeed = Math.floor(Math.random() * 1_000_000_000);
let composerBaseItems: BoardItem[] | null = null;
let composerStartY = 76;
let composerDebounceTimer: number | null = null;
let serverSyncTimer: number | null = null;

// Last generated transparent PNG blob/URL for preview toast
let lastExportBlob: Blob | null = null;
let lastExportBlobUrl: string | null = null;

// MCP App connection
const app = new App({ name: 'Handwriting Board', version: '1.1.0' }, {});
let mcpConnected = false;

let hurryOverride: number | null = null;

function getSynth(item: BoardItem): SynthesizedResult | null {
  if (item.type === 'user_stroke') return null;
  let cached = synthCache.get(item.id);
  if (!cached) {
    const effective =
      item.type === 'text' && hurryOverride !== null
        ? { ...item, hurry: hurryOverride }
        : item;
    cached = effective.type === 'text' ? synthesizeText(effective) : synthesizeDoodle(effective);
    synthCache.set(item.id, cached);
  }
  return cached;
}

function computeContentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of boardState.items) {
    if (item.type === 'user_stroke') {
      const r = Math.max(2, item.size * 0.65);
      for (const pt of item.points) {
        if (pt.x - r < minX) minX = pt.x - r;
        if (pt.y - r < minY) minY = pt.y - r;
        if (pt.x + r > maxX) maxX = pt.x + r;
        if (pt.y + r > maxY) maxY = pt.y + r;
      }
    } else {
      const synth = getSynth(item);
      if (!synth) continue;
      for (const stroke of synth.strokes) {
        const r = Math.max(1.6, stroke.baseWidth * 0.85);
        for (const pt of stroke.points) {
          if (pt.x - r < minX) minX = pt.x - r;
          if (pt.y - r < minY) minY = pt.y - r;
          if (pt.x + r > maxX) maxX = pt.x + r;
          if (pt.y + r > maxY) maxY = pt.y + r;
        }
      }
    }
  }

  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function syncBoardHeightToContent(): void {
  const bounds = computeContentBounds();
  const neededH = bounds ? Math.max(BASE_BOARD_H, bounds.maxY + 64) : BASE_BOARD_H;
  resizeCanvases(neededH);
}

function statusLabel(state: BoardState): string {
  const last = [...state.items].reverse().find((it) => it.type === 'text');
  if (!last || last.type !== 'text') {
    return state.items.length === 0 ? 'Чистая доска • v8' : `Элементов: ${state.items.length} • v8`;
  }
  const hPct = Math.round((hurryOverride ?? last.hurry ?? 0.45) * 100);
  return `✍️ ${last.pen} • спешка ${hPct}% • v8`;
}

function rebuildStaticLayer(excludeId: string | null): void {
  syncBoardHeightToContent();
  staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderSurface(staticCtx, boardState.surface, BOARD_W, currentBoardH);

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

  // Pick a visible default pen color on dark chalkboard
  if (next.surface === 'chalkboard' && (drawColor === '#1e293b' || drawColor === '#1d31a8' || drawColor === '#18349c')) {
    setDrawColor('#f8fafc', false);
  } else if (next.surface !== 'chalkboard' && drawColor === '#f8fafc') {
    setDrawColor('#1d31a8', false);
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

function setDrawColor(color: string, updateComposer = true): void {
  drawColor = color;
  swatchWrap.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
  if (updateComposer && textInput.value.trim().length > 0) {
    renderComposerLive(false);
  }
}

// --- Server bridge helpers ---
async function callServer(name: string, args: Record<string, unknown> = {}): Promise<BoardState | null> {
  if (!mcpConnected) return null;
  try {
    const res = await app.callServerTool({ name, arguments: args });
    const sc = (res as { structuredContent?: { state?: BoardState } }).structuredContent;
    if (sc?.state) return sc.state;
  } catch (err) {
    console.warn('callServerTool skipped/failed:', name, err);
  }
  return null;
}

// --- Local Text Composer (zero AI roundtrips!) ---
function buildComposerTextItem(text: string, id: string, y: number): TextItem {
  const size = Number(sizeSlider.value) || 27;
  const pen = (penSelect.value as PenKind) || 'ballpoint';
  const hurry = Number(hurrySlider.value) / 100;
  return {
    id,
    type: 'text',
    text,
    x: 56,
    y,
    maxWidth: BOARD_W - 112,
    size,
    color: drawColor,
    pen: boardState.surface === 'chalkboard' ? 'chalk' : pen,
    slant: 0.24,
    hurry,
    seed: composerSeed,
    animate: false,
    createdAt: Date.now(),
  };
}

function renderComposerLive(syncToServer = true): void {
  const text = textInput.value;
  const baseItems = composerBaseItems ?? [];

  if (!text.trim()) {
    boardState.items = baseItems.slice();
    synthCache.delete(LIVE_TEXT_ID);
    stopAnimation();
    rebuildStaticLayer(null);
    paintFrame(null);
    statusPill.textContent = statusLabel(boardState);
    return;
  }

  const liveItem = buildComposerTextItem(text, LIVE_TEXT_ID, composerStartY);
  synthCache.delete(LIVE_TEXT_ID);
  boardState.items = [...baseItems, liveItem];
  boardState.lastAddedId = LIVE_TEXT_ID;
  stopAnimation();
  rebuildStaticLayer(null);
  paintFrame(null);
  statusPill.textContent = statusLabel(boardState);

  if (syncToServer && mcpConnected) {
    if (serverSyncTimer !== null) window.clearTimeout(serverSyncTimer);
    serverSyncTimer = window.setTimeout(() => {
      void callServer('app_replace_text', {
        text,
        pen: liveItem.pen,
        color: liveItem.color,
        size: liveItem.size,
        slant: liveItem.slant,
        hurry: liveItem.hurry,
        seed: liveItem.seed,
        append: baseItems.length > 0,
      });
    }, 800);
  }
}

textInput.addEventListener('input', () => {
  if (composerBaseItems === null) {
    // First edit replaces the board view cleanly so user can type fresh notes immediately
    composerBaseItems = [];
    composerStartY = 76;
  }
  if (composerDebounceTimer !== null) window.clearTimeout(composerDebounceTimer);
  composerDebounceTimer = window.setTimeout(() => {
    renderComposerLive(true);
  }, 90);
});

sizeSlider.addEventListener('input', () => {
  sizeVal.textContent = sizeSlider.value;
  if (textInput.value.trim()) {
    renderComposerLive(true);
  } else {
    // Scale existing board text items live too!
    const sz = Number(sizeSlider.value);
    for (const item of boardState.items) {
      if (item.type === 'text') item.size = sz;
    }
    synthCache.clear();
    stopAnimation();
    rebuildStaticLayer(null);
    paintFrame(null);
  }
});

penSelect.addEventListener('change', () => {
  const pen = penSelect.value as PenKind;
  if (textInput.value.trim()) {
    renderComposerLive(true);
  } else {
    for (const item of boardState.items) {
      if (item.type === 'text') item.pen = pen;
    }
    synthCache.clear();
    stopAnimation();
    rebuildStaticLayer(null);
    paintFrame(null);
    statusPill.textContent = statusLabel(boardState);
  }
});

btnShuffle.addEventListener('click', () => {
  composerSeed = Math.floor(Math.random() * 1_000_000_000);
  if (textInput.value.trim()) {
    renderComposerLive(true);
  } else {
    for (const item of boardState.items) {
      if (item.type !== 'user_stroke') {
        item.seed = Math.floor(Math.random() * 1_000_000_000);
      }
    }
    synthCache.clear();
    stopAnimation();
    rebuildStaticLayer(null);
    paintFrame(null);
  }
});

btnPullText.addEventListener('click', () => {
  const existingTexts = boardState.items
    .filter((it): it is TextItem => it.type === 'text')
    .map((it) => it.text);
  if (existingTexts.length === 0) return;
  composerBaseItems = [];
  composerStartY = 76;
  textInput.value = existingTexts.join('\n\n');
  textInput.focus();
  renderComposerLive(false);
});

btnAppendBlock.addEventListener('click', () => {
  const text = textInput.value;
  if (!text.trim()) {
    textInput.focus();
    return;
  }
  const baseItems = composerBaseItems ?? boardState.items.filter((it) => it.id !== LIVE_TEXT_ID);
  const committedId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const committed = buildComposerTextItem(text, committedId, composerStartY);
  const synth = getSynth(committed);
  composerBaseItems = [...baseItems, committed];
  composerStartY = Math.round((synth ? synth.endY : composerStartY + 120) + committed.size * 0.45);
  composerSeed = Math.floor(Math.random() * 1_000_000_000);
  boardState.items = composerBaseItems.slice();
  synthCache.delete(LIVE_TEXT_ID);
  textInput.value = '';
  rebuildStaticLayer(null);
  paintFrame(null);
  statusPill.textContent = `✓ Блок добавлен • v6`;
  textInput.focus();
});

btnToggleComposer.addEventListener('click', () => {
  const willHide = !composerPanel.classList.contains('hidden');
  composerPanel.classList.toggle('hidden', willHide);
  btnToggleComposer.classList.toggle('active', !willHide);
  if (!willHide) textInput.focus();
});

// --- Transparent Cropped 3x PNG Export ---
async function buildTransparentPng(desiredScale = 3): Promise<{
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
} | null> {
  stopAnimation();
  const bounds = computeContentBounds();
  if (!bounds) return null;

  const pad = 22;
  const srcX = bounds.minX - pad;
  const srcY = bounds.minY - pad;
  const srcW = Math.max(24, bounds.maxX - bounds.minX + pad * 2);
  const srcH = Math.max(24, bounds.maxY - bounds.minY + pad * 2);

  // Clamp resolution safely under 4096px max canvas edge while keeping crisp 3x retina quality
  const maxDim = Math.max(srcW, srcH);
  const scale = Math.max(1, Math.min(desiredScale, 4096 / maxDim));
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const expCanvas = document.createElement('canvas');
  expCanvas.width = outW;
  expCanvas.height = outH;
  const expCtx = expCanvas.getContext('2d')!;
  expCtx.clearRect(0, 0, outW, outH);
  expCtx.setTransform(scale, 0, 0, scale, -srcX * scale, -srcY * scale);

  // Render ONLY ink strokes (zero background, zero dots!)
  for (const item of boardState.items) {
    if (item.type === 'user_stroke') {
      renderUserStroke(expCtx, item);
    } else {
      const synth = getSynth(item);
      if (synth) {
        for (const stroke of synth.strokes) {
          renderInkStroke(expCtx, stroke, Infinity);
        }
      }
    }
  }

  const dataUrl = expCanvas.toDataURL('image/png');
  const blob = await new Promise<Blob>((resolve, reject) => {
    expCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });

  return { blob, dataUrl, width: outW, height: outH };
}

function makeFilename(prefix: string, ext = 'png'): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${prefix}-${stamp}.${ext}`;
}

function collectAllBoardStrokes(): RenderedStroke[] {
  const strokes: RenderedStroke[] = [];
  for (const item of boardState.items) {
    if (item.type === 'user_stroke') {
      if (item.points.length < 2) continue;
      strokes.push({
        points: item.points.map((pt) => ({ x: pt.x, y: pt.y, p: pt.p, t: 0 })),
        color: item.color,
        pen: item.pen,
        baseWidth: item.size,
        alpha: 1.0,
      });
    } else {
      const synth = getSynth(item);
      if (synth) strokes.push(...synth.strokes);
    }
  }
  return strokes;
}

function exportVectorPdf(cleanNoBg: boolean): void {
  stopAnimation();
  const strokes = collectAllBoardStrokes();
  if (strokes.length === 0) {
    statusPill.textContent = 'На доске пока пусто';
    return;
  }

  let srcX = 0;
  let srcY = 0;
  let srcW = BOARD_W;
  let srcH = currentBoardH;
  let bg: PdfBg = boardState.surface;

  if (cleanNoBg) {
    const bounds = computeContentBounds();
    if (!bounds) return;
    const pad = 26;
    srcX = bounds.minX - pad;
    srcY = bounds.minY - pad;
    srcW = Math.max(40, bounds.maxX - bounds.minX + pad * 2);
    srcH = Math.max(40, bounds.maxY - bounds.minY + pad * 2);
    bg = 'transparent';
  } else {
    syncBoardHeightToContent();
    srcH = currentBoardH;
  }

  const pdfBytes = buildVectorPdf({
    strokes,
    srcX,
    srcY,
    srcW,
    srcH,
    bg,
    title: boardState.title || 'Handwriting Board',
  });
  const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const filename = makeFilename(cleanNoBg ? 'handwriting-vector-clean' : 'handwriting-vector', 'pdf');
  triggerDownloadUrl(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const kb = Math.max(1, Math.round(pdfBytes.length / 1024));
  statusPill.textContent = `📄 Векторный PDF сохранён (${kb} КБ)`;
}

function setExportBlobUrl(blob: Blob): string {
  if (lastExportBlobUrl) URL.revokeObjectURL(lastExportBlobUrl);
  lastExportBlob = blob;
  lastExportBlobUrl = URL.createObjectURL(blob);
  return lastExportBlobUrl;
}

function triggerDownloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showExportToast(title: string, hint: string, dataUrl: string, blobUrl: string, filename: string): void {
  exportToastTitle.textContent = title;
  exportToastHint.textContent = hint;
  exportPreviewImg.src = dataUrl;
  btnToastDownload.href = blobUrl;
  btnToastDownload.download = filename;
  exportToast.classList.remove('hidden');
}

async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch (err) {
    console.warn('Clipboard image write blocked:', err);
    return false;
  }
}

btnCopyPng.addEventListener('click', async () => {
  const result = await buildTransparentPng(3);
  if (!result) {
    statusPill.textContent = 'На доске пока пусто';
    return;
  }
  const filename = makeFilename('handwriting-transparent');
  const blobUrl = setExportBlobUrl(result.blob);
  const copied = await copyBlobToClipboard(result.blob);
  if (copied) {
    statusPill.textContent = `📋 PNG без фона скопирован (${result.width}×${result.height})`;
    const orig = btnCopyPng.textContent;
    btnCopyPng.textContent = '✓ Скопировано';
    window.setTimeout(() => {
      btnCopyPng.textContent = orig;
    }, 1800);
  } else {
    showExportToast(
      `PNG без фона (${result.width}×${result.height})`,
      'Буфер ограничен — нажми ПКМ → Копировать картинку',
      result.dataUrl,
      blobUrl,
      filename,
    );
    statusPill.textContent = 'Открой превью: ПКМ → Копировать';
  }
});

btnExportTransparent.addEventListener('click', async () => {
  const result = await buildTransparentPng(3);
  if (!result) {
    statusPill.textContent = 'На доске пока пусто';
    return;
  }
  const filename = makeFilename('handwriting-transparent');
  const blobUrl = setExportBlobUrl(result.blob);
  triggerDownloadUrl(blobUrl, filename);
  showExportToast(
    `PNG без фона (${result.width}×${result.height})`,
    'Скачан! Также можно ПКМ → Копировать / Сохранить',
    result.dataUrl,
    blobUrl,
    filename,
  );
  statusPill.textContent = `⬇ PNG без фона (${result.width}×${result.height})`;
});

btnToastCopy.addEventListener('click', async () => {
  if (!lastExportBlob) return;
  const ok = await copyBlobToClipboard(lastExportBlob);
  btnToastCopy.textContent = ok ? '✓ Скопировано' : 'ПКМ по картинке ↑';
  window.setTimeout(() => {
    btnToastCopy.textContent = '📋 Копировать';
  }, 1800);
});

btnCloseToast.addEventListener('click', () => {
  exportToast.classList.add('hidden');
});

btnExportPdf.addEventListener('click', () => {
  exportVectorPdf(false);
});

btnExportPdfClean.addEventListener('click', () => {
  exportVectorPdf(true);
});

btnExportBg.addEventListener('click', () => {
  stopAnimation();
  rebuildStaticLayer(null);
  paintFrame(null);
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = makeFilename('handwriting-board');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// --- Pointer drawing on the board ---
function clientToBoard(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * BOARD_W,
    y: ((ev.clientY - rect.top) / rect.height) * currentBoardH,
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
  if (composerBaseItems !== null) {
    composerBaseItems.push(strokeItem);
  }
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
  if (btn?.dataset.color) setDrawColor(btn.dataset.color, true);
});

btnReplay.addEventListener('click', () => {
  const lastAnim = [...boardState.items].reverse().find((it) => it.type !== 'user_stroke');
  if (lastAnim) startAnimation(lastAnim.id);
});

hurrySlider.addEventListener('input', () => {
  const pct = Number(hurrySlider.value);
  hurryVal.textContent = `${pct}%`;
  hurryOverride = pct / 100;
  synthCache.clear();
  stopAnimation();
  rebuildStaticLayer(null);
  paintFrame(null);
  statusPill.textContent = statusLabel(boardState);
});

btnSpeed.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  btnSpeed.textContent = `${SPEEDS[speedIdx]}x`;
});

btnUndo.addEventListener('click', async () => {
  if (composerBaseItems !== null) {
    if (textInput.value.trim()) {
      textInput.value = '';
      renderComposerLive(false);
      return;
    }
    if (composerBaseItems.length > 0) {
      composerBaseItems.pop();
      boardState.items = composerBaseItems.slice();
      applyBoardState({ ...boardState }, false);
      return;
    }
  }
  const next = await callServer('app_undo');
  if (next) {
    applyBoardState(next, false);
  } else if (boardState.items.length > 0) {
    boardState.items.pop();
    applyBoardState({ ...boardState }, false);
  }
});

btnClear.addEventListener('click', async () => {
  textInput.value = '';
  composerBaseItems = [];
  composerStartY = 76;
  exportToast.classList.add('hidden');
  const next = await callServer('app_clear_board');
  if (next) {
    applyBoardState(next, false);
  } else {
    boardState.items = [];
    boardState.cursorY = 76;
    applyBoardState({ ...boardState }, false);
  }
});

// --- MCP App Lifecycle (register handlers BEFORE connect!) ---
app.ontoolinput = () => {
  statusPill.textContent = '✍️ Подготовка...';
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: { state?: BoardState } }).structuredContent;
  if (sc?.state) {
    composerBaseItems = null;
    applyBoardState(sc.state, false);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  rebuildStaticLayer(null);
  paintFrame(null);

  if (window.parent === window) {
    const demoState: BoardState = {
      version: 1,
      title: 'Доска',
      surface: 'paper',
      width: BOARD_W,
      height: BASE_BOARD_H,
      cursorY: 76,
      lastAddedId: 'demo-1',
      items: [
        {
          id: 'demo-1',
          type: 'text',
          text: 'Mam na imię Anton i mam 25 lat. Jestem spokojny, miły i wysoki.\nZ zawodu jestem programistą. Bardzo lubię swoją pracę.',
          x: 56,
          y: 86,
          maxWidth: 1080,
          size: 27,
          color: '#1d31a8',
          pen: 'ballpoint',
          slant: 0.24,
          hurry: 0.45,
          seed: 42,
          animate: false,
          createdAt: 1,
        },
      ],
    };
    applyBoardState(demoState, false);
    return;
  }

  try {
    await app.connect();
    mcpConnected = true;
    const hostCtx = app.getHostContext();
    if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
    if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);

    const state = await callServer('app_get_state');
    if (state) applyBoardState(state, false);
  } catch (err) {
    console.error('MCP App connect failed:', err);
  }
}

init();
