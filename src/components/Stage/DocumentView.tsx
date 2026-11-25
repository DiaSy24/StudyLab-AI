import React, { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js';
import { AlignLeft, Download, Eye, Loader2 } from 'lucide-react';
import { renderStudyMarkdown } from '../../lib/markdown';
import { documentKindForFilename, resourceTextUrl, type DocumentKind } from '../../lib/fileKinds';
import type { StudyResource } from '../../types/study';

interface DocumentViewProps {
  resource: StudyResource;
  /** Zoom multiplier (1 = default). */
  zoom: number;
  onLoaded?: () => void;
}

const KIND_LABELS: Record<DocumentKind, string> = {
  docx: 'Word belgesi',
  pptx: 'PowerPoint sunumu',
  sheet: 'Hesap tablosu',
  audio: 'Ses dosyası',
  video: 'Video',
  notebook: 'Jupyter defteri',
  text: 'Belge',
};

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    let msg = `Dosya okunamadı (${r.status})`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return r.arrayBuffer();
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-xs text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-indigo-400" /> {label}
    </div>
  );
}

/** Server-extracted plain text: used for old/unsupported formats and as a fallback. */
function ExtractedTextView({ resource, zoom, reason }: { resource: StudyResource; zoom: number; reason?: string }) {
  const [data, setData] = useState<{ text: string; kind: string; approximate?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(resourceTextUrl(resource), { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Metin çıkarılamadı (${r.status})`);
        return body as { text: string; kind: string; approximate?: boolean };
      })
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [resource]);

  if (error) {
    return <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">{error}</div>;
  }
  if (!data) return <Spinner label="Belgenin metni çıkarılıyor..." />;

  return (
    <div className="mx-auto max-w-4xl space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="rounded-full bg-slate-800 px-2 py-0.5">{data.kind}</span>
        {data.approximate && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-200">
            Metin yaklaşık olarak kurtarıldı (biçimlendirme gösterilemiyor)
          </span>
        )}
        {reason && <span className="text-slate-500">{reason}</span>}
      </div>
      <pre
        className="whitespace-pre-wrap break-words rounded-2xl border border-slate-800 bg-slate-900/75 p-5 font-sans leading-relaxed text-slate-200"
        style={{ fontSize: 13 * zoom }}
      >
        {data.text.trim() || 'Bu dosyada okunabilir metin bulunamadı.'}
      </pre>
    </div>
  );
}

/** Tracks an element's width (for fit-to-width scaling). */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function DocxView({ url, zoom, onError, onLoaded }: { url: string; zoom: number; onError: (msg: string) => void; onLoaded?: () => void }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [pageWidth, setPageWidth] = useState(0);
  const containerWidth = useElementWidth(outerRef);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [{ renderAsync }, buf] = await Promise.all([import('docx-preview'), fetchArrayBuffer(url)]);
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = '';
        await renderAsync(buf, hostRef.current, undefined, {
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        });
        const page = hostRef.current?.querySelector<HTMLElement>('section.docx');
        if (page) setPageWidth(page.offsetWidth);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          onLoaded?.();
        }
      }
    })();
    return () => {
      cancelled = true;
      if (hostRef.current) {
        hostRef.current.innerHTML = '';
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // 100% = the page fits the panel width (like PDFs); zoom in/out from there
  const fit = pageWidth > 0 && containerWidth > 0 ? Math.min(1.5, (containerWidth - 4) / pageWidth) : 1;

  return (
    <div ref={outerRef} className="w-full">
      {loading && <Spinner label="Word belgesi hazırlanıyor..." />}
      <div ref={hostRef} className="docx-host" style={{ zoom: fit * zoom }} />
    </div>
  );
}

function PptxView({ url, zoom, onError, onLoaded }: { url: string; zoom: number; onError: (msg: string) => void; onLoaded?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let previewer: { destroy: () => void } | null = null;
    setLoading(true);
    (async () => {
      try {
        const [{ init }, buf] = await Promise.all([import('pptx-preview'), fetchArrayBuffer(url)]);
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = '';
        const width = Math.max(480, Math.min(1280, hostRef.current.clientWidth || 960));
        const p = init(hostRef.current, { width, height: Math.round((width * 9) / 16), mode: 'list' });
        previewer = p;
        await p.preview(buf);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          onLoaded?.();
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        previewer?.destroy();
      } catch {
        // ignore
      }
      if (hostRef.current) {
        hostRef.current.innerHTML = '';
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <>
      {loading && <Spinner label="Sunum hazırlanıyor..." />}
      <div ref={hostRef} className="pptx-host mx-auto" style={{ zoom }} />
    </>
  );
}

function SheetView({ url, zoom, onError, onLoaded }: { url: string; zoom: number; onError: (msg: string) => void; onLoaded?: () => void }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setActive(0);
    (async () => {
      try {
        const [XLSX, buf] = await Promise.all([import('xlsx'), fetchArrayBuffer(url)]);
        const wb = XLSX.read(buf, { type: 'array', cellDates: true, sheetStubs: true });
        const out = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          // Formulas without a saved result: show the formula instead of an empty cell
          if (ws) {
            for (const [addr, cell] of Object.entries(ws)) {
              if (addr.startsWith('!') || !cell || typeof cell !== 'object') continue;
              const c = cell as { t?: string; f?: string; v?: unknown; w?: string };
              if (c.f && (c.t === 'z' || c.v === undefined || c.v === '')) {
                c.t = 's';
                c.v = `=${c.f}`;
                c.w = `=${c.f}`;
              }
            }
          }
          return { name, html: ws ? XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }) : '' };
        });
        if (!cancelled) setSheets(out);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) onLoaded?.();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (!sheets) return <Spinner label="Tablo okunuyor..." />;
  return (
    <div className="space-y-2">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                i === active ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="sheet-host overflow-auto rounded-xl border border-slate-800 bg-slate-900/70"
        style={{ fontSize: 12 * zoom }}
        dangerouslySetInnerHTML={{ __html: sheets[active]?.html || '<p style="padding:12px">Boş sayfa</p>' }}
      />
    </div>
  );
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: { output_type: string; text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string }[];
}

function NotebookView({ url, zoom, onError, onLoaded }: { url: string; zoom: number; onError: (msg: string) => void; onLoaded?: () => void }) {
  const [cells, setCells] = useState<NotebookCell[] | null>(null);
  const [language, setLanguage] = useState('python');

  useEffect(() => {
    let cancelled = false;
    setCells(null);
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((nb: { cells?: NotebookCell[]; metadata?: { language_info?: { name?: string } } }) => {
        if (cancelled) return;
        setLanguage(nb.metadata?.language_info?.name || 'python');
        setCells(nb.cells || []);
      })
      .catch((err) => !cancelled && onError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && onLoaded?.());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const join = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('') : v || '');
  const lang = hljs.getLanguage(language) ? language : 'plaintext';

  if (!cells) return <Spinner label="Defter okunuyor..." />;
  return (
    <div className="mx-auto max-w-4xl space-y-3" style={{ fontSize: 12 * zoom }}>
      {cells.map((cell, i) =>
        cell.cell_type === 'markdown' ? (
          <div
            key={i}
            className="study-prose rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            dangerouslySetInnerHTML={{ __html: renderStudyMarkdown(join(cell.source)) }}
          />
        ) : (
          <div key={i} className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1117]">
            <pre className="overflow-x-auto p-3 font-mono">
              <code
                className={`hljs language-${lang}`}
                style={{ background: 'transparent', padding: 0 }}
                dangerouslySetInnerHTML={{ __html: hljs.highlight(join(cell.source), { language: lang, ignoreIllegals: true }).value }}
              />
            </pre>
            {(cell.outputs || []).map((o, j) => {
              const png = o.data?.['image/png'];
              if (png) {
                return <img key={j} alt="çıktı" className="max-w-full bg-white p-2" src={`data:image/png;base64,${join(png).trim()}`} />;
              }
              const text = join(o.text) || join(o.data?.['text/plain']) || (o.ename ? `${o.ename}: ${o.evalue}` : '');
              return text ? (
                <pre key={j} className="overflow-x-auto border-t border-slate-800 bg-slate-950 p-3 font-mono text-slate-300">
                  {text}
                </pre>
              ) : null;
            })}
          </div>
        ),
      )}
    </div>
  );
}

/** Viewer for rich/binary documents: Word, PowerPoint, Excel, media, notebooks, and anything else. */
export const DocumentView: React.FC<DocumentViewProps> = ({ resource, zoom, onLoaded }) => {
  const kind = useMemo(() => documentKindForFilename(resource.name), [resource.name]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    setRenderError(null);
    setShowText(false);
  }, [resource.id, resource.url]);

  const canToggleText = kind === 'docx' || kind === 'pptx' || kind === 'sheet' || kind === 'notebook';

  let body: React.ReactNode;
  if (kind === 'text' || renderError || showText) {
    body = (
      <ExtractedTextView
        resource={resource}
        zoom={zoom}
        reason={renderError ? `Görsel önizleme açılamadı (${renderError}); metin gösteriliyor.` : undefined}
      />
    );
  } else if (kind === 'docx') {
    body = <DocxView url={resource.url} zoom={zoom} onError={setRenderError} onLoaded={onLoaded} />;
  } else if (kind === 'pptx') {
    body = <PptxView url={resource.url} zoom={zoom} onError={setRenderError} onLoaded={onLoaded} />;
  } else if (kind === 'sheet') {
    body = <SheetView url={resource.url} zoom={zoom} onError={setRenderError} onLoaded={onLoaded} />;
  } else if (kind === 'notebook') {
    body = <NotebookView url={resource.url} zoom={zoom} onError={setRenderError} onLoaded={onLoaded} />;
  } else if (kind === 'audio') {
    body = (
      <div className="flex justify-center pt-10">
        <audio controls src={resource.url} className="w-full max-w-xl" />
      </div>
    );
  } else {
    body = (
      <div className="flex justify-center">
        <video controls src={resource.url} className="max-h-[78vh] max-w-full rounded-xl bg-black" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-300">{KIND_LABELS[kind]}</span>
        <div className="flex items-center gap-1.5">
          {canToggleText && !renderError && (
            <button
              type="button"
              onClick={() => setShowText((v) => !v)}
              className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
            >
              {showText ? <Eye className="h-3.5 w-3.5" /> : <AlignLeft className="h-3.5 w-3.5" />}
              {showText ? 'Belge görünümü' : 'Sadece metin'}
            </button>
          )}
          <a
            href={resource.url}
            download={resource.name}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
          >
            <Download className="h-3.5 w-3.5" /> İndir
          </a>
        </div>
      </div>
      {body}
    </div>
  );
};
