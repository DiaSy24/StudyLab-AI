import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { api } from '../../lib/api';
import { categoryForFilename } from '../../lib/fileKinds';
import type { LinkedTreeEntry, StudyResource } from '../../types/study';

interface SidebarFolderTreeProps {
  resource: StudyResource;
  /** Relative path of the file currently open in the viewer (if it belongs to this folder). */
  activePath: string | null;
  onOpenFile: (relativePath: string) => void;
  /** Called whenever this folder's file tree is loaded or refreshed. */
  onEntriesLoaded?: (folderId: string, entries: LinkedTreeEntry[]) => void;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children: TreeNode[];
}

function buildTree(entries: LinkedTreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const node: TreeNode = { name: e.path.slice(slash + 1), path: e.path, type: e.type, children: [] };
    byPath.set(e.path, node);
    (byPath.get(slash >= 0 ? e.path.slice(0, slash) : '') || root).children.push(node);
  }
  return root.children;
}

function FileIcon({ name }: { name: string }) {
  const kind = categoryForFilename(name);
  if (kind === 'pdf') return <FileText className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
  if (kind === 'image') return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (kind === 'note') return <File className="h-3.5 w-3.5 shrink-0 text-slate-300" />;
  if (kind === 'document') {
    const lower = name.toLowerCase();
    if (/\.(xlsx|xlsm|xlsb|xls|ods)$/.test(lower)) return <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
    if (/\.(pptx|pptm|ppsx|ppt|odp)$/.test(lower)) return <FileText className="h-3.5 w-3.5 shrink-0 text-orange-400" />;
    if (/\.(mp4|webm|ogv|mov|m4v|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/.test(lower))
      return <FileVideo className="h-3.5 w-3.5 shrink-0 text-fuchsia-400" />;
    return <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" />;
  }
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-cyan-400" />;
}

function expandedKey(resourceId: string): string {
  return `studylab.folderTree.${resourceId}`;
}

/** Collapsible file tree of a linked folder, shown under it in the left menu. */
export const SidebarFolderTree: React.FC<SidebarFolderTreeProps> = ({
  resource,
  activePath,
  onOpenFile,
  onEntriesLoaded,
}) => {
  const [entries, setEntries] = useState<LinkedTreeEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const onEntriesLoadedRef = useRef(onEntriesLoaded);
  onEntriesLoadedRef.current = onEntriesLoaded;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(expandedKey(resource.id));
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(expandedKey(resource.id), JSON.stringify([...expanded]));
    } catch {
      // ignore storage errors
    }
  }, [resource.id, expanded]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getLinkedTree(resource);
      setEntries(res.entries);
      setTruncated(res.truncated);
      onEntriesLoadedRef.current?.(resource.id, res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [resource]);

  useEffect(() => {
    void load();
  }, [load]);

  // Make sure the folders leading to the open file are expanded
  useEffect(() => {
    if (!activePath) return;
    const parts = activePath.split('/');
    if (parts.length < 2) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath]);

  const tree = useMemo(() => buildTree(entries || []), [entries]);
  const fileCount = useMemo(() => (entries || []).filter((e) => e.type === 'file').length, [entries]);
  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
  const matches = useMemo(
    () =>
      normalizedQuery
        ? (entries || []).filter(
            (e) => e.type === 'file' && e.path.toLocaleLowerCase('tr-TR').includes(normalizedQuery),
          )
        : [],
    [entries, normalizedQuery],
  );

  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const rowClass = (isActive: boolean) =>
    `flex w-full items-center gap-1.5 rounded-md py-[3px] pr-1.5 text-left text-[11px] transition ${
      isActive ? 'bg-cyan-500/20 text-white ring-1 ring-cyan-500/40' : 'text-slate-300 hover:bg-slate-800/70'
    }`;

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            type="button"
            title={node.path}
            onClick={() => (node.type === 'dir' ? toggle(node.path) : onOpenFile(node.path))}
            style={{ paddingLeft: 4 + depth * 11 }}
            className={rowClass(node.type === 'file' && node.path === activePath)}
          >
            {node.type === 'dir' ? (
              <>
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-slate-500" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-slate-500" />
                )}
                {isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                )}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon name={node.name} />
              </>
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {node.type === 'dir' && isOpen && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div className="mt-0.5 mb-1 ml-5 border-l border-slate-800 pl-1.5">
      <div className="mb-1 flex items-center gap-1">
        {fileCount > 8 && (
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-1.5 py-0.5">
            <Search className="h-3 w-3 shrink-0 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`${fileCount} dosyada ara...`}
              className="min-w-0 flex-1 bg-transparent text-[10px] text-white placeholder-slate-500 focus:outline-none"
            />
          </div>
        )}
        {fileCount <= 8 && <span className="flex-1 text-[10px] text-slate-500">{entries ? `${fileCount} dosya` : ''}</span>}
        <button
          type="button"
          title="Klasörü yeniden oku"
          onClick={() => void load()}
          className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-white"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
      </div>

      {error && <p className="px-1 py-0.5 text-[10px] text-rose-300">{error}</p>}
      {entries === null && !error && <p className="px-1 py-0.5 text-[10px] text-slate-500">Okunuyor...</p>}

      {normalizedQuery ? (
        <>
          {matches.map((e) => (
            <button
              key={e.path}
              type="button"
              title={e.path}
              onClick={() => onOpenFile(e.path)}
              className={`${rowClass(e.path === activePath)} pl-1`}
            >
              <FileIcon name={e.path} />
              <span className="truncate">{e.path}</span>
            </button>
          ))}
          {matches.length === 0 && <p className="px-1 py-0.5 text-[10px] text-slate-500">Eşleşen dosya yok.</p>}
        </>
      ) : (
        renderNodes(tree, 0)
      )}
      {truncated && <p className="px-1 pt-0.5 text-[10px] text-slate-500">Liste çok uzun, kısaltıldı.</p>}
    </div>
  );
};
