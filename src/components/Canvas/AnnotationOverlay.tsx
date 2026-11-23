import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Highlighter,
  Pen,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import type { AnnotationLabel, DrawingStroke, StrokePoint } from '../../types/study';

type ToolType = 'pen' | 'highlighter' | 'circle' | 'arrow' | 'text' | 'eraser';

interface AnnotationOverlayProps {
  baseImageDataUrl: string | null;
  sourceLabel: string;
  quickChatBusy?: boolean;
  onCancel: () => void;
  onSubmitAnnotation: (compositeDataUrl: string, questionPrompt: string) => Promise<void>;
}

const PEN_COLORS = [
  { id: 'red', hex: '#f43f5e', label: 'Kırmızı' },
  { id: 'amber', hex: '#fbbf24', label: 'Sarı' },
  { id: 'cyan', hex: '#38bdf8', label: 'Mavi' },
  { id: 'green', hex: '#34d399', label: 'Yeşil' },
];

const QUICK_PROMPTS = [
  {
    label: 'Daha basit anlat',
    prompt: 'İşaretlediğim kısmı tam anlayamadım. Bunu çok daha sade ve sezgisel bir dille anlatır mısın?',
  },
  {
    label: 'Farklı yolla / benzetmeyle göster',
    prompt: 'İşaretlediğim bu noktayı bambaşka bir bakış açısı veya gerçek hayat benzetmesiyle açıklar mısın?',
  },
  {
    label: 'Yeni 2D/3D çizimle açıkla',
    prompt: 'İşaretlediğim bölgeyi daha net kavramam için yeni bir etkileşimli 2D veya 3D görselleştirme oluşturur musun?',
  },
  {
    label: 'Adım adım birlikte çözelim',
    prompt: 'İşaretlediğim yeri birlikte adım adım çözelim; önce bana küçük bir yol gösterici soru sor.',
  },
];

function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawingStroke) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = stroke.width * 3.5;
  } else if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * 4.5;
  } else {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
  }

  if (stroke.tool === 'circle' && stroke.points.length >= 2) {
    const start = stroke.points[0];
    const end = stroke.points[stroke.points.length - 1];
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(4, rx), Math.max(4, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (stroke.tool === 'arrow' && stroke.points.length >= 2) {
    const start = stroke.points[0];
    const end = stroke.points[stroke.points.length - 1];
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLen = 18;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLen * Math.cos(angle - Math.PI / 6),
      end.y - headLen * Math.sin(angle - Math.PI / 6),
    );
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLen * Math.cos(angle + Math.PI / 6),
      end.y - headLen * Math.sin(angle + Math.PI / 6),
    );
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

function drawLabel(ctx: CanvasRenderingContext2D, label: AnnotationLabel) {
  ctx.save();
  ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(label.text);
  const padX = 10;
  const padY = 6;
  const w = metrics.width + padX * 2;
  const h = 26;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = label.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(label.x, label.y - h / 2, w, h, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(label.text, label.x + padX, label.y + 5);
  ctx.restore();
}

export const AnnotationOverlay: React.FC<AnnotationOverlayProps> = ({
  baseImageDataUrl,
  sourceLabel,
  quickChatBusy = false,
  onCancel,
  onSubmitAnnotation,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [tool, setTool] = useState<ToolType>('pen');
  const [color, setColor] = useState(PEN_COLORS[0].hex);
  const [width, setWidth] = useState(4);
  const [strokes, setStrokes] = useState<DrawingStroke[]>([]);
  const [labels, setLabels] = useState<AnnotationLabel[]>([]);
  const activeStrokeRef = useRef<DrawingStroke | null>(null);
  const [activeStroke, setActiveStroke] = useState<DrawingStroke | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Sync canvas dimensions to container
  useEffect(() => {
    const syncSize = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    };
    syncSize();
    window.addEventListener('resize', syncSize);
    return () => window.removeEventListener('resize', syncSize);
  }, []);

  // Re-render strokes & labels whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (activeStroke) drawStroke(ctx, activeStroke);
    for (const lbl of labels) drawLabel(ctx, lbl);
  }, [strokes, activeStroke, labels]);

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getPoint(e);
    if (tool === 'text') {
      const note = window.prompt('İşaretli yere eklenecek kısa not (örn: "Neden sinüs?")');
      if (note && note.trim()) {
        setLabels((prev) => [
          ...prev,
          { id: `lbl-${Date.now()}`, x: pt.x, y: pt.y, text: note.trim(), color },
        ]);
      }
      return;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or unsupported pointer capture
    }
    const nextStroke: DrawingStroke = {
      id: `st-${Date.now()}`,
      tool: tool === 'eraser' ? 'eraser' : tool,
      color,
      width,
      points: [pt],
    };
    activeStrokeRef.current = nextStroke;
    setActiveStroke(nextStroke);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  const handlePointerUp = () => {
    const finished = activeStrokeRef.current;
    if (!finished) return;
    activeStrokeRef.current = null;
    setStrokes((prev) => [...prev, finished]);
    setActiveStroke(null);
  };

  const buildCompositeImage = async (): Promise<string> => {
    const drawCanvas = canvasRef.current;
    const w = drawCanvas?.width || 960;
    const h = drawCanvas?.height || 600;

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, w, h);

    if (baseImageDataUrl) {
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          // Fit image cleanly preserving aspect ratio
          const scale = Math.min(w / img.width, h / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          const dx = (w - dw) / 2;
          const dy = (h - dh) / 2;
          ctx.drawImage(img, dx, dy, dw, dh);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = baseImageDataUrl;
      });
    }

    if (drawCanvas) {
      ctx.drawImage(drawCanvas, 0, 0);
    }
    return out.toDataURL('image/png');
  };

  const handleSend = async (promptText: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const composite = await buildCompositeImage();
      await onSubmitAnnotation(
        composite,
        promptText.trim() || 'İşaretlediğim bölgeyi detaylı ve anlaşılır şekilde anlatır mısın?',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-30 flex flex-col bg-slate-950/35 backdrop-blur-[1px]"
    >
      {/* Background frozen snapshot if captured (e.g. frozen 3D model angle!) */}
      {baseImageDataUrl && (
        <img
          src={baseImageDataUrl}
          alt="Dondurulmuş sahne"
          className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
        />
      )}

      {/* Transparent High-Precision Drawing Layer */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
      />

      {/* Top Floating Drawing Toolbar */}
      <div className="pointer-events-auto relative z-10 mx-auto mt-3 flex flex-wrap items-center gap-1.5 rounded-2xl border border-rose-500/40 bg-slate-900/95 px-3 py-2 shadow-2xl backdrop-blur">
        <span className="mr-1 rounded-lg bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-200">
          İşaretleme Modu • {sourceLabel}
        </span>

        {(
          [
            { id: 'pen', label: 'Kalem', Icon: Pen },
            { id: 'highlighter', label: 'Fosforlu', Icon: Highlighter },
            { id: 'circle', label: 'Daire', Icon: Circle },
            { id: 'arrow', label: 'Ok', Icon: ArrowUpRight },
            { id: 'text', label: 'Metin Notu', Icon: Type },
            { id: 'eraser', label: 'Silgi', Icon: Eraser },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => setTool(id)}
            className={`rounded-lg p-1.5 transition ${
              tool === id
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {PEN_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.label}
            onClick={() => setColor(c.hex)}
            className={`h-5 w-5 rounded-full transition ${
              color === c.hex ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''
            }`}
            style={{ backgroundColor: c.hex }}
          />
        ))}

        <input
          type="range"
          min={2}
          max={10}
          value={width}
          title="Kalem kalınlığı"
          onChange={(e) => setWidth(Number(e.target.value))}
          className="ml-1 w-16 accent-rose-500"
        />

        <div className="mx-1 h-5 w-px bg-slate-700" />

        <button
          type="button"
          title="Geri Al"
          onClick={() => setStrokes((prev) => prev.slice(0, -1))}
          className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Çizimleri Temizle"
          onClick={() => {
            setStrokes([]);
            setLabels([]);
          }}
          className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-rose-300"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="İptal Et"
          onClick={onCancel}
          className="ml-1 rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Bottom Floating Quick Ask Bar */}
      <div className="pointer-events-auto relative z-10 mx-auto mt-auto mb-4 w-[min(94%,740px)] rounded-2xl border border-amber-500/40 bg-slate-900/95 p-3 shadow-2xl backdrop-blur">
        {quickChatBusy && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
            <Zap className="h-3 w-3 shrink-0" />
            <span>
              Hızlı Chat şu an başka bir soruyu yanıtlıyor; gönderirsen bu soru yeni bir Hızlı Chat
              oturumunda paralel olarak açılır.
            </span>
          </div>
        )}
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q.label}
              type="button"
              disabled={submitting}
              onClick={() => void handleSend(q.prompt)}
              className="flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-3 py-1 text-[11px] font-medium text-indigo-100 transition hover:bg-indigo-500/30 disabled:opacity-50"
            >
              <Sparkles className="h-3 w-3 text-indigo-300" />
              {q.label}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend(customPrompt);
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="İşaretlediğin yerle ilgili özel sorunu yaz (Hızlı Chat'e gönderilir)..."
            className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-lg transition hover:brightness-110 disabled:opacity-50"
          >
            <Zap className="h-3.5 w-3.5" />
            {submitting ? 'Gönderiliyor...' : "Hızlı Chat'e Sor"}
          </button>
        </form>
      </div>
    </div>
  );
};
