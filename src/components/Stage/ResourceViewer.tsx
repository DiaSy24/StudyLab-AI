import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Pencil,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { renderStudyMarkdown } from '../../lib/markdown';
import {
  buildPdfScaleKey,
  computePdfRenderMetrics,
  getPrefetchTargets,
  PdfPageCache,
  type PdfCachedPage,
} from '../../lib/pdfPageCache';
import { shouldIgnoreNavKeyEvent, type SiblingNavigation } from '../../lib/resourceNavigation';
import { CodeView } from './CodeView';
import { DocumentView } from './DocumentView';
import type { StudyResource } from '../../types/study';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ResourceViewerHandle {
  captureBaseImage: () => Promise<string | null>;
  /** Navigates to a 1-based page (PDF) or page/slide (Word/PowerPoint). Out-of-range values are clamped. */
  goToPage: (page: number) => void;
}

export interface RequestedViewerJump {
  resourceId: string;
  page: number;
  seq: number;
}

/** Page-like elements rendered by docx-preview (Word pages) and pptx-preview (slides). */
const PAGED_DOC_SELECTOR = 'section.docx, .pptx-preview-slide-wrapper';

interface ResourceViewerProps {
  resource: StudyResource;
  siblingNav?: SiblingNavigation;
  /** Whether the viewer tab is actively visible (guards keyboard arrow shortcuts). */
  isActive?: boolean;
  /** Declarative page jump request (handles async resource switches and hidden-to-visible tab transitions). */
  requestedJump?: RequestedViewerJump | null;
  onStartAnnotate: () => void;
  /** Reports the visible page and page count. `pageCount` is 0 when the resource has no pages. */
  onPageChange?: (page: number, pageCount: number) => void;
}

interface StoredViewerState {
  pageNum: number;
  /** Multiplier relative to fit-to-width (1 = page fits the panel width). */
  fitZoom: number;
  scrollTop: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const DEFAULT_ZOOM = 1;
const ZOOM_STEP = 0.2;
const VIEWER_PADDING_PX = 40; // p-5 on both sides
const PDF_RANGE_CHUNK_SIZE = 512 * 1024; // 512 KB range chunks over localhost
const PDF_CANVAS_MAX_AREA_BYTES = 64 * 1024 * 1024; // 64 MB worker image resize cap
const PDF_PREFETCH_DELAY_MS = 80;
const PDF_PAGE_KEEP_RADIUS = 2;
const PDF_WHEEL_RENDER_DEBOUNCE_MS = 120;
const PDF_RENDER_BADGE_DELAY_MS = 120;
const SCROLL_SAVE_DEBOUNCE_MS = 250;

function safeCancelRender(task: pdfjsLib.RenderTask | null): void {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    // ignore already settled render task
  }
}

function getStorageKey(resourceId: string): string {
  return `studylab.resourceState.${resourceId}`;
}

function loadViewerState(resourceId: string): StoredViewerState {
  try {
    const raw = window.localStorage.getItem(getStorageKey(resourceId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredViewerState>;
      return {
        pageNum:
          typeof parsed.pageNum === 'number' && parsed.pageNum >= 1
            ? Math.floor(parsed.pageNum)
            : 1,
        fitZoom:
          typeof parsed.fitZoom === 'number' && parsed.fitZoom >= MIN_ZOOM && parsed.fitZoom <= MAX_ZOOM
            ? parsed.fitZoom
            : DEFAULT_ZOOM,
        scrollTop: typeof parsed.scrollTop === 'number' && parsed.scrollTop >= 0 ? parsed.scrollTop : 0,
      };
    }
  } catch {
    // ignore storage errors
  }
  return { pageNum: 1, fitZoom: DEFAULT_ZOOM, scrollTop: 0 };
}

function saveViewerState(resourceId: string, state: StoredViewerState): void {
  try {
    window.localStorage.setItem(getStorageKey(resourceId), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

export const ResourceViewer = forwardRef<ResourceViewerHandle, ResourceViewerProps>(
  ({ resource, siblingNav, isActive = true, requestedJump = null, onStartAnnotate, onPageChange }, ref) => {
    const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const loadedResourceIdRef = useRef<string | null>(null);
    const requestedJumpRef = useRef(requestedJump);
    requestedJumpRef.current = requestedJump;
    const lastHandledJumpSeqRef = useRef<number>(-1);
    const pendingDocPageRef = useRef<number | null>(null);
    const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
    const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
    const pdfPageCacheRef = useRef<PdfPageCache>(new PdfPageCache());
    const pdfPagesRef = useRef<Map<number, pdfjsLib.PDFPageProxy>>(new Map());
    const activeRenderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
    const prefetchRenderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
    const prefetchTimerRef = useRef<number | null>(null);
    const prefetchRunIdRef = useRef(0);
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;
    const renderZoomTimerRef = useRef<number | null>(null);
    const zoomAnchorRafRef = useRef<number | null>(null);
    const saveStateTimerRef = useRef<number | null>(null);
    const pendingSaveRef = useRef<{ resourceId: string; state: StoredViewerState } | null>(null);
    const lastPaintedSizeRef = useRef<{ cssWidth: number; cssHeight: number; zoom: number } | null>(null);

    const initialState = loadViewerState(resource.id);
    const lastPageNumRef = useRef(initialState.pageNum);
    const navDirectionRef = useRef<1 | -1>(1);
    const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [pageNum, setPageNum] = useState(initialState.pageNum);
    const [pageInput, setPageInput] = useState(String(initialState.pageNum));
    const [fileIndexInput, setFileIndexInput] = useState(String((siblingNav?.index ?? 0) + 1));
    const [numPages, setNumPages] = useState(0);
    const [zoom, setZoom] = useState(initialState.fitZoom);
    const [renderZoom, setRenderZoom] = useState(initialState.fitZoom);
    const [containerWidth, setContainerWidth] = useState(0);
    const [loading, setLoading] = useState(false);
    const [pdfCanvasReady, setPdfCanvasReady] = useState(false);
    const [pdfPageRendering, setPdfPageRendering] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [noteText, setNoteText] = useState<string>('');
    // Word pages / PowerPoint slides are stacked in one scroll; track the one in view.
    const [docPage, setDocPage] = useState(0);
    const [docPageCount, setDocPageCount] = useState(0);

    const flushPendingViewerState = useCallback(() => {
      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
        saveStateTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        const { resourceId, state } = pendingSaveRef.current;
        pendingSaveRef.current = null;
        saveViewerState(resourceId, state);
      }
    }, []);

    const scheduleSaveViewerState = useCallback((resourceId: string, state: StoredViewerState) => {
      pendingSaveRef.current = { resourceId, state };
      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
      }
      saveStateTimerRef.current = window.setTimeout(() => {
        saveStateTimerRef.current = null;
        if (pendingSaveRef.current) {
          const pending = pendingSaveRef.current;
          pendingSaveRef.current = null;
          saveViewerState(pending.resourceId, pending.state);
        }
      }, SCROLL_SAVE_DEBOUNCE_MS);
    }, []);

    const cancelPrefetch = useCallback(() => {
      prefetchRunIdRef.current += 1;
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = null;
      }
      safeCancelRender(prefetchRenderTaskRef.current);
      prefetchRenderTaskRef.current = null;
    }, []);

    const cleanupDistantPdfPages = useCallback((centerPage: number) => {
      for (const [p, proxy] of Array.from(pdfPagesRef.current.entries())) {
        if (Math.abs(p - centerPage) > PDF_PAGE_KEEP_RADIUS) {
          pdfPagesRef.current.delete(p);
          try {
            proxy.cleanup();
          } catch {
            // ignore page cleanup failures on destroyed documents
          }
        }
      }
    }, []);

    const cleanupPdfResources = useCallback(
      (destroyDoc: boolean) => {
        cancelPrefetch();
        safeCancelRender(activeRenderTaskRef.current);
        activeRenderTaskRef.current = null;
        pdfPageCacheRef.current.clear();
        for (const proxy of pdfPagesRef.current.values()) {
          try {
            proxy.cleanup();
          } catch {
            // ignore
          }
        }
        pdfPagesRef.current.clear();
        lastPaintedSizeRef.current = null;

        if (destroyDoc) {
          const lt = loadingTaskRef.current;
          loadingTaskRef.current = null;
          const doc = pdfDocRef.current;
          pdfDocRef.current = null;
          if (doc) {
            void doc.destroy().catch(() => {});
          } else if (lt) {
            void lt.destroy().catch(() => {});
          }
          const canvas = pdfCanvasRef.current;
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
            canvas.style.width = '';
            canvas.style.height = '';
          }
        }
      },
      [cancelPrefetch],
    );

    // Ensure all timers and PDF/worker allocations are released on unmount
    useEffect(() => {
      return () => {
        flushPendingViewerState();
        if (renderZoomTimerRef.current !== null) {
          window.clearTimeout(renderZoomTimerRef.current);
          renderZoomTimerRef.current = null;
        }
        if (zoomAnchorRafRef.current !== null) {
          window.cancelAnimationFrame(zoomAnchorRafRef.current);
          zoomAnchorRafRef.current = null;
        }
        cleanupPdfResources(true);
      };
    }, [flushPendingViewerState, cleanupPdfResources]);

    // Keep page input synchronized with active page number
    useEffect(() => {
      setPageInput(String(pageNum));
    }, [pageNum]);

    // Keep sibling file index input synchronized with active sibling index
    useEffect(() => {
      if (siblingNav) {
        setFileIndexInput(String(siblingNav.index + 1));
      }
    }, [siblingNav?.index]);

    // Persist pageNum & zoom for the currently loaded resource
    useEffect(() => {
      if (loadedResourceIdRef.current !== resource.id) return;
      const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      scheduleSaveViewerState(resource.id, { pageNum, fitZoom: zoom, scrollTop });
    }, [resource.id, pageNum, zoom, scheduleSaveViewerState]);

    useEffect(() => {
      let cancelled = false;
      flushPendingViewerState();
      cleanupPdfResources(true);

      const saved = loadViewerState(resource.id);
      const jump =
        requestedJumpRef.current &&
        requestedJumpRef.current.resourceId === resource.id &&
        requestedJumpRef.current.seq !== lastHandledJumpSeqRef.current
          ? requestedJumpRef.current
          : null;
      if (jump) {
        lastHandledJumpSeqRef.current = jump.seq;
      }
      const initialPage = jump ? Math.max(1, Math.floor(jump.page)) : saved.pageNum;
      lastPageNumRef.current = initialPage;
      navDirectionRef.current = 1;
      loadedResourceIdRef.current = null;
      pendingScrollTopRef.current = jump ? (resource.category === 'pdf' ? 0 : null) : saved.scrollTop;
      pendingDocPageRef.current =
        jump && (resource.category === 'document' || resource.category === 'other') ? initialPage : null;

      if (renderZoomTimerRef.current !== null) {
        window.clearTimeout(renderZoomTimerRef.current);
        renderZoomTimerRef.current = null;
      }

      setError(null);
      setPdfDoc(null);
      setPdfCanvasReady(false);
      setPdfPageRendering(false);
      setPageNum(initialPage);
      setPageInput(String(initialPage));
      setZoom(saved.fitZoom);
      setRenderZoom(saved.fitZoom);
      setNumPages(0);
      setNoteText('');
      setDocPage(0);
      setDocPageCount(0);

      if (resource.category === 'pdf') {
        setLoading(true);
        const loadingTask = pdfjsLib.getDocument({
          url: resource.url,
          disableRange: false,
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
          canvasMaxAreaInBytes: PDF_CANVAS_MAX_AREA_BYTES,
        });
        loadingTaskRef.current = loadingTask;
        loadingTask.promise
          .then((doc) => {
            if (cancelled) {
              void doc.destroy().catch(() => {});
              return;
            }
            pdfDocRef.current = doc;
            loadingTaskRef.current = null;
            const latestJump =
              requestedJumpRef.current &&
              requestedJumpRef.current.resourceId === resource.id &&
              requestedJumpRef.current.seq !== lastHandledJumpSeqRef.current
                ? requestedJumpRef.current
                : null;
            if (latestJump) {
              lastHandledJumpSeqRef.current = latestJump.seq;
              pendingScrollTopRef.current = 0;
            }
            const targetPage = latestJump ? latestJump.page : initialPage;
            const clampedPage = Math.min(Math.max(1, Math.floor(targetPage)), doc.numPages);
            lastPageNumRef.current = clampedPage;
            loadedResourceIdRef.current = resource.id;
            setPdfDoc(doc);
            setNumPages(doc.numPages);
            setPageNum(clampedPage);
            setPageInput(String(clampedPage));
            setLoading(false);
          })
          .catch((err) => {
            if (cancelled) return;
            loadingTaskRef.current = null;
            setError(`PDF yüklenemedi: ${err instanceof Error ? err.message : String(err)}`);
            setLoading(false);
          });
      } else if (resource.category === 'note') {
        setLoading(true);
        fetch(resource.url)
          .then((r) => r.text())
          .then((txt) => {
            if (cancelled) return;
            loadedResourceIdRef.current = resource.id;
            setNoteText(txt);
            setLoading(false);
            window.requestAnimationFrame(() => {
              if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
                scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
                pendingScrollTopRef.current = null;
              }
            });
          })
          .catch(() => {
            if (!cancelled) {
              setError('Not dosyası okunamadı.');
              setLoading(false);
            }
          });
      } else {
        setLoading(false);
        loadedResourceIdRef.current = resource.id;
        if (resource.category === 'image') {
          window.requestAnimationFrame(() => {
            if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
              scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
              pendingScrollTopRef.current = null;
            }
          });
        }
      }

      return () => {
        cancelled = true;
        flushPendingViewerState();
        cleanupPdfResources(true);
      };
    }, [resource.id, resource.url, resource.category, flushPendingViewerState, cleanupPdfResources]);

    // Track the available width so "fit to width" follows panel resizes.
    useEffect(() => {
      const el = scrollContainerRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const update = () => {
        const w = el.clientWidth - VIEWER_PADDING_PX;
        if (w > 0) setContainerWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const paintCachedPage = useCallback((entry: PdfCachedPage, targetZoom: number) => {
      const canvas = pdfCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
      if (!ctx) return;

      // Resize and draw synchronously in the same turn so the browser never composites a blank white frame.
      if (canvas.width !== entry.pixelWidth) canvas.width = entry.pixelWidth;
      if (canvas.height !== entry.pixelHeight) canvas.height = entry.pixelHeight;
      ctx.drawImage(entry.image, 0, 0, entry.pixelWidth, entry.pixelHeight);
      canvas.style.width = `${entry.cssWidth}px`;
      canvas.style.height = `${entry.cssHeight}px`;

      lastPaintedSizeRef.current = {
        cssWidth: entry.cssWidth,
        cssHeight: entry.cssHeight,
        zoom: targetZoom,
      };
      setPdfCanvasReady(true);
      setPdfPageRendering(false);

      if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
        scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;
      }
    }, []);

    const renderPdfPageToCache = useCallback(
      async (
        doc: pdfjsLib.PDFDocumentProxy,
        pageNumber: number,
        containerW: number,
        targetZoom: number,
        dpr: number,
        onTask: (task: pdfjsLib.RenderTask | null) => void,
      ): Promise<PdfCachedPage | null> => {
        if (pdfDocRef.current !== doc) return null;
        let page = pdfPagesRef.current.get(pageNumber);
        if (!page) {
          page = await doc.getPage(pageNumber);
          if (pdfDocRef.current !== doc) {
            try {
              page.cleanup();
            } catch {
              // ignore
            }
            return null;
          }
          pdfPagesRef.current.set(pageNumber, page);
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const metrics = computePdfRenderMetrics(
          baseViewport.width,
          baseViewport.height,
          containerW,
          targetZoom,
          dpr,
        );
        const viewport = page.getViewport({ scale: metrics.renderScale });

        const offscreen = document.createElement('canvas');
        offscreen.width = metrics.pixelWidth;
        offscreen.height = metrics.pixelHeight;
        const ctx = offscreen.getContext('2d', { alpha: false }) ?? offscreen.getContext('2d');
        if (!ctx) {
          offscreen.width = 0;
          offscreen.height = 0;
          return null;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, offscreen.width, offscreen.height);

        const renderTask = page.render({
          canvas: offscreen,
          canvasContext: ctx,
          viewport,
          background: 'rgb(255, 255, 255)',
        });
        onTask(renderTask);

        try {
          await renderTask.promise;
        } catch (err) {
          offscreen.width = 0;
          offscreen.height = 0;
          throw err;
        } finally {
          onTask(null);
        }

        if (pdfDocRef.current !== doc) {
          offscreen.width = 0;
          offscreen.height = 0;
          return null;
        }

        let cachedImage: ImageBitmap | HTMLCanvasElement = offscreen;
        if (typeof window.createImageBitmap === 'function') {
          try {
            const bitmap = await window.createImageBitmap(offscreen);
            offscreen.width = 0;
            offscreen.height = 0;
            if (pdfDocRef.current !== doc) {
              bitmap.close();
              return null;
            }
            cachedImage = bitmap;
          } catch {
            // Fall back to keeping the offscreen canvas directly
          }
        }

        pdfPageCacheRef.current.set({
          pageNum: pageNumber,
          scaleKey: metrics.scaleKey,
          image: cachedImage,
          pixelWidth: metrics.pixelWidth,
          pixelHeight: metrics.pixelHeight,
          cssWidth: metrics.cssWidth,
          cssHeight: metrics.cssHeight,
        });
        return pdfPageCacheRef.current.get(pageNumber, metrics.scaleKey) ?? null;
      },
      [],
    );

    const schedulePrefetch = useCallback(
      (
        doc: pdfjsLib.PDFDocumentProxy,
        centerPage: number,
        containerW: number,
        targetZoom: number,
        dpr: number,
      ) => {
        if (!isActiveRef.current || pdfDocRef.current !== doc || doc.numPages <= 1 || containerW <= 0) {
          return;
        }
        cancelPrefetch();
        const runId = prefetchRunIdRef.current;
        const scaleKey = buildPdfScaleKey(containerW, targetZoom, dpr);
        const targets = getPrefetchTargets(centerPage, doc.numPages, navDirectionRef.current);
        if (targets.length === 0) return;

        prefetchTimerRef.current = window.setTimeout(() => {
          prefetchTimerRef.current = null;
          void (async () => {
            for (const targetPage of targets) {
              if (
                prefetchRunIdRef.current !== runId ||
                pdfDocRef.current !== doc ||
                !isActiveRef.current
              ) {
                return;
              }
              if (pdfPageCacheRef.current.has(targetPage, scaleKey)) continue;
              try {
                await renderPdfPageToCache(doc, targetPage, containerW, targetZoom, dpr, (task) => {
                  prefetchRenderTaskRef.current = task;
                });
              } catch {
                // Cancelled or non-fatal prefetch failure
                return;
              }
            }
            if (prefetchRunIdRef.current === runId && pdfDocRef.current === doc) {
              cleanupDistantPdfPages(centerPage);
            }
          })();
        }, PDF_PREFETCH_DELAY_MS);
      },
      [cancelPrefetch, renderPdfPageToCache, cleanupDistantPdfPages],
    );

    // Smooth CSS pre-scaling while continuous Ctrl+wheel zoom settles before crisp re-render
    useEffect(() => {
      if (resource.category !== 'pdf' || zoom === renderZoom) return;
      const canvas = pdfCanvasRef.current;
      const painted = lastPaintedSizeRef.current;
      if (!canvas || !painted || painted.zoom <= 0) return;
      const ratio = zoom / painted.zoom;
      canvas.style.width = `${Math.max(1, Math.floor(painted.cssWidth * ratio))}px`;
      canvas.style.height = `${Math.max(1, Math.floor(painted.cssHeight * ratio))}px`;
    }, [resource.category, zoom, renderZoom]);

    // Render active PDF page via bounded LRU cache + double-buffered offscreen canvas (zero white flash)
    useEffect(() => {
      if (loading || !pdfDoc || !pdfCanvasRef.current || containerWidth <= 0) return;
      const safePage = Math.min(Math.max(1, pageNum), pdfDoc.numPages);
      if (safePage > lastPageNumRef.current) navDirectionRef.current = 1;
      else if (safePage < lastPageNumRef.current) navDirectionRef.current = -1;
      lastPageNumRef.current = safePage;

      const dpr = window.devicePixelRatio || 1;
      const scaleKey = buildPdfScaleKey(containerWidth, renderZoom, dpr);

      cancelPrefetch();
      pdfPageCacheRef.current.invalidateOtherScales(scaleKey);

      const cached = pdfPageCacheRef.current.get(safePage, scaleKey);
      if (cached) {
        paintCachedPage(cached, renderZoom);
        cleanupDistantPdfPages(safePage);
        schedulePrefetch(pdfDoc, safePage, containerWidth, renderZoom, dpr);
        return () => {
          cancelPrefetch();
        };
      }

      let cancelled = false;
      const badgeTimer = window.setTimeout(() => {
        if (!cancelled) setPdfPageRendering(true);
      }, PDF_RENDER_BADGE_DELAY_MS);

      void renderPdfPageToCache(pdfDoc, safePage, containerWidth, renderZoom, dpr, (task) => {
        activeRenderTaskRef.current = task;
      })
        .then((entry) => {
          window.clearTimeout(badgeTimer);
          if (cancelled || !entry) return;
          paintCachedPage(entry, renderZoom);
          cleanupDistantPdfPages(safePage);
          schedulePrefetch(pdfDoc, safePage, containerWidth, renderZoom, dpr);
        })
        .catch(() => {
          window.clearTimeout(badgeTimer);
          if (!cancelled) setPdfPageRendering(false);
        });

      return () => {
        cancelled = true;
        window.clearTimeout(badgeTimer);
        safeCancelRender(activeRenderTaskRef.current);
        activeRenderTaskRef.current = null;
        cancelPrefetch();
      };
    }, [
      loading,
      pdfDoc,
      pageNum,
      renderZoom,
      containerWidth,
      cancelPrefetch,
      paintCachedPage,
      renderPdfPageToCache,
      cleanupDistantPdfPages,
      schedulePrefetch,
    ]);

    // When switching away from the resource tab, drop neighbor bitmaps; re-warm when returning
    useEffect(() => {
      if (resource.category !== 'pdf' || !pdfDoc) return;
      const safePage = Math.min(Math.max(1, pageNum), pdfDoc.numPages);
      if (!isActive) {
        cancelPrefetch();
        pdfPageCacheRef.current.pruneKeeping(new Set([safePage]));
        cleanupDistantPdfPages(safePage);
        return;
      }
      if (containerWidth > 0) {
        schedulePrefetch(pdfDoc, safePage, containerWidth, renderZoom, window.devicePixelRatio || 1);
      }
    }, [
      isActive,
      resource.category,
      pdfDoc,
      pageNum,
      renderZoom,
      containerWidth,
      cancelPrefetch,
      cleanupDistantPdfPages,
      schedulePrefetch,
    ]);

    const getDocPages = useCallback((): HTMLElement[] => {
      const el = scrollContainerRef.current;
      return el ? Array.from(el.querySelectorAll<HTMLElement>(PAGED_DOC_SELECTOR)) : [];
    }, []);

    const scrollToDocPage = useCallback(
      (page: number, smooth = true): boolean => {
        const el = scrollContainerRef.current;
        const pages = getDocPages();
        if (!el || el.clientHeight <= 0 || pages.length === 0) return false;
        const clamped = Math.min(Math.max(1, Math.floor(page)), pages.length);
        const target = pages[clamped - 1];
        const top =
          el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
        el.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
        setDocPage(clamped);
        setDocPageCount(pages.length);
        return true;
      },
      [getDocPages],
    );

    /** Finds which Word page / slide sits at the reading line (40% from the top) of the viewer. */
    const updateDocPage = useCallback(() => {
      const el = scrollContainerRef.current;
      if (!el || (resource.category !== 'document' && resource.category !== 'other')) return;
      const pages = getDocPages();
      setDocPageCount(pages.length);
      if (pages.length === 0) {
        setDocPage(0);
        return;
      }
      if (pendingDocPageRef.current !== null && el.clientHeight > 0) {
        const pending = pendingDocPageRef.current;
        pendingDocPageRef.current = null;
        if (scrollToDocPage(pending, false)) return;
      }
      const rect = el.getBoundingClientRect();
      const line = rect.top + el.clientHeight * 0.4;
      let current = 1;
      pages.forEach((page, idx) => {
        if (page.getBoundingClientRect().top <= line) current = idx + 1;
      });
      setDocPage(current);
    }, [resource.category, getDocPages, scrollToDocPage]);

    // Apply declarative jump requests on already-mounted resources and when a hidden viewer becomes visible
    useEffect(() => {
      if (!requestedJump || requestedJump.resourceId !== resource.id) return;
      if (requestedJump.seq === lastHandledJumpSeqRef.current) return;

      if (resource.category === 'pdf') {
        if (loadedResourceIdRef.current !== resource.id || !pdfDoc || numPages <= 0) return;
        lastHandledJumpSeqRef.current = requestedJump.seq;
        const clamped = Math.min(Math.max(1, Math.floor(requestedJump.page)), numPages);
        pendingScrollTopRef.current = 0;
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setPageNum(clamped);
        return;
      }

      if (resource.category === 'document' || resource.category === 'other') {
        lastHandledJumpSeqRef.current = requestedJump.seq;
        pendingScrollTopRef.current = null;
        const target = Math.max(1, Math.floor(requestedJump.page));
        if (!scrollToDocPage(target, true)) {
          pendingDocPageRef.current = target;
        }
      }
    }, [requestedJump, resource.id, resource.category, pdfDoc, numPages, scrollToDocPage]);

    useEffect(() => {
      if (!isActive || pendingDocPageRef.current === null) return;
      const raf = window.requestAnimationFrame(() => {
        if (pendingDocPageRef.current !== null && scrollToDocPage(pendingDocPageRef.current, false)) {
          pendingDocPageRef.current = null;
        }
      });
      return () => window.cancelAnimationFrame(raf);
    }, [isActive, scrollToDocPage]);

    const docScrollRafRef = useRef<number | null>(null);
    const handleViewerScroll = useCallback(() => {
      if (docScrollRafRef.current !== null) return;
      docScrollRafRef.current = window.requestAnimationFrame(() => {
        docScrollRafRef.current = null;
        updateDocPage();
      });
    }, [updateDocPage]);

    const currentPage = resource.category === 'pdf' ? pageNum : docPage;
    const pageCount = resource.category === 'pdf' ? numPages : docPageCount;
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;
    useEffect(() => {
      onPageChangeRef.current?.(pageCount > 0 ? currentPage : 0, pageCount);
    }, [currentPage, pageCount, resource.id]);

    useImperativeHandle(ref, () => ({
      goToPage: (page: number) => {
        if (!Number.isFinite(page)) return;
        if (resource.category === 'pdf') {
          if (numPages <= 0) return;
          setPageNum(Math.min(Math.max(1, Math.floor(page)), numPages));
          return;
        }
        const target = Math.max(1, Math.floor(page));
        if (!scrollToDocPage(target, true)) {
          pendingDocPageRef.current = target;
        }
      },
      captureBaseImage: async () => {
        if (resource.category === 'pdf' && pdfCanvasRef.current) {
          return pdfCanvasRef.current.toDataURL('image/png');
        }
        if (resource.category === 'image' && imgRef.current) {
          const img = imgRef.current;
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.clientWidth || 800;
          canvas.height = img.naturalHeight || img.clientHeight || 600;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.fillStyle = '#0b1120';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png');
        }
        return null;
      },
    }));

    const zoomable =
      (resource.category === 'pdf' && numPages > 0) ||
      resource.category === 'image' ||
      resource.category === 'code' ||
      resource.category === 'document' ||
      resource.category === 'other';

    /**
     * Changes zoom while keeping the point under `anchor` (viewport coords; default: center)
     * in place, so zooming in doesn't throw you back to the top-left corner.
     */
    const applyZoom = useCallback(
      (
        target: number,
        anchor?: { clientX: number; clientY: number },
        opts?: { debounceRender?: boolean },
      ) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(target.toFixed(2))));
        const commitRenderZoom = () => {
          if (renderZoomTimerRef.current !== null) {
            window.clearTimeout(renderZoomTimerRef.current);
            renderZoomTimerRef.current = null;
          }
          if (opts?.debounceRender) {
            renderZoomTimerRef.current = window.setTimeout(() => {
              renderZoomTimerRef.current = null;
              setRenderZoom((prev) => (prev === next ? prev : next));
            }, PDF_WHEEL_RENDER_DEBOUNCE_MS);
          } else {
            setRenderZoom((prev) => (prev === next ? prev : next));
          }
        };

        const el = scrollContainerRef.current;
        if (!el) {
          setZoom(next);
          commitRenderZoom();
          return;
        }
        const rect = el.getBoundingClientRect();
        const px = anchor ? anchor.clientX - rect.left : el.clientWidth / 2;
        const py = anchor ? anchor.clientY - rect.top : el.clientHeight / 2;
        const sw = el.scrollWidth;
        const sh = el.scrollHeight;
        const fx = (el.scrollLeft + px) / Math.max(1, sw);
        const fy = (el.scrollTop + py) / Math.max(1, sh);
        setZoom((prev) => (prev === next ? prev : next));
        commitRenderZoom();

        // Cancel any previous zoom-anchor loop before starting a new one
        if (zoomAnchorRafRef.current !== null) {
          window.cancelAnimationFrame(zoomAnchorRafRef.current);
          zoomAnchorRafRef.current = null;
        }

        // Content re-renders asynchronously (PDF canvas); re-anchor once its size changes.
        let frames = 0;
        const tick = () => {
          zoomAnchorRafRef.current = null;
          const node = scrollContainerRef.current;
          if (!node) return;
          if (node.scrollWidth !== sw || node.scrollHeight !== sh) {
            node.scrollLeft = fx * node.scrollWidth - px;
            node.scrollTop = fy * node.scrollHeight - py;
            return;
          }
          if (++frames < 30) {
            zoomAnchorRafRef.current = window.requestAnimationFrame(tick);
          }
        };
        zoomAnchorRafRef.current = window.requestAnimationFrame(tick);
      },
      [],
    );

    // Ctrl + mouse wheel (or trackpad pinch) zooms toward the cursor
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    useEffect(() => {
      const el = scrollContainerRef.current;
      if (!el || !zoomable) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta = Math.max(-100, Math.min(100, e.deltaY));
        applyZoom(
          zoomRef.current * Math.pow(1.0025, -delta),
          { clientX: e.clientX, clientY: e.clientY },
          { debounceRender: resource.category === 'pdf' },
        );
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [zoomable, applyZoom, resource.category]);

    // Drag-to-pan ("hand") for pages and images; for documents only once zoomed wider than the panel
    const panRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
    const panMovedRef = useRef(false);
    const [isPanning, setIsPanning] = useState(false);
    const [overflowX, setOverflowX] = useState(false);

    useEffect(() => {
      const el = scrollContainerRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const check = () => setOverflowX(el.scrollWidth > el.clientWidth + 2);
      const raf = window.requestAnimationFrame(check);
      const ro = new ResizeObserver(check);
      ro.observe(el);
      return () => {
        window.cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, [resource.id, zoom, pageNum, docPageCount]);

    const canPan =
      resource.category === 'pdf' ||
      resource.category === 'image' ||
      ((resource.category === 'document' || resource.category === 'other') && overflowX);

    const handlePanStart = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!canPan || e.button !== 0 || e.pointerType === 'touch') return;
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, select, textarea, audio, video, [contenteditable="true"]')) return;
      const el = e.currentTarget;
      panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      panMovedRef.current = false;
    };

    const handlePanMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (!pan || pan.id !== e.pointerId) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!panMovedRef.current && Math.hypot(dx, dy) < 4) return;
      if (!panMovedRef.current) {
        panMovedRef.current = true;
        setIsPanning(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      e.preventDefault();
      e.currentTarget.scrollLeft = pan.left - dx;
      e.currentTarget.scrollTop = pan.top - dy;
    };

    const handlePanEnd = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!panRef.current || panRef.current.id !== e.pointerId) return;
      panRef.current = null;
      setIsPanning(false);
      // keep panMovedRef true until the click that follows has been swallowed
      window.setTimeout(() => {
        panMovedRef.current = false;
      }, 0);
    };

    const commitPageInput = () => {
      const parsed = parseInt(pageInput, 10);
      if (!Number.isFinite(parsed) || numPages <= 0) {
        setPageInput(String(pageNum));
        return;
      }
      const clamped = Math.min(Math.max(1, parsed), numPages);
      setPageNum(clamped);
      setPageInput(String(clamped));
    };

    const commitFileIndexInput = () => {
      if (!siblingNav || siblingNav.total <= 1) return;
      const parsed = parseInt(fileIndexInput, 10);
      if (!Number.isFinite(parsed)) {
        setFileIndexInput(String(siblingNav.index + 1));
        return;
      }
      const clamped = Math.min(Math.max(1, parsed), siblingNav.total);
      setFileIndexInput(String(clamped));
      if (clamped - 1 !== siblingNav.index) {
        siblingNav.onNavigate(clamped - 1);
      }
    };

    // Keyboard Left/Right arrows: PDF navigates pages; non-PDF navigates sibling files
    useEffect(() => {
      if (!isActive) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const hasDialog = Boolean(document.querySelector('[role="dialog"]'));
        if (shouldIgnoreNavKeyEvent(e, hasDialog)) return;

        if (resource.category === 'pdf' && numPages > 0) {
          if (e.key === 'ArrowLeft' && pageNum > 1) {
            e.preventDefault();
            setPageNum((p) => Math.max(1, p - 1));
          } else if (e.key === 'ArrowRight' && pageNum < numPages) {
            e.preventDefault();
            setPageNum((p) => Math.min(numPages, p + 1));
          }
          return;
        }

        if (resource.category !== 'pdf' && siblingNav && siblingNav.total > 1) {
          if (e.key === 'ArrowLeft' && siblingNav.index > 0) {
            e.preventDefault();
            siblingNav.onNavigate(siblingNav.index - 1);
          } else if (e.key === 'ArrowRight' && siblingNav.index < siblingNav.total - 1) {
            e.preventDefault();
            siblingNav.onNavigate(siblingNav.index + 1);
          }
        }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [isActive, resource.category, numPages, pageNum, siblingNav]);

    return (
      <div className="relative flex h-full flex-col bg-slate-950">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800/90 bg-slate-900/90 px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold leading-tight text-white" title={resource.name}>
                {resource.name}
              </h3>
              {resource.source === 'local' && resource.localPath && (
                <p
                  className="truncate font-mono text-[10px] leading-tight text-slate-500"
                  title={`Bilgisayarından canlı okunuyor: ${resource.localPath}`}
                >
                  {resource.localPath}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {resource.category === 'pdf' && numPages > 0 && (
              <>
                <button
                  type="button"
                  title="Önceki sayfa (←)"
                  aria-label="Önceki sayfa"
                  disabled={pageNum <= 1}
                  onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitPageInput();
                  }}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-1.5 py-1 text-[11px] text-slate-300"
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="PDF sayfa numarası"
                    title="Sayfa numarası yazıp Enter’a bas"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                    onBlur={commitPageInput}
                    className="w-8 rounded bg-slate-950 px-1 py-0.5 text-center font-mono text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="whitespace-nowrap">/ {numPages}</span>
                </form>
                <button
                  type="button"
                  title="Sonraki sayfa (→)"
                  aria-label="Sonraki sayfa"
                  disabled={pageNum >= numPages}
                  onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <div className="mx-0.5 h-4 w-px bg-slate-700" />
              </>
            )}

            {resource.category !== 'pdf' && docPageCount > 1 && (
              <>
                <span
                  className="whitespace-nowrap rounded-lg bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300"
                  title="Görünen sayfa / slayt"
                >
                  {docPage} / {docPageCount}
                </span>
                <div className="mx-0.5 h-4 w-px bg-slate-700" />
              </>
            )}

            {resource.category !== 'pdf' && siblingNav && siblingNav.total > 1 && (
              <>
                <button
                  type="button"
                  title={
                    siblingNav.prevLabel
                      ? `Önceki dosya: ${siblingNav.prevLabel} (←)`
                      : 'Önceki dosya (←)'
                  }
                  aria-label="Önceki dosya"
                  disabled={siblingNav.index <= 0}
                  onClick={() => siblingNav.onNavigate(Math.max(0, siblingNav.index - 1))}
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitFileIndexInput();
                  }}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-1.5 py-1 text-[11px] text-slate-300"
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Dosya sırası"
                    title="Dosya numarası yazıp Enter’a bas"
                    value={fileIndexInput}
                    onChange={(e) => setFileIndexInput(e.target.value.replace(/[^0-9]/g, ''))}
                    onBlur={commitFileIndexInput}
                    className="w-8 rounded bg-slate-950 px-1 py-0.5 text-center font-mono text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="whitespace-nowrap">/ {siblingNav.total}</span>
                </form>
                <button
                  type="button"
                  title={
                    siblingNav.nextLabel
                      ? `Sonraki dosya: ${siblingNav.nextLabel} (→)`
                      : 'Sonraki dosya (→)'
                  }
                  aria-label="Sonraki dosya"
                  disabled={siblingNav.index >= siblingNav.total - 1}
                  onClick={() =>
                    siblingNav.onNavigate(Math.min(siblingNav.total - 1, siblingNav.index + 1))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <div className="mx-0.5 h-4 w-px bg-slate-700" />
              </>
            )}

            {zoomable && (
              <>
                <button
                  type="button"
                  title="Uzaklaştır (Ctrl + tekerlek)"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => applyZoom(zoom - ZOOM_STEP)}
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Genişliğe sığdır (%100)"
                  onClick={() => applyZoom(DEFAULT_ZOOM)}
                  className="min-w-[3.25rem] rounded-lg border border-slate-700 bg-slate-800 px-1.5 py-1 font-mono text-[11px] text-slate-200 hover:bg-slate-700"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  title="Yakınlaştır (Ctrl + tekerlek) • Yakınlaştırınca sürükleyerek gezin"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => applyZoom(zoom + ZOOM_STEP)}
                  className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onStartAnnotate}
              title="Sayfanın üzerini elle işaretle ve sor"
              className="flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
            >
              <Pencil className="h-3.5 w-3.5" /> İşaretle
            </button>
          </div>
        </div>

        {/* Viewer Body */}
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            handleViewerScroll();
            if (loadedResourceIdRef.current !== resource.id) return;
            scheduleSaveViewerState(resource.id, {
              pageNum,
              fitZoom: zoom,
              scrollTop: e.currentTarget.scrollTop,
            });
          }}
          onDragStart={(e) => {
            // Native image/link dragging would cancel the hand-pan gesture
            if (canPan) e.preventDefault();
          }}
          onPointerDown={handlePanStart}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerCancel={handlePanEnd}
          onClickCapture={(e) => {
            // Swallow the click that ends a drag so links/buttons under the cursor don't fire
            if (panMovedRef.current) {
              e.stopPropagation();
              e.preventDefault();
              panMovedRef.current = false;
            }
          }}
          className={`min-h-0 flex-1 overflow-auto p-5 ${
            isPanning ? 'cursor-grabbing select-none' : canPan ? 'cursor-grab' : ''
          }`}
        >
          {loading && (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">
              Kaynak yükleniyor...
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
              {error}
            </div>
          )}

          {!loading && !error && resource.category === 'pdf' && (
            <div className="flex w-max min-w-full justify-center">
              <canvas
                ref={pdfCanvasRef}
                className={`rounded-xl shadow-2xl ring-1 ring-slate-700 ${
                  pdfCanvasReady ? 'bg-white' : 'opacity-0'
                }`}
              />
            </div>
          )}

          {!loading && !error && resource.category === 'image' && (
            <div
              className="mx-auto flex justify-center"
              style={{ width: zoom === DEFAULT_ZOOM ? '100%' : `${Math.round(zoom * 100)}%` }}
            >
              <img
                key={resource.id}
                ref={imgRef}
                src={resource.url}
                alt={resource.name}
                crossOrigin="anonymous"
                onLoad={() => {
                  if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
                    scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
                    pendingScrollTopRef.current = null;
                  }
                }}
                className={`rounded-xl object-contain shadow-2xl ring-1 ring-slate-700 ${
                  zoom === DEFAULT_ZOOM ? 'max-h-[82vh] max-w-full' : 'w-full'
                }`}
              />
            </div>
          )}

          {!loading && !error && resource.category === 'note' && (
            <div className="mx-auto max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/75 p-6 shadow-xl">
              <div
                className="study-prose"
                dangerouslySetInnerHTML={{ __html: renderStudyMarkdown(noteText) }}
              />
            </div>
          )}

          {!loading && !error && resource.category === 'code' && (
            <CodeView
              url={resource.url}
              filename={resource.name}
              fontScale={zoom}
              binaryFallback={<DocumentView resource={{ ...resource, category: 'other' }} zoom={zoom} />}
              onLoaded={() => {
                window.requestAnimationFrame(() => {
                  if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
                    scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
                    pendingScrollTopRef.current = null;
                  }
                });
              }}
            />
          )}

          {!loading && !error && resource.category === 'folder' && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-slate-400">
              <FolderOpen className="h-9 w-9 text-amber-300/70" />
              <p className="font-semibold text-slate-200">Sol menüden bir dosya seç</p>
              <p className="max-w-sm text-[11px] leading-relaxed text-slate-500">
                “{resource.name}” klasörünü sol menüde genişletip bir dosyaya tıkla; PDF’ler sayfa sayfa, kodlar renkli
                olarak burada açılır. Klasör AI bağlamında seçiliyken Gemini içindeki dosyaları doğrudan okuyabilir.
              </p>
            </div>
          )}

          {!loading && !error && (resource.category === 'document' || resource.category === 'other') && (
            <DocumentView
              resource={resource}
              zoom={zoom}
              onLoaded={() => {
                window.requestAnimationFrame(() => {
                  if (pendingDocPageRef.current !== null) {
                    const target = pendingDocPageRef.current;
                    if (scrollToDocPage(target, false)) {
                      pendingDocPageRef.current = null;
                      return;
                    }
                  }
                  if (scrollContainerRef.current && pendingScrollTopRef.current !== null) {
                    scrollContainerRef.current.scrollTop = pendingScrollTopRef.current;
                    pendingScrollTopRef.current = null;
                  }
                  updateDocPage();
                });
              }}
            />
          )}
        </div>

        {!loading && !error && resource.category === 'pdf' && pdfPageRendering && (
          <div className="pointer-events-none absolute right-4 bottom-4 z-20 flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/90 px-2.5 py-1 text-[11px] text-slate-300 shadow-lg backdrop-blur">
            <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
            <span>Sayfa {pageNum} hazırlanıyor...</span>
          </div>
        )}
      </div>
    );
  },
);

ResourceViewer.displayName = 'ResourceViewer';
