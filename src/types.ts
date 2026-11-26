export type BoardSurface = 'whiteboard' | 'chalkboard' | 'notebook' | 'lined' | 'paper';

export type PenKind = 'ballpoint' | 'marker' | 'fountain' | 'chalk' | 'pencil';

export type DoodleKind =
  | 'underline'
  | 'circle'
  | 'arrow'
  | 'box'
  | 'star'
  | 'heart'
  | 'scribble'
  | 'crossout'
  | 'line';

export interface TextItem {
  id: string;
  type: 'text';
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  size: number;
  color: string;
  pen: PenKind;
  slant: number;
  /** Writing hurry/speed from 0.0 (neat v4) to 1.0 (fast rushed notes), default 0.5 */
  hurry?: number;
  seed: number;
  animate: boolean;
  createdAt: number;
}

export interface DoodleItem {
  id: string;
  type: 'doodle';
  kind: DoodleKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  x2?: number;
  y2?: number;
  color: string;
  pen: PenKind;
  seed: number;
  animate: boolean;
  createdAt: number;
}

export interface UserStrokeItem {
  id: string;
  type: 'user_stroke';
  points: Array<{ x: number; y: number; p: number }>;
  color: string;
  pen: PenKind;
  size: number;
  createdAt: number;
}

export type BoardItem = TextItem | DoodleItem | UserStrokeItem;

export interface BoardState {
  version: number;
  title: string;
  surface: BoardSurface;
  width: number;
  height: number;
  cursorY: number;
  items: BoardItem[];
  lastAddedId?: string;
}
