import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { DesktopUpdateStatus } from '../../types/desktop';

export const UpdateBanner: React.FC = () => {
  const [status, setStatus] = useState<DesktopUpdateStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const desktop = window.studyLabDesktop;
    if (!desktop) return;
    const unsubscribe = desktop.onUpdateStatus((next) => {
      if (next.state === 'error' && next.silent) {
        return;
      }
      setStatus(next);
      if (next.state === 'available' || next.state === 'downloaded' || next.state === 'error') {
        setDismissed(false);
      }
      if (next.state === 'not-available') {
        setDismissed(false);
        window.setTimeout(() => {
          setStatus((cur) => (cur.state === 'not-available' ? { state: 'idle' } : cur));
        }, 4000);
      }
    });
    return unsubscribe;
  }, []);

  if (dismissed || status.state === 'idle' || status.state === 'checking') {
    return null;
  }

  if (status.state === 'not-available') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-xs text-emerald-100">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
          <span>StudyLab AI güncel (v{status.version}).</span>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 text-emerald-200/70 hover:bg-emerald-500/20 hover:text-emerald-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (status.state === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-100">
        <span className="truncate">Güncelleme kontrol edilemedi: {status.message}</span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 text-rose-200/70 hover:bg-rose-500/20 hover:text-rose-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (status.state === 'available' || status.state === 'downloading') {
    const percent = status.state === 'downloading' ? status.percent : 0;
    return (
      <div className="flex items-center justify-between gap-3 border-b border-indigo-500/30 bg-indigo-500/15 px-4 py-1.5 text-xs text-indigo-100">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-300" />
          <span className="font-medium">
            Yeni StudyLab AI sürümü {status.version ? `(v${status.version}) ` : ''}indiriliyor...
          </span>
          {status.state === 'downloading' ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-indigo-400 transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="text-[11px] text-indigo-200">%{percent}</span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 text-indigo-200/70 hover:bg-indigo-500/20 hover:text-indigo-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // status.state === 'downloaded'
  return (
    <div className="flex items-center justify-between gap-3 border-b border-emerald-500/40 bg-gradient-to-r from-indigo-600/25 via-emerald-600/20 to-cyan-600/20 px-4 py-2 text-xs text-white">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald-300" />
        <span className="font-semibold">
          StudyLab AI v{status.version} indirildi ve kuruluma hazır!
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void window.studyLabDesktop?.installUpdate()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-slate-950 shadow transition hover:bg-emerald-400"
        >
          <RefreshCw className="h-3 w-3" />
          Yeniden Başlat ve Güncelle
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          title="Sonra (uygulama kapanınca otomatik kurulur)"
          className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export const DesktopVersionButton: React.FC = () => {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const desktop = window.studyLabDesktop;
    if (!desktop) return;
    void desktop.getAppInfo().then((info) => setVersion(info.version));
  }, []);

  if (!version) return null;

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await window.studyLabDesktop?.checkForUpdates();
    } finally {
      setChecking(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCheck()}
      title="Güncellemeleri kontrol et"
      className="inline-flex items-center gap-1 rounded-md border border-slate-700/80 bg-slate-900 px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:border-indigo-500/60 hover:text-white"
    >
      {checking ? (
        <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
      ) : (
        <Download className="h-3 w-3 text-indigo-400" />
      )}
      v{version}
    </button>
  );
};
