import type { ChatMessage, LinkedTreeEntry, StudyResource } from '../types/study';
import { folderFileResource } from './fileKinds';
import { fileNameOf } from './resourceNavigation';

/**
 * Page-by-page explanation & source-matching helpers.
 *
 * The tutor precedes page-by-page explanations of a resource with a source
 * directive (`<!-- kaynak: path/or/name -->`) and opens every page (or range)
 * with a heading such as `## Sayfa 3`, `## Sayfa 3-4 — Başlık` or `## Slayt 5`.
 * These helpers split a markdown answer into sections and resolve each section's
 * resource so the chat panel can open and sync both the source and its page.
 */

export interface PageSection {
  /** First page covered by this section (1-based, physical page order). */
  from: number;
  /** Last page covered by this section (inclusive). Equal to `from` for single pages. */
  to: number;
  /** Optional source hint (resource id, path, or filename) associated with this section. */
  source?: string;
  /** Markdown of the section, including its heading line. */
  markdown: string;
}

export interface SplitPageSectionsResult {
  /** Markdown before the first page heading (intro text). */
  preamble: string;
  sections: PageSection[];
}

export interface ResolvedPageSource {
  /** Resource ID (`res.id` or `<folderId>::<innerPath>`). */
  id: string;
  /** Short human-readable filename (e.g. `Ders02.pdf`). */
  label: string;
  /** Navigable StudyResource (direct workspace resource or virtual folder file). */
  resource: StudyResource;
}

const PAGE_WORD = '(?:Sayfa|Sayfalar|Slayt|Slaytlar|Page|Pages|Slide|Slides)';

/** Classic heading: `## Sayfa 3`, `### Slayt 2-4: ...`, `**Sayfa 7**`. */
const PAGE_HEADING_PLAIN = new RegExp(
  `^\\s{0,3}(?:#{1,4}\\s*|\\*\\*\\s*)(?:📄\\s*)?${PAGE_WORD}\\s+(\\d{1,4})(?:\\s*[-–—]\\s*(\\d{1,4}))?(?!\\d)`,
  'i',
);

/** Bracketed source in heading: `## [Ders1.pdf] Sayfa 3 — Başlık` or `**[hafta1/slayt.pptx] Slayt 2**`. */
const PAGE_HEADING_BRACKET_SOURCE = new RegExp(
  `^\\s{0,3}(?:#{1,4}\\s*|\\*\\*\\s*)(?:📄\\s*)?\\[([^\\[\\]\\n]{1,240})\\]\\s*(?:[-–—•|:]\\s*)?(?:📄\\s*)?${PAGE_WORD}\\s+(\\d{1,4})(?:\\s*[-–—]\\s*(\\d{1,4}))?(?!\\d)`,
  'i',
);

/** Filename prefix in heading: `## Ders1.pdf — Sayfa 3: Konu` or ``## `hafta2/slayt.pptx` | Slayt 4``. */
const PAGE_HEADING_PREFIX_SOURCE = new RegExp(
  `^\\s{0,3}(?:#{1,4}\\s*|\\*\\*\\s*)(?:📄\\s*)?\`?([^\\n\`|•:\\[\\]]{1,240}\\.[a-z0-9]{2,6})\`?\\s*(?:[-–—•|:]\\s*)(?:📄\\s*)?${PAGE_WORD}\\s+(\\d{1,4})(?:\\s*[-–—]\\s*(\\d{1,4}))?(?!\\d)`,
  'i',
);

/** Invisible HTML comment directive: `<!-- kaynak: resources/123-ders.pdf -->`. */
const SOURCE_COMMENT_LINE = /^\s*<!--\s*(?:kaynak|study-source|source)\s*:\s*(.+?)\s*-->\s*$/i;

/** Standalone Markdown heading naming a document right above page headings, e.g. `## 📄 Hafta02.pdf`. */
const STANDALONE_FILE_HEADING =
  /^\s{0,3}#{1,4}\s+(?:📄\s*)?(?:Kaynak\s*:\s*)?`?([^\n`#*<>|]{1,240}\.(?:pdf|docx|docm|dotx|doc|odt|pptx|pptm|ppsx|ppt|odp|rtf|epub|xlsx|xlsm|xlsb|xls|ods|ipynb|md|txt))`?\s*$/i;

const PAGED_EXT_RE = /\.(pdf|docx|docm|dotx|pptx|pptm|ppsx)$/i;

export function cleanSourceHint(raw: string): string {
  return raw.trim().replace(/^[`"']+|[`"']+$/g, '').trim();
}

function buildRange(fromStr: string, toStr?: string, sourceRaw?: string): {
  from: number;
  to: number;
  source?: string;
} | null {
  const from = Number(fromStr);
  const toRaw = toStr ? Number(toStr) : from;
  if (!Number.isFinite(from) || from < 1) return null;
  const to = Number.isFinite(toRaw) && toRaw >= from ? toRaw : from;
  const cleanedSource = sourceRaw ? cleanSourceHint(sourceRaw) : '';
  return cleanedSource ? { from, to, source: cleanedSource } : { from, to };
}

export function parsePageHeading(
  line: string,
): { from: number; to: number; source?: string } | null {
  const plain = PAGE_HEADING_PLAIN.exec(line);
  if (plain) return buildRange(plain[1], plain[2]);

  const bracketed = PAGE_HEADING_BRACKET_SOURCE.exec(line);
  if (bracketed) return buildRange(bracketed[2], bracketed[3], bracketed[1]);

  const prefixed = PAGE_HEADING_PREFIX_SOURCE.exec(line);
  if (prefixed) return buildRange(prefixed[2], prefixed[3], prefixed[1]);

  return null;
}

export function splitPageSections(markdown: string): SplitPageSectionsResult {
  if (!markdown) return { preamble: '', sections: [] };

  const lines = markdown.split('\n');
  const preambleLines: string[] = [];
  const sections: PageSection[] = [];
  let current: { from: number; to: number; source?: string; lines: string[] } | null = null;
  let directiveSource: string | undefined;
  let headingFileSource: string | undefined;
  let inFence = false;

  const flush = () => {
    if (current) {
      const sec: PageSection = {
        from: current.from,
        to: current.to,
        markdown: current.lines.join('\n').replace(/\s+$/, ''),
      };
      if (current.source) sec.source = current.source;
      sections.push(sec);
      current = null;
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    if (!inFence) {
      const commentMatch = SOURCE_COMMENT_LINE.exec(line);
      if (commentMatch) {
        flush();
        const nextSource = cleanSourceHint(commentMatch[1]);
        if (nextSource) {
          directiveSource = nextSource;
          headingFileSource = undefined;
        }
        continue;
      }

      const heading = parsePageHeading(line);
      if (heading) {
        flush();
        if (heading.source) {
          headingFileSource = heading.source;
        }
        const effectiveSource = heading.source || directiveSource || headingFileSource;
        current = {
          from: heading.from,
          to: heading.to,
          ...(effectiveSource ? { source: effectiveSource } : {}),
          lines: [line],
        };
        continue;
      }

      const fileHeading = STANDALONE_FILE_HEADING.exec(line);
      if (fileHeading) {
        flush();
        const candidate = cleanSourceHint(fileHeading[1]);
        if (candidate) headingFileSource = candidate;
      }
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

/** True when `res` is a paged resource supported by Sayfa Senkron (PDF, Word, PowerPoint). */
export function isPagedResource(res: Pick<StudyResource, 'category' | 'name'>): boolean {
  if (res.category === 'pdf') return true;
  return PAGED_EXT_RE.test(res.name);
}

function normalizeSlashPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}

/** Case-insensitive string check supporting both ASCII and Turkish dotted/dotless I. */
function sameCi(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return a.toLocaleLowerCase('tr-TR') === b.toLocaleLowerCase('tr-TR');
}

function toResolved(resource: StudyResource): ResolvedPageSource {
  return {
    id: resource.id,
    label: resource.name,
    resource,
  };
}

function pickPreferredCandidate(candidates: StudyResource[]): StudyResource | null {
  if (candidates.length === 0) return null;
  return candidates.find((c) => isPagedResource(c)) ?? candidates[0];
}

function stripMulterPrefix(filename: string): string {
  return filename.replace(/^\d{10,}-/, '');
}

function stemOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Resolves a source hint (resource ID, virtual `<folderId>::<innerPath>`, workspace path,
 * `.extracted/...` path, absolute local path, folder-relative path, or bare filename)
 * against the workspace's resources and any loaded linked-folder trees.
 */
export function matchStudyResource(
  rawHint: string | undefined | null,
  resources: readonly StudyResource[],
  folderTrees?: Record<string, LinkedTreeEntry[]>,
): ResolvedPageSource | null {
  if (!rawHint || resources.length === 0) return null;
  let hint = cleanSourceHint(rawHint);
  if (!hint) return null;

  // Unwrap `.extracted/<key>.txt` hints if the model referenced the extracted text cache path
  const normInitial = normalizeSlashPath(hint);
  if (normInitial.startsWith('.extracted/') && normInitial.toLowerCase().endsWith('.txt')) {
    const inner = normInitial.slice('.extracted/'.length, -'.txt'.length);
    if (inner.startsWith('viewing/')) {
      hint = inner.slice('viewing/'.length);
    } else {
      const slashIdx = inner.indexOf('/');
      if (slashIdx > 0) {
        const maybeFolderId = inner.slice(0, slashIdx);
        const maybeRel = inner.slice(slashIdx + 1);
        const folder = resources.find((r) => r.id === maybeFolderId && r.category === 'folder');
        if (folder && maybeRel) {
          return toResolved(folderFileResource(folder, maybeRel));
        }
      }
      hint = inner;
    }
  }

  // 1. Virtual linked-folder file ID: `<folderId>::<innerPath>`
  const sepIdx = hint.indexOf('::');
  if (sepIdx > 0) {
    const folderId = hint.slice(0, sepIdx);
    const innerPath = normalizeSlashPath(hint.slice(sepIdx + 2));
    const folder = resources.find((r) => r.id === folderId && r.category === 'folder');
    if (folder && innerPath) {
      return toResolved(folderFileResource(folder, innerPath));
    }
  }

  // 2. Direct non-folder resource ID
  const byId = resources.find((r) => r.category !== 'folder' && r.id === hint);
  if (byId) return toResolved(byId);

  const normHint = normalizeSlashPath(hint);
  if (!normHint) return null;

  // 3. Exact relative / local / stored path match on direct resources
  for (const res of resources) {
    if (res.category === 'folder') continue;
    if (res.relativePath && sameCi(normalizeSlashPath(res.relativePath), normHint)) {
      return toResolved(res);
    }
    if (res.localPath && sameCi(normalizeSlashPath(res.localPath), normHint)) {
      return toResolved(res);
    }
    if (
      res.storedName &&
      (sameCi(res.storedName, normHint) ||
        sameCi(`resources/${res.storedName}`, normHint) ||
        normHint.toLowerCase().endsWith(`/resources/${res.storedName.toLowerCase()}`))
    ) {
      return toResolved(res);
    }
  }

  // 4. Full path inside a linked folder (`<folder.localPath>/<innerPath>`) — works even before folderTrees load
  const folders = resources.filter((r) => r.category === 'folder');
  for (const folder of folders) {
    const root = normalizeSlashPath(folder.localPath || folder.relativePath);
    if (!root) continue;
    if (
      normHint.length > root.length &&
      normHint.charAt(root.length) === '/' &&
      sameCi(normHint.slice(0, root.length), root)
    ) {
      const rawInner = normHint.slice(root.length + 1);
      const tree = folderTrees?.[folder.id];
      const canonical =
        tree?.find((e) => e.type === 'file' && sameCi(e.path, rawInner))?.path ?? rawInner;
      return toResolved(folderFileResource(folder, canonical));
    }
  }

  // 5. Relative path inside a linked folder (`hafta2/Ders2.pdf` or `KlasorAdi/hafta2/Ders2.pdf`)
  if (normHint.includes('/') && folderTrees) {
    const relMatches: StudyResource[] = [];
    for (const folder of folders) {
      const tree = folderTrees[folder.id];
      if (!tree) continue;
      let stripped = normHint;
      if (
        folder.name &&
        normHint.length > folder.name.length &&
        normHint.charAt(folder.name.length) === '/' &&
        sameCi(normHint.slice(0, folder.name.length), folder.name)
      ) {
        stripped = normHint.slice(folder.name.length + 1);
      }
      for (const entry of tree) {
        if (entry.type !== 'file') continue;
        if (
          sameCi(entry.path, stripped) ||
          sameCi(entry.path, normHint) ||
          sameCi(entry.path.slice(-normHint.length - 1), `/${normHint}`)
        ) {
          relMatches.push(folderFileResource(folder, entry.path));
        }
      }
    }
    const chosenRel = pickPreferredCandidate(relMatches);
    if (chosenRel) return toResolved(chosenRel);
  }

  // 6. Basename / filename match across direct resources and loaded folder trees
  const baseHint = fileNameOf(normHint);
  const strippedBase = stripMulterPrefix(baseHint);
  const nameMatches: StudyResource[] = [];

  for (const res of resources) {
    if (res.category === 'folder') continue;
    const resBase = fileNameOf(normalizeSlashPath(res.name));
    if (
      sameCi(resBase, baseHint) ||
      sameCi(resBase, strippedBase) ||
      (res.storedName &&
        (sameCi(res.storedName, baseHint) || sameCi(stripMulterPrefix(res.storedName), strippedBase)))
    ) {
      nameMatches.push(res);
    }
  }

  if (folderTrees) {
    for (const folder of folders) {
      const tree = folderTrees[folder.id];
      if (!tree) continue;
      for (const entry of tree) {
        if (entry.type !== 'file') continue;
        const entryBase = fileNameOf(entry.path);
        if (sameCi(entryBase, baseHint) || sameCi(entryBase, strippedBase)) {
          nameMatches.push(folderFileResource(folder, entry.path));
        }
      }
    }
  }

  const chosenByName = pickPreferredCandidate(nameMatches);
  if (chosenByName) return toResolved(chosenByName);

  // 7. Extensionless stem match against paged resources (e.g. `<!-- kaynak: Ders02 -->` -> `Ders02.pdf`)
  if (!baseHint.includes('.') && baseHint.length >= 2) {
    const stemMatches: StudyResource[] = [];
    for (const res of resources) {
      if (res.category !== 'folder' && isPagedResource(res) && sameCi(stemOf(res.name), baseHint)) {
        stemMatches.push(res);
      }
    }
    if (folderTrees) {
      for (const folder of folders) {
        for (const entry of folderTrees[folder.id] ?? []) {
          if (entry.type !== 'file') continue;
          const entryName = fileNameOf(entry.path);
          if (PAGED_EXT_RE.test(entryName) && sameCi(stemOf(entryName), baseHint)) {
            stemMatches.push(folderFileResource(folder, entry.path));
          }
        }
      }
    }
    if (stemMatches.length === 1) return toResolved(stemMatches[0]);
  }

  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks whether free-form text (such as a student's prompt) explicitly mentions one of
 * the workspace's files by path or filename (tolerating Turkish case suffixes like `'yi`).
 */
export function findMentionedResourceInText(
  text: string | undefined | null,
  resources: readonly StudyResource[],
  folderTrees?: Record<string, LinkedTreeEntry[]>,
): ResolvedPageSource | null {
  if (!text || resources.length === 0) return null;

  const candidates: StudyResource[] = [];
  for (const res of resources) {
    if (res.category !== 'folder') candidates.push(res);
  }
  if (folderTrees) {
    for (const res of resources) {
      if (res.category !== 'folder') continue;
      for (const entry of folderTrees[res.id] ?? []) {
        if (entry.type === 'file') {
          candidates.push(folderFileResource(res, entry.path));
        }
      }
    }
  }

  // Match longer/more specific names first (e.g. `Ders1_Ek.pdf` before `Ders1.pdf`)
  candidates.sort((a, b) => b.name.length - a.name.length);

  const matched: StudyResource[] = [];
  for (const cand of candidates) {
    const tokens = cand.innerPath && cand.innerPath !== cand.name ? [cand.innerPath, cand.name] : [cand.name];
    for (const tok of tokens) {
      if (tok.length < 3) continue;
      const re = new RegExp(
        `(?:^|[\\s"'\`(\\[/\\\\])${escapeRegExp(tok)}(?:['’]?[a-zA-ZğüşıöçĞÜŞİÖÇ]{0,5})?(?=$|[\\s"'\`)\\]:.,;?!])`,
        'i',
      );
      if (re.test(text)) {
        matched.push(cand);
        break;
      }
    }
  }

  const best = pickPreferredCandidate(matched);
  return best ? toResolved(best) : null;
}

/**
 * Infers the default source for an assistant message when individual page sections
 * do not carry an explicit `source` tag (or for messages saved before source tags existed).
 */
export function inferMessageSource(
  message: Pick<ChatMessage, 'sourceResourceId' | 'sourcePath'> | null | undefined,
  prevUserMessage:
    | Pick<ChatMessage, 'content' | 'sourceResourceId' | 'sourcePath' | 'attachedResourceIds'>
    | null
    | undefined,
  resources: readonly StudyResource[],
  folderTrees?: Record<string, LinkedTreeEntry[]>,
): ResolvedPageSource | null {
  if (resources.length === 0) return null;

  // 1. Explicit filename mentioned in the user's question (e.g. "Hafta2.pdf'yi sayfa sayfa anlat")
  const mentioned = findMentionedResourceInText(prevUserMessage?.content, resources, folderTrees);
  if (mentioned) return mentioned;

  // 2. Resource open in the viewer when the turn was sent
  const fromMsgId = matchStudyResource(message?.sourceResourceId, resources, folderTrees);
  if (fromMsgId) return fromMsgId;
  const fromMsgPath = matchStudyResource(message?.sourcePath, resources, folderTrees);
  if (fromMsgPath) return fromMsgPath;

  const fromUserId = matchStudyResource(prevUserMessage?.sourceResourceId, resources, folderTrees);
  if (fromUserId) return fromUserId;
  const fromUserPath = matchStudyResource(prevUserMessage?.sourcePath, resources, folderTrees);
  if (fromUserPath) return fromUserPath;

  // 3. Legacy fallback: if there is only a single paged resource in context/workspace, use it
  const attachedSet =
    prevUserMessage?.attachedResourceIds && prevUserMessage.attachedResourceIds.length > 0
      ? new Set(prevUserMessage.attachedResourceIds)
      : null;
  const pool = attachedSet ? resources.filter((r) => attachedSet.has(r.id)) : resources;

  const pagedPool: StudyResource[] = [];
  for (const r of pool) {
    if (r.category !== 'folder' && isPagedResource(r)) {
      pagedPool.push(r);
    } else if (r.category === 'folder' && folderTrees?.[r.id]) {
      for (const e of folderTrees[r.id]) {
        if (e.type === 'file' && PAGED_EXT_RE.test(e.path)) {
          pagedPool.push(folderFileResource(r, e.path));
        }
      }
    }
  }
  if (pagedPool.length === 1) {
    return toResolved(pagedPool[0]);
  }

  return null;
}
