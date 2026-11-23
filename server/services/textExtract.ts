import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

/** Formats whose text we can extract for the AI / text preview. */
export const EXTRACTABLE_EXTENSIONS = new Set([
  'docx', 'docm', 'dotx', 'doc', 'odt', 'rtf', 'epub',
  'pptx', 'pptm', 'ppsx', 'ppt', 'odp',
  'xlsx', 'xlsm', 'xlsb', 'xls', 'ods',
  'ipynb', 'zip', 'jar',
]);

const MAX_SOURCE_BYTES = 60 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

export interface ExtractedText {
  text: string;
  /** Human-readable format label (Turkish). */
  kind: string;
  /** True when the text was recovered heuristically (old binary formats). */
  approximate?: boolean;
}

function extOf(p: string): string {
  return path.extname(p).slice(1).toLowerCase();
}

export function isExtractable(filename: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(extOf(filename));
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function xmlToText(xml: string, paragraphTags: string[]): string {
  let s = xml;
  for (const tag of paragraphTags) {
    s = s.replace(new RegExp(`</${tag}>`, 'g'), '\n');
  }
  s = s.replace(/<(text:tab|w:tab)\s*\/>/g, '\t').replace(/<(text:line-break|a:br|w:br)\s*\/?>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(s)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function numericSort(a: string, b: string): number {
  const na = Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const nb = Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return na - nb;
}

async function extractPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(numericSort);
  const parts: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i])!.async('string');
    const text = xmlToText(xml, ['a:p']);
    const notesName = slides[i].replace('slides/slide', 'notesSlides/notesSlide');
    let notes = '';
    if (zip.file(notesName)) {
      notes = xmlToText(await zip.file(notesName)!.async('string'), ['a:p']).replace(/^\d+$/m, '').trim();
    }
    parts.push(`=== Slayt ${i + 1} ===\n${text}${notes ? `\n[Konuşmacı notları]\n${notes}` : ''}`);
  }
  return parts.join('\n\n');
}

async function extractOdf(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const content = zip.file('content.xml');
  if (!content) return '';
  return xmlToText(await content.async('string'), ['text:p', 'text:h', 'draw:page']);
}

async function extractEpub(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const pages = Object.keys(zip.files)
    .filter((f) => /\.(x?html?)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const parts: string[] = [];
  for (const p of pages) {
    const html = await zip.file(p)!.async('string');
    parts.push(xmlToText(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''), ['p', 'h1', 'h2', 'h3', 'h4', 'li', 'div']));
  }
  return parts.filter(Boolean).join('\n\n');
}

function extractSpreadsheet(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheetStubs: true });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    // Formulas without a saved result: keep the formula text instead of an empty cell
    if (sheet) {
      for (const [addr, cell] of Object.entries(sheet)) {
        if (addr.startsWith('!') || !cell || typeof cell !== 'object') continue;
        const c = cell as XLSX.CellObject;
        if (c.f && (c.t === 'z' || c.v === undefined || c.v === '')) {
          c.t = 's';
          c.v = `=${c.f}`;
          c.w = `=${c.f}`;
        }
      }
    }
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) : '';
    return `=== Sayfa: ${name} ===\n${csv}`;
  }).join('\n\n');
}

async function extractZipListing(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return [`Arşivdeki dosyalar (${names.length}):`, ...names.slice(0, 2000)].join('\n');
}

function extractNotebook(raw: string): string {
  const nb = JSON.parse(raw) as {
    cells?: { cell_type: string; source: string | string[]; outputs?: { text?: string | string[]; data?: Record<string, string | string[]> }[] }[];
  };
  const join = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('') : v || '');
  return (nb.cells || [])
    .map((c, i) => {
      const head = `--- Hücre ${i + 1} (${c.cell_type === 'code' ? 'kod' : c.cell_type}) ---`;
      const outputs = (c.outputs || [])
        .map((o) => join(o.text) || join(o.data?.['text/plain']))
        .filter(Boolean)
        .join('\n');
      return `${head}\n${join(c.source)}${outputs ? `\n[Çıktı]\n${outputs}` : ''}`;
    })
    .join('\n\n');
}

/** Minimal RTF → text (good enough for reading notes/homework). */
export function rtfToText(rtf: string): string {
  let s = rtf.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, '');
  s = s.replace(/\\par[d]?\b ?/g, '\n').replace(/\\line\b ?/g, '\n').replace(/\\tab\b ?/g, '\t');
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
    const code = Number(n);
    return String.fromCharCode(code < 0 ? code + 65536 : code);
  });
  const cp1254: Record<number, string> = { 0xd0: 'Ğ', 0xf0: 'ğ', 0xdd: 'İ', 0xfd: 'ı', 0xde: 'Ş', 0xfe: 'ş' };
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => {
    const code = parseInt(h, 16);
    return cp1254[code] ?? String.fromCharCode(code);
  });
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '');
  return s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Heuristic text recovery for old binary formats (.doc, .ppt) and unknown files:
 * collects runs of readable UTF-16LE and single-byte text.
 */
export function extractPrintableStrings(buf: Buffer, minLen = 5): string {
  const isReadable = (c: number) =>
    (c >= 0x20 && c < 0x7f) || c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0xc0 && c <= 0x17f);

  const utf16: string[] = [];
  let run = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    if (isReadable(c)) run += String.fromCharCode(c);
    else {
      if (run.trim().length >= minLen) utf16.push(run);
      run = '';
    }
  }
  if (run.trim().length >= minLen) utf16.push(run);

  const single: string[] = [];
  run = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if ((c >= 0x20 && c < 0x7f) || c === 0x09 || c === 0x0a || c === 0x0d) run += String.fromCharCode(c);
    else {
      if (run.trim().length >= minLen) single.push(run);
      run = '';
    }
  }
  if (run.trim().length >= minLen) single.push(run);

  const pick = utf16.join('').length >= single.join('').length * 0.6 ? utf16 : single;
  return pick
    .map((s) => s.replace(/\r/g, '\n').trim())
    .filter((s) => /[a-zA-ZğüşıöçĞÜŞİÖÇ]{3,}/.test(s))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cap(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[... metin kısaltıldı ...]` : text;
}

/** Extracts readable text from a document. Returns null for formats with nothing to extract. */
export async function extractText(filePath: string, filename = filePath): Promise<ExtractedText | null> {
  const ext = extOf(filename);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SOURCE_BYTES) {
    return { text: `Dosya çok büyük (${Math.round(stat.size / 1024 / 1024)} MB); metni çıkarılmadı.`, kind: 'büyük dosya' };
  }
  const buf = await fs.readFile(filePath);

  try {
    switch (ext) {
      case 'docx':
      case 'docm':
      case 'dotx': {
        const res = await mammoth.extractRawText({ buffer: buf });
        return { text: cap(res.value.replace(/\n{3,}/g, '\n\n').trim()), kind: 'Word belgesi' };
      }
      case 'pptx':
      case 'pptm':
      case 'ppsx':
        return { text: cap(await extractPptx(buf)), kind: 'PowerPoint sunumu' };
      case 'xlsx':
      case 'xlsm':
      case 'xlsb':
      case 'xls':
      case 'ods':
        return { text: cap(extractSpreadsheet(buf)), kind: 'Excel / hesap tablosu' };
      case 'odt':
        return { text: cap(await extractOdf(buf)), kind: 'OpenDocument metni' };
      case 'odp':
        return { text: cap(await extractOdf(buf)), kind: 'OpenDocument sunumu' };
      case 'epub':
        return { text: cap(await extractEpub(buf)), kind: 'e-kitap' };
      case 'rtf':
        return { text: cap(rtfToText(buf.toString('latin1'))), kind: 'RTF belgesi' };
      case 'ipynb':
        return { text: cap(extractNotebook(buf.toString('utf-8'))), kind: 'Jupyter defteri' };
      case 'zip':
      case 'jar':
        return { text: cap(await extractZipListing(buf)), kind: 'arşiv' };
      case 'doc':
        return { text: cap(extractPrintableStrings(buf)), kind: 'eski Word belgesi (.doc)', approximate: true };
      case 'ppt':
        return { text: cap(extractPrintableStrings(buf)), kind: 'eski PowerPoint (.ppt)', approximate: true };
      default:
        return { text: cap(extractPrintableStrings(buf)), kind: 'ikili dosya', approximate: true };
    }
  } catch (err) {
    // Damaged/unsupported container: fall back to heuristic strings
    return {
      text: cap(extractPrintableStrings(buf)),
      kind: `okunamayan dosya (${err instanceof Error ? err.message : 'bilinmeyen hata'})`,
      approximate: true,
    };
  }
}

const emptyExtractionCache = new Map<string, number>();

/**
 * Writes extracted text to `<workspaceDir>/.extracted/<key>.txt`, reusing it while the
 * source is unchanged. Returns the workspace-relative path, or null if nothing was extracted.
 */
export async function ensureExtractedText(
  workspaceDir: string,
  key: string,
  sourcePath: string,
  filename = sourcePath,
): Promise<string | null> {
  const safeKey = key.replace(/[^a-zA-Z0-9._\-/]/g, '_').replace(/\.\.+/g, '_');
  const rel = path.posix.join('.extracted', `${safeKey}.txt`);
  const out = path.join(workspaceDir, ...rel.split('/'));
  let srcMtimeMs: number;
  try {
    const [src, dst] = await Promise.all([fs.stat(sourcePath), fs.stat(out).catch(() => null)]);
    srcMtimeMs = src.mtimeMs;
    if (dst && dst.mtimeMs >= srcMtimeMs) return rel;
    if (emptyExtractionCache.get(sourcePath) === srcMtimeMs) return null;
  } catch {
    return null;
  }
  const extracted = await extractText(sourcePath, filename);
  if (!extracted || !extracted.text.trim()) {
    emptyExtractionCache.set(sourcePath, srcMtimeMs);
    return null;
  }
  emptyExtractionCache.delete(sourcePath);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const header = `[${extracted.kind}${extracted.approximate ? ' — metin yaklaşık olarak kurtarıldı' : ''}] ${path.basename(filename)}\n\n`;
  await fs.writeFile(out, header + extracted.text, 'utf-8');
  return rel;
}
