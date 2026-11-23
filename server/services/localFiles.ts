import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { StudyResource } from '../../src/types/study.js';

/** Source-code / config extensions shown with syntax highlighting. */
const CODE_EXTENSIONS = new Set([
  'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'py', 'pyw', 'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx', 'mts', 'cts', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'cs', 'fs', 'vb',
  'go', 'rs', 'swift', 'm', 'mm', 'php', 'rb', 'pl', 'pm', 'lua', 'r', 'dart', 'sql', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue',
  'svelte', 'xml', 'xsd', 'xaml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'json', 'jsonc', 'csv', 'tsv', 'dockerfile', 'makefile', 'mk', 'cmake', 'asm', 's', 'v', 'sv',
  'vhd', 'vhdl', 'hs', 'ml', 'mli', 'ex', 'exs', 'erl', 'clj', 'cljs', 'f', 'f90', 'f95', 'jl',
  'nim', 'zig', 'sol', 'proto', 'graphql', 'gql', 'tf', 'hcl', 'lisp', 'el', 'scm', 'pas', 'ada',
  'cob', 'prolog', 'pro', 'matlab', 'sas', 'diff', 'patch', 'log', 'gitignore', 'editorconfig',
]);

const CODE_BASENAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile', 'vagrantfile']);

const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'tex', 'rst']);

/** Rich documents rendered by the document viewer (Office, OpenDocument, media, notebooks, archives). */
const DOCUMENT_EXTENSIONS = new Set([
  'docx', 'docm', 'dotx', 'doc', 'odt', 'rtf', 'epub',
  'pptx', 'pptm', 'ppsx', 'ppt', 'odp',
  'xlsx', 'xlsm', 'xlsb', 'xls', 'ods',
  'ipynb', 'zip', 'jar',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba',
  'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv',
]);

/** Directories skipped when listing a linked folder (build output, dependencies, VCS metadata). */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '__pycache__', '.gradle',
  'target', 'build', 'dist', 'out', '.next', '.nuxt', 'venv', '.venv', 'env', '.mypy_cache',
  '.pytest_cache', '.dart_tool', 'Pods', 'DerivedData', 'obj', '.cache', 'coverage',
]);

export const MAX_TREE_ENTRIES = 3000;
const MAX_TREE_DEPTH = 14;

function extOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

export function isCodeFilename(filename: string): boolean {
  const base = path.basename(filename).toLowerCase();
  return CODE_BASENAMES.has(base) || CODE_EXTENSIONS.has(extOf(base)) || (base.startsWith('.') && CODE_EXTENSIONS.has(base.slice(1)));
}

/** Heuristic: no NUL bytes and very few control characters in the first 8 KB. */
export function isProbablyText(sample: Buffer): boolean {
  const len = Math.min(sample.length, 8192);
  if (len === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / len < 0.05;
}

export async function readSample(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function detectResourceCategory(
  mimeType: string,
  filename: string,
  sample?: Buffer,
): StudyResource['category'] {
  const lower = filename.toLowerCase();
  const ext = extOf(lower);
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mimeType.startsWith('image/') || /^(png|jpe?g|webp|gif|bmp|svg)$/.test(ext)) return 'image';
  if (NOTE_EXTENSIONS.has(ext)) return 'note';
  if (DOCUMENT_EXTENSIONS.has(ext) || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 'document';
  }
  if (isCodeFilename(lower)) return 'code';
  if (mimeType.startsWith('text/')) return 'code';
  // Unknown extension: treat readable text as code/plain text so it can be viewed and read by AI
  if (sample && isProbablyText(sample)) return 'code';
  return 'other';
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Resolves `relative` inside `root`, refusing anything (incl. symlinks) that escapes it. */
export async function resolveInside(root: string, relative: string): Promise<string | null> {
  const target = path.resolve(root, relative);
  const rootNorm = normalizeForCompare(root);
  const isInside = (p: string) => {
    const n = normalizeForCompare(p);
    return n === rootNorm || n.startsWith(rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep);
  };
  if (!isInside(target)) return null;
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    const realRootNorm = normalizeForCompare(realRoot);
    const realTargetNorm = normalizeForCompare(realTarget);
    if (
      realTargetNorm !== realRootNorm &&
      !realTargetNorm.startsWith(realRootNorm.endsWith(path.sep) ? realRootNorm : realRootNorm + path.sep)
    ) {
      return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}

export interface TreeEntry {
  /** Path relative to the linked root, always with forward slashes. */
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

const STAT_CONCURRENCY = 32;
const DEFAULT_TREE_CACHE_TTL_MS = 30_000;

interface TreeCacheItem {
  result: { entries: TreeEntry[]; truncated: boolean };
  fetchedAt: number;
}

const treeCache = new Map<string, TreeCacheItem>();

export function invalidateTreeCache(root?: string): void {
  if (!root) {
    treeCache.clear();
    return;
  }
  treeCache.delete(normalizeForCompare(root));
}

/** Breadth-first listing of a linked folder (skips dependency/build dirs, capped). */
export async function listTree(root: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const entries: TreeEntry[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'tr', { numeric: true });
    });

    const pendingFiles: { childRel: string; fullPath: string; entry: TreeEntry }[] = [];

    for (const d of dirents) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        entries.push({ path: childRel, type: 'dir' });
        if (depth + 1 < MAX_TREE_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        const entry: TreeEntry = { path: childRel, type: 'file' };
        entries.push(entry);
        pendingFiles.push({ childRel, fullPath: path.join(abs, d.name), entry });
      }
    }

    // Stat files in parallel batches instead of one-by-one sequentially
    for (let i = 0; i < pendingFiles.length; i += STAT_CONCURRENCY) {
      const batch = pendingFiles.slice(i, i + STAT_CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          try {
            item.entry.size = (await fs.stat(item.fullPath)).size;
          } catch {
            // ignore unreadable files
          }
        }),
      );
    }

    if (truncated) break;
  }
  return { entries, truncated };
}

/** Cached wrapper around `listTree` to avoid rescanning huge linked folders on every chat message. */
export async function listTreeCached(
  root: string,
  ttlMs = DEFAULT_TREE_CACHE_TTL_MS,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const key = normalizeForCompare(root);
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.result;
  }
  const result = await listTree(root);
  treeCache.set(key, { result, fetchedAt: Date.now() });
  return result;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  roots: string[];
  home: string;
  entries: { name: string; path: string; type: 'dir' | 'file'; size?: number }[];
}

async function listRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (l) => {
      const root = `${l}:\\`;
      try {
        await fs.access(root);
        return root;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((r): r is string => r !== null);
}

/** Lists one directory of the local computer for the "link from computer" picker. */
export async function browseDirectory(requested?: string): Promise<BrowseResult> {
  const home = os.homedir();
  const dir = path.resolve(requested && requested.trim() ? requested.trim() : home);
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('Bu yol bir klasör değil.'), { status: 400 });
  }
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries: BrowseResult['entries'] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: full, type: 'dir' });
    } else if (d.isFile()) {
      let size: number | undefined;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        // ignore
      }
      entries.push({ name: d.name, path: full, type: 'file', size });
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' });
  });
  const parentDir = path.dirname(dir);
  return {
    path: dir,
    parent: parentDir === dir ? null : parentDir,
    roots: await listRoots(),
    home,
    entries,
  };
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Local-disk endpoints must only be reachable from this app running on localhost.
 * Blocks other websites (Origin check) and DNS-rebinding (Host check).
 */
export function requireLocalOrigin(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host ? hostnameOf(req.headers.host) : null;
  const origin = req.headers.origin;
  const originHost = origin ? hostnameOf(origin) : null;
  const hostOk = host !== null && LOCAL_HOSTNAMES.has(host);
  const originOk = !origin || (originHost !== null && LOCAL_HOSTNAMES.has(originHost));
  if (!hostOk || !originOk) {
    res.status(403).json({ error: 'Yerel dosya erişimi yalnızca bu bilgisayardaki uygulamadan yapılabilir.' });
    return;
  }
  next();
}
