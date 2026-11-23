import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  Cpu,
  History,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  RefreshCw,
  Search,
  Send,
  Square,
  Trash2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { renderStudyMarkdown } from '../../lib/markdown';
import type {
  AgyStatus,
  ChatMessage,
  ChatSession,
  StudyArtifact,
  Workspace,
} from '../../types/study';
import { useAutoResizeTextarea } from './useAutoResizeTextarea';
import { ChatMessageItem, useElapsedSeconds } from './ChatMessageItem';

interface QuickChatPopoverProps {
  open: boolean;
  workspace: Workspace | null;
  agyStatus: AgyStatus | null;
  selectedQuickModel?: string;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeTurnSessionIds: string[];
  messages: ChatMessage[];
  artifacts: StudyArtifact[];
  streamingText: string;
  statusText: string | null;
  isBusy: boolean;
  errorBanner: string | null;
  onClose: () => void;
  onSendMessage: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onChangeQuickModel: (model: string) => void;
  onResetSession: () => Promise<void>;
  onCreateSession: () => Promise<void>;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onOpenArtifact: (artifact: StudyArtifact) => void;
  onRefreshAgy: () => void;
  onOpenAgySetup: () => void;
}

function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export const QuickChatPopover: React.FC<QuickChatPopoverProps> = ({
  open,
  workspace,
  agyStatus,
  selectedQuickModel,
  sessions,
  activeSessionId,
  activeTurnSessionIds,
  messages,
  artifacts,
  streamingText,
  statusText,
  isBusy,
  errorBanner,
  onClose,
  onSendMessage,
  onAbort,
  onChangeQuickModel,
  onResetSession,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onOpenArtifact,
  onRefreshAgy,
  onOpenAgySetup,
}) => {
  const [input, setInput] = useState('');
  const textareaRef = useAutoResizeTextarea(input, 160);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0] || null;
  const activeTurnSet = new Set(activeTurnSessionIds);
  const elapsedSeconds = useElapsedSeconds(isBusy);
  const streamingHtml = useMemo(
    () => (streamingText ? renderStudyMarkdown(streamingText) : ''),
    [streamingText],
  );
  const linkedArtifactsByMsgId = useMemo(() => {
    const artifactMap = new Map(artifacts.map((a) => [a.id, a]));
    const byMsg = new Map<string, StudyArtifact[]>();
    for (const msg of messages) {
      if (msg.artifactIds && msg.artifactIds.length > 0) {
        const linked = msg.artifactIds
          .map((id) => artifactMap.get(id))
          .filter(Boolean) as StudyArtifact[];
        if (linked.length > 0) byMsg.set(msg.id, linked);
      }
    }
    return byMsg;
  }, [artifacts, messages]);
  const emptyArtifacts = useMemo<StudyArtifact[]>(() => [], []);

  const scrollToBottom = (smooth = false) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };

  const handleFeedScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= 56;
    autoScrollRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  };

  // Scroll to bottom when opening popover, switching workspaces, or changing quick session
  useEffect(() => {
    if (!open) return;
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    const raf = window.requestAnimationFrame(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, workspace?.id, activeSessionId]);

  // Follow streaming output if user hasn't scrolled up
  useEffect(() => {
    if (!open || !autoScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages, streamingText, statusText]);

  // Close history subview or popover with Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (historyOpen) {
        setHistoryOpen(false);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, historyOpen, onClose]);

  if (!open) return null;

  const normalizedQuery = historyQuery.trim().toLocaleLowerCase('tr-TR');
  const filteredSessions = normalizedQuery
    ? sessions.filter((s) => s.title.toLocaleLowerCase('tr-TR').includes(normalizedQuery))
    : sessions;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isBusy || !workspace) return;
    const text = input.trim();
    setInput('');
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    await onSendMessage(text);
  };

  return (
    <aside
      role="dialog"
      aria-label="Hızlı Chat"
      className={`absolute top-3 right-3 z-40 flex flex-col overflow-hidden rounded-2xl border border-amber-500/40 bg-slate-950/95 shadow-2xl shadow-black/70 backdrop-blur-md transition-[width,height] duration-150 ${
        expanded
          ? 'h-[min(86%,calc(100%-1.5rem))] w-[min(680px,calc(100%-1.5rem))]'
          : 'h-[min(640px,calc(100%-1.5rem))] w-[min(440px,calc(100%-1.5rem))]'
      }`}
    >
      {/* Header */}
      <div className="space-y-2 border-b border-slate-800/90 bg-slate-900/85 px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/35">
              <Zap className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-xs font-bold text-white">Hızlı Chat</h2>
                {isBusy && (
                  <span className="flex items-center gap-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Yanıtlıyor
                  </span>
                )}
              </div>
              <p
                className="truncate text-[10px] text-slate-400"
                title={activeSession?.title || 'Hızlı Sohbet'}
              >
                {activeSession?.title || 'Hızlı Sohbet'}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setHistoryQuery('');
                setHistoryOpen((v) => !v);
              }}
              title="Önceki hızlı sohbetler"
              aria-label="Önceki hızlı sohbetler"
              className={`relative rounded-lg border p-1.5 transition ${
                historyOpen
                  ? 'border-amber-500/60 bg-amber-500/20 text-amber-200'
                  : 'border-slate-700/80 bg-slate-900 text-slate-300 hover:border-amber-500/60 hover:text-white'
              }`}
            >
              <History className="h-3.5 w-3.5" />
              {sessions.length > 1 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[15px] rounded-full bg-amber-500 px-1 text-center text-[9px] font-bold leading-[15px] text-slate-950">
                  {sessions.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setHistoryOpen(false);
                void onCreateSession();
              }}
              title="Yeni Hızlı Sohbet (temiz bağlam)"
              aria-label="Yeni Hızlı Sohbet"
              className="rounded-lg bg-amber-500/90 p-1.5 text-slate-950 shadow-sm transition hover:bg-amber-400"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              title="Hızlı Chat bağlamını sıfırla"
              aria-label="Hızlı Chat bağlamını sıfırla"
              onClick={() => void onResetSession()}
              className="rounded-lg border border-slate-700/80 bg-slate-900 p-1.5 text-slate-400 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              title={expanded ? 'Daralt' : 'Genişlet'}
              aria-label={expanded ? 'Daralt' : 'Genişlet'}
              onClick={() => setExpanded((e) => !e)}
              className="rounded-lg border border-slate-700/80 bg-slate-900 p-1.5 text-slate-400 hover:text-white"
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>

            <button
              type="button"
              title="Kapat (Esc)"
              aria-label="Hızlı Chat'i kapat"
              onClick={onClose}
              className="rounded-lg border border-slate-700/80 bg-slate-900 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Dedicated AI Model Selector Row */}
        <div className="flex items-center justify-between gap-2">
          {agyStatus?.models && agyStatus.models.length > 0 ? (
            <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-950 px-2 py-1">
              <Cpu className="h-3 w-3 shrink-0 text-amber-300" />
              <span className="shrink-0 text-[10px] font-medium text-slate-400">Model:</span>
              <select
                aria-label="Hızlı Chat AI modeli"
                value={
                  selectedQuickModel !== undefined
                    ? selectedQuickModel
                    : workspace?.quickModel || ''
                }
                onChange={(e) => onChangeQuickModel(e.target.value)}
                title="Hızlı Chat için ayrı AI modeli seç"
                className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-slate-100 focus:outline-none"
              >
                <option value="" className="bg-slate-900">
                  Varsayılan Model
                </option>
                {agyStatus.models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-slate-900">
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          ) : agyStatus && !agyStatus.available ? (
            <button
              type="button"
              onClick={onOpenAgySetup}
              className="flex items-center gap-1 text-[10px] font-semibold text-amber-400 hover:underline"
            >
              <WifiOff className="h-3 w-3" />{' '}
              {agyStatus.state === 'not_installed'
                ? 'agy kurulu değil • Kurulumu Aç'
                : agyStatus.state === 'auth_required'
                  ? 'Google girişi gerekli • Giriş Yap'
                  : 'Bağlantı hatası • Kontrol Et'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRefreshAgy}
              className="flex items-center gap-1 text-[10px] text-amber-400 hover:underline"
            >
              <WifiOff className="h-3 w-3" /> Model listesini yenile
            </button>
          )}
          <span className="shrink-0 rounded-md bg-slate-800/80 px-2 py-1 text-[10px] text-slate-400">
            İşaretle &amp; Sor
          </span>
        </div>
      </div>

      {/* Body: Messages Feed or Inline History List */}
      <div className="relative min-h-0 flex-1">
        {historyOpen ? (
          <div className="flex h-full flex-col bg-slate-950/95">
            <div className="border-b border-slate-800 px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-white">
                  Hızlı Sohbet Geçmişi ({sessions.length})
                </span>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(false)}
                  className="text-[11px] font-medium text-amber-300 hover:underline"
                >
                  Sohbete Dön
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 text-slate-500" />
                <input
                  autoFocus
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Hızlı sohbetlerde ara..."
                  className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 text-[10px] text-slate-500">
                Her hızlı sohbet oturumu bağımsız bir bağlamdır ve ana sohbetten ayrıdır.
              </p>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {filteredSessions.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-slate-500">
                  Eşleşen hızlı sohbet bulunamadı.
                </p>
              )}
              {filteredSessions.map((sess) => {
                const isCurrent = sess.id === activeSessionId;
                const isRunning = activeTurnSet.has(sess.id);
                return (
                  <div
                    key={sess.id}
                    className={`group flex items-center gap-2 rounded-xl px-3 py-2 transition ${
                      isCurrent
                        ? 'bg-amber-500/15 text-white ring-1 ring-amber-500/40'
                        : 'text-slate-300 hover:bg-slate-800/70'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setHistoryOpen(false);
                        if (!isCurrent) void onSelectSession(sess.id);
                      }}
                      className="flex min-w-0 flex-1 flex-col text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        {isRunning && (
                          <span
                            title="Yanıt üretiliyor"
                            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400"
                          />
                        )}
                        <span className="truncate text-xs font-medium">{sess.title}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">
                            Açık
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-500">
                        {sess.messageCount} mesaj • {formatSessionTime(sess.updatedAt)}
                      </span>
                    </button>
                    {sessions.length > 1 && (
                      <button
                        type="button"
                        title="Hızlı oturumu sil"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            sess.messageCount === 0 ||
                            confirm(`"${sess.title}" hızlı oturumunu silmek istiyor musun?`)
                          ) {
                            void onDeleteSession(sess.id);
                          }
                        }}
                        className="rounded p-1 text-slate-500 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-300 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              onScroll={handleFeedScroll}
              className="h-full space-y-3.5 overflow-y-auto px-3.5 py-3.5 [overflow-anchor:none]"
            >
              {messages.length === 0 && !isBusy && (
                <div className="rounded-2xl border border-amber-500/20 bg-slate-900/70 p-4 text-center">
                  <Zap className="mx-auto mb-2 h-6 w-6 text-amber-400" />
                  <p className="text-xs font-semibold text-white">Hızlı Chat Hazır</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    PDF, görsel veya 3D sahne üzerinde kalemle işaretleyip sorduğun sorular otomatik
                    olarak buraya gelir. İstersen aşağıdan doğrudan hızlı soru da sorabilirsin.
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <ChatMessageItem
                  key={msg.id}
                  message={msg}
                  linkedArtifacts={linkedArtifactsByMsgId.get(msg.id) ?? emptyArtifacts}
                  variant="quick"
                  onOpenArtifact={onOpenArtifact}
                />
              ))}

              {/* Streaming Live Response */}
              {isBusy && (
                <div className="flex flex-col items-start">
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] text-amber-300">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>{statusText || 'Hızlı Chat yanıtlıyor...'}</span>
                    {elapsedSeconds > 0 && (
                      <span className="tabular-nums text-slate-500">• {elapsedSeconds} sn</span>
                    )}
                  </div>
                  <div className="w-[92%] rounded-2xl border border-amber-500/30 bg-slate-900/95 px-3.5 py-2.5">
                    {streamingText ? (
                      <div
                        className="study-prose text-xs"
                        dangerouslySetInnerHTML={{ __html: streamingHtml }}
                      />
                    ) : (
                      <div className="flex items-center gap-2 py-1 text-xs text-slate-400">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                        <span>{statusText || 'Antigravity CLI yanıtı bekleniyor...'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {errorBanner && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  <p>{errorBanner}</p>
                  {((agyStatus && !agyStatus.available) ||
                    /antigravity|agy|oturum|giriş/i.test(errorBanner)) && (
                    <button
                      type="button"
                      onClick={onOpenAgySetup}
                      className="mt-2 inline-flex items-center rounded-lg bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 ring-1 ring-rose-400/40 transition hover:bg-rose-500/30"
                    >
                      Kurulum / Giriş Sihirbazını Aç
                    </button>
                  )}
                </div>
              )}
            </div>

            {showScrollToBottom && (
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                className="absolute right-3 bottom-3 z-10 flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-slate-900/95 px-3 py-1.5 text-[11px] font-semibold text-amber-200 shadow-lg backdrop-blur transition hover:bg-amber-500 hover:text-slate-950"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                En alta in
              </button>
            )}
          </>
        )}
      </div>

      {/* Composer Footer */}
      {!historyOpen && (
        <div className="border-t border-slate-800/90 bg-slate-900/80 p-3">
          <form onSubmit={(e) => void handleSubmit(e)} className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Hızlı soru sor veya işaretli alanla ilgili devam et... (Enter: Gönder)"
              className="max-h-40 flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
            />
            {isBusy ? (
              <button
                type="button"
                onClick={() => void onAbort()}
                title="Yanıtı Durdur"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white transition hover:bg-rose-500"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                title="Hızlı Chat'e Gönder"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-400 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      )}
    </aside>
  );
};
