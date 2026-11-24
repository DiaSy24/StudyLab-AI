import { describe, expect, it } from 'vitest';
import {
  findMentionedResourceInText,
  findSectionForPage,
  inferMessageSource,
  matchStudyResource,
  parsePageHeading,
  splitPageSections,
} from '../src/lib/pageSections.js';
import type { ChatMessage, LinkedTreeEntry, StudyResource } from '../src/types/study.js';

function makeResource(overrides: Partial<StudyResource>): StudyResource {
  return {
    id: overrides.id ?? 'res-1',
    workspaceId: 'ws-1',
    name: overrides.name ?? 'Ders1.pdf',
    storedName: overrides.storedName ?? '1763900000000-Ders1.pdf',
    mimeType: overrides.mimeType ?? 'application/pdf',
    size: overrides.size ?? 1024,
    category: overrides.category ?? 'pdf',
    url: overrides.url ?? '/api/workspaces/ws-1/resources/1763900000000-Ders1.pdf',
    relativePath: overrides.relativePath ?? 'resources/1763900000000-Ders1.pdf',
    uploadedAt: '2026-11-24T09:00:00.000Z',
    ...overrides,
  };
}

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

  it('parses ranges, slides, bold headings and inline source headings', () => {
    expect(parsePageHeading('## Sayfa 3-5: Özet')).toEqual({ from: 3, to: 5 });
    expect(parsePageHeading('### Slayt 7')).toEqual({ from: 7, to: 7 });
    expect(parsePageHeading('**Sayfa 4**')).toEqual({ from: 4, to: 4 });
    expect(parsePageHeading('## Sayfa 12–13')).toEqual({ from: 12, to: 13 });
    expect(parsePageHeading('## [Ders2.pdf] Sayfa 3 — Limit')).toEqual({
      from: 3,
      to: 3,
      source: 'Ders2.pdf',
    });
    expect(parsePageHeading('## hafta1/slayt.pptx — Slayt 2-4')).toEqual({
      from: 2,
      to: 4,
      source: 'hafta1/slayt.pptx',
    });
    expect(parsePageHeading('Sayfa 3 hakkında')).toBeNull();
    expect(parsePageHeading('## Sayfa düzeni')).toBeNull();
  });

  it('extracts and strips <!-- kaynak: ... --> directives across single and multiple sources', () => {
    const md = `Kısa giriş.
<!-- kaynak: resources/1763900000000-Ders1.pdf -->
## Sayfa 1
Ders 1 sayfa 1.

## Sayfa 2
Ders 1 sayfa 2.

<!-- kaynak: hafta2/Ders2.pptx -->
## Slayt 1
Ders 2 slayt 1.`;

    const { preamble, sections } = splitPageSections(md);
    expect(preamble).toBe('Kısa giriş.');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({
      from: 1,
      to: 1,
      source: 'resources/1763900000000-Ders1.pdf',
    });
    expect(sections[0].markdown).not.toContain('<!--');
    expect(sections[1]).toMatchObject({
      from: 2,
      to: 2,
      source: 'resources/1763900000000-Ders1.pdf',
    });
    expect(sections[1].markdown).not.toContain('<!--');
    expect(sections[2]).toMatchObject({
      from: 1,
      to: 1,
      source: 'hafta2/Ders2.pptx',
    });
  });

  it('detects standalone file headings above page sections when no comment directive is used', () => {
    const md = `# 📄 Hafta03_Turev.pdf
## Sayfa 1
Tanım.`;
    const { sections } = splitPageSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].source).toBe('Hafta03_Turev.pdf');
  });

  it('returns whole text as preamble when there are no page headings', () => {
    const md = '## Başlık\nmetin';
    expect(splitPageSections(md)).toEqual({ preamble: md, sections: [] });
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = `## Sayfa 1
\`\`\`md
<!-- kaynak: sahte.pdf -->
## Sayfa 9
\`\`\`
## Sayfa 2
son`;
    const { sections } = splitPageSections(md);
    expect(sections.map((s) => s.from)).toEqual([1, 2]);
    expect(sections[0].markdown).toContain('## Sayfa 9');
    expect(sections[1].source).toBeUndefined();
  });

  it('finds the section covering a page', () => {
    const { sections } = splitPageSections('## Sayfa 1\na\n## Sayfa 2-4\nb\n## Sayfa 6\nc');
    expect(findSectionForPage(sections, 3)?.from).toBe(2);
    expect(findSectionForPage(sections, 6)?.from).toBe(6);
    expect(findSectionForPage(sections, 5)).toBeUndefined();
  });

  it('matches uploaded, local, linked-folder and .extracted resource hints accurately', () => {
    const resources: StudyResource[] = [
      makeResource({
        id: 'r-pdf1',
        name: 'Analiz_01.pdf',
        storedName: '1763900001-Analiz_01.pdf',
        relativePath: 'resources/1763900001-Analiz_01.pdf',
      }),
      makeResource({
        id: 'r-local',
        name: 'Notlar.docx',
        storedName: '',
        category: 'document',
        source: 'local',
        localPath: 'D:\\Dersler\\Notlar.docx',
        relativePath: 'D:\\Dersler\\Notlar.docx',
      }),
      makeResource({
        id: 'r-folder',
        name: 'Slaytlar',
        storedName: '',
        category: 'folder',
        source: 'local',
        localPath: 'D:\\Dersler\\Slaytlar',
        relativePath: 'D:\\Dersler\\Slaytlar',
      }),
    ];
    const folderTrees: Record<string, LinkedTreeEntry[]> = {
      'r-folder': [
        { path: 'hafta1/01_giris.pptx', type: 'file', size: 100 },
        { path: 'hafta2/02_limit.pdf', type: 'file', size: 200 },
      ],
    };

    // Uploaded file by relativePath and bare filename
    expect(matchStudyResource('resources/1763900001-Analiz_01.pdf', resources)?.id).toBe('r-pdf1');
    expect(matchStudyResource('analiz_01.pdf', resources)?.id).toBe('r-pdf1');

    // Local linked file by Windows path & .extracted cache path
    expect(matchStudyResource('D:\\Dersler\\Notlar.docx', resources)?.id).toBe('r-local');
    expect(matchStudyResource('.extracted/r-local.txt', resources)?.id).toBe('r-local');

    // Linked folder file by full path EVEN WITHOUT folderTrees loaded
    const withoutTrees = matchStudyResource('D:\\Dersler\\Slaytlar\\hafta2\\02_limit.pdf', resources);
    expect(withoutTrees?.id).toBe('r-folder::hafta2/02_limit.pdf');
    expect(withoutTrees?.label).toBe('02_limit.pdf');
    expect(withoutTrees?.resource.folderId).toBe('r-folder');
    expect(withoutTrees?.resource.innerPath).toBe('hafta2/02_limit.pdf');

    // Linked folder file by relative path, virtual ID, and filename with folderTrees
    expect(matchStudyResource('hafta1/01_giris.pptx', resources, folderTrees)?.id).toBe(
      'r-folder::hafta1/01_giris.pptx',
    );
    expect(matchStudyResource('r-folder::hafta2/02_limit.pdf', resources, folderTrees)?.id).toBe(
      'r-folder::hafta2/02_limit.pdf',
    );
    expect(matchStudyResource('01_giris.pptx', resources, folderTrees)?.id).toBe(
      'r-folder::hafta1/01_giris.pptx',
    );
    expect(matchStudyResource('.extracted/r-folder/hafta1/01_giris.pptx.txt', resources, folderTrees)?.id).toBe(
      'r-folder::hafta1/01_giris.pptx',
    );
  });

  it('infers message source from user prompt mentions (with Turkish suffixes) and viewer metadata', () => {
    const resources: StudyResource[] = [
      makeResource({ id: 'r1', name: 'Hafta1.pdf', storedName: '1-Hafta1.pdf', relativePath: 'resources/1-Hafta1.pdf' }),
      makeResource({ id: 'r2', name: 'Hafta2.pdf', storedName: '2-Hafta2.pdf', relativePath: 'resources/2-Hafta2.pdf' }),
    ];

    expect(findMentionedResourceInText("Hafta2.pdf'yi sayfa sayfa anlat", resources)?.id).toBe('r2');

    // Explicit mention in user prompt wins even when r1 was open in the viewer
    const userMentioningR2: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: "Hafta2.pdf'yi sayfa sayfa açıkla",
      createdAt: '2026-11-24T09:00:00.000Z',
      sourceResourceId: 'r1',
    };
    const assistantReply: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '## Sayfa 1\nAçıklama',
      createdAt: '2026-11-24T09:00:05.000Z',
      sourceResourceId: 'r1',
    };
    expect(inferMessageSource(assistantReply, userMentioningR2, resources)?.id).toBe('r2');

    // Generic "bu kaynağı anlat" falls back to the open viewer resource (sourceResourceId)
    const userGeneric: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: 'Bu kaynağı şu an baktığım sayfadan itibaren sayfa sayfa anlat.',
      createdAt: '2026-11-24T09:01:00.000Z',
      sourceResourceId: 'r1',
    };
    expect(inferMessageSource(assistantReply, userGeneric, resources)?.id).toBe('r1');
  });
});
