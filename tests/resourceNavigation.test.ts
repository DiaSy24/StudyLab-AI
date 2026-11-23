import { describe, expect, it } from 'vitest';
import {
  fileNameOf,
  getNavigableWorkspaceResources,
  getSameDirFiles,
  parentDirOf,
  shouldIgnoreNavKeyEvent,
} from '../src/lib/resourceNavigation.js';
import type { LinkedTreeEntry, StudyResource } from '../src/types/study.js';

function makeResource(overrides: Partial<StudyResource>): StudyResource {
  return {
    id: overrides.id ?? 'res-1',
    workspaceId: 'ws-1',
    name: overrides.name ?? 'file.png',
    storedName: overrides.storedName ?? 'file.png',
    mimeType: overrides.mimeType ?? 'image/png',
    size: overrides.size ?? 100,
    category: overrides.category ?? 'image',
    url: overrides.url ?? '/api/workspaces/ws-1/resources/file.png',
    relativePath: overrides.relativePath ?? 'resources/file.png',
    uploadedAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('resourceNavigation helpers', () => {
  it('extracts parentDirOf and fileNameOf for root and nested paths', () => {
    expect(parentDirOf('foto1.jpg')).toBe('');
    expect(fileNameOf('foto1.jpg')).toBe('foto1.jpg');

    expect(parentDirOf('hafta1/foto2.png')).toBe('hafta1');
    expect(fileNameOf('hafta1/foto2.png')).toBe('foto2.png');

    expect(parentDirOf('a/b/c/Main.java')).toBe('a/b/c');
    expect(fileNameOf('a/b/c/Main.java')).toBe('Main.java');
  });

  it('returns only files in the exact same directory across mixed extensions', () => {
    const entries: LinkedTreeEntry[] = [
      { path: 'alt', type: 'dir' },
      { path: '01_foto.jpg', type: 'file', size: 10 },
      { path: '02_not.md', type: 'file', size: 20 },
      { path: '03_kod.java', type: 'file', size: 30 },
      { path: '04_slayt.pdf', type: 'file', size: 40 },
      { path: 'alt/ic_foto.png', type: 'file', size: 50 },
      { path: 'alt/derin', type: 'dir' },
      { path: 'alt/rapor.docx', type: 'file', size: 60 },
      { path: 'alt/derin/gizli.txt', type: 'file', size: 70 },
    ];

    const rootSiblings = getSameDirFiles(entries, '01_foto.jpg').map((e) => e.path);
    expect(rootSiblings).toEqual([
      '01_foto.jpg',
      '02_not.md',
      '03_kod.java',
      '04_slayt.pdf',
    ]);

    const subSiblings = getSameDirFiles(entries, 'alt/ic_foto.png').map((e) => e.path);
    expect(subSiblings).toEqual(['alt/ic_foto.png', 'alt/rapor.docx']);

    const deepSiblings = getSameDirFiles(entries, 'alt/derin/gizli.txt').map((e) => e.path);
    expect(deepSiblings).toEqual(['alt/derin/gizli.txt']);
  });

  it('filters out folder entries from workspace resources while preserving sidebar order', () => {
    const list: StudyResource[] = [
      makeResource({ id: 'r1', name: 'foto2.jpg', category: 'image' }),
      makeResource({ id: 'r-folder', name: 'DersKlasoru', category: 'folder' }),
      makeResource({ id: 'r2', name: 'Main.java', category: 'code' }),
      makeResource({ id: 'r3', name: 'Ders.pdf', category: 'pdf' }),
      makeResource({ id: 'r4', name: 'ozet.md', category: 'note' }),
      makeResource({ id: 'r5', name: 'rapor.docx', category: 'document' }),
    ];

    expect(getNavigableWorkspaceResources(list).map((r) => r.id)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);
  });

  it('ignores keyboard navigation when modifiers, inputs, media, or modals are active', () => {
    const base = {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: null,
    };

    expect(shouldIgnoreNavKeyEvent(base)).toBe(false);
    expect(shouldIgnoreNavKeyEvent({ ...base, ctrlKey: true })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, metaKey: true })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, altKey: true })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, shiftKey: true })).toBe(true);
    expect(shouldIgnoreNavKeyEvent(base, true)).toBe(true);

    const makeTarget = (tagName: string, matched = false, isContentEditable = false) =>
      ({
        tagName,
        isContentEditable,
        closest: () => (matched ? {} : null),
      }) as unknown as EventTarget;

    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('INPUT', true) })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('TEXTAREA', true) })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('SELECT', true) })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('AUDIO', true) })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('VIDEO', true) })).toBe(true);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('DIV', false, true) })).toBe(true);

    // Clicking a toolbar button and then pressing arrow keys should still navigate
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('BUTTON', false) })).toBe(false);
    expect(shouldIgnoreNavKeyEvent({ ...base, target: makeTarget('BODY', false) })).toBe(false);
  });
});
