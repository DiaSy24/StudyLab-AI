export const MAX_PDF_DPR = 2;
export const MAX_PDF_CANVAS_PIXELS = 12_000_000; // ~48 MB RGBA upper bound per page
export const MAX_PDF_CANVAS_DIM = 4096;
export const DEFAULT_PDF_CACHE_MAX_ENTRIES = 5;
export const DEFAULT_PDF_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB total decoded bitmap budget

export interface PdfRenderMetrics {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  renderScale: number;
  effectiveDpr: number;
  scaleKey: string;
}

export interface DisposableCanvasImage {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

export interface PdfCachedPage<
  T extends DisposableCanvasImage = ImageBitmap | HTMLCanvasElement,
> {
  pageNum: number;
  scaleKey: string;
  image: T;
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  byteSize: number;
}

/**
 * Stable cache key for the current viewer geometry and zoom level.
 * Computed synchronously before `getPage()` so cache hits avoid worker roundtrips.
 */
export function buildPdfScaleKey(
  containerWidth: number,
  zoom: number,
  devicePixelRatio = 1,
): string {
  const safeWidth = Math.max(1, Math.round(containerWidth));
  const safeZoom = Math.max(1, Math.round(zoom * 1000));
  const safeDpr = Math.max(100, Math.round(Math.min(Math.max(1, devicePixelRatio), MAX_PDF_DPR) * 100));
  return `w${safeWidth}:z${safeZoom}:d${safeDpr}`;
}

/**
 * Computes exact CSS display dimensions and bounded backing-store pixel dimensions
 * so high zoom levels (up to 400%) on HiDPI monitors never allocate 200MB+ canvases.
 */
export function computePdfRenderMetrics(
  baseWidth: number,
  baseHeight: number,
  containerWidth: number,
  zoom: number,
  devicePixelRatio = 1,
): PdfRenderMetrics {
  const safeBaseW = Math.max(1, baseWidth);
  const safeBaseH = Math.max(1, baseHeight);
  const safeContainerW = Math.max(1, containerWidth);
  const safeZoom = Math.max(0.1, zoom);
  const clampedDpr = Math.min(Math.max(1, devicePixelRatio || 1), MAX_PDF_DPR);

  const fitScale = safeContainerW / safeBaseW;
  const cssScale = fitScale * safeZoom;
  const cssWidth = Math.max(1, Math.floor(safeBaseW * cssScale));
  const cssHeight = Math.max(1, Math.floor(safeBaseH * cssScale));

  const desiredW = safeBaseW * cssScale * clampedDpr;
  const desiredH = safeBaseH * cssScale * clampedDpr;

  let downscale = 1;
  if (desiredW > MAX_PDF_CANVAS_DIM || desiredH > MAX_PDF_CANVAS_DIM) {
    downscale = Math.min(downscale, MAX_PDF_CANVAS_DIM / desiredW, MAX_PDF_CANVAS_DIM / desiredH);
  }
  const scaledPixels = desiredW * downscale * (desiredH * downscale);
  if (scaledPixels > MAX_PDF_CANVAS_PIXELS) {
    downscale *= Math.sqrt(MAX_PDF_CANVAS_PIXELS / scaledPixels);
  }

  const effectiveDpr = Math.max(0.25, clampedDpr * downscale);
  const renderScale = cssScale * effectiveDpr;
  const pixelWidth = Math.max(1, Math.min(MAX_PDF_CANVAS_DIM, Math.floor(safeBaseW * renderScale)));
  const pixelHeight = Math.max(1, Math.min(MAX_PDF_CANVAS_DIM, Math.floor(safeBaseH * renderScale)));

  return {
    cssWidth,
    cssHeight,
    pixelWidth,
    pixelHeight,
    renderScale,
    effectiveDpr,
    scaleKey: buildPdfScaleKey(safeContainerW, safeZoom, clampedDpr),
  };
}

/**
 * Returns adjacent page numbers to pre-render in priority order based on navigation direction.
 */
export function getPrefetchTargets(
  currentPage: number,
  numPages: number,
  direction: 1 | -1 = 1,
): number[] {
  if (numPages <= 1) return [];
  const candidates =
    direction < 0 ? [currentPage - 1, currentPage + 1] : [currentPage + 1, currentPage - 1];
  const out: number[] = [];
  for (const p of candidates) {
    if (p >= 1 && p <= numPages && p !== currentPage && !out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

function disposeCanvasImage(image: DisposableCanvasImage): void {
  if (typeof image.close === 'function') {
    try {
      image.close();
    } catch {
      // ignore already-closed bitmaps
    }
    return;
  }
  if (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) {
    image.width = 0;
    image.height = 0;
  }
}

function makeCacheKey(pageNum: number, scaleKey: string): string {
  return `${pageNum}@${scaleKey}`;
}

/**
 * Bounded LRU cache for pre-rendered PDF page bitmaps.
 * Explicitly closes evicted ImageBitmaps so GPU and RAM memory remain strictly capped.
 */
export class PdfPageCache<
  T extends DisposableCanvasImage = ImageBitmap | HTMLCanvasElement,
> {
  private readonly entries = new Map<string, PdfCachedPage<T>>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(opts?: { maxEntries?: number; maxBytes?: number }) {
    this.maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_PDF_CACHE_MAX_ENTRIES);
    this.maxBytes = Math.max(1, opts?.maxBytes ?? DEFAULT_PDF_CACHE_MAX_BYTES);
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.totalBytes;
  }

  has(pageNum: number, scaleKey: string): boolean {
    return this.entries.has(makeCacheKey(pageNum, scaleKey));
  }

  get(pageNum: number, scaleKey: string): PdfCachedPage<T> | undefined {
    const key = makeCacheKey(pageNum, scaleKey);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh LRU order (most recently used at the end)
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(entry: Omit<PdfCachedPage<T>, 'byteSize'>): void {
    const key = makeCacheKey(entry.pageNum, entry.scaleKey);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - existing.byteSize);
      if (existing.image !== entry.image) {
        disposeCanvasImage(existing.image);
      }
    }

    const byteSize = Math.max(0, entry.pixelWidth * entry.pixelHeight * 4);
    const fullEntry: PdfCachedPage<T> = { ...entry, byteSize };
    this.entries.set(key, fullEntry);
    this.totalBytes += byteSize;

    // Evict least-recently-used entries until within both entry count and byte budget.
    // Always preserve the newly inserted entry so the active page doesn't immediately evict itself.
    for (const [candidateKey, candidate] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) {
        break;
      }
      if (candidateKey === key) continue;
      this.entries.delete(candidateKey);
      this.totalBytes = Math.max(0, this.totalBytes - candidate.byteSize);
      disposeCanvasImage(candidate.image);
    }
  }

  /** Frees all cached pages rendered for stale zoom levels or container widths. */
  invalidateOtherScales(keepScaleKey: string): void {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (entry.scaleKey !== keepScaleKey) {
        this.entries.delete(key);
        this.totalBytes = Math.max(0, this.totalBytes - entry.byteSize);
        disposeCanvasImage(entry.image);
      }
    }
  }

  /** Keeps only entries whose page number is in `allowedPages`, disposing everything else. */
  pruneKeeping(allowedPages: ReadonlySet<number>): void {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (!allowedPages.has(entry.pageNum)) {
        this.entries.delete(key);
        this.totalBytes = Math.max(0, this.totalBytes - entry.byteSize);
        disposeCanvasImage(entry.image);
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      disposeCanvasImage(entry.image);
    }
    this.entries.clear();
    this.totalBytes = 0;
  }
}
