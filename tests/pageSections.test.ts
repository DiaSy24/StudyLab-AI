import { describe, expect, it } from 'vitest';
import { findSectionForPage, parsePageHeading, splitPageSections } from '../src/lib/pageSections.js';

describe('pageSections', () => {
  it('splits single pages and keeps the preamble', () => {
    const md = `Giriş metni.

## Sayfa 1
Birinci sayfa.

## Sayfa 2 — Türev
İkinci sayfa.`;
    const { preamble, sections } = splitPageSections(md);
    expect(preamble).toBe('Giriş metni.');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ from: 1, to: 1 });
    expect(sections[0].markdown).toContain('Birinci sayfa.');
    expect(sections[1]).toMatchObject({ from: 2, to: 2 });
    expect(sections[1].markdown.startsWith('## Sayfa 2')).toBe(true);
  });

  it('parses ranges, slides and bold headings', () => {
    expect(parsePageHeading('## Sayfa 3-5: Özet')).toEqual({ from: 3, to: 5 });
    expect(parsePageHeading('### Slayt 7')).toEqual({ from: 7, to: 7 });
    expect(parsePageHeading('**Sayfa 4**')).toEqual({ from: 4, to: 4 });
    expect(parsePageHeading('## Sayfa 12–13')).toEqual({ from: 12, to: 13 });
    expect(parsePageHeading('Sayfa 3 hakkında')).toBeNull();
    expect(parsePageHeading('## Sayfa düzeni')).toBeNull();
  });

  it('returns whole text as preamble when there are no page headings', () => {
    const md = '## Başlık\nmetin';
    expect(splitPageSections(md)).toEqual({ preamble: md, sections: [] });
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = `## Sayfa 1
\`\`\`md
## Sayfa 9
\`\`\`
## Sayfa 2
son`;
    const { sections } = splitPageSections(md);
    expect(sections.map((s) => s.from)).toEqual([1, 2]);
    expect(sections[0].markdown).toContain('## Sayfa 9');
  });

  it('finds the section covering a page', () => {
    const { sections } = splitPageSections('## Sayfa 1\na\n## Sayfa 2-4\nb\n## Sayfa 6\nc');
    expect(findSectionForPage(sections, 3)?.from).toBe(2);
    expect(findSectionForPage(sections, 6)?.from).toBe(6);
    expect(findSectionForPage(sections, 5)).toBeUndefined();
  });
});
