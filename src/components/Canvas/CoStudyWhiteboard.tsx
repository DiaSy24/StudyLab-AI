import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Box,
  CheckCircle2,
  Circle,
  Eraser,
  Hand,
  Highlighter,
  Lightbulb,
  Maximize,
  Minus,
  Pen,
  Plus,
  ScanSearch,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { renderLatex } from '../../lib/markdown';
import type { BoardCard, DrawingStroke, StrokePoint, WhiteboardState } from '../../types/study';

interface CoStudyWhiteboardProps {
  whiteboard: WhiteboardState;
  /** localStorage key used to remember the pan/zoom position (per workspace). */
  viewStorageKey?: string;
  isBusy: boolean;
  onChangeWhiteboard: (next: WhiteboardState) => void;
  onCoStudyAction: (
    action: 'check-step' | 'hint' | 'visualize-board',
    boardSnapshotDataUrl: string,
  ) => Promise<void>;
}

const COLORS = ['#f8fafc', '#f43f5e', '#38bdf8', '#fbbf24', '#34d399', '#a78bfa'];

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const GRID_SIZE = 24;
const CARD_WIDTH = 288; // w-72
const CARD_HEIGHT_ESTIMATE = 150;

/** Camera: screen = world * scale + (x, y) */
interface BoardView {
  x: number;
  y: number;
  scale: number;
}

const DEFAULT_VIEW: BoardView = { x: 0, y: 0, scale: 1 };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function loadView(key: string | undefined): BoardView {
  if (!key) return DEFAULT_VIEW;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_VIEW;
    const v = JSON.parse(raw) as Partial<BoardView>;
    if (
      typeof v.x === 'number' && Number.isFinite(v.x) &&
      typeof v.y === 'number' && Number.isFinite(v.y) &&
      typeof v.scale === 'number' && Number.isFinite(v.scale)
    ) {
      return { x: v.x, y: v.y, scale: clampScale(v.scale) };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_VIEW;
}

/** World-space bounding box of all strokes and cards, or null when the board is empty. */
function getContentBounds(
  wb: WhiteboardState,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of wb.strokes) {
    const pad = stroke.width * 3;
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x - pad);
      minY = Math.min(minY, p.y - pad);
      maxX = Math.max(maxX, p.x + pad);
      maxY = Math.max(maxY, p.y + pad);
    }
  }
  for (const card of wb.cards) {
    minX = Math.min(minX, card.x);
    minY = Math.min(minY, card.y);
    maxX = Math.max(maxX, card.x + CARD_WIDTH);
    maxY = Math.max(maxY, card.y + CARD_HEIGHT_ESTIMATE);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function renderStroke(ctx: CanvasRenderingContext2D, stroke: DrawingStroke) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = stroke.width * 4;
  } else if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * 4.5;
  } else {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
  }

  if (stroke.tool === 'circle' && stroke.points.length >= 2) {
    const a = stroke.points[0];
    const b = stroke.points[stroke.points.length - 1];
    ctx.beginPath();
    ctx.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.max(4, Math.abs(b.x - a.x) / 2),
      Math.max(4, Math.abs(b.y - a.y) / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (stroke.tool === 'arrow' && stroke.points.length >= 2) {
    const a = stroke.points[0];
    const b = stroke.points[stroke.points.length - 1];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 16 * Math.cos(angle - Math.PI / 6), b.y - 16 * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 16 * Math.cos(angle + Math.PI / 6), b.y - 16 * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export const CoStudyWhiteboard: React.FC<CoStudyWhiteboardProps> = ({
  whiteboard,
  viewStorageKey,
  isBusy,
  onChangeWhiteboard,
  onCoStudyAction,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [tool, setTool] = useState<DrawingStroke['tool']>('pen');
  const [handMode, setHandMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [color, setColor] = useState(COLORS[2]);
  const [width, setWidth] = useState(3);
  const activeStrokeRef = useRef<DrawingStroke | null>(null);
  const [activeStroke, setActiveStroke] = useState<DrawingStroke | null>(null);
  const [draggingCard, setDraggingCard] = useState<{ id: string; dx: number; dy: number } | null>(null);

  const [view, setView] = useState<BoardView>(() => loadView(viewStorageKey));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Active pointers on the drawing surface (for two-finger pinch / pan)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<
    | { kind: 'pan'; startX: number; startY: number; view: BoardView }
    | { kind: 'pinch'; startDist: number; startMid: { x: number; y: number }; view: BoardView }
    | null
  >(null);
  const [isPanning, setIsPanning] = useState(false);

  // Reload the saved camera when switching workspaces
  useEffect(() => {
    setView(loadView(viewStorageKey));
  }, [viewStorageKey]);

  // Persist the camera (debounced)
  useEffect(() => {
    if (!viewStorageKey) return;
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(viewStorageKey, JSON.stringify(view));
      } catch {
        // ignore storage errors
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [view, viewStorageKey]);

  // Track the board size (panel resizes, not just window resizes)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Redraw strokes with the current camera
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(size.w * dpr);
    const ph = Math.round(size.h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    for (const st of whiteboard.strokes) renderStroke(ctx, st);
    if (activeStroke) renderStroke(ctx, activeStroke);
  }, [whiteboard.strokes, activeStroke, view, size]);

  /** Zoom by `factor`, keeping the screen point (sx, sy) fixed. */
  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k };
    });
  }, []);

  const zoomFromCenter = (factor: number) => {
    zoomAt(size.w / 2, size.h / 2, factor);
  };

  const fitToContent = () => {
    const bounds = getContentBounds(whiteboard);
    if (!bounds || size.w === 0) {
      setView(DEFAULT_VIEW);
      return;
    }
    const pad = 48;
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const scale = clampScale(Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh, 1.5));
    setView({
      scale,
      x: (size.w - bw * scale) / 2 - bounds.minX * scale,
      y: (size.h - bh * scale) / 2 - bounds.minY * scale,
    });
  };

  // Mouse wheel: zoom toward the cursor. Shift+wheel / horizontal trackpad scroll pans.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.shiftKey || (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey)) {
        const amount = e.shiftKey && dx === 0 ? dy : dx;
        setView((v) => ({ ...v, x: v.x - amount }));
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const clamped = Math.max(-120, Math.min(120, dy));
      const factor = Math.pow(e.ctrlKey ? 1.01 : 1.0018, -clamped);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Hold Space to pan temporarily
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const toLocal = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const toWorld = (local: { x: number; y: number }) => {
    const v = viewRef.current;
    return { x: (local.x - v.x) / v.scale, y: (local.y - v.y) / v.scale };
  };

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const w = toWorld(toLocal(e));
    return { x: w.x, y: w.y, pressure: e.pressure || 0.5 };
  };

  const cancelActiveStroke = () => {
    activeStrokeRef.current = null;
    setActiveStroke(null);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic pointer capture failure
    }
    const local = toLocal(e);
    pointersRef.current.set(e.pointerId, local);

    // Second finger down → pinch zoom / two-finger pan (discard the half-drawn stroke)
    if (pointersRef.current.size === 2) {
      cancelActiveStroke();
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = {
        kind: 'pinch',
        startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: viewRef.current,
      };
      setIsPanning(true);
      return;
    }
    if (pointersRef.current.size > 2) return;

    if (handMode || spaceHeld || e.button === 1 || e.button === 2) {
      e.preventDefault();
      gestureRef.current = { kind: 'pan', startX: local.x, startY: local.y, view: viewRef.current };
      setIsPanning(true);
      return;
    }

    const nextStroke: DrawingStroke = {
      id: `wb-${Date.now()}`,
      tool,
      color,
      width,
      points: [getPoint(e)],
    };
    activeStrokeRef.current = nextStroke;
    setActiveStroke(nextStroke);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const local = toLocal(e);
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, local);
    }

    const gesture = gestureRef.current;
    if (gesture?.kind === 'pinch') {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const start = gesture.view;
      const scale = clampScale(start.scale * (dist / gesture.startDist));
      const worldMidX = (gesture.startMid.x - start.x) / start.scale;
      const worldMidY = (gesture.startMid.y - start.y) / start.scale;
      setView({ scale, x: mid.x - worldMidX * scale, y: mid.y - worldMidY * scale });
      return;
    }
    if (gesture?.kind === 'pan') {
      setView({
        ...gesture.view,
        x: gesture.view.x + (local.x - gesture.startX),
        y: gesture.view.y + (local.y - gesture.startY),
      });
      return;
    }

    const current = activeStrokeRef.current;
    if (!current) return;
    const pt = getPoint(e);
    const updated: DrawingStroke =
      current.tool === 'circle' || current.tool === 'arrow'
        ? { ...current, points: [current.points[0], pt] }
        : { ...current, points: [...current.points, pt] };
    activeStrokeRef.current = updated;
    setActiveStroke(updated);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (gestureRef.current) {
      if (pointersRef.current.size === 0) {
        gestureRef.current = null;
        setIsPanning(false);
      }
      return;
    }
    const finished = activeStrokeRef.current;
    if (!finished) return;
    activeStrokeRef.current = null;
    onChangeWhiteboard({
      ...whiteboard,
      strokes: [...whiteboard.strokes, finished],
      updatedAt: new Date().toISOString(),
    });
    setActiveStroke(null);
  };

  const addUserNoteCard = () => {
    const text = window.prompt('Tahtaya eklemek istediğin adım veya soru:');
    if (!text || !text.trim()) return;
    const card: BoardCard = {
      id: `card-${Date.now()}`,
      author: 'user',
      kind: 'note',
      title: 'Benim Notum',
      content: text.trim(),
      x: (size.w / 2 - view.x) / view.scale - CARD_WIDTH / 2 + (whiteboard.cards.length % 4) * 16,
      y: (size.h / 2 - view.y) / view.scale - 60 + (whiteboard.cards.length % 4) * 16,
      color: '#38bdf8',
      createdAt: new Date().toISOString(),
    };
    onChangeWhiteboard({
      ...whiteboard,
      cards: [...whiteboard.cards, card],
      updatedAt: new Date().toISOString(),
    });
  };

  const removeCard = (id: string) => {
    onChangeWhiteboard({
      ...whiteboard,
      cards: whiteboard.cards.filter((c) => c.id !== id),
      updatedAt: new Date().toISOString(),
    });
  };

  const captureBoardSnapshot = (): string => {
    // Capture the whole board content (not just the visible viewport) in world coordinates.
    const bounds = getContentBounds(whiteboard) || { minX: 0, minY: 0, maxX: 1000, maxY: 640 };
    const pad = 32;
    const worldW = bounds.maxX - bounds.minX + pad * 2;
    const worldH = bounds.maxY - bounds.minY + pad * 2;
    const k = Math.min(1, 1800 / worldW, 1400 / worldH);
    const w = Math.max(320, Math.round(worldW * k));
    const h = Math.max(240, Math.round(worldH * k));
    const ox = -bounds.minX + pad;
    const oy = -bounds.minY + pad;

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d')!;

    // Dark background + dot grid
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(148,163,184,0.2)';
    for (let x = 24; x < w; x += 24) {
      for (let y = 24; y < h; y += 24) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }

    ctx.save();
    ctx.setTransform(k, 0, 0, k, ox * k, oy * k);

    // Draw cards onto snapshot so Gemini sees both cards & user handwriting!
    for (const card of whiteboard.cards) {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = card.color || '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(card.x, card.y, 280, 120, 12);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = card.color || '#a5b4fc';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText(`[${card.author === 'ai' ? 'AI' : 'Öğrenci'}] ${card.title}`, card.x + 12, card.y + 24);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px system-ui, sans-serif';
      const words = card.content.split(' ');
      let line = '';
      let lineY = card.y + 48;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > 256) {
          ctx.fillText(line, card.x + 12, lineY);
          line = word;
          lineY += 16;
          if (lineY > card.y + 108) break;
        } else {
          line = test;
        }
      }
      if (line && lineY <= card.y + 108) {
        ctx.fillText(line, card.x + 12, lineY);
      }
      ctx.restore();
    }
    ctx.restore();

    // Strokes on their own layer so the eraser only removes ink, not cards/background
    const inkLayer = document.createElement('canvas');
    inkLayer.width = w;
    inkLayer.height = h;
    const inkCtx = inkLayer.getContext('2d')!;
    inkCtx.setTransform(k, 0, 0, k, ox * k, oy * k);
    for (const st of whiteboard.strokes) renderStroke(inkCtx, st);
    ctx.drawImage(inkLayer, 0, 0);

    return out.toDataURL('image/png');
  };

  const selectDrawTool = (id: DrawingStroke['tool']) => {
    setTool(id);
    setHandMode(false);
  };

  const panActive = handMode || spaceHeld;

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Co-Study Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/95 px-4 py-2">
        {/* Drawing Tools */}
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            title="El aracı: tahtada gezin (veya Boşluk tuşunu basılı tut / orta tuş / iki parmak)"
            onClick={() => setHandMode((h) => !h)}
            className={`rounded-lg p-1.5 transition ${
              handMode
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <Hand className="h-3.5 w-3.5" />
          </button>
          {(
            [
              { id: 'pen', label: 'Kalem', Icon: Pen },
              { id: 'highlighter', label: 'Fosforlu', Icon: Highlighter },
              { id: 'circle', label: 'Daire', Icon: Circle },
              { id: 'arrow', label: 'Ok', Icon: ArrowUpRight },
              { id: 'eraser', label: 'Silgi', Icon: Eraser },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={label}
              onClick={() => selectDrawTool(id)}
              className={`rounded-lg p-1.5 transition ${
                tool === id && !handMode
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}

          <div className="mx-1 h-4 w-px bg-slate-700" />

          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-4 w-4 rounded-full transition ${
                color === c ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''
              }`}
              style={{ backgroundColor: c }}
            />
          ))}

          <input
            type="range"
            min={2}
            max={10}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="ml-1 w-14 accent-indigo-500"
          />

          <div className="mx-1 h-4 w-px bg-slate-700" />

          <button
            type="button"
            onClick={addUserNoteCard}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
          >
            <Plus className="h-3 w-3" /> Not Kartı
          </button>

          <button
            type="button"
            title="Son çizimi geri al"
            onClick={() =>
              onChangeWhiteboard({
                ...whiteboard,
                strokes: whiteboard.strokes.slice(0, -1),
                updatedAt: new Date().toISOString(),
              })
            }
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            title="Çizimleri temizle"
            onClick={() =>
              onChangeWhiteboard({
                ...whiteboard,
                strokes: [],
                updatedAt: new Date().toISOString(),
              })
            }
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* AI Co-Study Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onCoStudyAction('check-step', captureBoardSnapshot())}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/30 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Adımımı Kontrol Et
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onCoStudyAction('hint', captureBoardSnapshot())}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500/20 px-2.5 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30 disabled:opacity-50"
          >
            <Lightbulb className="h-3.5 w-3.5" /> İpucu Ver
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onCoStudyAction('visualize-board', captureBoardSnapshot())}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-500/40 transition hover:bg-cyan-500/30 disabled:opacity-50"
          >
            <Box className="h-3.5 w-3.5" /> Görselleştir
          </button>
        </div>
      </div>

      {/* Board Surface */}
      <div
        ref={wrapRef}
        onContextMenu={(e) => e.preventDefault()}
        onPointerMove={(e) => {
          if (!draggingCard || !wrapRef.current) return;
          const rect = wrapRef.current.getBoundingClientRect();
          const v = viewRef.current;
          const nx = (e.clientX - rect.left - v.x) / v.scale - draggingCard.dx;
          const ny = (e.clientY - rect.top - v.y) / v.scale - draggingCard.dy;
          onChangeWhiteboard({
            ...whiteboard,
            cards: whiteboard.cards.map((c) =>
              c.id === draggingCard.id ? { ...c, x: nx, y: ny } : c,
            ),
            updatedAt: new Date().toISOString(),
          });
        }}
        onPointerUp={() => setDraggingCard(null)}
        onPointerLeave={() => setDraggingCard(null)}
        style={{
          backgroundSize: `${GRID_SIZE * view.scale}px ${GRID_SIZE * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        className="dot-grid relative flex-1 overflow-hidden"
      >
        {/* Freehand Drawing Layer */}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`absolute inset-0 h-full w-full touch-none ${
            isPanning ? 'cursor-grabbing' : panActive ? 'cursor-grab' : 'cursor-crosshair'
          }`}
        />

        {/* Shared Draggable AI & User Cards (world-space layer that follows the camera) */}
        <div
          className="pointer-events-none absolute top-0 left-0 z-10 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
        {whiteboard.cards.map((card) => (
          <div
            key={card.id}
            style={{
              left: card.x,
              top: card.y,
              borderColor: `${card.color}70`,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const scale = viewRef.current.scale;
              setDraggingCard({
                id: card.id,
                dx: (e.clientX - rect.left) / scale,
                dy: (e.clientY - rect.top) / scale,
              });
            }}
            className="pointer-events-auto absolute w-72 cursor-grab rounded-2xl border bg-slate-900/92 p-3.5 shadow-2xl backdrop-blur active:cursor-grabbing"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <StickyNote className="h-3.5 w-3.5" style={{ color: card.color }} />
                <span
                  className="text-[11px] font-bold"
                  style={{ color: card.color }}
                >
                  {card.author === 'ai' ? 'AI' : 'Sen'} • {card.title}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeCard(card.id);
                }}
                className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-slate-200">{card.content}</p>
            {card.latex && (
              <div
                className="mt-2 overflow-x-auto rounded-lg bg-slate-950/80 px-2.5 py-1.5 text-center text-xs text-white"
                dangerouslySetInnerHTML={{ __html: renderLatex(card.latex, true) }}
              />
            )}
          </div>
        ))}

        </div>

        {/* Zoom / Navigation Controls */}
        <div className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-xl border border-slate-700/80 bg-slate-900/90 p-1 shadow-xl backdrop-blur">
          <button
            type="button"
            title="Uzaklaştır"
            disabled={view.scale <= MIN_SCALE + 1e-3}
            onClick={() => zoomFromCenter(1 / 1.2)}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="%100 yakınlık"
            onClick={() => zoomFromCenter(1 / view.scale)}
            className="min-w-[3.25rem] rounded-lg px-1.5 py-1 font-mono text-[11px] text-slate-200 hover:bg-slate-800"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            type="button"
            title="Yakınlaştır"
            disabled={view.scale >= MAX_SCALE - 1e-3}
            onClick={() => zoomFromCenter(1.2)}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-slate-700" />
          <button
            type="button"
            title="Tüm içeriği ekrana sığdır"
            onClick={fitToContent}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <ScanSearch className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Başlangıç konumuna dön"
            onClick={() => setView(DEFAULT_VIEW)}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Subtle Bottom Guidance (hidden when the board is too narrow to fit it beside the controls) */}
        {size.w >= 760 && (
        <div className="pointer-events-none absolute right-4 bottom-3 z-20 rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1 text-[11px] text-slate-400">
          Tekerlek: yakınlaştır • Boşluk/orta tuş/el aracı + sürükle: gezin • Kartları sürükle
        </div>
        )}
      </div>
    </div>
  );
};
