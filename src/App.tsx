import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  FileText,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Pencil,
  PenTool,
  Sigma,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AnnotationOverlay } from './components/Canvas/AnnotationOverlay';
import { CoStudyWhiteboard } from './components/Canvas/CoStudyWhiteboard';
import { DesktopVersionButton, UpdateBanner } from './components/Desktop/UpdateBanner';
import { QuickChatPopover } from './components/Chat/QuickChatPopover';
import { TutorChatPanel } from './components/Chat/TutorChatPanel';
import { AgySetupModal } from './components/Setup/AgySetupModal';
import { WorkspaceSidebar } from './components/Sidebar/WorkspaceSidebar';
import { ArtifactSandbox, type SandboxHandle } from './components/Stage/ArtifactSandbox';
import { FormulaLabView } from './components/Stage/FormulaLabView';
import { QuizStudio } from './components/Stage/QuizStudio';
import {
  ResourceViewer,
  type RequestedViewerJump,
  type ResourceViewerHandle,
} from './components/Stage/ResourceViewer';
import { api } from './lib/api';
import { folderFileResource } from './lib/fileKinds';
import { isPagedResource, matchStudyResource } from './lib/pageSections';
import {
  fileNameOf,
  getNavigableWorkspaceResources,
  getSameDirFiles,
  type SiblingNavigation,
} from './lib/resourceNavigation';
import type {
  ActiveTurnSnapshot,
  AgyStatus,
  AnnotationAttachment,
  ChatMessage,
  ChatSession,
  ExamLanguage,
  LinkedTreeEntry,
  StudyArtifact,
  StudyMode,
  StudyResource,
  WhiteboardState,
  Workspace,
} from './types/study';

type StageTab = 'artifact' | 'resource' | 'whiteboard' | 'quiz';

const DEFAULT_LEFT_WIDTH = 288;
const DEFAULT_RIGHT_WIDTH = 420;
const MIN_LEFT_WIDTH = 210;
const MAX_LEFT_WIDTH = 480;
const MIN_RIGHT_WIDTH = 300;
const MAX_RIGHT_WIDTH = 720;
const MIN_CENTER_WIDTH = 340;

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  } catch {
    return fallback;
  }
}

interface StoredUiState {
  activeTab?: StageTab;
  activeResourceId?: string | null;
  activeArtifactId?: string | null;
}

const ACTIVE_WORKSPACE_KEY = 'studylab.activeWorkspaceId';
const LAST_MODEL_KEY = 'studylab.lastModel';
const LAST_QUICK_MODEL_KEY = 'studylab.lastQuickModel';

function readStoredModel(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredModel(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

function readUiState(workspaceId: string): StoredUiState {
  try {
    const raw = window.localStorage.getItem(`studylab.ui.${workspaceId}`);
    return raw ? (JSON.parse(raw) as StoredUiState) : {};
  } catch {
    return {};
  }
}

function writeUiState(workspaceId: string, state: StoredUiState): void {
  try {
    window.localStorage.setItem(`studylab.ui.${workspaceId}`, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [resources, setResources] = useState<StudyResource[]>([]);
  const [artifacts, setArtifacts] = useState<StudyArtifact[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTurnSessionIds, setActiveTurnSessionIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [whiteboard, setWhiteboard] = useState<WhiteboardState>({
    strokes: [],
    cards: [],
    updatedAt: new Date().toISOString(),
  });

  const [agyStatus, setAgyStatus] = useState<AgyStatus | null>(null);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const hasAutoPromptedSetupRef = useRef(false);
  const [selectedModel, setSelectedModel] = useState<string>(
    () => readStoredModel(LAST_MODEL_KEY) ?? '',
  );
  const [selectedQuickModel, setSelectedQuickModel] = useState<string>(
    () => readStoredModel(LAST_QUICK_MODEL_KEY) ?? '',
  );
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<StageTab>('artifact');
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [activeResourceId, setActiveResourceId] = useState<string | null>(null);
  // Which file is open inside each linked folder (folder resource id → relative path)
  const [folderSelections, setFolderSelections] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem('studylab.folderSelections');
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  // Cached directory entries for linked folders (used for sibling navigation even when sidebar is closed)
  const [folderTrees, setFolderTrees] = useState<Record<string, LinkedTreeEntry[]>>({});

  // Streaming state (main chat)
  const [isBusy, setIsBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Hızlı Chat (Quick Chat) floating panel state
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  const [quickHasUnread, setQuickHasUnread] = useState(false);
  const [quickSessions, setQuickSessions] = useState<ChatSession[]>([]);
  const [activeQuickSessionId, setActiveQuickSessionId] = useState<string | null>(null);
  const [quickMessages, setQuickMessages] = useState<ChatMessage[]>([]);
  const [quickIsBusy, setQuickIsBusy] = useState(false);
  const [quickStreamingText, setQuickStreamingText] = useState('');
  const [quickStatusText, setQuickStatusText] = useState<string | null>(null);
  const [quickErrorBanner, setQuickErrorBanner] = useState<string | null>(null);

  // Universal Hand-Annotation Overlay state
  const [annotating, setAnnotating] = useState(false);
  const [annotationBaseImage, setAnnotationBaseImage] = useState<string | null>(null);
  const [annotationSourceLabel, setAnnotationSourceLabel] = useState('');

  // Resizable sidebars state
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    readStoredWidth('studylab.leftWidth', DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
  );
  const [rightWidth, setRightWidth] = useState<number>(() =>
    readStoredWidth('studylab.rightWidth', DEFAULT_RIGHT_WIDTH, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH),
  );
  const [leftOpen, setLeftOpen] = useState(() => readStoredFlag('studylab.leftOpen', true));
  const [rightOpen, setRightOpen] = useState(() => readStoredFlag('studylab.rightOpen', true));
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(null);
  // "Sayfa Senkron": page-by-page explanations synced with the resource viewer
  const [pageSync, setPageSync] = useState(() => readStoredFlag('studylab.pageSync', false));
  const [viewerPage, setViewerPage] = useState<{ resourceId: string; page: number; count: number } | null>(
    null,
  );
  const [requestedJump, setRequestedJump] = useState<RequestedViewerJump | null>(null);
  const jumpSeqRef = useRef(0);
  const loadedFolderIdsRef = useRef<Set<string>>(new Set());

  const sandboxRef = useRef<SandboxHandle>(null);
  const resourceViewerRef = useRef<ResourceViewerHandle>(null);
  const whiteboardSaveTimer = useRef<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const quickStreamAbortRef = useRef<AbortController | null>(null);
  const quickChatOpenRef = useRef(quickChatOpen);
  const activeQuickSessionIdRef = useRef(activeQuickSessionId);
  quickChatOpenRef.current = quickChatOpen;
  activeQuickSessionIdRef.current = activeQuickSessionId;

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      quickStreamAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.leftWidth', String(leftWidth));
    } catch {
      // ignore storage errors
    }
  }, [leftWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.rightWidth', String(rightWidth));
    } catch {
      // ignore storage errors
    }
  }, [rightWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.leftOpen', leftOpen ? '1' : '0');
      window.localStorage.setItem('studylab.rightOpen', rightOpen ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }, [leftOpen, rightOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.pageSync', pageSync ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }, [pageSync]);

  // Remember where the user was (tab, open resource, open artifact) per workspace
  const activeWorkspaceId = activeWorkspace?.id;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    writeUiState(activeWorkspaceId, { activeTab, activeResourceId, activeArtifactId });
    try {
      window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    } catch {
      // ignore storage errors
    }
  }, [activeWorkspaceId, activeTab, activeResourceId, activeArtifactId]);

  useEffect(() => {
    try {
      window.localStorage.setItem('studylab.folderSelections', JSON.stringify(folderSelections));
    } catch {
      // ignore storage errors
    }
  }, [folderSelections]);

  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const leftOpenRef = useRef(leftOpen);
  const rightOpenRef = useRef(rightOpen);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;
  leftOpenRef.current = leftOpen;
  rightOpenRef.current = rightOpen;

  const startResize = (side: 'left' | 'right', e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === 'left' ? leftWidthRef.current : rightWidthRef.current;
    setResizingSide(side);

    const handleMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const viewportWidth = window.innerWidth;
      if (side === 'left') {
        const occupiedRight = rightOpenRef.current ? rightWidthRef.current : 0;
        const maxAllowed = Math.min(
          MAX_LEFT_WIDTH,
          Math.max(MIN_LEFT_WIDTH, viewportWidth - occupiedRight - MIN_CENTER_WIDTH),
        );
        const next = Math.min(maxAllowed, Math.max(MIN_LEFT_WIDTH, startWidth + dx));
        setLeftWidth(Math.round(next));
      } else {
        const occupiedLeft = leftOpenRef.current ? leftWidthRef.current : 0;
        const maxAllowed = Math.min(
          MAX_RIGHT_WIDTH,
          Math.max(MIN_RIGHT_WIDTH, viewportWidth - occupiedLeft - MIN_CENTER_WIDTH),
        );
        const next = Math.min(maxAllowed, Math.max(MIN_RIGHT_WIDTH, startWidth - dx));
        setRightWidth(Math.round(next));
      }
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      setResizingSide(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  const attachToActiveTurn = useCallback(
    (workspaceId: string, sessionId: string, activeTurn: ActiveTurnSnapshot | null | undefined) => {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;

      if (!activeTurn) {
        setIsBusy(false);
        setStreamingText('');
        setStatusText(null);
        return;
      }

      setIsBusy(true);
      setStreamingText(activeTurn.streamingText);
      setStatusText(activeTurn.statusMessage);

      const controller = new AbortController();
      streamAbortRef.current = controller;

      void api.attachChatStream(
        workspaceId,
        {
          onSnapshot: (snap) => {
            setStreamingText(snap.streamingText);
            setStatusText(snap.statusMessage);
          },
          onStatus: (status) => {
            setStatusText(status);
          },
          onDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onSync: () => {
            void api.selectSession(workspaceId, sessionId).then((res) => {
              setSessions(res.sessions);
              setMessages(res.messages);
              setActiveTurnSessionIds(res.activeTurnSessionIds);
              setIsBusy(false);
              setStreamingText('');
              setStatusText(null);
            });
          },
          onDone: (data) => {
            setMessages((prev) =>
              prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
            );
            if (data.sessions) {
              setSessions(data.sessions);
            }
            if (data.artifacts && data.artifacts.length > 0) {
              setArtifacts((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const fresh = data.artifacts.filter((a) => !existingIds.has(a.id));
                return [...prev, ...fresh];
              });
              const first = data.artifacts[0];
              setActiveArtifactId(first.id);
              setActiveTab(first.type === 'quiz' ? 'quiz' : 'artifact');
            }
            if (data.whiteboard) {
              setWhiteboard(data.whiteboard);
            }
            setActiveTurnSessionIds((prev) => prev.filter((id) => id !== sessionId));
            setIsBusy(false);
            setStreamingText('');
            setStatusText(null);
          },
          onError: (err) => {
            setErrorBanner(err);
            setActiveTurnSessionIds((prev) => prev.filter((id) => id !== sessionId));
            setIsBusy(false);
            setStreamingText('');
            setStatusText(null);
          },
        },
        controller.signal,
        sessionId,
      );
    },
    [],
  );

  const attachToActiveQuickTurn = useCallback(
    (workspaceId: string, sessionId: string, activeTurn: ActiveTurnSnapshot | null | undefined) => {
      quickStreamAbortRef.current?.abort();
      quickStreamAbortRef.current = null;

      if (!activeTurn) {
        setQuickIsBusy(false);
        setQuickStreamingText('');
        setQuickStatusText(null);
        return;
      }

      setQuickIsBusy(true);
      setQuickStreamingText(activeTurn.streamingText);
      setQuickStatusText(activeTurn.statusMessage);

      const controller = new AbortController();
      quickStreamAbortRef.current = controller;

      void api.attachChatStream(
        workspaceId,
        {
          onSnapshot: (snap) => {
            setQuickStreamingText(snap.streamingText);
            setQuickStatusText(snap.statusMessage);
          },
          onStatus: (status) => {
            setQuickStatusText(status);
          },
          onDelta: (delta) => {
            setQuickStreamingText((prev) => prev + delta);
          },
          onSync: () => {
            void api.selectSession(workspaceId, sessionId).then((res) => {
              setQuickSessions(res.sessions);
              setQuickMessages(res.messages);
              setActiveTurnSessionIds(res.activeTurnSessionIds);
              setQuickIsBusy(false);
              setQuickStreamingText('');
              setQuickStatusText(null);
            });
          },
          onDone: (data) => {
            if (activeQuickSessionIdRef.current === sessionId) {
              setQuickMessages((prev) =>
                prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
              );
            }
            if (data.sessions) {
              setQuickSessions(data.sessions);
            }
            if (data.artifacts && data.artifacts.length > 0) {
              setArtifacts((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const fresh = data.artifacts.filter((a) => !existingIds.has(a.id));
                return [...prev, ...fresh];
              });
              const first = data.artifacts[0];
              setActiveArtifactId(first.id);
              setActiveTab(first.type === 'quiz' ? 'quiz' : 'artifact');
            }
            if (data.whiteboard) {
              setWhiteboard(data.whiteboard);
            }
            setActiveTurnSessionIds((prev) => prev.filter((id) => id !== sessionId));
            setQuickIsBusy(false);
            setQuickStreamingText('');
            setQuickStatusText(null);
            if (!quickChatOpenRef.current) {
              setQuickHasUnread(true);
            }
          },
          onError: (err) => {
            setQuickErrorBanner(err);
            setActiveTurnSessionIds((prev) => prev.filter((id) => id !== sessionId));
            setQuickIsBusy(false);
            setQuickStreamingText('');
            setQuickStatusText(null);
          },
        },
        controller.signal,
        sessionId,
      );
    },
    [],
  );

  const loadWorkspaceDetail = useCallback(
    async (workspaceId: string) => {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      quickStreamAbortRef.current?.abort();
      quickStreamAbortRef.current = null;

      const detail = await api.getWorkspaceDetail(workspaceId);
      setActiveWorkspace(detail.workspace);
      setResources(detail.resources);
      loadedFolderIdsRef.current.clear();
      setFolderTrees({});
      setRequestedJump(null);
      setArtifacts(detail.artifacts);
      setSessions(detail.sessions || []);
      setActiveSessionId(detail.activeSessionId || null);
      setActiveTurnSessionIds(detail.activeTurnSessionIds || []);
      setMessages(detail.messages);
      setQuickSessions(detail.quickSessions || []);
      setActiveQuickSessionId(detail.activeQuickSessionId || null);
      setQuickMessages(detail.quickMessages || []);
      setWhiteboard(detail.whiteboard);
      setSelectedResourceIds(new Set(detail.resources.map((r) => r.id)));
      setErrorBanner(null);
      setQuickErrorBanner(null);
      setQuickHasUnread(false);
      setAnnotating(false);

      // Restore where the user left off in this workspace (if still valid);
      // otherwise choose an initial visible artifact/resource sensibly.
      const saved = readUiState(workspaceId);
      const savedResource = saved.activeResourceId
        ? detail.resources.find((r) => r.id === saved.activeResourceId)
        : undefined;
      const savedArtifact = saved.activeArtifactId
        ? detail.artifacts.find((a) => a.id === saved.activeArtifactId)
        : undefined;
      const validTabs: StageTab[] = ['artifact', 'resource', 'whiteboard', 'quiz'];

      setActiveResourceId(savedResource?.id ?? detail.resources[0]?.id ?? null);

      if (saved.activeTab && validTabs.includes(saved.activeTab)) {
        setActiveTab(saved.activeTab);
        setActiveArtifactId(savedArtifact?.id ?? null);
      } else {
        const latestVisual = [...detail.artifacts]
          .reverse()
          .find((a) => a.type === '3d-scene' || a.type === '2d-canvas' || a.type === 'formula-lab');
        const latestQuiz = [...detail.artifacts].reverse().find((a) => a.type === 'quiz');

        if (latestVisual) {
          setActiveArtifactId(latestVisual.id);
          setActiveTab('artifact');
        } else if (latestQuiz) {
          setActiveArtifactId(latestQuiz.id);
          setActiveTab('quiz');
        } else if (detail.resources[0]) {
          setActiveArtifactId(null);
          setActiveTab('resource');
        } else {
          setActiveArtifactId(null);
          setActiveTab('whiteboard');
        }
      }

      if (detail.activeSessionId) {
        attachToActiveTurn(workspaceId, detail.activeSessionId, detail.activeTurn);
      } else {
        setIsBusy(false);
        setStreamingText('');
        setStatusText(null);
      }

      if (detail.activeQuickSessionId) {
        attachToActiveQuickTurn(workspaceId, detail.activeQuickSessionId, detail.activeQuickTurn);
      } else {
        setQuickIsBusy(false);
        setQuickStreamingText('');
        setQuickStatusText(null);
      }
    },
    [attachToActiveTurn, attachToActiveQuickTurn],
  );

  // Bootstrap workspaces & agy status
  useEffect(() => {
    void api
      .getAgyStatus()
      .then((status) => {
        setAgyStatus(status);
        if (
          !hasAutoPromptedSetupRef.current &&
          (status.state === 'not_installed' || status.state === 'auth_required')
        ) {
          hasAutoPromptedSetupRef.current = true;
          setSetupModalOpen(true);
        }
      })
      .catch(() => {
        setAgyStatus({
          available: false,
          state: 'error',
          installed: false,
          authenticated: false,
          models: [],
          error: 'agy durumuna ulaşılamadı.',
        });
      });

    void api.listWorkspaces().then(({ workspaces: list, preferences }) => {
      setWorkspaces(list);
      let storedId: string | null = null;
      try {
        storedId = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
      } catch {
        // ignore storage errors
      }
      const initial = list.find((w) => w.id === storedId) || list[0];

      // Hydrate last selected models from server preferences (or initial workspace) if localStorage has none yet
      if (readStoredModel(LAST_MODEL_KEY) === null) {
        const hydrated = preferences?.lastModel || initial?.model || '';
        if (hydrated) {
          setSelectedModel(hydrated);
          writeStoredModel(LAST_MODEL_KEY, hydrated);
        }
      }
      if (readStoredModel(LAST_QUICK_MODEL_KEY) === null) {
        const hydratedQuick = preferences?.lastQuickModel || initial?.quickModel || '';
        if (hydratedQuick) {
          setSelectedQuickModel(hydratedQuick);
          writeStoredModel(LAST_QUICK_MODEL_KEY, hydratedQuick);
        }
      }

      if (initial) {
        void loadWorkspaceDetail(initial.id);
      }
    });
  }, [loadWorkspaceDetail]);

  const activeArtifact =
    artifacts.find((a) => a.id === activeArtifactId) ||
    [...artifacts].reverse().find((a) => a.type !== 'quiz') ||
    null;

  const activeQuiz =
    (activeArtifact?.type === 'quiz' ? activeArtifact : null) ||
    [...artifacts].reverse().find((a) => a.type === 'quiz') ||
    null;

  const activeResource =
    resources.find((r) => r.id === activeResourceId) || resources[0] || null;

  // For linked folders, the viewer shows the file picked inside the folder (as its own resource)
  const activeFolderPath =
    activeResource?.category === 'folder' ? folderSelections[activeResource.id] || null : null;
  const displayedResource = useMemo(
    () =>
      activeResource && activeFolderPath
        ? folderFileResource(activeResource, activeFolderPath)
        : activeResource,
    [activeResource, activeFolderPath],
  );

  // Page info of the resource currently in the viewer (null when it has no pages)
  const currentViewerPage =
    viewerPage && displayedResource && viewerPage.resourceId === displayedResource.id && viewerPage.count > 0
      ? viewerPage
      : null;
  const pageSyncAvailable = Boolean(currentViewerPage);

  const handleViewerPageChange = useCallback(
    (page: number, count: number) => {
      const resourceId = displayedResource?.id;
      if (!resourceId) return;
      setViewerPage((prev) =>
        prev && prev.resourceId === resourceId && prev.page === page && prev.count === count
          ? prev
          : { resourceId, page, count },
      );
    },
    [displayedResource?.id],
  );

  const handleRequestViewerPage = useCallback((page: number) => {
    resourceViewerRef.current?.goToPage(page);
  }, []);

  const handleRequestResourcePage = useCallback(
    (resourceId: string | null, page: number) => {
      if (!Number.isFinite(page) || page < 1) return;
      const target = resourceId
        ? matchStudyResource(resourceId, resources, folderTrees)?.resource ?? null
        : displayedResource && displayedResource.category !== 'folder'
          ? displayedResource
          : null;
      if (!target) return;

      if (target.folderId && target.innerPath) {
        const fId = target.folderId;
        const inner = target.innerPath;
        setFolderSelections((prev) => (prev[fId] === inner ? prev : { ...prev, [fId]: inner }));
        setActiveResourceId(fId);
      } else {
        setActiveResourceId(target.id);
      }
      setActiveTab('resource');
      setAnnotating(false);
      setRequestedJump({
        resourceId: target.id,
        page: Math.max(1, Math.floor(page)),
        seq: ++jumpSeqRef.current,
      });
    },
    [resources, folderTrees, displayedResource],
  );

  const handleFolderTreeLoaded = useCallback((folderId: string, entries: LinkedTreeEntry[]) => {
    loadedFolderIdsRef.current.add(folderId);
    setFolderTrees((prev) => ({ ...prev, [folderId]: entries }));
  }, []);

  // Preload linked folder trees so sibling navigation and Sayfa Senkron source matching work even when collapsed
  useEffect(() => {
    const missing = resources.filter(
      (r) => r.category === 'folder' && !folderTrees[r.id] && !loadedFolderIdsRef.current.has(r.id),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    for (const folder of missing) {
      loadedFolderIdsRef.current.add(folder.id);
      void api
        .getLinkedTree(folder)
        .then((res) => {
          if (!cancelled) {
            setFolderTrees((prev) => ({ ...prev, [folder.id]: res.entries }));
          }
        })
        .catch(() => {
          // ignore; SidebarFolderTree shows errors if expanded
        });
    }
    return () => {
      cancelled = true;
    };
  }, [resources, folderTrees]);

  // Sibling navigation for non-PDF resources:
  // - Inside a linked folder: files in the same directory (any extension)
  // - Direct workspace resources: non-folder resources in the sidebar's current order
  const siblingNav = useMemo<SiblingNavigation | undefined>(() => {
    if (!activeResource) return undefined;

    if (activeResource.category === 'folder') {
      if (!activeFolderPath) return undefined;
      const entries = folderTrees[activeResource.id];
      if (!entries) return undefined;
      const sameDir = getSameDirFiles(entries, activeFolderPath);
      const index = sameDir.findIndex((e) => e.path === activeFolderPath);
      if (index < 0 || sameDir.length <= 1) return undefined;
      const folderId = activeResource.id;
      return {
        index,
        total: sameDir.length,
        prevLabel: index > 0 ? fileNameOf(sameDir[index - 1].path) : undefined,
        nextLabel: index < sameDir.length - 1 ? fileNameOf(sameDir[index + 1].path) : undefined,
        onNavigate: (nextIndex: number) => {
          const target = sameDir[nextIndex];
          if (!target) return;
          setFolderSelections((prev) => ({ ...prev, [folderId]: target.path }));
          setActiveResourceId(folderId);
          setActiveTab('resource');
          setAnnotating(false);
        },
      };
    }

    const navigable = getNavigableWorkspaceResources(resources);
    const index = navigable.findIndex((r) => r.id === activeResource.id);
    if (index < 0 || navigable.length <= 1) return undefined;
    return {
      index,
      total: navigable.length,
      prevLabel: index > 0 ? navigable[index - 1].name : undefined,
      nextLabel: index < navigable.length - 1 ? navigable[index + 1].name : undefined,
      onNavigate: (nextIndex: number) => {
        const target = navigable[nextIndex];
        if (!target) return;
        setActiveResourceId(target.id);
        setActiveTab('resource');
        setAnnotating(false);
      },
    };
  }, [activeResource, activeFolderPath, folderTrees, resources]);

  // Resolve effective models against the currently available model list so retired/missing IDs fall back gracefully
  const effectiveModel = useMemo(() => {
    if (!selectedModel) return '';
    if (agyStatus?.models && agyStatus.models.length > 0) {
      return agyStatus.models.some((m) => m.id === selectedModel) ? selectedModel : '';
    }
    return selectedModel;
  }, [selectedModel, agyStatus?.models]);

  const effectiveQuickModel = useMemo(() => {
    if (!selectedQuickModel) return '';
    if (agyStatus?.models && agyStatus.models.length > 0) {
      return agyStatus.models.some((m) => m.id === selectedQuickModel) ? selectedQuickModel : '';
    }
    return selectedQuickModel;
  }, [selectedQuickModel, agyStatus?.models]);

  // --- Workspace & Resource Handlers ---
  const handleCreateWorkspace = async (input: {
    title: string;
    subject: string;
    color: string;
    icon: string;
  }) => {
    const detail = await api.createWorkspace({
      ...input,
      model: effectiveModel || undefined,
      quickModel: effectiveQuickModel || undefined,
    });
    setWorkspaces((prev) => [detail.workspace, ...prev]);
    await loadWorkspaceDetail(detail.workspace.id);
  };

  const handleDeleteWorkspace = async (id: string) => {
    await api.deleteWorkspace(id);
    const remaining = workspaces.filter((w) => w.id !== id);
    setWorkspaces(remaining);
    if (activeWorkspace?.id === id && remaining[0]) {
      await loadWorkspaceDetail(remaining[0].id);
    }
  };

  const handleUploadFiles = async (files: File[]) => {
    if (!activeWorkspace) return;
    const { resources: uploaded } = await api.uploadResources(activeWorkspace.id, files);
    setResources((prev) => [...uploaded, ...prev]);
    setSelectedResourceIds((prev) => {
      const next = new Set(prev);
      for (const r of uploaded) next.add(r.id);
      return next;
    });
    if (uploaded[0]) {
      setActiveResourceId(uploaded[0].id);
      setActiveTab('resource');
    }
  };

  const handleLinkLocal = async (absolutePath: string) => {
    if (!activeWorkspace) return;
    const { resource } = await api.linkLocalResource(activeWorkspace.id, absolutePath);
    setResources((prev) => [resource, ...prev.filter((r) => r.id !== resource.id)]);
    setSelectedResourceIds((prev) => new Set(prev).add(resource.id));
    setActiveResourceId(resource.id);
    setActiveTab('resource');
    setAnnotating(false);
  };

  const handleDeleteResource = async (resourceId: string) => {
    if (!activeWorkspace) return;
    await api.deleteResource(activeWorkspace.id, resourceId);
    loadedFolderIdsRef.current.delete(resourceId);
    setResources((prev) => prev.filter((r) => r.id !== resourceId));
    setFolderTrees((prev) => {
      if (!(resourceId in prev)) return prev;
      const next = { ...prev };
      delete next[resourceId];
      return next;
    });
    setSelectedResourceIds((prev) => {
      const next = new Set(prev);
      next.delete(resourceId);
      return next;
    });
  };

  const handleReorderResources = async (orderedIds: string[]) => {
    if (!activeWorkspace) return;
    const wsId = activeWorkspace.id;
    const previous = resources;
    const byId = new Map(previous.map((r) => [r.id, r]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean) as StudyResource[];
    for (const r of previous) if (!orderedIds.includes(r.id)) next.push(r);
    setResources(next);
    try {
      const { resources: saved } = await api.reorderResources(wsId, orderedIds);
      setResources(saved);
    } catch (err) {
      setResources(previous);
      setErrorBanner(`Kaynak sıralaması kaydedilemedi: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleToggleResourceContext = (resourceId: string) => {
    setSelectedResourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return next;
    });
  };

  // --- Chat & Streaming Handler ---
  const sendTutorTurn = useCallback(
    async (
      message: string,
      opts?: {
        annotation?: AnnotationAttachment;
        coStudyAction?: 'check-step' | 'hint' | 'visualize-board' | 'fix-artifact';
        artifactError?: string;
        studyModeOverride?: StudyMode;
        /** Overrides the "Sayfa Senkron" state for this turn (used right after toggling it on). */
        pageByPageOverride?: boolean;
      },
    ) => {
      if (!activeWorkspace || isBusy) return;
      const pageByPage = opts?.pageByPageOverride ?? pageSync;
      setIsBusy(true);
      setStreamingText('');
      setStatusText('Mesaj gönderiliyor...');
      setErrorBanner(null);

      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      const targetSessionId = activeSessionId || undefined;
      if (targetSessionId) {
        setActiveTurnSessionIds((prev) =>
          prev.includes(targetSessionId) ? prev : [...prev, targetSessionId],
        );
      }

      const hasViewedResource =
        Boolean(displayedResource && displayedResource.category !== 'folder') &&
        (activeTab === 'resource' ||
          Boolean(pageByPage && displayedResource && (currentViewerPage || isPagedResource(displayedResource))));

      await api.streamChat(
        activeWorkspace.id,
        {
          message,
          sessionId: targetSessionId,
          studyMode: opts?.studyModeOverride || activeWorkspace.studyMode,
          model: effectiveModel || null,
          selectedResourceIds: Array.from(selectedResourceIds),
          activeArtifactId: activeArtifact?.id,
          annotation: opts?.annotation,
          coStudyAction: opts?.coStudyAction,
          artifactError: opts?.artifactError,
          viewingResourceId: hasViewedResource && displayedResource ? displayedResource.id : undefined,
          viewingPath:
            hasViewedResource && displayedResource
              ? displayedResource.localPath || displayedResource.relativePath
              : undefined,
          viewingPage:
            hasViewedResource && currentViewerPage ? currentViewerPage.page : undefined,
          viewingPageCount:
            hasViewedResource && currentViewerPage ? currentViewerPage.count : undefined,
          pageByPage: pageByPage ? true : undefined,
        },
        {
          onUserMessage: (msg, updatedSessions) => {
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
            if (updatedSessions) {
              setSessions(updatedSessions);
            }
          },
          onStatus: (status) => {
            setStatusText(status);
          },
          onDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onDone: (data) => {
            setMessages((prev) =>
              prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
            );
            if (data.sessions) {
              setSessions(data.sessions);
            }
            if (data.artifacts && data.artifacts.length > 0) {
              setArtifacts((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const fresh = data.artifacts.filter((a) => !existingIds.has(a.id));
                return [...prev, ...fresh];
              });
              const first = data.artifacts[0];
              setActiveArtifactId(first.id);
              setActiveTab(first.type === 'quiz' ? 'quiz' : 'artifact');
            }
            if (data.whiteboard) {
              setWhiteboard(data.whiteboard);
            }
            if (targetSessionId) {
              setActiveTurnSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
            }
            setIsBusy(false);
            setStreamingText('');
            setStatusText(null);
          },
          onError: (err) => {
            setErrorBanner(err);
            if (/antigravity|agy|oturum|giriş/i.test(err)) {
              void api.getAgyStatus(true).then(setAgyStatus).catch(() => {});
            }
            if (targetSessionId) {
              setActiveTurnSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
            }
            setIsBusy(false);
            setStreamingText('');
            setStatusText(null);
          },
        },
        controller.signal,
      );
    },
    [
      activeWorkspace,
      activeArtifact,
      activeSessionId,
      isBusy,
      selectedResourceIds,
      activeTab,
      displayedResource,
      effectiveModel,
      pageSync,
      currentViewerPage,
    ],
  );

  // --- Hızlı Chat (Quick Chat) Streaming Handler ---
  const sendQuickTurn = useCallback(
    async (
      message: string,
      opts?: {
        annotation?: AnnotationAttachment;
        sessionIdOverride?: string;
      },
    ) => {
      if (!activeWorkspace) return;
      const targetSessionId = opts?.sessionIdOverride || activeQuickSessionId || undefined;
      if (!opts?.sessionIdOverride && quickIsBusy) return;

      setQuickIsBusy(true);
      setQuickStreamingText('');
      setQuickStatusText('Mesaj gönderiliyor...');
      setQuickErrorBanner(null);

      quickStreamAbortRef.current?.abort();
      const controller = new AbortController();
      quickStreamAbortRef.current = controller;

      if (targetSessionId) {
        setActiveTurnSessionIds((prev) =>
          prev.includes(targetSessionId) ? prev : [...prev, targetSessionId],
        );
      }

      await api.streamChat(
        activeWorkspace.id,
        {
          message,
          sessionId: targetSessionId,
          studyMode: activeWorkspace.studyMode,
          model: effectiveQuickModel || null,
          selectedResourceIds: Array.from(selectedResourceIds),
          activeArtifactId: activeArtifact?.id,
          annotation: opts?.annotation,
          viewingPath:
            activeTab === 'resource' && displayedResource
              ? displayedResource.localPath || displayedResource.relativePath
              : undefined,
        },
        {
          onUserMessage: (msg, updatedSessions) => {
            if (!targetSessionId || activeQuickSessionIdRef.current === targetSessionId) {
              setQuickMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
            }
            if (updatedSessions) {
              setQuickSessions(updatedSessions);
            }
          },
          onStatus: (status) => {
            setQuickStatusText(status);
          },
          onDelta: (delta) => {
            setQuickStreamingText((prev) => prev + delta);
          },
          onDone: (data) => {
            if (!targetSessionId || activeQuickSessionIdRef.current === targetSessionId) {
              setQuickMessages((prev) =>
                prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
              );
            }
            if (data.sessions) {
              setQuickSessions(data.sessions);
            }
            if (data.artifacts && data.artifacts.length > 0) {
              setArtifacts((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const fresh = data.artifacts.filter((a) => !existingIds.has(a.id));
                return [...prev, ...fresh];
              });
              const first = data.artifacts[0];
              setActiveArtifactId(first.id);
              setActiveTab(first.type === 'quiz' ? 'quiz' : 'artifact');
            }
            if (data.whiteboard) {
              setWhiteboard(data.whiteboard);
            }
            if (targetSessionId) {
              setActiveTurnSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
            }
            setQuickIsBusy(false);
            setQuickStreamingText('');
            setQuickStatusText(null);
            if (!quickChatOpenRef.current) {
              setQuickHasUnread(true);
            }
          },
          onError: (err) => {
            setQuickErrorBanner(err);
            if (/antigravity|agy|oturum|giriş/i.test(err)) {
              void api.getAgyStatus(true).then(setAgyStatus).catch(() => {});
            }
            if (targetSessionId) {
              setActiveTurnSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
            }
            setQuickIsBusy(false);
            setQuickStreamingText('');
            setQuickStatusText(null);
          },
        },
        controller.signal,
      );
    },
    [
      activeWorkspace,
      activeArtifact,
      activeQuickSessionId,
      quickIsBusy,
      selectedResourceIds,
      activeTab,
      displayedResource,
      effectiveQuickModel,
    ],
  );

  // --- Universal Hand-Annotation Trigger ---
  const handleStartAnnotate = async () => {
    let baseImg: string | null = null;
    let label = 'Çalışma Sahnesi';

    if (activeTab === 'artifact' && activeArtifact) {
      label = activeArtifact.title;
      if (activeArtifact.type === '2d-canvas' || activeArtifact.type === '3d-scene') {
        baseImg = (await sandboxRef.current?.captureSnapshot()) || null;
      }
    } else if (activeTab === 'resource' && displayedResource) {
      label = displayedResource.name;
      baseImg = (await resourceViewerRef.current?.captureBaseImage()) || null;
    }

    setQuickChatOpen(false);
    setAnnotationBaseImage(baseImg);
    setAnnotationSourceLabel(label);
    setAnnotating(true);
  };

  const handleSubmitAnnotation = async (compositeDataUrl: string, questionPrompt: string) => {
    if (!activeWorkspace) return;
    const { annotation } = await api.saveAnnotation(
      activeWorkspace.id,
      compositeDataUrl,
      annotationSourceLabel,
    );
    setAnnotating(false);
    setAnnotationBaseImage(null);
    setQuickChatOpen(true);
    setQuickHasUnread(false);

    let targetQuickSessionId = activeQuickSessionId || undefined;
    if (quickIsBusy || !targetQuickSessionId) {
      quickStreamAbortRef.current?.abort();
      quickStreamAbortRef.current = null;
      const created = await api.createSession(activeWorkspace.id, undefined, 'quick');
      setQuickSessions(created.sessions);
      setActiveQuickSessionId(created.activeSessionId);
      activeQuickSessionIdRef.current = created.activeSessionId;
      setQuickMessages(created.messages);
      setActiveTurnSessionIds(created.activeTurnSessionIds);
      targetQuickSessionId = created.activeSessionId;
    }

    await sendQuickTurn(questionPrompt, {
      annotation,
      sessionIdOverride: targetQuickSessionId,
    });
  };

  // --- Whiteboard Auto-save & Co-Study ---
  const handleChangeWhiteboard = (next: WhiteboardState) => {
    setWhiteboard(next);
    if (!activeWorkspace) return;
    if (whiteboardSaveTimer.current) {
      window.clearTimeout(whiteboardSaveTimer.current);
    }
    const wsId = activeWorkspace.id;
    whiteboardSaveTimer.current = window.setTimeout(() => {
      void api.saveWhiteboard(wsId, next);
    }, 600);
  };

  const handleCoStudyAction = async (
    action: 'check-step' | 'hint' | 'visualize-board',
    boardSnapshotDataUrl: string,
  ) => {
    if (!activeWorkspace) return;
    const { annotation } = await api.saveAnnotation(
      activeWorkspace.id,
      boardSnapshotDataUrl,
      'Ortak Çalışma Tahtası',
    );
    const promptByAction = {
      'check-step': 'Ortak çalışma tahtasına yazdığım adımları inceleyip kontrol eder misin?',
      hint: 'Ortak tahtadaki bu problemde takıldım; cevabı doğrudan vermeden bir sonraki adım için ipucu verir misin?',
      'visualize-board': 'Ortak çalışma tahtasındaki bu problemi daha iyi anlamam için etkileşimli bir 2D veya 3D görselleştirme oluşturur musun?',
    };
    await sendTutorTurn(promptByAction[action], {
      annotation,
      coStudyAction: action,
      studyModeOverride: action === 'hint' ? 'socratic' : undefined,
    });
  };

  const handleSaveArtifactCode = async (artifactId: string, newCode: string) => {
    if (!activeWorkspace) return;
    const { artifact } = await api.updateArtifact(activeWorkspace.id, artifactId, newCode);
    setArtifacts((prev) => prev.map((a) => (a.id === artifact.id ? artifact : a)));
  };

  const handleAutoFixError = (artifact: StudyArtifact, errorMessage: string) => {
    void sendTutorTurn(
      `"${artifact.title}" görselleştirmesinde "${errorMessage}" hatası oluştu. Lütfen hatayı düzeltip çalışan yeni sürümünü oluştur.`,
      { coStudyAction: 'fix-artifact', artifactError: errorMessage },
    );
  };

  const handleChangeMode = (mode: StudyMode) => {
    if (!activeWorkspace) return;
    setActiveWorkspace({ ...activeWorkspace, studyMode: mode });
    void api.updateWorkspace(activeWorkspace.id, { studyMode: mode });
  };

  const handleChangeExamLanguage = (examLanguage: ExamLanguage) => {
    if (!activeWorkspace) return;
    setActiveWorkspace({ ...activeWorkspace, examLanguage });
    setWorkspaces((prev) => prev.map((w) => (w.id === activeWorkspace.id ? { ...w, examLanguage } : w)));
    void api.updateWorkspace(activeWorkspace.id, { examLanguage });
  };

  const handleChangeModel = (model: string) => {
    setSelectedModel(model);
    writeStoredModel(LAST_MODEL_KEY, model);
    if (!activeWorkspace) return;
    const nextModel = model || undefined;
    setActiveWorkspace({ ...activeWorkspace, model: nextModel });
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === activeWorkspace.id ? { ...w, model: nextModel } : w)),
    );
    void api.updateWorkspace(activeWorkspace.id, { model: model || null });
  };

  const handleChangeQuickModel = (model: string) => {
    setSelectedQuickModel(model);
    writeStoredModel(LAST_QUICK_MODEL_KEY, model);
    if (!activeWorkspace) return;
    const nextModel = model || undefined;
    setActiveWorkspace({ ...activeWorkspace, quickModel: nextModel });
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === activeWorkspace.id ? { ...w, quickModel: nextModel } : w)),
    );
    void api.updateWorkspace(activeWorkspace.id, { quickModel: model || null });
  };

  const handleResetSession = async () => {
    if (!activeWorkspace) return;
    const { workspace, sessions: nextSessions } = await api.resetSession(
      activeWorkspace.id,
      activeSessionId || undefined,
      'main',
    );
    setActiveWorkspace(workspace);
    if (nextSessions) setSessions(nextSessions);
    setStatusText(null);
  };

  const handleCreateSession = async () => {
    if (!activeWorkspace) return;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    const res = await api.createSession(activeWorkspace.id, undefined, 'main');
    setSessions(res.sessions);
    setActiveSessionId(res.activeSessionId);
    setMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    setIsBusy(false);
    setStreamingText('');
    setStatusText(null);
    setErrorBanner(null);
  };

  const handleSelectSession = async (sessionId: string) => {
    if (!activeWorkspace) return;
    const res = await api.selectSession(activeWorkspace.id, sessionId);
    setSessions(res.sessions);
    setActiveSessionId(res.activeSessionId);
    setMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    setErrorBanner(null);
    attachToActiveTurn(activeWorkspace.id, res.activeSessionId, res.activeTurn);
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!activeWorkspace) return;
    const res = await api.deleteSession(activeWorkspace.id, sessionId);
    setSessions(res.sessions);
    setActiveSessionId(res.activeSessionId);
    setMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    attachToActiveTurn(activeWorkspace.id, res.activeSessionId, res.activeTurn);
  };

  // --- Hızlı Chat Session Handlers ---
  const handleResetQuickSession = async () => {
    if (!activeWorkspace) return;
    const { sessions: nextSessions } = await api.resetSession(
      activeWorkspace.id,
      activeQuickSessionId || undefined,
      'quick',
    );
    if (nextSessions) setQuickSessions(nextSessions);
    setQuickStatusText(null);
  };

  const handleCreateQuickSession = async () => {
    if (!activeWorkspace) return;
    quickStreamAbortRef.current?.abort();
    quickStreamAbortRef.current = null;
    const res = await api.createSession(activeWorkspace.id, undefined, 'quick');
    setQuickSessions(res.sessions);
    setActiveQuickSessionId(res.activeSessionId);
    activeQuickSessionIdRef.current = res.activeSessionId;
    setQuickMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    setQuickIsBusy(false);
    setQuickStreamingText('');
    setQuickStatusText(null);
    setQuickErrorBanner(null);
    setQuickChatOpen(true);
    setQuickHasUnread(false);
  };

  const handleSelectQuickSession = async (sessionId: string) => {
    if (!activeWorkspace) return;
    const res = await api.selectSession(activeWorkspace.id, sessionId);
    setQuickSessions(res.sessions);
    setActiveQuickSessionId(res.activeSessionId);
    activeQuickSessionIdRef.current = res.activeSessionId;
    setQuickMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    setQuickErrorBanner(null);
    attachToActiveQuickTurn(activeWorkspace.id, res.activeSessionId, res.activeTurn);
  };

  const handleDeleteQuickSession = async (sessionId: string) => {
    if (!activeWorkspace) return;
    const res = await api.deleteSession(activeWorkspace.id, sessionId);
    setQuickSessions(res.sessions);
    setActiveQuickSessionId(res.activeSessionId);
    activeQuickSessionIdRef.current = res.activeSessionId;
    setQuickMessages(res.messages);
    setActiveTurnSessionIds(res.activeTurnSessionIds);
    attachToActiveQuickTurn(activeWorkspace.id, res.activeSessionId, res.activeTurn);
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <UpdateBanner />
      <div
        className={`relative flex min-h-0 flex-1 overflow-hidden bg-slate-950 text-slate-100 ${
          resizingSide ? 'cursor-col-resize select-none' : ''
        }`}
      >
      {/* Left Sidebar: Workspaces, Resources, Saved Artifacts */}
      {leftOpen && (
        <>
          <WorkspaceSidebar
            width={leftWidth}
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            resources={resources}
            artifacts={artifacts}
            selectedResourceIds={selectedResourceIds}
            activeArtifactId={activeArtifact?.id || null}
            activeResourceId={activeResource?.id || null}
            activeFolderPath={activeFolderPath}
            onOpenFolderFile={(folder, rel) => {
              setFolderSelections((prev) => ({ ...prev, [folder.id]: rel }));
              setActiveResourceId(folder.id);
              setActiveTab('resource');
              setAnnotating(false);
            }}
            onFolderTreeLoaded={handleFolderTreeLoaded}
            onSelectWorkspace={(id) => void loadWorkspaceDetail(id)}
            onCreateWorkspace={handleCreateWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
            onUploadFiles={handleUploadFiles}
            onToggleResourceContext={handleToggleResourceContext}
            onOpenResource={(res) => {
              setActiveResourceId(res.id);
              setActiveTab('resource');
              setAnnotating(false);
            }}
            onDeleteResource={handleDeleteResource}
            onReorderResources={(order) => void handleReorderResources(order)}
            onLinkLocal={handleLinkLocal}
            onOpenArtifact={(art) => {
              setActiveArtifactId(art.id);
              setActiveTab(art.type === 'quiz' ? 'quiz' : 'artifact');
              setAnnotating(false);
            }}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Sol menü genişliğini ayarla"
            title="Sürükleyerek genişlet/daralt • Çift tıkla: varsayılan genişlik"
            onPointerDown={(e) => startResize('left', e)}
            onDoubleClick={() => setLeftWidth(DEFAULT_LEFT_WIDTH)}
            className={`group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center transition-colors ${
              resizingSide === 'left'
                ? 'bg-indigo-500/70'
                : 'bg-slate-800/80 hover:bg-indigo-500/60'
            }`}
          >
            <span
              className={`h-10 w-0.5 rounded-full transition-colors ${
                resizingSide === 'left'
                  ? 'bg-white'
                  : 'bg-slate-600 group-hover:bg-indigo-200'
              }`}
            />
          </div>
        </>
      )}

      {/* Center Interactive Stage */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-slate-950">
        {/* Stage Tab Bar */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/80 px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLeftOpen((o) => !o)}
              title={leftOpen ? 'Sol menüyü gizle' : 'Sol menüyü göster'}
              className={`rounded-lg border p-1.5 transition ${
                leftOpen
                  ? 'border-slate-700/80 bg-slate-900 text-slate-300 hover:border-indigo-500 hover:text-white'
                  : 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
              }`}
            >
              <PanelLeft className="h-4 w-4" />
            </button>

            <div className="flex items-center gap-1 rounded-xl bg-slate-950 p-1 ring-1 ring-slate-800">
            <button
              type="button"
              onClick={() => {
                setActiveTab('artifact');
                setAnnotating(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'artifact'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {activeArtifact?.type === 'formula-lab' ? (
                <Sigma className="h-3.5 w-3.5" />
              ) : (
                <Box className="h-3.5 w-3.5" />
              )}
              Etkileşimli Sahne
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('resource');
                setAnnotating(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'resource'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Kaynaklar ({resources.length})
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('whiteboard');
                setAnnotating(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'whiteboard'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <PenTool className="h-3.5 w-3.5" />
              Ortak Tahta
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('quiz');
                setAnnotating(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'quiz'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <HelpCircle className="h-3.5 w-3.5" />
              Alıştırma
            </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <DesktopVersionButton />
            {/* Hızlı Chat Controls (left of the icon-only Annotate button) */}
            <div className="flex items-center gap-1 rounded-xl bg-slate-950/90 p-0.5 ring-1 ring-slate-800">
              <button
                type="button"
                onClick={() => {
                  setQuickChatOpen((prev) => {
                    const next = !prev;
                    if (next) setQuickHasUnread(false);
                    return next;
                  });
                }}
                title={quickChatOpen ? "Hızlı Chat'i gizle" : "Hızlı Chat'i aç"}
                aria-label="Hızlı Chat"
                aria-expanded={quickChatOpen}
                className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  quickChatOpen
                    ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/50'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-amber-200'
                }`}
              >
                {quickIsBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-300" />
                ) : (
                  <Zap className="h-3.5 w-3.5 text-amber-300" />
                )}
                <span>Hızlı Chat</span>
                {quickHasUnread && !quickChatOpen && (
                  <span
                    aria-label="Yeni yanıt var"
                    className="h-2 w-2 rounded-full bg-amber-400 shadow-sm shadow-amber-400/60"
                  />
                )}
              </button>

              <button
                type="button"
                onClick={() => void handleCreateQuickSession()}
                title="Yeni Hızlı Sohbet (temiz bağlam)"
                aria-label="Yeni Hızlı Sohbet"
                className="flex items-center justify-center rounded-lg p-1 text-slate-300 transition hover:bg-amber-500/20 hover:text-amber-200"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Universal Hand-Annotation Shortcut (Icon-only) */}
            {activeTab !== 'whiteboard' && (
              <button
                type="button"
                onClick={() => void handleStartAnnotate()}
                title="Elle İşaretle & Sor (Hızlı Chat)"
                aria-label="Elle İşaretle & Sor"
                className="flex items-center justify-center rounded-lg bg-gradient-to-r from-rose-500/25 to-indigo-500/25 p-1.5 text-rose-200 ring-1 ring-rose-500/40 transition hover:from-rose-500/35 hover:to-indigo-500/35 hover:text-white"
              >
                <Pencil className="h-4 w-4 text-rose-300" />
              </button>
            )}

            <button
              type="button"
              onClick={() => setRightOpen((o) => !o)}
              title={rightOpen ? 'Sağ sohbet panelini gizle' : 'Sağ sohbet panelini göster'}
              className={`rounded-lg border p-1.5 transition ${
                rightOpen
                  ? 'border-slate-700/80 bg-slate-900 text-slate-300 hover:border-indigo-500 hover:text-white'
                  : 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
              }`}
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Active Stage View */}
        <div className="relative flex-1 overflow-hidden">
          {activeTab === 'artifact' && (
            <>
              {activeArtifact && (activeArtifact.type === '2d-canvas' || activeArtifact.type === '3d-scene') && (
                <ArtifactSandbox
                  ref={sandboxRef}
                  artifact={activeArtifact}
                  onStartAnnotate={() => void handleStartAnnotate()}
                  onAutoFixError={handleAutoFixError}
                  onSaveCode={handleSaveArtifactCode}
                />
              )}
              {activeArtifact && activeArtifact.type === 'formula-lab' && (
                <FormulaLabView
                  artifact={activeArtifact}
                  onAskQuestion={(q) => void sendTutorTurn(q)}
                  onStartAnnotate={() => void handleStartAnnotate()}
                />
              )}
              {(!activeArtifact || activeArtifact.type === 'quiz') && (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-400 ring-1 ring-indigo-500/30">
                    <Sparkles className="h-7 w-7" />
                  </div>
                  <h3 className="text-base font-bold text-white">Henüz Canlı Görselleştirme Yok</h3>
                  <p className="max-w-md text-xs leading-relaxed text-slate-400">
                    Sağdaki sohbetten Gemini’den herhangi bir formülü, fizik olayını veya geometri konusunu
                    etkileşimli 2D çizim ya da 3D model olarak göstermesini isteyebilirsin.
                  </p>
                </div>
              )}
            </>
          )}

          {activeResource ? (
            <div className={activeTab === 'resource' ? 'h-full w-full' : 'hidden'}>
              <ResourceViewer
                ref={resourceViewerRef}
                resource={displayedResource!}
                siblingNav={siblingNav}
                isActive={activeTab === 'resource' && !annotating}
                requestedJump={requestedJump}
                onStartAnnotate={() => void handleStartAnnotate()}
                onPageChange={handleViewerPageChange}
              />
            </div>
          ) : (
            activeTab === 'resource' && (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-xs text-slate-400">
                <FileText className="h-8 w-8 text-slate-600" />
                <p>Sol panelden PDF, ders fotoğrafı veya not yükleyerek burada inceleyebilir ve üzerini işaretleyebilirsin.</p>
              </div>
            )
          )}

          {activeTab === 'whiteboard' && (
            <CoStudyWhiteboard
              whiteboard={whiteboard}
              viewStorageKey={activeWorkspace ? `studylab.whiteboardView.${activeWorkspace.id}` : undefined}
              isBusy={isBusy}
              onChangeWhiteboard={handleChangeWhiteboard}
              onCoStudyAction={handleCoStudyAction}
            />
          )}

          {activeTab === 'quiz' && (
            <>
              {activeQuiz ? (
                <QuizStudio
                  artifact={activeQuiz}
                  onAskQuestion={(q) => void sendTutorTurn(q)}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-xs text-slate-400">
                  <HelpCircle className="h-8 w-8 text-slate-600" />
                  <p>Bu çalışma alanında henüz etkileşimli alıştırma yok. Sohbetten “Alıştırma oluştur” diyerek hemen üretebilirsin.</p>
                </div>
              )}
            </>
          )}

          {/* Universal Hand-Annotation Overlay */}
          {annotating && (
            <AnnotationOverlay
              baseImageDataUrl={annotationBaseImage}
              sourceLabel={annotationSourceLabel}
              quickChatBusy={quickIsBusy}
              onCancel={() => {
                setAnnotating(false);
                setAnnotationBaseImage(null);
              }}
              onSubmitAnnotation={handleSubmitAnnotation}
            />
          )}

          {/* Floating Hızlı Chat (Quick Chat) Popover */}
          <QuickChatPopover
            open={quickChatOpen}
            workspace={activeWorkspace}
            agyStatus={agyStatus}
            selectedQuickModel={effectiveQuickModel}
            sessions={quickSessions}
            activeSessionId={activeQuickSessionId}
            activeTurnSessionIds={activeTurnSessionIds}
            messages={quickMessages}
            artifacts={artifacts}
            streamingText={quickStreamingText}
            statusText={quickStatusText}
            isBusy={quickIsBusy}
            errorBanner={quickErrorBanner}
            onClose={() => setQuickChatOpen(false)}
            onSendMessage={(msg) => sendQuickTurn(msg)}
            onAbort={async () => {
              if (activeWorkspace) {
                await api.abortChat(activeWorkspace.id, activeQuickSessionId || undefined);
              }
            }}
            onChangeQuickModel={handleChangeQuickModel}
            onResetSession={handleResetQuickSession}
            onCreateSession={handleCreateQuickSession}
            onSelectSession={handleSelectQuickSession}
            onDeleteSession={handleDeleteQuickSession}
            onOpenArtifact={(art) => {
              setActiveArtifactId(art.id);
              setActiveTab(art.type === 'quiz' ? 'quiz' : 'artifact');
            }}
            onRefreshAgy={() => {
              void api.getAgyStatus(true).then(setAgyStatus);
            }}
            onOpenAgySetup={() => setSetupModalOpen(true)}
          />
        </div>
      </main>

      {/* Right Panel: Streaming Gemini AI Tutor */}
      {rightOpen && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Sağ sohbet paneli genişliğini ayarla"
            title="Sürükleyerek genişlet/daralt • Çift tıkla: varsayılan genişlik"
            onPointerDown={(e) => startResize('right', e)}
            onDoubleClick={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
            className={`group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center transition-colors ${
              resizingSide === 'right'
                ? 'bg-indigo-500/70'
                : 'bg-slate-800/80 hover:bg-indigo-500/60'
            }`}
          >
            <span
              className={`h-10 w-0.5 rounded-full transition-colors ${
                resizingSide === 'right'
                  ? 'bg-white'
                  : 'bg-slate-600 group-hover:bg-indigo-200'
              }`}
            />
          </div>
          <TutorChatPanel
            width={rightWidth}
            workspace={activeWorkspace}
            agyStatus={agyStatus}
            selectedModel={effectiveModel}
            sessions={sessions}
            activeSessionId={activeSessionId}
            activeTurnSessionIds={activeTurnSessionIds}
            messages={messages}
            artifacts={artifacts}
            resources={resources}
            folderTrees={folderTrees}
            displayedResource={displayedResource}
            isResourceTabActive={activeTab === 'resource'}
            streamingText={streamingText}
            statusText={statusText}
            isBusy={isBusy}
            errorBanner={errorBanner}
            onSendMessage={(msg, opts) => sendTutorTurn(msg, { pageByPageOverride: opts?.pageByPage })}
            pageSync={pageSync}
            pageSyncAvailable={pageSyncAvailable}
            activePage={pageSync && activeTab === 'resource' ? currentViewerPage?.page ?? null : null}
            activeResourceId={activeTab === 'resource' ? displayedResource?.id ?? null : null}
            onRequestPage={handleRequestViewerPage}
            onRequestResourcePage={handleRequestResourcePage}
            onTogglePageSync={(next) => {
              setPageSync(next);
            }}
            onAbort={async () => {
              if (activeWorkspace) {
                await api.abortChat(activeWorkspace.id, activeSessionId || undefined);
              }
            }}
            onChangeMode={handleChangeMode}
            onChangeModel={handleChangeModel}
            onChangeExamLanguage={handleChangeExamLanguage}
            onResetSession={handleResetSession}
            onCreateSession={handleCreateSession}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onOpenArtifact={(art) => {
              setActiveArtifactId(art.id);
              setActiveTab(art.type === 'quiz' ? 'quiz' : 'artifact');
            }}
            onRefreshAgy={() => {
              void api.getAgyStatus(true).then(setAgyStatus);
            }}
            onOpenAgySetup={() => setSetupModalOpen(true)}
          />
        </>
      )}

      {/* Antigravity (agy) Onboarding & Login Wizard */}
      <AgySetupModal
        open={setupModalOpen}
        agyStatus={agyStatus}
        onClose={() => setSetupModalOpen(false)}
        onStatusChange={setAgyStatus}
      />

      {/* Transparent iframe-safe drag shield while resizing */}
      {resizingSide && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </div>
    </div>
  );
}
