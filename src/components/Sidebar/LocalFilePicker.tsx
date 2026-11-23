import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowUp,
  File,
  FileCode2,
  Folder,
  FolderCheck,
  HardDrive,
  Home,
  Link2,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { LocalBrowseResult } from '../../types/study';

interface LocalFilePickerProps {
  onClose: () => void;
  /** Links the chosen absolute path; resolves when done. */
  onLink: (absolutePath: string) => Promise<void>;
}

const LAST_DIR_KEY = 'studylab.localPicker.lastDir';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const LocalFilePicker: React.FC<LocalFilePickerProps> = ({ onClose, onLink }) => {
  const [listing, setListing] = useState<LocalBrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (dir?: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseLocal(dir);
      setListing(res);
      setPathInput(res.path);
      setSelectedFile(null);
      try {
        window.localStorage.setItem(LAST_DIR_KEY, res.path);
      } catch {
        // ignore storage errors
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let last: string | undefined;
    try {
      last = window.localStorage.getItem(LAST_DIR_KEY) || undefined;
    } catch {
      last = undefined;
    }
    // If the remembered folder no longer exists, fall back to the home folder
    void open(last).then((ok) => {
      if (!ok && last) void open(undefined);
    });
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const link = async (target: string) => {
    setLinking(true);
    setError(null);
    try {
      await onLink(target);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  };

  const typedPathDiffers = listing && pathInput.trim() && pathInput.trim() !== listing.path;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bilgisayardan dosya veya klasör bağla"
        className="flex h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-bold text-white">Bilgisayardan Bağla</h3>
              <p className="text-[10px] text-slate-400">
                Dosya kopyalanmaz; AI ve görüntüleyici doğrudan bilgisayarındaki güncel halini okur.
              </p>
            </div>
          </div>
          <button
            type="button"
            title="Kapat (Esc)"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Path bar */}
        <div className="space-y-2 border-b border-slate-800 px-4 py-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pathInput.trim()) void open(pathInput.trim());
            }}
            className="flex items-center gap-1.5"
          >
            <button
              type="button"
              title="Üst klasör"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void open(listing.parent)}
              className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Kullanıcı klasörü"
              onClick={() => listing && void open(listing.home)}
              className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="Klasör yolu yaz veya yapıştır, Enter'a bas (ör. D:\Projeler\Odev1)"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
            >
              Git
            </button>
          </form>
          {listing && listing.roots.length > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              {listing.roots.map((root) => (
                <button
                  key={root}
                  type="button"
                  onClick={() => void open(root)}
                  className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium ${
                    listing.path.toLowerCase().startsWith(root.toLowerCase())
                      ? 'bg-indigo-500/25 text-indigo-200'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <HardDrive className="h-3 w-3" /> {root.replace(/\\$/, '')}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Listing */}
        <div className="relative min-h-0 flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/60">
              <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
            </div>
          )}
          {error && (
            <div className="mb-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}
          {listing?.entries.length === 0 && !loading && (
            <p className="px-2 py-6 text-center text-xs text-slate-500">Bu klasör boş.</p>
          )}
          {listing?.entries.map((entry) => {
            const isSelected = selectedFile === entry.path;
            const isHidden = entry.name.startsWith('.');
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => {
                  if (entry.type === 'dir') void open(entry.path);
                  else setSelectedFile(entry.path);
                }}
                onDoubleClick={() => {
                  if (entry.type === 'file') void link(entry.path);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
                  isSelected
                    ? 'bg-cyan-500/20 ring-1 ring-cyan-500/50'
                    : 'hover:bg-slate-800/80'
                } ${isHidden ? 'opacity-60' : ''}`}
              >
                {entry.type === 'dir' ? (
                  <Folder className="h-4 w-4 shrink-0 text-amber-400" />
                ) : /\.[a-z0-9]+$/i.test(entry.name) && !/\.(pdf|png|jpe?g|gif|webp|md|txt)$/i.test(entry.name) ? (
                  <FileCode2 className="h-4 w-4 shrink-0 text-cyan-400" />
                ) : (
                  <File className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{entry.name}</span>
                {entry.type === 'file' && (
                  <span className="shrink-0 text-[10px] text-slate-500">{formatSize(entry.size)}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-slate-900/95 px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-[10px] text-slate-500">
            {selectedFile
              ? `Seçili dosya: ${selectedFile}`
              : 'Bir klasöre tıkla içine gir; dosyaya tıkla seç (çift tık: hemen bağla).'}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!listing || linking || Boolean(typedPathDiffers)}
              title={typedPathDiffers ? 'Önce yazdığın yola gitmek için Enter’a bas' : undefined}
              onClick={() => listing && void link(listing.path)}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
            >
              <FolderCheck className="h-3.5 w-3.5" /> Bu klasörün tamamını bağla
            </button>
            <button
              type="button"
              disabled={!selectedFile || linking}
              onClick={() => selectedFile && void link(selectedFile)}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              {linking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Seçili dosyayı bağla
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
