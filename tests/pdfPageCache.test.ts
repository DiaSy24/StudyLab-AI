import { describe, expect, it, vi } from 'vitest';
import {
  buildPdfScaleKey,
  computePdfRenderMetrics,
  getPrefetchTargets,
  MAX_PDF_CANVAS_DIM,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_DPR,
  PdfPageCache,
  type DisposableCanvasImage,
} from '../src/lib/pdfPageCache.js';

function makeMockBitmap(width: number, height: number): DisposableCanvasImage & { closed: boolean } {
  const obj = {
    width,
    height,
    closed: false,
    close: vi.fn(() => {
      obj.closed = true;
    }),
  };
  return obj;
}

describe('pdfPageCache', () => {
  describe('computePdfRenderMetrics', () => {
    it('preserves exact CSS dimensions while capping DPR to MAX_PDF_DPR', () => {
      const m = computePdfRenderMetrics(600, 800, 900, 1, 3);
      expect(m.cssWidth).toBe(900);
      expect(m.cssHeight).toBe(1200);
      expect(m.effectiveDpr).toBe(MAX_PDF_DPR);
      expect(m.pixelWidth).toBe(1800);
      expect(m.pixelHeight).toBe(2400);
      expect(m.scaleKey).toBe(buildPdfScaleKey(900, 1, 3));
    });

    it('caps backing-store dimensions and total pixels at 400% zoom on HiDPI displays', () => {
      const m = computePdfRenderMetrics(595, 842, 1000, 4, 2);
      // CSS size still reflects full 400% zoom for smooth scrolling/panning
      expect(m.cssWidth).toBe(4000);
      expect(m.cssHeight).toBeGreaterThan(5600);
      // Backing-store stays strictly within safe memory bounds
      expect(m.pixelWidth).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIM);
      expect(m.pixelHeight).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIM);
      expect(m.pixelWidth * m.pixelHeight).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS);
    });
  });

  describe('getPrefetchTargets', () => {
    it('prioritizes forward neighbor when moving forward and backward neighbor when moving backward', () => {
      expect(getPrefetchTargets(5, 10, 1)).toEqual([6, 4]);
      expect(getPrefetchTargets(5, 10, -1)).toEqual([4, 6]);
    });

    it('clamps cleanly at first, last, and single-page documents', () => {
      expect(getPrefetchTargets(1, 10, 1)).toEqual([2]);
      expect(getPrefetchTargets(1, 10, -1)).toEqual([2]);
      expect(getPrefetchTargets(10, 10, 1)).toEqual([9]);
      expect(getPrefetchTargets(1, 1, 1)).toEqual([]);
    });
  });

  describe('PdfPageCache', () => {
    it('evicts least-recently-used pages and closes their bitmaps when maxEntries is exceeded', () => {
      const cache = new PdfPageCache<ReturnType<typeof makeMockBitmap>>({
        maxEntries: 2,
        maxBytes: 100 * 1024 * 1024,
      });
      const b1 = makeMockBitmap(100, 100);
      const b2 = makeMockBitmap(100, 100);
      const b3 = makeMockBitmap(100, 100);

      cache.set({ pageNum: 1, scaleKey: 's1', image: b1, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });
      cache.set({ pageNum: 2, scaleKey: 's1', image: b2, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });

      // Touch page 1 so page 2 becomes the LRU candidate
      expect(cache.get(1, 's1')?.image).toBe(b1);

      cache.set({ pageNum: 3, scaleKey: 's1', image: b3, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });

      expect(cache.size).toBe(2);
      expect(cache.has(1, 's1')).toBe(true);
      expect(cache.has(3, 's1')).toBe(true);
      expect(cache.has(2, 's1')).toBe(false);
      expect(b2.closed).toBe(true);
      expect(b1.closed).toBe(false);
      expect(b3.closed).toBe(false);
    });

    it('evicts older entries to stay within the byte budget while keeping the newest entry', () => {
      // Each 1000x1000 bitmap = 4,000,000 bytes (~3.8 MB)
      const cache = new PdfPageCache<ReturnType<typeof makeMockBitmap>>({
        maxEntries: 5,
        maxBytes: 8_500_000,
      });
      const b1 = makeMockBitmap(1000, 1000);
      const b2 = makeMockBitmap(1000, 1000);
      const b3 = makeMockBitmap(1000, 1000);

      cache.set({ pageNum: 1, scaleKey: 's1', image: b1, pixelWidth: 1000, pixelHeight: 1000, cssWidth: 500, cssHeight: 500 });
      cache.set({ pageNum: 2, scaleKey: 's1', image: b2, pixelWidth: 1000, pixelHeight: 1000, cssWidth: 500, cssHeight: 500 });
      expect(cache.byteSize).toBe(8_000_000);

      cache.set({ pageNum: 3, scaleKey: 's1', image: b3, pixelWidth: 1000, pixelHeight: 1000, cssWidth: 500, cssHeight: 500 });
      expect(cache.size).toBe(2);
      expect(cache.byteSize).toBe(8_000_000);
      expect(b1.closed).toBe(true);
      expect(cache.has(2, 's1')).toBe(true);
      expect(cache.has(3, 's1')).toBe(true);
    });

    it('disposes stale scale entries, prunes non-allowed pages, and clears all memory', () => {
      const cache = new PdfPageCache<ReturnType<typeof makeMockBitmap>>();
      const b1 = makeMockBitmap(100, 100);
      const b2 = makeMockBitmap(100, 100);
      const b3 = makeMockBitmap(100, 100);

      cache.set({ pageNum: 1, scaleKey: 'old', image: b1, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });
      cache.set({ pageNum: 2, scaleKey: 'cur', image: b2, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });
      cache.set({ pageNum: 3, scaleKey: 'cur', image: b3, pixelWidth: 100, pixelHeight: 100, cssWidth: 100, cssHeight: 100 });

      cache.invalidateOtherScales('cur');
      expect(b1.closed).toBe(true);
      expect(cache.size).toBe(2);

      cache.pruneKeeping(new Set([2]));
      expect(b3.closed).toBe(true);
      expect(cache.size).toBe(1);
      expect(cache.has(2, 'cur')).toBe(true);

      cache.clear();
      expect(b2.closed).toBe(true);
      expect(cache.size).toBe(0);
      expect(cache.byteSize).toBe(0);
    });
  });
});
