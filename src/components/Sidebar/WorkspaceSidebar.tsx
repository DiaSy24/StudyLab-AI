import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownUp,
  Atom,
  BookOpen,
  Box,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  FileImage,
  Folder,
  FileText,
  FlaskConical,
  FolderPlus,
  GripVertical,
  HelpCircle,
  Layers,
  Plus,
  Sigma,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Link2,
  X,
} from 'lucide-react';
import type { LinkedTreeEntry, StudyArtifact, StudyResource, Workspace } from '../../types/study';
import { LocalFilePicker } from './LocalFilePicker';
import { SidebarFolderTree } from './SidebarFolderTree';

interface WorkspaceSidebarProps {
  width?: number;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  resources: StudyResource[];
  artifacts: StudyArtifact[];
  selectedResourceIds: Set<string>;
  activeArtifactId: string | null;
  activeResourceId: string | null;
  /** Relative path of the file open inside the active linked folder (if any). */
  activeFolderPath: string | null;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: (input: { title: string; subject: string; color: string; icon: string }) => Promise<void>;
  onDeleteWorkspace: (id: string) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<void>;
  onToggleResourceContext: (resourceId: string) => void;
  onOpenResource: (resource: StudyResource) => void;
  onOpenFolderFile: (folder: StudyResource, relativePath: string) => void;
  onFolderTreeLoaded?: (folderId: string, entries: LinkedTreeEntry[]) => void;
  onDeleteResource: (resourceId: string) => Promise<void>;
  onLinkLocal: (absolutePath: string) => Promise<void>;
  onReorderResources: (orderedIds: string[]) => void;
  onOpenArtifact: (artifact: StudyArtifact) => void;
}

const RESOURCE_DRAG_TYPE = 'application/x-studylab-resource';

type ResourceSortKey = 'name-asc' | 'name-desc' | 'newest' | 'oldest';

const SORT_OPTIONS: { id: ResourceSortKey; label: string }[] = [
  { id: 'name-asc', label: 'Ada göre (A → Z)' },
  { id: 'name-desc', label: 'Ada göre (Z → A)' },
  { id: 'newest', label: 'Yeni yüklenen üstte' },
  { id: 'oldest', label: 'Eski yüklenen üstte' },
];

function sortResources(list: StudyResource[], key: ResourceSortKey): StudyResource[] {
  const copy = [...list];
  const byName = (a: StudyResource, b: StudyResource) =>
    a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' });
  const byDate = (a: StudyResource, b: StudyResource) =>
    new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
  switch (key) {
    case 'name-asc':
      return copy.sort(byName);
    case 'name-desc':
      return copy.sort((a, b) => byName(b, a));
    case 'newest':
      return copy.sort((a, b) => byDate(b, a));
    case 'oldest':
      return copy.sort(byDate);
  }
}

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
const ICONS = [
  { id: 'atom', label: 'Fizik', Icon: Atom },
  { id: 'sigma', label: 'Matematik', Icon: Sigma },
  { id: 'flask', label: 'Kimya', Icon: FlaskConical },
  { id: 'code', label: 'Yazılım', Icon: Code2 },
  { id: 'book', label: 'Genel', Icon: BookOpen },
];

function WorkspaceIcon({ icon, className }: { icon: string; className?: string }) {
  const found = ICONS.find((item) => item.id === icon);
  const Comp = found ? found.Icon : BookOpen;
  return <Comp className={className} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  width = 288,
  workspaces,
  activeWorkspace,
  resources,
  artifacts,
  selectedResourceIds,
  activeArtifactId,
  activeResourceId,
  activeFolderPath,
  onSelectWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onUploadFiles,
  onToggleResourceContext,
  onOpenResource,
  onOpenFolderFile,
  onFolderTreeLoaded,
  onDeleteResource,
  onReorderResources,
  onLinkLocal,
  onOpenArtifact,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [icon, setIcon] = useState('atom');
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem('studylab.sidebarOpenFolders');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.sidebarOpenFolders', JSON.stringify([...openFolders]));
    } catch {
      // ignore storage errors
    }
  }, [openFolders]);

  const toggleFolder = (id: string) =>
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [draggingResourceId, setDraggingResourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [sortMenuOpen]);

  const applySort = (key: ResourceSortKey) => {
    setSortMenuOpen(false);
    onReorderResources(sortResources(resources, key).map((r) => r.id));
  };

  const handleResourceDrop = (targetId: string, after: boolean) => {
    const sourceId = draggingResourceId;
    setDraggingResourceId(null);
    setDropTarget(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = resources.map((r) => r.id).filter((id) => id !== sourceId);
    const targetIdx = ids.indexOf(targetId);
    if (targetIdx < 0) return;
    ids.splice(after ? targetIdx + 1 : targetIdx, 0, sourceId);
    const unchanged = ids.every((id, i) => resources[i]?.id === id);
    if (!unchanged) onReorderResources(ids);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateWorkspace({
        title: title.trim(),
        subject: subject.trim() || 'Genel Ders',
        color,
        icon,
      });
      setTitle('');
      setSubject('');
      setModalOpen(false);
    } finally {
      setCreating(false);
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      await onUploadFiles(Array.from(fileList));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col overflow-hidden bg-slate-950/95"
    >
      {/* App Header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 shadow-lg shadow-indigo-500/20">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-slate-100">StudyLab AI</h1>
            <p className="text-[11px] text-slate-400">Etkileşimli Ders Stüdyosu</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          title="Yeni Çalışma Alanı Oluştur"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900 text-slate-200 transition hover:border-indigo-500 hover:bg-indigo-500/20 hover:text-indigo-200"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>

      {/* Workspaces List */}
      <div className="border-b border-slate-800/80 p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Çalışma Alanları ({workspaces.length})
          </span>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
          >
            <Plus className="h-3 w-3" /> Yeni
          </button>
        </div>

        <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspace?.id;
            return (
              <div
                key={ws.id}
                className={`group flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                  active
                    ? 'bg-indigo-500/18 text-white ring-1 ring-indigo-500/40'
                    : 'text-slate-300 hover:bg-slate-900/90'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectWorkspace(ws.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
                    style={{ backgroundColor: ws.color }}
                  >
                    <WorkspaceIcon icon={ws.icon} className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold">{ws.title}</p>
                    <p className="truncate text-[10px] text-slate-400">{ws.subject}</p>
                  </div>
                </button>
                {workspaces.length > 1 && (
                  <button
                    type="button"
                    title="Çalışma Alanını Sil"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`"${ws.title}" çalışma alanını silmek istiyor musun?`)) {
                        void onDeleteWorkspace(ws.id);
                      }
                    }}
                    className="hidden rounded-md p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable Resources & Artifacts */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {/* Resources Section */}
        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Kaynaklar ({resources.length})
            </span>
            <div className="flex items-center gap-1">
              {resources.length > 1 && (
                <div ref={sortMenuRef} className="relative">
                  <button
                    type="button"
                    title="Sırala (veya tutamaçtan sürükleyerek elle sırala)"
                    aria-label="Kaynakları sırala"
                    onClick={() => setSortMenuOpen((o) => !o)}
                    className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                      sortMenuOpen
                        ? 'bg-indigo-500/25 text-indigo-200'
                        : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <ArrowDownUp className="h-3 w-3" />
                  </button>
                  {sortMenuOpen && (
                    <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl">
                      {SORT_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => applySort(opt.id)}
                          className="block w-full px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-indigo-500/20"
                        >
                          {opt.label}
                        </button>
                      ))}
                      <p className="border-t border-slate-800 px-3 pt-1.5 pb-1 text-[10px] text-slate-500">
                        İpucu: satırları tutamaçtan sürükleyerek elle de sıralayabilirsin.
                      </p>
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 rounded-md bg-slate-800/80 px-2 py-0.5 text-[11px] font-medium text-cyan-300 hover:bg-slate-800"
              >
                <Upload className="h-3 w-3" /> Yükle
              </button>
              <button
                type="button"
                title="Bilgisayarındaki bir dosyayı veya klasörü kopyalamadan bağla"
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-1 rounded-md bg-slate-800/80 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-slate-800"
              >
                <Link2 className="h-3 w-3" /> Bağla
              </button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />

          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) return;
              e.preventDefault();
              setDragOver(false);
              void handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`mb-2.5 cursor-pointer rounded-xl border border-dashed px-3 py-2.5 text-center transition ${
              dragOver
                ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200'
                : 'border-slate-700/90 bg-slate-900/50 text-slate-400 hover:border-slate-600 hover:text-slate-300'
            }`}
          >
            <p className="text-[11px] font-medium">
              {uploading ? 'Yükleniyor...' : 'PDF, fotoğraf, not veya kod dosyası sürükle'}
            </p>
            <p className="text-[10px] text-slate-500">Her tür dosya (.java, .py, .cpp…) • Seçililer Gemini bağlamına eklenir</p>
          </div>

          <div className="space-y-1">
            {resources.map((res) => {
              const checked = selectedResourceIds.has(res.id);
              const isOpen = activeResourceId === res.id;
              const isDragging = draggingResourceId === res.id;
              const dropBefore = dropTarget?.id === res.id && !dropTarget.after;
              const dropAfter = dropTarget?.id === res.id && dropTarget.after;
              const isFolder = res.category === 'folder';
              const folderOpen = isFolder && openFolders.has(res.id);
              return (
                <div key={res.id}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(RESOURCE_DRAG_TYPE, res.id);
                    setDraggingResourceId(res.id);
                  }}
                  onDragEnd={() => {
                    setDraggingResourceId(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggingResourceId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > rect.top + rect.height / 2;
                    if (dropTarget?.id !== res.id || dropTarget.after !== after) {
                      setDropTarget({ id: res.id, after });
                    }
                  }}
                  onDrop={(e) => {
                    if (!draggingResourceId) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleResourceDrop(res.id, e.clientY > rect.top + rect.height / 2);
                  }}
                  className={`group relative flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 transition ${
                    isOpen
                      ? 'bg-cyan-500/15 ring-1 ring-cyan-500/40'
                      : 'hover:bg-slate-900/80'
                  } ${isDragging ? 'opacity-40' : ''}`}
                >
                  {dropBefore && (
                    <span className="pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full bg-indigo-400" />
                  )}
                  {dropAfter && (
                    <span className="pointer-events-none absolute right-1 -bottom-0.5 left-1 h-0.5 rounded-full bg-indigo-400" />
                  )}
                  <span
                    title="Sürükleyerek sırala"
                    className="shrink-0 cursor-grab text-slate-600 hover:text-slate-300 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                  <button
                    type="button"
                    title={checked ? 'AI bağlamından çıkar' : 'AI bağlamına ekle'}
                    onClick={() => onToggleResourceContext(res.id)}
                    className="shrink-0 text-slate-400 hover:text-indigo-300"
                  >
                    {checked ? (
                      <CheckSquare className="h-4 w-4 text-indigo-400" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    title={isFolder ? (folderOpen ? 'Klasörü daralt' : 'Klasörü genişlet') : undefined}
                    onClick={() => (isFolder ? toggleFolder(res.id) : onOpenResource(res))}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isFolder &&
                      (folderOpen ? (
                        <ChevronDown className="-mr-1 h-3 w-3 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="-mr-1 h-3 w-3 shrink-0 text-slate-400" />
                      ))}
                    {res.category === 'image' ? (
                      <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : res.category === 'folder' ? (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                    ) : res.category === 'code' ? (
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                    ) : res.category === 'document' || res.category === 'other' ? (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-slate-200" title={res.localPath || res.name}>
                        {res.name}
                      </p>
                      <p className="flex items-center gap-1 text-[10px] text-slate-500">
                        {res.source === 'local' && (
                          <span
                            title={`Bilgisayardan bağlı: ${res.localPath}`}
                            className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-amber-300"
                          >
                            <Link2 className="h-2.5 w-2.5" /> bağlı
                          </span>
                        )}
                        <span className="truncate">
                          {res.category === 'folder' ? 'Klasör' : formatSize(res.size)}
                        </span>
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    title={res.source === 'local' ? 'Bağlantıyı kaldır (bilgisayardaki dosyaya dokunulmaz)' : 'Kaynağı sil'}
                    onClick={() => void onDeleteResource(res.id)}
                    className="hidden rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {folderOpen && (
                  <SidebarFolderTree
                    resource={res}
                    activePath={isOpen ? activeFolderPath : null}
                    onOpenFile={(rel) => onOpenFolderFile(res, rel)}
                    onEntriesLoaded={onFolderTreeLoaded}
                  />
                )}
                </div>
              );
            })}
            {resources.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-slate-500">
                Henüz kaynak yüklenmedi.
              </p>
            )}
          </div>
        </section>

        {/* Artifacts Section */}
        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Üretilen Materyaller ({artifacts.length})
            </span>
          </div>
          <div className="space-y-1">
            {artifacts.map((art) => {
              const active = art.id === activeArtifactId;
              const Icon =
                art.type === '3d-scene'
                  ? Box
                  : art.type === 'formula-lab'
                    ? Sigma
                    : art.type === 'quiz'
                      ? HelpCircle
                      : Layers;
              const badgeColor =
                art.type === '3d-scene'
                  ? 'text-cyan-400'
                  : art.type === 'formula-lab'
                    ? 'text-pink-400'
                    : art.type === 'quiz'
                      ? 'text-amber-400'
                      : 'text-indigo-400';

              return (
                <button
                  key={art.id}
                  type="button"
                  onClick={() => onOpenArtifact(art)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                    active
                      ? 'bg-indigo-500/20 text-white ring-1 ring-indigo-500/40'
                      : 'text-slate-300 hover:bg-slate-900/80'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${badgeColor}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{art.title}</p>
                    <p className="text-[10px] text-slate-500">
                      {art.type === '3d-scene'
                        ? '3D Model'
                        : art.type === 'formula-lab'
                          ? 'Formül Lab'
                          : art.type === 'quiz'
                            ? 'Alıştırma'
                            : '2D Görsel'}{' '}
                      • v{art.version}
                    </p>
                  </div>
                </button>
              );
            })}
            {artifacts.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-slate-500">
                AI ile sohbet ettikçe 2D/3D modeller ve testler burada birikir.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Create Workspace Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-white">Yeni Çalışma Alanı</h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Çalışma Alanı Adı
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Örn: Kalkülüs II — Çok Değişkenli İntegraller"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Ders / Konu Etiketi
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Örn: Matematik, Fizik, Organik Kimya..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Renk</label>
                  <div className="flex flex-wrap gap-2">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className={`h-7 w-7 rounded-full transition ${
                          color === c ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">İkon</label>
                  <div className="flex flex-wrap gap-1.5">
                    {ICONS.map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        title={label}
                        onClick={() => setIcon(id)}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                          icon === id
                            ? 'border-indigo-400 bg-indigo-500/20 text-white'
                            : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-white'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  disabled={creating || !title.trim()}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {creating ? 'Oluşturuluyor...' : 'Oluştur'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {pickerOpen && (
        <LocalFilePicker onClose={() => setPickerOpen(false)} onLink={onLinkLocal} />
      )}
    </aside>
  );
};
