import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { AgyStatus } from '../../types/study';

interface AgySetupModalProps {
  open: boolean;
  agyStatus: AgyStatus | null;
  onClose: () => void;
  onStatusChange: (status: AgyStatus) => void;
}

interface LogLine {
  id: number;
  text: string;
  stream: 'stdout' | 'stderr';
}

export const AgySetupModal: React.FC<AgySetupModalProps> = ({
  open,
  agyStatus,
  onClose,
  onStatusChange,
}) => {
  const [installing, setInstalling] = useState(false);
  const [installLogs, setInstallLogs] = useState<LogLine[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installInfo, setInstallInfo] = useState<string | null>(null);

  const [launchingLogin, setLaunchingLogin] = useState(false);
  const [waitingForLogin, setWaitingForLogin] = useState(false);
  const [loginFeedback, setLoginFeedback] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const installAbortRef = useRef<AbortController | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  const state = agyStatus?.state ?? (agyStatus?.available ? 'ready' : 'not_installed');
  const installed = agyStatus?.installed ?? Boolean(agyStatus?.available);
  const authenticated = agyStatus?.authenticated ?? Boolean(agyStatus?.available);
  const isReady = state === 'ready' && authenticated;

  const installCommand =
    agyStatus?.installCommand || 'irm https://antigravity.google/cli/install.ps1 | iex';
  const loginCommand = agyStatus?.loginCommand || 'agy';

  const refreshStatus = useCallback(
    async (silent = false) => {
      if (!silent) setChecking(true);
      try {
        const next = await api.getAgyStatus(true);
        onStatusChange(next);
        if (next.state === 'ready' && next.authenticated) {
          setWaitingForLogin(false);
          setLoginError(null);
        }
        return next;
      } catch {
        return null;
      } finally {
        if (!silent) setChecking(false);
      }
    },
    [onStatusChange],
  );

  // Stop polling or running install when modal closes/unmounts
  useEffect(() => {
    if (!open) {
      setWaitingForLogin(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !installing) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, installing, onClose]);

  useEffect(() => {
    return () => {
      installAbortRef.current?.abort();
    };
  }, []);

  // Auto-scroll live install log box
  useEffect(() => {
    const el = logContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [installLogs]);

  // Automatic polling while waiting for user to finish Google Sign-In in the external window
  useEffect(() => {
    if (!open || !waitingForLogin || isReady) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (!active) return;
      void refreshStatus(true);
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, waitingForLogin, isReady, refreshStatus]);

  if (!open) return null;

  const copyCommand = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // clipboard blocked — ignore
    }
  };

  const handleStartInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    setInstallInfo('Kurulum başlatılıyor...');
    setInstallLogs([]);

    installAbortRef.current?.abort();
    const controller = new AbortController();
    installAbortRef.current = controller;

    await api.installAgy(
      {
        onStatus: (msg) => setInstallInfo(msg),
        onLog: (line, stream) => {
          setInstallLogs((prev) => {
            const next = [...prev, { id: ++logIdRef.current, text: line, stream }];
            return next.length > 200 ? next.slice(-200) : next;
          });
        },
        onDone: (status) => {
          onStatusChange(status);
          setInstalling(false);
          setInstallInfo(
            status.installed
              ? `Antigravity CLI (v${status.version || '?'}) başarıyla kuruldu!`
              : 'Kurulum tamamlandı; durum kontrol ediliyor...',
          );
        },
        onError: (err, status) => {
          if (status) onStatusChange(status);
          setInstalling(false);
          setInstallError(err);
          setInstallInfo(null);
        },
      },
      controller.signal,
    );
  };

  const handleLaunchLogin = async () => {
    if (launchingLogin) return;
    setLaunchingLogin(true);
    setLoginError(null);
    try {
      const res = await api.launchAgyLogin();
      setLoginFeedback(res.message);
      setWaitingForLogin(true);
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : 'Giriş penceresi açılamadı.',
      );
    } finally {
      setLaunchingLogin(false);
    }
  };

  const statusBadge = isReady
    ? {
        cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
        label: `Bağlı • agy v${agyStatus?.version || '?'} • ${agyStatus?.models.length || 0} model`,
      }
    : state === 'auth_required'
      ? {
          cls: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
          label: `Kurulu (v${agyStatus?.version || '?'}) • Google Girişi Bekleniyor`,
        }
      : state === 'error'
        ? {
            cls: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
            label: 'Bağlantı Hatası',
          }
        : {
            cls: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
            label: 'Antigravity CLI (agy) Kurulu Değil',
          };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !installing) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Antigravity (agy) Kurulum ve Giriş Sihirbazı"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl shadow-black/70"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 bg-slate-950/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/30 to-emerald-500/20 text-indigo-300 ring-1 ring-indigo-500/40">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-white">
                Antigravity (agy) Kurulum &amp; Giriş Sihirbazı
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                StudyLab AI, ücretsiz veya Pro/Ultra Google hesabınızla çalışan Antigravity CLI
                üzerinden Gemini modellerine bağlanır.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusBadge.cls}`}
                >
                  {isReady ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  {statusBadge.label}
                </span>
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void refreshStatus(false)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-slate-300 transition hover:border-indigo-500 hover:text-white disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
                  Durumu Yenile
                </button>
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={installing}
            onClick={onClose}
            title="Kapat (Esc)"
            aria-label="Kapat"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Ready Success Card */}
          {isReady && (
            <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-bold text-emerald-200">
                    Her Şey Hazır! Gemini Ders Öğretmeni Bağlı
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-100/80">
                    Antigravity CLI (v{agyStatus?.version}) ve{' '}
                    <strong>{agyStatus?.models.length} Gemini modeli</strong> kullanıma hazır.
                    Hemen ders çalışma sohbetine başlayabilirsin.
                  </p>
                  {agyStatus?.binaryPath && (
                    <p className="mt-2 truncate font-mono text-[10px] text-slate-400">
                      Konum: {agyStatus.binaryPath}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-500"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Çalışmaya Başla
                    </button>
                    <button
                      type="button"
                      disabled={launchingLogin}
                      onClick={() => void handleLaunchLogin()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-indigo-500 hover:text-white disabled:opacity-50"
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      Hesap Değiştir / Terminalde Aç
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] text-slate-400">
                    Farklı bir Google hesabına geçmek için açılan terminalde{' '}
                    <code className="rounded bg-slate-950 px-1 py-0.5 text-slate-200">/logout</code>{' '}
                    yazıp ardından tekrar giriş yapabilirsin.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error Banner for connectivity/other issues */}
          {state === 'error' && agyStatus?.error && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <p className="font-semibold">{agyStatus.error}</p>
              {agyStatus.authError && (
                <p className="mt-1 font-mono text-[10px] text-rose-300/80">
                  {agyStatus.authError}
                </p>
              )}
            </div>
          )}

          {/* STEP 1: Install agy CLI */}
          <div
            className={`rounded-2xl border p-4 transition ${
              installed
                ? 'border-emerald-500/30 bg-slate-950/50'
                : 'border-indigo-500/50 bg-slate-950/90 ring-1 ring-indigo-500/20'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    installed
                      ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                      : 'bg-indigo-600 text-white'
                  }`}
                >
                  {installed ? <Check className="h-4 w-4" /> : '1'}
                </span>
                <div>
                  <h3 className="text-xs font-bold text-white">
                    Adım 1: Antigravity CLI (agy) Kurulumu
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {installed
                      ? `Kurulu (v${agyStatus?.version || '?'}). ${agyStatus?.binaryPath ? `(${agyStatus.binaryPath})` : ''}`
                      : 'Tek tıkla resmi Google Antigravity CLI aracını kurun — kurulum sonrası sunucuyu yeniden başlatmanıza gerek kalmaz.'}
                  </p>
                </div>
              </div>
              {installed && (
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Tamamlandı
                </span>
              )}
            </div>

            {!installed && (
              <div className="mt-3 space-y-3 pl-10">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={installing}
                    onClick={() => void handleStartInstall()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500 disabled:opacity-60"
                  >
                    {installing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {installing ? 'Kuruluyor...' : 'Otomatik Kur (Tek Tıkla)'}
                  </button>

                  <button
                    type="button"
                    disabled={checking || installing}
                    onClick={() => void refreshStatus(false)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-indigo-500 hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
                    Zaten Kurdum, Kontrol Et
                  </button>
                </div>

                {installInfo && (
                  <p className="text-[11px] text-indigo-300">{installInfo}</p>
                )}

                {installError && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                    {installError}
                  </div>
                )}

                {installLogs.length > 0 && (
                  <div
                    ref={logContainerRef}
                    className="max-h-36 overflow-y-auto rounded-xl border border-slate-800 bg-black/70 p-2.5 font-mono text-[10px] leading-relaxed"
                  >
                    {installLogs.map((entry) => (
                      <div
                        key={entry.id}
                        className={
                          entry.stream === 'stderr' ? 'text-amber-300' : 'text-slate-300'
                        }
                      >
                        {entry.text}
                      </div>
                    ))}
                  </div>
                )}

                {/* Manual fallback command */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-slate-400">
                      İsterseniz manuel kurulum komutu (PowerShell / Terminal):
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyCommand('install', installCommand)}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-200 transition hover:bg-slate-700"
                    >
                      {copiedKey === 'install' ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          Kopyalandı
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Kopyala
                        </>
                      )}
                    </button>
                  </div>
                  <code className="mt-1.5 block overflow-x-auto rounded-lg bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-indigo-200">
                    {installCommand}
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* STEP 2: Google Account Login */}
          <div
            className={`rounded-2xl border p-4 transition ${
              authenticated
                ? 'border-emerald-500/30 bg-slate-950/50'
                : installed
                  ? 'border-amber-500/50 bg-slate-950/90 ring-1 ring-amber-500/20'
                  : 'border-slate-800 bg-slate-950/35 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    authenticated
                      ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                      : installed
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {authenticated ? <Check className="h-4 w-4" /> : '2'}
                </span>
                <div>
                  <h3 className="text-xs font-bold text-white">
                    Adım 2: Google Hesabı ile Giriş
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {authenticated
                      ? 'Google oturumunuz aktif. Kimlik bilgileri işletim sisteminizin güvenli kasasında saklanır.'
                      : 'Antigravity giriş penceresini açıp tarayıcınızdan Google hesabınızla onay verin.'}
                  </p>
                </div>
              </div>
              {authenticated && (
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Giriş Yapıldı
                </span>
              )}
            </div>

            {installed && !authenticated && (
              <div className="mt-3 space-y-3 pl-10">
                <ol className="space-y-1 text-[11px] leading-relaxed text-slate-300">
                  <li>
                    <strong className="text-white">1.</strong> Aşağıdaki{' '}
                    <span className="text-amber-300 font-semibold">Giriş Penceresini Aç</span>{' '}
                    butonuna tıklayın.
                  </li>
                  <li>
                    <strong className="text-white">2.</strong> Açılan terminalde Google hesabı
                    seçeneğini onaylayın; varsayılan tarayıcınızda Google giriş ekranı açılacaktır.
                  </li>
                  <li>
                    <strong className="text-white">3.</strong> Tarayıcıda girişi tamamladığınızda
                    StudyLab bunu <strong>otomatik algılar</strong> ve kullanıma hazır hale gelir.
                  </li>
                </ol>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={launchingLogin}
                    onClick={() => void handleLaunchLogin()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-400 disabled:opacity-60"
                  >
                    {launchingLogin ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LogIn className="h-3.5 w-3.5" />
                    )}
                    Giriş Penceresini Aç
                  </button>

                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => void refreshStatus(false)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-amber-500 hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
                    Şimdi Kontrol Et
                  </button>
                </div>

                {waitingForLogin && (
                  <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
                    <span>
                      {loginFeedback ||
                        'Giriş bekleniyor... Tarayıcıda onayladığınızda otomatik algılanacak.'}
                    </span>
                  </div>
                )}

                {loginError && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                    {loginError}
                  </div>
                )}

                {agyStatus?.authError && (
                  <details className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-[10px] text-slate-400">
                    <summary className="cursor-pointer font-medium text-slate-300">
                      Teknik detay (agy çıktısı)
                    </summary>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-slate-400">
                      {agyStatus.authError}
                    </pre>
                  </details>
                )}

                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-slate-400">
                      Manuel giriş için herhangi bir terminalde çalıştırın:
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyCommand('login', loginCommand)}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-200 transition hover:bg-slate-700"
                    >
                      {copiedKey === 'login' ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          Kopyalandı
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Kopyala
                        </>
                      )}
                    </button>
                  </div>
                  <code className="mt-1.5 block rounded-lg bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-amber-200">
                    {loginCommand}
                  </code>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/60 px-5 py-3">
          <a
            href="https://antigravity.google/docs/getting-started"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-indigo-300"
          >
            <ExternalLink className="h-3 w-3" />
            Antigravity Resmi Dokümantasyonu
          </a>

          <button
            type="button"
            disabled={installing}
            onClick={onClose}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-40"
          >
            {isReady ? 'Kapat' : 'Şimdilik Atla'}
          </button>
        </div>
      </div>
    </div>
  );
};
