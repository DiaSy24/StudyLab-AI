import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Box,
  Code2,
  Eye,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';
import type { StudyArtifact } from '../../types/study';

export interface SandboxHandle {
  captureSnapshot: () => Promise<string | null>;
}

interface ArtifactSandboxProps {
  artifact: StudyArtifact;
  onStartAnnotate: () => void;
  onAutoFixError: (artifact: StudyArtifact, errorMessage: string) => void;
  onSaveCode: (artifactId: string, newCode: string) => Promise<void>;
}

/**
 * Wraps AI-generated 2D/3D HTML with:
 * - Local offline importmap for Three.js + OrbitControls (served from Express /vendor)
 * - Automatic WebGL preserveDrawingBuffer monkey-patch fallback so screenshots never come out black
 * - postMessage bridge for CAPTURE_SNAPSHOT and RUNTIME_ERROR reporting
 */
function buildSandboxedDocument(rawHtml: string, origin: string): string {
  const vendorBase = origin || window.location.origin;
  const importMap = `<script type="importmap">
{
  "imports": {
    "three": "${vendorBase}/vendor/three/build/three.module.js",
    "three/addons/": "${vendorBase}/vendor/three/addons/"
  }
}
</script>`;

  const bridgeScript = `<script>
(function() {
  // Force preserveDrawingBuffer: true on WebGL contexts so 3D snapshots always succeed
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return origGetContext.call(this, type, attrs);
  };

  function reportError(msg) {
    try {
      window.parent.postMessage({ type: 'STUDY_ARTIFACT_ERROR', message: String(msg) }, '*');
    } catch (_) {}
  }

  window.addEventListener('error', function(e) {
    reportError(e.message || 'Çalışma zamanı hatası');
  });
  window.addEventListener('unhandledrejection', function(e) {
    reportError(e.reason && e.reason.message ? e.reason.message : String(e.reason || 'Promise hatası'));
  });

  // AI-generated scenes often read window.innerWidth/innerHeight once at startup, before the
  // iframe layout has settled, and only fix themselves on a resize event. Re-broadcast resize
  // after load and whenever the frame's real size changes so they always fit correctly.
  var lastW = -1, lastH = -1;
  function fireResize(force) {
    var w = window.innerWidth, h = window.innerHeight;
    if (!force && w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  }
  window.addEventListener('load', function() {
    requestAnimationFrame(function() { fireResize(true); });
    [50, 250, 800, 1600].forEach(function(ms) { setTimeout(function() { fireResize(true); }, ms); });
  });
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    new ResizeObserver(function() { fireResize(false); }).observe(document.documentElement);
  }

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'STUDY_RESIZE') {
      fireResize(true);
      return;
    }
    if (!event.data || event.data.type !== 'STUDY_CAPTURE_SNAPSHOT') return;
    const reqId = event.data.requestId;
    try {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      let bestCanvas = null;
      let bestArea = 0;
      for (const c of canvases) {
        const area = c.width * c.height;
        if (area > bestArea) {
          bestArea = area;
          bestCanvas = c;
        }
      }
      if (bestCanvas) {
        const dataUrl = bestCanvas.toDataURL('image/png');
        window.parent.postMessage({ type: 'STUDY_SNAPSHOT_RESULT', requestId: reqId, dataUrl: dataUrl }, '*');
        return;
      }

      const svg = document.querySelector('svg');
      if (svg) {
        const xml = new XMLSerializer().serializeToString(svg);
        const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        const img = new Image();
        img.onload = function() {
          const c = document.createElement('canvas');
          c.width = svg.clientWidth || 960;
          c.height = svg.clientHeight || 600;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#0b1120';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          window.parent.postMessage({ type: 'STUDY_SNAPSHOT_RESULT', requestId: reqId, dataUrl: c.toDataURL('image/png') }, '*');
        };
        img.onerror = function() {
          window.parent.postMessage({ type: 'STUDY_SNAPSHOT_RESULT', requestId: reqId, dataUrl: null }, '*');
        };
        img.src = svgUrl;
        return;
      }

      window.parent.postMessage({ type: 'STUDY_SNAPSHOT_RESULT', requestId: reqId, dataUrl: null }, '*');
    } catch (err) {
      window.parent.postMessage({ type: 'STUDY_SNAPSHOT_RESULT', requestId: reqId, dataUrl: null, error: String(err) }, '*');
    }
  });
})();
</script>`;

  const baseStyle = `<style>html,body{width:100%;height:100%;margin:0;}</style>`;

  const trimmed = rawHtml.trim();
  const hasHtmlTag = /<html[\s>]/i.test(trimmed);
  let doc = hasHtmlTag
    ? trimmed
    : `<!doctype html><html lang="tr"><head><meta charset="utf-8" /><style>body{margin:0;background:#0b1120;color:#e2e8f0;font-family:system-ui,sans-serif;}</style></head><body>${trimmed}</body></html>`;

  if (/<head[\s>]/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1>\n${baseStyle}\n${importMap}\n${bridgeScript}\n`);
  } else {
    doc = `${baseStyle}\n${importMap}\n${bridgeScript}\n${doc}`;
  }

  return doc;
}

export const ArtifactSandbox = forwardRef<SandboxHandle, ArtifactSandboxProps>(
  ({ artifact, onStartAnnotate, onAutoFixError, onSaveCode }, ref) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const frameContainerRef = useRef<HTMLDivElement>(null);
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
    const [codeDraft, setCodeDraft] = useState(artifact.content);
    const [saving, setSaving] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [fullscreen, setFullscreen] = useState(false);
    const [runtimeError, setRuntimeError] = useState<string | null>(null);

    useEffect(() => {
      setCodeDraft(artifact.content);
      setRuntimeError(null);
      setViewMode('preview');
    }, [artifact.id, artifact.content]);

    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return;
        if (event.data?.type === 'STUDY_ARTIFACT_ERROR') {
          setRuntimeError(String(event.data.message || 'Görselleştirme çalıştırma hatası'));
        }
      };
      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }, []);

    const notifyResize = () => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'STUDY_RESIZE' }, '*');
    };

    // Tell the sandboxed scene to re-measure whenever its container size changes
    useEffect(() => {
      const el = frameContainerRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      let raf = 0;
      const ro = new ResizeObserver(() => {
        window.cancelAnimationFrame(raf);
        raf = window.requestAnimationFrame(notifyResize);
      });
      ro.observe(el);
      return () => {
        window.cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, [viewMode]);

    useImperativeHandle(ref, () => ({
      captureSnapshot: () =>
        new Promise<string | null>((resolve) => {
          const win = iframeRef.current?.contentWindow;
          if (!win) {
            resolve(null);
            return;
          }
          const requestId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const timer = window.setTimeout(() => {
            window.removeEventListener('message', onReply);
            resolve(null);
          }, 2000);

          const onReply = (event: MessageEvent) => {
            if (event.data?.type === 'STUDY_SNAPSHOT_RESULT' && event.data.requestId === requestId) {
              window.clearTimeout(timer);
              window.removeEventListener('message', onReply);
              resolve(event.data.dataUrl || null);
            }
          };

          window.addEventListener('message', onReply);
          win.postMessage({ type: 'STUDY_CAPTURE_SNAPSHOT', requestId }, '*');
        }),
    }));

    const srcDoc = useMemo(
      () => buildSandboxedDocument(artifact.content, window.location.origin),
      [artifact.content],
    );

    const handleSave = async () => {
      setSaving(true);
      try {
        await onSaveCode(artifact.id, codeDraft);
        setViewMode('preview');
        setRuntimeError(null);
      } finally {
        setSaving(false);
      }
    };

    return (
      <div
        className={`flex h-full flex-col bg-slate-950 ${
          fullscreen ? 'fixed inset-0 z-50' : 'relative'
        }`}
      >
        {/* Sandbox Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/90 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-500/20 text-cyan-300">
              <Box className="h-3.5 w-3.5" />
            </span>
            <h3 className="truncate text-xs font-semibold text-slate-100">{artifact.title}</h3>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
              {artifact.type === '3d-scene' ? '3D Sahne' : '2D Canlı'} • v{artifact.version}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onStartAnnotate}
              className="flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 ring-1 ring-rose-500/40 transition hover:bg-rose-500/30"
            >
              <Pencil className="h-3.5 w-3.5" />
              {artifact.type === '3d-scene' ? 'Bu Açıyı Dondur & İşaretle' : 'Üzerini İşaretle'}
            </button>

            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'preview' ? 'code' : 'preview')}
              className="flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              {viewMode === 'preview' ? (
                <>
                  <Code2 className="h-3.5 w-3.5" /> Kodu Gör
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> Önizleme
                </>
              )}
            </button>

            <button
              type="button"
              title="Yenile"
              onClick={() => {
                setRuntimeError(null);
                setReloadKey((k) => k + 1);
              }}
              className="rounded-lg border border-slate-700/80 bg-slate-800/80 p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              title={fullscreen ? 'Küçült' : 'Tam Ekran'}
              onClick={() => setFullscreen((f) => !f)}
              className="rounded-lg border border-slate-700/80 bg-slate-800/80 p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Runtime Error Banner with AI Auto-Fix */}
        {runtimeError && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
            <div className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span className="truncate">Sahne çalıştırma hatası: {runtimeError}</span>
            </div>
            <button
              type="button"
              onClick={() => onAutoFixError(artifact, runtimeError)}
              className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400"
            >
              <Sparkles className="h-3.5 w-3.5" /> AI ile Otomatik Düzelt
            </button>
          </div>
        )}

        {/* Content */}
        <div ref={frameContainerRef} className="relative flex-1 overflow-hidden">
          {viewMode === 'preview' ? (
            <iframe
              key={`${artifact.id}-${reloadKey}`}
              ref={iframeRef}
              title={artifact.title}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              onLoad={() => {
                notifyResize();
                window.setTimeout(notifyResize, 300);
              }}
              className="h-full w-full border-0 bg-slate-950"
            />
          ) : (
            <div className="flex h-full flex-col bg-slate-950">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
                <span>Etkileşimli HTML / Three.js / Canvas Kodu</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> {saving ? 'Kaydediliyor...' : 'Kaydet & Çalıştır'}
                </button>
              </div>
              <textarea
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                spellCheck={false}
                className="flex-1 resize-none bg-slate-950 p-4 font-mono text-xs leading-relaxed text-indigo-100 focus:outline-none"
              />
            </div>
          )}
        </div>
      </div>
    );
  },
);

ArtifactSandbox.displayName = 'ArtifactSandbox';
