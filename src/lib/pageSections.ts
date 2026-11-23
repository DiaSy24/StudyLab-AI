/**
 * Page-by-page explanation helpers.
 *
 * The tutor is instructed to open every page (or page range) of a
 * page-by-page explanation with a heading such as `## Sayfa 3`,
 * `## Sayfa 3-4 — Başlık` or `## Slayt 5`. These helpers split a markdown
 * answer into those sections so the chat panel can sync them with the viewer.
 */

export interface PageSection {
  /** First page covered by this section (1-based, physical page order). */
  from: number;
  /** Last page covered by this section (inclusive). Equal to `from` for single pages. */
  to: number;
  /** Markdown of the section, including its heading line. */
  markdown: string;
}

export interface SplitPageSectionsResult {
  /** Markdown before the first page heading (intro text). */
  preamble: string;
  sections: PageSection[];
}

/**
 * Matches heading lines like `## Sayfa 3`, `### Slayt 2-4: ...`, `**Sayfa 7**`.
 * Group 1 = from, group 2 = optional to.
 */
const PAGE_HEADING_LINE =
  /^\s{0,3}(?:#{1,4}\s*|\*\*\s*)(?:📄\s*)?(?:Sayfa|Sayfalar|Slayt|Slaytlar|Page|Pages|Slide|Slides)\s+(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?(?!\d)/i;

export function parsePageHeading(line: string): { from: number; to: number } | null {
  const match = PAGE_HEADING_LINE.exec(line);
  if (!match) return null;
  const from = Number(match[1]);
  const toRaw = match[2] ? Number(match[2]) : from;
  if (!Number.isFinite(from) || from < 1) return null;
  const to = Number.isFinite(toRaw) && toRaw >= from ? toRaw : from;
  return { from, to };
}

export function splitPageSections(markdown: string): SplitPageSectionsResult {
  if (!markdown) return { preamble: '', sections: [] };

  const lines = markdown.split('\n');
  const preambleLines: string[] = [];
  const sections: PageSection[] = [];
  let current: { from: number; to: number; lines: string[] } | null = null;
  let inFence = false;

  const flush = () => {
    if (current) {
      sections.push({
        from: current.from,
        to: current.to,
        markdown: current.lines.join('\n').replace(/\s+$/, ''),
      });
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : parsePageHeading(line);
    if (heading) {
      flush();
      current = { ...heading, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  flush();

  return {
    preamble: sections.length ? preambleLines.join('\n').trim() : markdown,
    sections,
  };
}

export function findSectionForPage<T extends { from: number; to: number }>(
  sections: readonly T[],
  page: number,
): T | undefined {
  return sections.find((s) => s.from <= page && page <= s.to);
}
