import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Box, FileText, HelpCircle, Layers, Sigma, User } from 'lucide-react';
import { renderStudyMarkdown } from '../../lib/markdown';
import { splitPageSections } from '../../lib/pageSections';
import { fileNameOf } from '../../lib/resourceNavigation';
import type { ChatMessage, StudyArtifact } from '../../types/study';

export interface SourceBadgeInfo {
  id: string;
  label: string;
}

export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

/**
 * Renders tutor markdown. Page-by-page answers (`## Sayfa N` headings) are split into
 * `.page-section` blocks carrying `data-page-from` / `data-page-to` and matched resource
 * metadata (`data-resource-id` / `data-resource-label`) so the chat panel can focus them
 * and open the corresponding source + page in the viewer.
 */
export const StudyMarkdownBody: React.FC<{
  markdown: string;
  className?: string;
  defaultSource?: SourceBadgeInfo | null;
  onResolveSource?: (hint: string) => SourceBadgeInfo | null;
  onOpenSourcePage?: (
    resourceId: string | null,
    page: number,
    sectionEl?: HTMLElement | null,
  ) => void;
}> = React.memo(
  ({
    markdown,
    className = 'study-prose text-xs',
    defaultSource = null,
    onResolveSource,
    onOpenSourcePage,
  }) => {
    const parts = useMemo(() => {
      const { preamble, sections } = splitPageSections(markdown);
      if (sections.length === 0) return null;
      return {
        preambleHtml: preamble ? renderStudyMarkdown(preamble) : '',
        sections: sections.map((sec) => ({
          from: sec.from,
          to: sec.to,
          source: sec.source,
          html: renderStudyMarkdown(sec.markdown),
        })),
      };
    }, [markdown]);

    const plainHtml = useMemo(() => (parts ? '' : renderStudyMarkdown(markdown)), [parts, markdown]);

    if (!parts) {
      return <div className={className} dangerouslySetInnerHTML={{ __html: plainHtml }} />;
    }

    return (
      <div className={className}>
        {parts.preambleHtml && (
          <div className="page-preamble" dangerouslySetInnerHTML={{ __html: parts.preambleHtml }} />
        )}
        {parts.sections.map((sec, idx) => {
          const resolved =
            (sec.source && onResolveSource ? onResolveSource(sec.source) : null) ||
            defaultSource ||
            null;
          const displayLabel =
            resolved?.label || (sec.source ? fileNameOf(sec.source.replace(/\\/g, '/')) : '');
          const canJump = Boolean(onOpenSourcePage && (resolved?.id || defaultSource));

          return (
            <div
              key={`${sec.from}-${sec.to}-${idx}`}
              className="page-section"
              data-page-from={sec.from}
              data-page-to={sec.to}
              data-resource-id={resolved?.id || ''}
              data-resource-label={displayLabel}
            >
              {displayLabel &&
                (canJump ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const secEl = e.currentTarget.closest<HTMLElement>('.page-section');
                      onOpenSourcePage?.(resolved?.id || null, sec.from, secEl);
                    }}
                    title={`${displayLabel} • ${sec.from}. sayfayı aç`}
                    className="page-section-source"
                  >
                    <FileText className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{displayLabel}</span>
                  </button>
                ) : (
                  <span className="page-section-source cursor-default" title={displayLabel}>
                    <FileText className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{displayLabel}</span>
                  </span>
                ))}
              <div dangerouslySetInnerHTML={{ __html: sec.html }} />
            </div>
          );
        })}
      </div>
    );
  },
);

StudyMarkdownBody.displayName = 'StudyMarkdownBody';

interface ChatMessageItemProps {
  message: ChatMessage;
  linkedArtifacts: StudyArtifact[];
  variant: 'main' | 'quick';
  defaultSource?: SourceBadgeInfo | null;
  onResolveSource?: (hint: string) => SourceBadgeInfo | null;
  onOpenSourcePage?: (
    resourceId: string | null,
    page: number,
    sectionEl?: HTMLElement | null,
  ) => void;
  onOpenArtifact: (artifact: StudyArtifact) => void;
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = React.memo(
  ({
    message,
    linkedArtifacts,
    variant,
    defaultSource,
    onResolveSource,
    onOpenSourcePage,
    onOpenArtifact,
  }) => {
    const isUser = message.role === 'user';
    const isQuick = variant === 'quick';


    return (
      <div
        data-message-role={message.role}
        className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-slate-500">
          {isUser ? (
            <>
              <span>Sen</span>
              <User className={`h-3 w-3 ${isQuick ? 'text-amber-300' : 'text-cyan-400'}`} />
            </>
          ) : (
            <>
              <Bot className={`h-3 w-3 ${isQuick ? 'text-amber-400' : 'text-indigo-400'}`} />
              <span>{isQuick ? 'Hızlı Chat' : 'Gemini Öğretmen'}</span>
              {message.durationSeconds ? (
                <span>• {message.durationSeconds.toFixed(1)} sn</span>
              ) : null}
            </>
          )}
        </div>

        <div
          className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
            isUser
              ? isQuick
                ? 'bg-gradient-to-br from-amber-600/90 to-indigo-600/90 text-white'
                : 'bg-indigo-600/90 text-white'
              : isQuick
                ? 'border border-slate-800 bg-slate-900/95 text-slate-100'
                : 'border border-slate-800 bg-slate-900/90 text-slate-100'
          }`}
        >
          {message.annotation && (
            <div className="mb-2 overflow-hidden rounded-xl border border-white/20 bg-slate-950">
              <img
                src={message.annotation.url}
                alt="İşaretli görsel"
                className={`${isQuick ? 'max-h-36' : 'max-h-40'} w-full object-contain`}
              />
              <div
                className={`${
                  isQuick ? 'bg-black/45 text-amber-100' : 'bg-black/40 text-indigo-100'
                } px-2 py-1 text-[10px]`}
              >
                {isQuick ? 'İşaretli görsel' : 'İşaretli ekran görüntüsü'}{' '}
                {message.annotation.sourceLabel ? `• ${message.annotation.sourceLabel}` : ''}
              </div>
            </div>
          )}

          {isUser ? (
            <p className="whitespace-pre-wrap text-xs leading-relaxed">{message.content}</p>
          ) : (
            <StudyMarkdownBody
              markdown={message.displayContent || message.content}
              defaultSource={defaultSource}
              onResolveSource={onResolveSource}
              onOpenSourcePage={onOpenSourcePage}
            />
          )}

          {linkedArtifacts.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-2.5">
              {linkedArtifacts.map((art) => {
                const Icon =
                  art.type === '3d-scene'
                    ? Box
                    : art.type === 'formula-lab'
                      ? Sigma
                      : art.type === 'quiz'
                        ? HelpCircle
                        : Layers;
                return (
                  <button
                    key={art.id}
                    type="button"
                    onClick={() => onOpenArtifact(art)}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition ${
                      isQuick
                        ? 'border-amber-500/35 bg-amber-500/10 hover:bg-amber-500/20'
                        : 'border-indigo-500/35 bg-indigo-500/12 hover:bg-indigo-500/25'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        className={`h-4 w-4 shrink-0 ${isQuick ? 'text-amber-300' : 'text-cyan-300'}`}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-white">{art.title}</p>
                        <p
                          className={`text-[10px] ${
                            isQuick ? 'text-amber-200/80' : 'text-indigo-200/80'
                          }`}
                        >
                          Sahnede aç • v{art.version}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                        isQuick
                          ? 'bg-amber-500/30 text-amber-100'
                          : 'bg-indigo-600/40 text-indigo-100'
                      }`}
                    >
                      Aç
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!isQuick && message.boardActionsApplied ? (
            <div className="mt-2 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[10px] font-medium text-emerald-200">
              Ortak Çalışma Tahtasına {message.boardActionsApplied} yeni kart eklendi.
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);

ChatMessageItem.displayName = 'ChatMessageItem';
