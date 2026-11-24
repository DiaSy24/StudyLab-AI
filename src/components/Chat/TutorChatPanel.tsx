import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  BookOpenText,
  Cpu,
  GraduationCap,
  History,
  Languages,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  AgyStatus,
  ChatMessage,
  ChatSession,
  ExamLanguage,
  LinkedTreeEntry,
  StudyArtifact,
  StudyMode,
  StudyResource,
  Workspace,
} from '../../types/study';
import {
  inferMessageSource,
  isPagedResource,
  matchStudyResource,
} from '../../lib/pageSections';
import { useAutoResizeTextarea } from './useAutoResizeTextarea';
import {
  ChatMessageItem,
  StudyMarkdownBody,
  useElapsedSeconds,
  type SourceBadgeInfo,
} from './ChatMessageItem';

interface TutorChatPanelProps {
  width?: number;
  workspace: Workspace | null;
  agyStatus: AgyStatus | null;
  selectedModel?: string;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeTurnSessionIds: string[];
  messages: ChatMessage[];
  artifacts: StudyArtifact[];
  resources?: StudyResource[];
  folderTrees?: Record<string, LinkedTreeEntry[]>;
  displayedResource?: StudyResource | null;
  isResourceTabActive?: boolean;
  streamingText: string;
  statusText: string | null;
  isBusy: boolean;
  errorBanner: string | null;
  onSendMessage: (message: string, opts?: { pageByPage?: boolean }) => Promise<void>;
  onAbort: () => Promise<void>;
  onChangeMode: (mode: StudyMode) => void;
  onChangeModel: (model: string) => void;
  onChangeExamLanguage: (lang: ExamLanguage) => void;
  onResetSession: () => Promise<void>;
  onCreateSession: () => Promise<void>;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onOpenArtifact: (artifact: StudyArtifact) => void;
  onRefreshAgy: () => void;
  onOpenAgySetup: () => void;
  /** "Sayfa Senkron" mode: focus the explanation of the viewer's page and sync both ways. */
  pageSync?: boolean;
  /** Whether the open resource has pages (PDF / Word / PowerPoint). */
  pageSyncAvailable?: boolean;
  /** Page currently shown in the resource viewer (only while pageSync is on and resource tab is visible). */
  activePage?: number | null;
  /** Resource ID currently shown in the resource viewer. */
  activeResourceId?: string | null;
  /** Asks the resource viewer to show a page on the current resource. */
  onRequestPage?: (page: number) => void;
  /** Asks the stage to open `resourceId` (if given) and navigate to `page`. */
  onRequestResourcePage?: (resourceId: string | null, page: number) => void;
  onTogglePageSync?: (next: boolean) => void;
}

/** Ignore viewer page updates for this long after the chat itself moved the viewer. */
const CHAT_DRIVEN_LOCK_MS = 1000;
/** Max wait for an async cross-resource switch before releasing the chat-driven target lock. */
const PENDING_TARGET_TIMEOUT_MS = 2500;
/** Ignore scroll-based focus picking while a programmatic smooth scroll runs. */
const PROGRAMMATIC_SCROLL_LOCK_MS = 750;
const PAGE_REQUEST_DEBOUNCE_MS = 140;

const PAGE_BY_PAGE_TEXT = 'Bu kaynağı şu an baktığım sayfadan itibaren sayfa sayfa anlat.';

interface SectionDomInfo {
  from: number;
  to: number;
  resourceId: string;
  resourceLabel: string;
}

function sectionInfo(el: HTMLElement): SectionDomInfo {
  const from = Number(el.dataset.pageFrom) || 0;
  const to = Number(el.dataset.pageTo) || from;
  const resourceId = el.dataset.resourceId || '';
  const resourceLabel = el.dataset.resourceLabel || '';
  return { from, to, resourceId, resourceLabel };
}

/**
 * Finds the latest `.page-section` covering `(resourceId, page)`.
 * Sections tagged with a different `data-resource-id` never match `resourceId`;
 * legacy untagged sections (`data-resource-id=""`) match only when no tagged match exists.
 */
function findLastSectionForResourcePage(
  sections: HTMLElement[],
  resourceId: string | null,
  page: number,
): HTMLElement | null {
  if (resourceId) {
    for (let i = sections.length - 1; i >= 0; i--) {
      const info = sectionInfo(sections[i]);
      if (info.resourceId === resourceId && page >= info.from && page <= info.to) {
        return sections[i];
      }
    }
  }
  for (let i = sections.length - 1; i >= 0; i--) {
    const info = sectionInfo(sections[i]);
    if (!info.resourceId && page >= info.from && page <= info.to) {
      return sections[i];
    }
  }
  return null;
}

const MODES: { id: StudyMode; label: string; desc: string }[] = [
  { id: 'visual', label: 'Görsel', desc: '2D/3D çizim & formül üretir' },
  { id: 'socratic', label: 'Sokratik', desc: 'Adım adım beraber çözer' },
  { id: 'exam', label: 'Sınav', desc: 'Test & alıştırma odaklı' },
];

const QUICK_CHIPS = [
  { label: '3D modelle göster', text: 'Bu konuyu etkileşimli bir 3D Three.js modeli ile gösterip anlatır mısın?' },
  { label: '2D simülasyon çiz', text: 'Bunu parametrelerini değiştirebileceğim etkileşimli bir 2D simülasyonla görselleştirir misin?' },
  { label: 'Formül Laboratuvarı', text: 'Bu konunun ana formülünü tıklanabilir terimler ve sürgülerle Formül Laboratuvarı olarak hazırla.' },
  { label: 'Alıştırma oluştur', text: 'Bu konu ve seçili kaynaklarım üzerinden 3 soruluk etkileşimli bir alıştırma (quiz) hazırla.' },
];

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

export const TutorChatPanel: React.FC<TutorChatPanelProps> = ({
  width = 420,
  workspace,
  agyStatus,
  selectedModel,
  sessions,
  activeSessionId,
  activeTurnSessionIds,
  messages,
  artifacts,
  resources = [],
  folderTrees,
  displayedResource = null,
  isResourceTabActive = false,
  streamingText,
  statusText,
  isBusy,
  errorBanner,
  onSendMessage,
  onAbort,
  onChangeMode,
  onChangeModel,
  onChangeExamLanguage,
  onResetSession,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onOpenArtifact,
  onRefreshAgy,
  onOpenAgySetup,
  pageSync = false,
  pageSyncAvailable = false,
  activePage = null,
  activeResourceId = null,
  onRequestPage,
  onRequestResourcePage,
  onTogglePageSync,
}) => {
  const [input, setInput] = useState('');
  const textareaRef = useAutoResizeTextarea(input, 160);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0] || null;
  const activeTurnSet = new Set(activeTurnSessionIds);

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

  // ---- Sayfa Senkron (source-matched page-by-page focus) ----
  const [focusActive, setFocusActive] = useState(false);
  const [focusedMeta, setFocusedMeta] = useState<{
    from: number;
    to: number;
    label: string;
  } | null>(null);
  const [missingPage, setMissingPage] = useState<number | null>(null);
  const focusedSectionRef = useRef<HTMLElement | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const chatDrivenUntilRef = useRef(0);
  const pendingChatTargetRef = useRef<{
    resourceId: string | null;
    from: number;
    to: number;
    expiresAt: number;
  } | null>(null);
  const suppressNextEnableOpenRef = useRef(false);
  const prevPageSyncRef = useRef(pageSync);
  const wasBusyRef = useRef(isBusy);
  const pageRequestTimerRef = useRef<number | null>(null);
  const pickRafRef = useRef<number | null>(null);
  const pageSyncRef = useRef(pageSync);
  pageSyncRef.current = pageSync;
  const activePageRef = useRef(activePage);
  activePageRef.current = activePage;
  const activeResourceIdRef = useRef(activeResourceId);
  activeResourceIdRef.current = activeResourceId;
  const isResourceTabActiveRef = useRef(isResourceTabActive);
  isResourceTabActiveRef.current = isResourceTabActive;
  const onRequestPageRef = useRef(onRequestPage);
  onRequestPageRef.current = onRequestPage;
  const onRequestResourcePageRef = useRef(onRequestResourcePage);
  onRequestResourcePageRef.current = onRequestResourcePage;

  const handleResolveSource = useCallback(
    (hint: string): SourceBadgeInfo | null => {
      const matched = matchStudyResource(hint, resources, folderTrees);
      return matched ? { id: matched.id, label: matched.label } : null;
    },
    [resources, folderTrees],
  );

  const defaultSourceByMsgId = useMemo(() => {
    const map = new Map<string, SourceBadgeInfo>();
    let lastUser: ChatMessage | null = null;
    for (const msg of messages) {
      if (msg.role === 'user') {
        lastUser = msg;
        continue;
      }
      const inferred = inferMessageSource(msg, lastUser, resources, folderTrees);
      if (inferred) {
        map.set(msg.id, { id: inferred.id, label: inferred.label });
      }
    }
    return map;
  }, [messages, resources, folderTrees]);

  const streamingDefaultSource = useMemo<SourceBadgeInfo | null>(() => {
    if (!isBusy) return null;
    let lastUser: ChatMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = messages[i];
        break;
      }
    }
    const inferred = inferMessageSource(null, lastUser, resources, folderTrees);
    if (inferred) return { id: inferred.id, label: inferred.label };
    if (displayedResource && displayedResource.category !== 'folder' && isPagedResource(displayedResource)) {
      return { id: displayedResource.id, label: displayedResource.name };
    }
    return null;
  }, [isBusy, messages, resources, folderTrees, displayedResource]);

  const getSections = useCallback((): HTMLElement[] => {
    const el = scrollContainerRef.current;
    return el ? Array.from(el.querySelectorAll<HTMLElement>('.page-section')) : [];
  }, []);

  /** Moves the focus highlight via DOM classes so memoized messages don't re-render. */
  const applyFocus = useCallback((section: HTMLElement | null) => {
    const container = scrollContainerRef.current;
    if (focusedSectionRef.current !== section) {
      focusedSectionRef.current?.classList.remove('is-focused');
      container
        ?.querySelectorAll('.has-page-focus')
        .forEach((n) => n.classList.remove('has-page-focus'));
    }
    focusedSectionRef.current = section;
    if (section && container) {
      section.classList.add('is-focused');
      let item: HTMLElement | null = section;
      while (item && item.parentElement !== container) item = item.parentElement;
      item?.classList.add('has-page-focus');
      const info = sectionInfo(section);
      setFocusedMeta((prev) =>
        prev &&
        prev.from === info.from &&
        prev.to === info.to &&
        prev.label === info.resourceLabel
          ? prev
          : { from: info.from, to: info.to, label: info.resourceLabel },
      );
    } else {
      setFocusedMeta(null);
    }
    setFocusActive(Boolean(section));
  }, []);

  /** Smoothly centers a section in the feed (top-aligned if taller than the feed) and focuses it. */
  const centerSection = useCallback(
    (target: HTMLElement) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const offset = container.scrollTop + (r.top - cr.top);
      const top =
        r.height < container.clientHeight ? offset - (container.clientHeight - r.height) / 2 : offset - 12;
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS;
      autoScrollRef.current = false;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      applyFocus(target);
      setMissingPage(null);
    },
    [applyFocus],
  );

  /** Returns the `.page-section` currently visible inside the chat viewport closest to its middle. */
  const pickVisibleSection = useCallback((): HTMLElement | null => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    const sections = getSections();
    if (sections.length === 0) return null;
    const cr = container.getBoundingClientRect();
    if (cr.height <= 0) return null;
    const mid = cr.top + cr.height / 2;
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const sec of sections) {
      const r = sec.getBoundingClientRect();
      if (r.bottom <= cr.top + 8 || r.top >= cr.bottom - 8) continue;
      const dist = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (dist <= bestDist) {
        bestDist = dist;
        best = sec;
      }
    }
    return best;
  }, [getSections]);

  /** Opens the matched resource and starting page of `sec` in the stage viewer. */
  const openSectionTarget = useCallback((sec: HTMLElement, immediate = false) => {
    const { from, to, resourceId } = sectionInfo(sec);
    if (!from) return;
    const currentResId = activeResourceIdRef.current;
    const currentPage = activePageRef.current;
    const tabOpen = isResourceTabActiveRef.current;
    const sameResource = !resourceId ? Boolean(currentResId) : currentResId === resourceId;

    if (tabOpen && sameResource && currentPage !== null && currentPage >= from && currentPage <= to) {
      return;
    }

    if (pageRequestTimerRef.current !== null) {
      window.clearTimeout(pageRequestTimerRef.current);
      pageRequestTimerRef.current = null;
    }

    const fire = () => {
      pageRequestTimerRef.current = null;
      chatDrivenUntilRef.current = Date.now() + CHAT_DRIVEN_LOCK_MS;
      pendingChatTargetRef.current = {
        resourceId: resourceId || null,
        from,
        to,
        expiresAt: Date.now() + PENDING_TARGET_TIMEOUT_MS,
      };
      if (onRequestResourcePageRef.current) {
        onRequestResourcePageRef.current(resourceId || null, from);
      } else {
        onRequestPageRef.current?.(from);
      }
    };

    if (immediate) {
      fire();
    } else {
      pageRequestTimerRef.current = window.setTimeout(fire, PAGE_REQUEST_DEBOUNCE_MS);
    }
  }, []);

  /** Chat -> viewer: focus the visible section crossing the middle of the feed and open its source/page. */
  const pickFocusFromScroll = useCallback(
    (requestPage: boolean) => {
      if (!pageSyncRef.current) return;
      const best = pickVisibleSection();
      if (!best) {
        applyFocus(null);
        return;
      }
      applyFocus(best);
      setMissingPage(null);
      if (requestPage) {
        openSectionTarget(best, false);
      }
    },
    [applyFocus, openSectionTarget, pickVisibleSection],
  );

  const handleOpenSourcePage = useCallback(
    (resourceId: string | null, page: number, sectionEl?: HTMLElement | null) => {
      if (pageSyncRef.current && sectionEl) {
        applyFocus(sectionEl);
        setMissingPage(null);
        openSectionTarget(sectionEl, true);
        return;
      }
      if (onRequestResourcePageRef.current) {
        onRequestResourcePageRef.current(resourceId, page);
      } else {
        onRequestPageRef.current?.(page);
      }
    },
    [applyFocus, openSectionTarget],
  );

  const handleFeedClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pageSync) return;
    if (window.getSelection()?.toString()) return;
    const target = e.target as HTMLElement | null;
    if (!target || target.closest('a, button, input, textarea, select')) return;
    const sec = target.closest<HTMLElement>('.page-section');
    if (!sec) return;
    applyFocus(sec);
    setMissingPage(null);
    openSectionTarget(sec, true);
  };

  const handleFeedScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= 56;
    autoScrollRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);

    if (pageSync && Date.now() >= programmaticScrollUntilRef.current && pickRafRef.current === null) {
      pickRafRef.current = window.requestAnimationFrame(() => {
        pickRafRef.current = null;
        pickFocusFromScroll(true);
      });
    }
  };

  // Toggle-on focus -> viewer open, plus Viewer -> chat synchronization.
  useEffect(() => {
    const justEnabled = !prevPageSyncRef.current && pageSync;
    prevPageSyncRef.current = pageSync;

    if (!pageSync) {
      pendingChatTargetRef.current = null;
      applyFocus(null);
      setMissingPage(null);
      return;
    }

    if (justEnabled) {
      if (suppressNextEnableOpenRef.current) {
        suppressNextEnableOpenRef.current = false;
      } else {
        const currentFocused =
          focusedSectionRef.current && focusedSectionRef.current.isConnected
            ? focusedSectionRef.current
            : null;
        const visibleTarget = currentFocused || pickVisibleSection();
        if (visibleTarget) {
          applyFocus(visibleTarget);
          setMissingPage(null);
          openSectionTarget(visibleTarget, true);
          return;
        }
      }
    }

    // Wait for any chat-initiated async resource/page jump to finish before syncing Viewer -> chat.
    const pending = pendingChatTargetRef.current;
    if (pending) {
      if (Date.now() < pending.expiresAt) {
        const landedResource = !pending.resourceId || activeResourceId === pending.resourceId;
        if (
          isResourceTabActive &&
          landedResource &&
          activePage !== null &&
          activePage >= pending.from &&
          activePage <= pending.to
        ) {
          pendingChatTargetRef.current = null;
          chatDrivenUntilRef.current = 0;
          setMissingPage(null);
        }
        return;
      }
      pendingChatTargetRef.current = null;
    }

    if (Date.now() < chatDrivenUntilRef.current) return;

    if (!isResourceTabActive || !activePage) {
      setMissingPage(null);
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;

    const current = focusedSectionRef.current;
    if (current && current.isConnected) {
      const info = sectionInfo(current);
      const sameSource = !info.resourceId || info.resourceId === activeResourceId;
      if (sameSource && activePage >= info.from && activePage <= info.to) {
        setMissingPage(null);
        return;
      }
    }

    const sections = getSections();
    const target = findLastSectionForResourcePage(sections, activeResourceId, activePage);
    if (!target) {
      applyFocus(null);
      setMissingPage(sections.length > 0 ? activePage : null);
      return;
    }

    centerSection(target);
  }, [
    pageSync,
    isResourceTabActive,
    activeResourceId,
    activePage,
    applyFocus,
    centerSection,
    getSections,
    openSectionTarget,
    pickVisibleSection,
  ]);

  // Re-attach focus when messages re-render or when a streamed page-by-page reply finishes.
  useEffect(() => {
    const justFinishedTurn = wasBusyRef.current && !isBusy;
    wasBusyRef.current = isBusy;
    if (!pageSync) return;

    const raf = window.requestAnimationFrame(() => {
      if (isBusy) {
        // While a reply streams, highlight the visible section; don't flip viewer pages mid-stream.
        const vis = pickVisibleSection();
        if (vis) applyFocus(vis);
        return;
      }

      const current = focusedSectionRef.current;
      if (!justFinishedTurn && current && current.isConnected) return;

      const sections = getSections();
      if (sections.length === 0) return;

      const curResId = activeResourceIdRef.current;
      const curPage = activePageRef.current;
      const tabOpen = isResourceTabActiveRef.current;

      if (justFinishedTurn) {
        const container = scrollContainerRef.current;
        const assistantNodes = container
          ? Array.from(container.querySelectorAll<HTMLElement>('[data-message-role="assistant"]'))
          : [];
        const latestAssistant = assistantNodes[assistantNodes.length - 1] ?? null;
        const newSections = latestAssistant
          ? Array.from(latestAssistant.querySelectorAll<HTMLElement>('.page-section'))
          : [];
        if (newSections.length > 0) {
          const matchForOpen =
            tabOpen && curPage
              ? findLastSectionForResourcePage(newSections, curResId, curPage)
              : null;
          if (matchForOpen) {
            centerSection(matchForOpen);
            return;
          }
          const firstNew = newSections[0];
          centerSection(firstNew);
          openSectionTarget(firstNew, true);
          return;
        }
      }

      const target =
        tabOpen && curPage ? findLastSectionForResourcePage(sections, curResId, curPage) : null;
      if (target) {
        centerSection(target);
      } else if (tabOpen && curPage) {
        applyFocus(null);
        setMissingPage(curPage);
      } else {
        const vis = pickVisibleSection();
        applyFocus(vis);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    pageSync,
    messages,
    streamingText,
    isBusy,
    applyFocus,
    centerSection,
    getSections,
    openSectionTarget,
    pickVisibleSection,
  ]);

  useEffect(
    () => () => {
      if (pageRequestTimerRef.current !== null) window.clearTimeout(pageRequestTimerRef.current);
      if (pickRafRef.current !== null) window.cancelAnimationFrame(pickRafRef.current);
    },
    [],
  );

  const handleExplainPageByPage = async () => {
    if (isBusy || !workspace) return;
    if (!pageSync) {
      suppressNextEnableOpenRef.current = true;
      onTogglePageSync?.(true);
    }
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    const promptText =
      isResourceTabActive && pageSyncAvailable
        ? PAGE_BY_PAGE_TEXT
        : displayedResource && displayedResource.category !== 'folder' && isPagedResource(displayedResource)
          ? `"${displayedResource.name}" kaynağını sayfa sayfa anlat.`
          : 'Ders kaynağını baştan itibaren sayfa sayfa anlat.';
    await onSendMessage(promptText, { pageByPage: true });
  };

  // Reset scroll to bottom when switching workspaces or chat sessions
  useEffect(() => {
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    const raf = window.requestAnimationFrame(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [workspace?.id, activeSessionId]);

  // Only follow incoming stream/messages if the user hasn't scrolled up to read earlier content
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    // Following the stream is not the user scrolling: don't let it flip viewer pages.
    if (pageSyncRef.current) programmaticScrollUntilRef.current = Date.now() + 250;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, statusText]);

  const elapsedSeconds = useElapsedSeconds(isBusy);
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
  const normalizedQuery = historyQuery.trim().toLocaleLowerCase('tr-TR');
  const filteredSessions = normalizedQuery
    ? sessions.filter((s) => s.title.toLocaleLowerCase('tr-TR').includes(normalizedQuery))
    : sessions;

  // Close the history popup with Escape
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [historyOpen]);

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
    <section
      style={{ width }}
      className="flex h-full shrink-0 flex-col overflow-hidden bg-slate-950/95"
    >
      {/* Top Status & Mode Bar */}
      <div className="space-y-2.5 border-b border-slate-800/90 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
              <GraduationCap className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-xs font-bold text-white" title="Gemini Ders Öğretmeni">Gemini Ders Öğretmeni</h2>
              <div className="flex min-w-0 items-center gap-1.5 text-[10px]">
                {agyStatus?.available ? (
                  <button
                    type="button"
                    onClick={onOpenAgySetup}
                    title="Antigravity (agy) bağlantı durumu ve hesap ayarları"
                    className="flex shrink-0 items-center gap-1 text-emerald-400 hover:underline"
                  >
                    <Wifi className="h-3 w-3" /> agy v{agyStatus.version} bağlı
                  </button>
                ) : agyStatus?.state === 'not_installed' ? (
                  <button
                    type="button"
                    onClick={onOpenAgySetup}
                    className="flex shrink-0 items-center gap-1 font-semibold text-rose-400 hover:underline"
                  >
                    <WifiOff className="h-3 w-3" /> agy kurulu değil • Kur
                  </button>
                ) : agyStatus?.state === 'auth_required' ? (
                  <button
                    type="button"
                    onClick={onOpenAgySetup}
                    className="flex shrink-0 items-center gap-1 font-semibold text-amber-400 hover:underline"
                  >
                    <WifiOff className="h-3 w-3" /> Giriş gerekli • Giriş Yap
                  </button>
                ) : agyStatus?.state === 'error' ? (
                  <button
                    type="button"
                    onClick={onOpenAgySetup}
                    className="flex shrink-0 items-center gap-1 font-semibold text-rose-400 hover:underline"
                  >
                    <WifiOff className="h-3 w-3" /> Bağlantı hatası • Kontrol Et
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onRefreshAgy}
                    className="flex shrink-0 items-center gap-1 text-amber-400 hover:underline"
                  >
                    <WifiOff className="h-3 w-3" /> agy kontrol ediliyor...
                  </button>
                )}
                <span className="text-slate-600">•</span>
                <span
                  className="truncate text-slate-400"
                  title={activeSession?.title || 'Sohbet Oturumu'}
                >
                  {activeSession?.title || 'Sohbet Oturumu'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onTogglePageSync?.(!pageSync)}
              aria-pressed={pageSync}
              aria-label="Sayfa Senkron"
              title={
                pageSync
                  ? 'Sayfa Senkron açık (kapatmak için tıkla)'
                  : 'Sayfa Senkron: anlatımı kaynak sayfasıyla eşleştir'
              }
              className={`rounded-lg border p-1.5 transition ${
                pageSync
                  ? 'border-indigo-400/70 bg-indigo-600 text-white shadow'
                  : 'border-slate-700/80 bg-slate-900 text-slate-300 hover:border-indigo-500 hover:text-white'
              }`}
            >
              <BookOpenText className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryQuery('');
                setHistoryOpen(true);
              }}
              title="Önceki sohbetler"
              aria-label="Önceki sohbetler"
              className="relative rounded-lg border border-slate-700/80 bg-slate-900 p-1.5 text-slate-300 hover:border-indigo-500 hover:text-white"
            >
              <History className="h-3.5 w-3.5" />
              {sessions.length > 1 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[15px] rounded-full bg-indigo-600 px-1 text-center text-[9px] font-bold leading-[15px] text-white">
                  {sessions.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void onCreateSession()}
              title="Yeni sohbet (temiz bağlam)"
              aria-label="Yeni sohbet"
              className="rounded-lg bg-indigo-600/90 p-1.5 text-white shadow-sm transition hover:bg-indigo-500"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </button>
            {agyStatus?.models && agyStatus.models.length > 0 && (
              <div className="flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-950 px-2 py-1">
                <Cpu className="h-3 w-3 text-slate-400" />
                <select
                  value={selectedModel !== undefined ? selectedModel : workspace?.model || ''}
                  onChange={(e) => onChangeModel(e.target.value)}
                  title="agy Gemini modeli seç"
                  className="max-w-[120px] bg-transparent text-[11px] text-slate-200 focus:outline-none"
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
              </div>
            )}
            <button
              type="button"
              title="agy konuşma oturumunu sıfırla (yeni bağlam)"
              onClick={() => void onResetSession()}
              className="rounded-lg border border-slate-700/80 bg-slate-900 p-1.5 text-slate-400 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Study Mode Switcher + question language */}
        <div className="flex items-stretch gap-1.5">
        <div className="grid flex-1 grid-cols-3 gap-1 rounded-xl bg-slate-950 p-1 ring-1 ring-slate-800">
          {MODES.map((m) => {
            const active = (workspace?.studyMode || 'visual') === m.id;
            return (
              <button
                key={m.id}
                type="button"
                title={m.desc}
                onClick={() => onChangeMode(m.id)}
                className={`rounded-lg py-1.5 text-xs font-semibold transition ${
                  active
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
          <label
            title="Soru / sınav dili: alıştırma, quiz ve sınav soruları bu dilde sorulur. Sohbet Türkçe kalır."
            className="flex shrink-0 items-center gap-1 rounded-xl bg-slate-950 px-2 ring-1 ring-slate-800"
          >
            <Languages className="h-3.5 w-3.5 text-slate-400" />
            <span className="sr-only">Soru dili</span>
            <select
              value={workspace?.examLanguage || 'auto'}
              onChange={(e) => onChangeExamLanguage(e.target.value as ExamLanguage)}
              className="bg-transparent text-[11px] font-semibold text-slate-200 focus:outline-none"
            >
              <option value="en" className="bg-slate-900">Sorular: English</option>
              <option value="tr" className="bg-slate-900">Sorular: Türkçe</option>
              <option value="auto" className="bg-slate-900">Sorular: Kaynak dili</option>
            </select>
          </label>
        </div>
      </div>

      {/* Persistent Setup / Login Banner when agy is not ready */}
      {agyStatus && !agyStatus.available && (
        <div
          className={`flex items-center justify-between gap-2 border-b px-4 py-2.5 ${
            agyStatus.state === 'auth_required'
              ? 'border-amber-500/30 bg-amber-500/10'
              : 'border-rose-500/30 bg-rose-500/10'
          }`}
        >
          <div className="min-w-0">
            <p className="truncate text-[11px] font-bold text-white">
              {agyStatus.state === 'not_installed'
                ? 'Antigravity CLI (agy) Kurulumu Gerekli'
                : agyStatus.state === 'auth_required'
                  ? 'Google Hesabıyla Giriş Bekleniyor'
                  : 'Antigravity (agy) Bağlantısı Hazır Değil'}
            </p>
            <p className="truncate text-[10px] text-slate-300">
              {agyStatus.state === 'not_installed'
                ? 'Tek tıkla kurup hemen sohbete başlayabilirsin.'
                : agyStatus.state === 'auth_required'
                  ? 'Giriş penceresinden Google hesabınla onayla.'
                  : agyStatus.error || 'Bağlantı durumunu kontrol et.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenAgySetup}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${
              agyStatus.state === 'auth_required'
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                : 'bg-indigo-600 text-white hover:bg-indigo-500'
            }`}
          >
            {agyStatus.state === 'not_installed'
              ? 'Kur'
              : agyStatus.state === 'auth_required'
                ? 'Giriş Yap'
                : 'Kontrol Et'}
          </button>
        </div>
      )}

      {/* Chat Messages Feed */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Sayfa Senkron status bar: its own row above the feed so it never covers messages */}
        {pageSync && (
          <div className="flex shrink-0 justify-center border-b border-slate-800/90 bg-slate-950 px-4 py-1.5">
            {missingPage && !isBusy ? (
              <div className="flex max-w-full items-center gap-2 rounded-full border border-indigo-500/40 bg-slate-900/95 py-1 pr-1 pl-3 text-[11px] text-slate-300">
                <BookOpenText className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
                <span className="truncate">
                  {isResourceTabActive && displayedResource && displayedResource.category !== 'folder'
                    ? `${displayedResource.name} • `
                    : ''}
                  Sayfa {missingPage} için açıklama yok
                </span>
                <button
                  type="button"
                  onClick={() => {
                    autoScrollRef.current = true;
                    void onSendMessage(`${missingPage}. sayfayı sayfa sayfa anlat.`, { pageByPage: true });
                  }}
                  className="shrink-0 rounded-full bg-indigo-600 px-2.5 py-0.5 font-semibold text-white transition hover:bg-indigo-500"
                >
                  Bu sayfayı açıkla
                </button>
              </div>
            ) : (
              <div className="flex max-w-full items-center gap-1.5 rounded-full bg-indigo-600/90 px-2.5 py-0.5 text-[10px] font-semibold text-white shadow">
                <BookOpenText className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  Sayfa Senkron
                  {focusedMeta?.label
                    ? ` • ${focusedMeta.label}`
                    : isResourceTabActive && displayedResource && displayedResource.category !== 'folder'
                      ? ` • ${displayedResource.name}`
                      : ''}
                  {activePage
                    ? ` • Sayfa ${activePage}`
                    : focusedMeta?.from
                      ? ` • Sayfa ${focusedMeta.from}${focusedMeta.to > focusedMeta.from ? `-${focusedMeta.to}` : ''}`
                      : pageSyncAvailable
                        ? ''
                        : ' • kaynak veya açıklama seç'}
                </span>
              </div>
            )}
          </div>
        )}

        <div
          ref={scrollContainerRef}
          onScroll={handleFeedScroll}
          onClick={handleFeedClick}
          className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 [overflow-anchor:none] ${
            pageSync && focusActive ? 'page-sync-on' : ''
          }`}
        >
        {messages.length === 0 && !isBusy && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-center">
            <Sparkles className="mx-auto mb-2 h-6 w-6 text-indigo-400" />
            <p className="text-xs font-semibold text-white">Çalışmaya Başlamaya Hazırsın!</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Sol panelden ders PDF’i veya fotoğraf yükle, soru sor ya da 3D model / formül laboratuvarı iste.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            linkedArtifacts={linkedArtifactsByMsgId.get(msg.id) ?? emptyArtifacts}
            variant="main"
            defaultSource={defaultSourceByMsgId.get(msg.id) ?? null}
            onResolveSource={handleResolveSource}
            onOpenSourcePage={handleOpenSourcePage}
            onOpenArtifact={onOpenArtifact}
          />
        ))}

        {/* Streaming Live Response */}
        {isBusy && (
          <div className="flex flex-col items-start">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] text-indigo-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{statusText || 'Gemini düşünüyor...'}</span>
              {elapsedSeconds > 0 && (
                <span className="tabular-nums text-slate-500">• {elapsedSeconds} sn</span>
              )}
            </div>
            <div className="w-[92%] rounded-2xl border border-indigo-500/30 bg-slate-900/90 px-3.5 py-2.5">
              {streamingText ? (
                <StudyMarkdownBody
                  markdown={streamingText}
                  defaultSource={streamingDefaultSource}
                  onResolveSource={handleResolveSource}
                  onOpenSourcePage={handleOpenSourcePage}
                />
              ) : (
                <div className="flex items-center gap-2 py-1 text-xs text-slate-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
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
            className="absolute right-4 bottom-3 z-10 flex items-center gap-1.5 rounded-full border border-indigo-500/40 bg-slate-900/95 px-3 py-1.5 text-[11px] font-semibold text-indigo-200 shadow-lg backdrop-blur transition hover:bg-indigo-600 hover:text-white"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            En alta in
          </button>
        )}
      </div>

      {/* Composer Footer */}
      <div className="border-t border-slate-800/90 bg-slate-900/70 p-3">
        {/* Quick Pedagogical Chips */}
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleExplainPageByPage()}
            title="Açık kaynağı bulunduğun sayfadan itibaren sayfa sayfa anlattırır ve Sayfa Senkron'u açar"
            className="flex shrink-0 items-center gap-1 rounded-full border border-indigo-500/50 bg-indigo-500/15 px-2.5 py-1 text-[10px] font-semibold text-indigo-200 transition hover:bg-indigo-500/30 disabled:opacity-40"
          >
            <BookOpenText className="h-3 w-3" />
            Sayfa sayfa açıkla
          </button>
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={isBusy}
              onClick={() => void onSendMessage(chip.text)}
              className="shrink-0 rounded-full border border-slate-700/90 bg-slate-950 px-2.5 py-1 text-[10px] font-medium text-slate-300 transition hover:border-indigo-500 hover:text-indigo-200 disabled:opacity-40"
            >
              {chip.label}
            </button>
          ))}
        </div>

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
            placeholder="Bir kavram sor, 3D model veya etkileşimli çizim iste... (Enter: Gönder)"
            className="max-h-40 flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
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
              title="Gönder"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </form>
      </div>
      {/* Previous Sessions Popup */}
      {historyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setHistoryOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Önceki sohbet oturumları"
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">Önceki Sohbetler ({sessions.length})</h3>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setHistoryOpen(false);
                    void onCreateSession();
                  }}
                  className="flex items-center gap-1 rounded-lg bg-indigo-600/90 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" /> Yeni Sohbet
                </button>
                <button
                  type="button"
                  title="Kapat (Esc)"
                  onClick={() => setHistoryOpen(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="border-b border-slate-800 px-4 py-2.5">
              <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 text-slate-500" />
                <input
                  autoFocus
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Sohbetlerde ara..."
                  className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 text-[10px] text-slate-500">Her oturum bağımsız bir bağlamdır.</p>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {filteredSessions.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-slate-500">Eşleşen sohbet bulunamadı.</p>
              )}
              {filteredSessions.map((sess) => {
                const isCurrent = sess.id === activeSessionId;
                const isRunning = activeTurnSet.has(sess.id);
                return (
                  <div
                    key={sess.id}
                    className={`group flex items-center gap-2 rounded-xl px-3 py-2 transition ${
                      isCurrent
                        ? 'bg-indigo-500/20 text-white ring-1 ring-indigo-500/40'
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
                          <span className="shrink-0 rounded-full bg-indigo-600/60 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-100">
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
                        title="Oturumu sil"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            sess.messageCount === 0 ||
                            confirm(`"${sess.title}" oturumunu silmek istiyor musun?`)
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
        </div>
      )}
    </section>
  );
};
