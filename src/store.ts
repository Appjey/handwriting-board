import fs from 'node:fs';
import path from 'node:path';
import { BoardItem, BoardState, BoardSurface } from './types.js';

const DEFAULT_STATE: BoardState = {
  version: 1,
  title: 'Доска',
  surface: 'whiteboard',
  width: 1200,
  height: 800,
  cursorY: 92,
  items: [],
};

export class BoardStore {
  private filePath: string;
  private state: BoardState;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'board-state.json');
    this.state = this.load();
  }

  private load(): BoardState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<BoardState>;
        if (parsed && Array.isArray(parsed.items)) {
          return {
            ...DEFAULT_STATE,
            ...parsed,
            items: parsed.items,
          };
        }
      }
    } catch {
      // Corrupted file: start fresh
    }
    return structuredClone(DEFAULT_STATE);
  }

  private save(): void {
    this.state.version += 1;
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getState(): BoardState {
    return this.state;
  }

  setSurface(surface: BoardSurface, title?: string): BoardState {
    this.state.surface = surface;
    if (title) this.state.title = title;
    this.state.lastAddedId = undefined;
    this.save();
    return this.state;
  }

  addItem(item: BoardItem, nextCursorY?: number): BoardState {
    this.state.items.push(item);
    this.state.lastAddedId = item.id;
    if (typeof nextCursorY === 'number') {
      this.state.cursorY = Math.min(this.state.height - 70, Math.max(70, nextCursorY));
    }
    this.save();
    return this.state;
  }

  undo(): BoardState {
    this.state.items.pop();
    this.state.lastAddedId = undefined;
    this.save();
    return this.state;
  }

  clear(surface?: BoardSurface, title?: string): BoardState {
    this.state.items = [];
    this.state.cursorY = 92;
    this.state.lastAddedId = undefined;
    if (surface) this.state.surface = surface;
    if (title) this.state.title = title;
    this.save();
    return this.state;
  }
}
