import type {
  ActiveTurnSnapshot,
  AgyStatus,
  AnnotationAttachment,
  ChatChannel,
  ChatMessage,
  ChatSession,
  LinkedTreeEntry,
  LocalBrowseResult,
  StudyArtifact,
  StudyMode,
  StudyResource,
  UserPreferences,
  WhiteboardState,
  Workspace,
  WorkspaceDetail,
} from '../types/study';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `İstek başarısız (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface ChatStreamHandlers {
  onUserMessage?: (msg: ChatMessage, sessions?: ChatSession[]) => void;
  onSnapshot?: (snap: { streamingText: string; statusMessage: string; startedAt?: string }) => void;
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
  onSync?: () => void;
  onDone?: (data: {
    message: ChatMessage;
    artifacts: StudyArtifact[];
    whiteboard: WhiteboardState | null;
    conversationId?: string;
    session?: ChatSession;
    sessions?: ChatSession[];
  }) => void;
  onError?: (error: string) => void;
}

async function consumeSseStream(res: Response, handlers: ChatStreamHandlers): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) {
    handlers.onError?.('Akış okuyucusu başlatılamadı.');
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        let eventName = 'message';
        let dataStr = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr += line.slice(5).trim();
          }
        }

        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          if (eventName === 'user_message' && data.message) {
            handlers.onUserMessage?.(data.message, data.sessions);
          } else if (eventName === 'snapshot') {
            handlers.onSnapshot?.(data);
          } else if (eventName === 'status' && data.message) {
            handlers.onStatus?.(data.message);
          } else if (eventName === 'delta' && typeof data.text === 'string') {
            handlers.onDelta?.(data.text);
          } else if (eventName === 'sync') {
            handlers.onSync?.();
          } else if (eventName === 'done') {
            handlers.onDone?.(data);
          } else if (eventName === 'error') {
            handlers.onError?.(data.error || 'AI yanıtında hata oluştu.');
          }
        } catch {
          // ignore malformed event chunk
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    throw err;
  }
}

export interface AgyInstallStreamHandlers {
  onStatus?: (message: string) => void;
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  onDone?: (status: AgyStatus, exitCode: number) => void;
  onError?: (error: string, status?: AgyStatus) => void;
}

export interface AgyLoginLaunchResult {
  launched: boolean;
  manualCommand: string;
  message: string;
}

export const api = {
  getAgyStatus(refresh = false): Promise<AgyStatus> {
    return jsonFetch<AgyStatus>(`/api/agy/status${refresh ? '?refresh=1' : ''}`);
  },

  launchAgyLogin(): Promise<AgyLoginLaunchResult> {
    return jsonFetch<AgyLoginLaunchResult>('/api/agy/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async installAgy(
    handlers: AgyInstallStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const res = await fetch('/api/agy/install', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        signal,
      });

      if (!res.ok) {
        let msg = `Kurulum başlatılamadı (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          // ignore
        }
        handlers.onError?.(msg);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        handlers.onError?.('Kurulum akışı okunamadı.');
        return;
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          let eventName = 'message';
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventName === 'status' && data.message) {
              handlers.onStatus?.(data.message);
            } else if (eventName === 'log' && typeof data.line === 'string') {
              handlers.onLog?.(data.line, data.stream === 'stderr' ? 'stderr' : 'stdout');
            } else if (eventName === 'done' && data.status) {
              handlers.onDone?.(data.status as AgyStatus, Number(data.exitCode ?? 0));
            } else if (eventName === 'error') {
              handlers.onError?.(
                data.error || 'Kurulum sırasında bir hata oluştu.',
                data.status as AgyStatus | undefined,
              );
            }
          } catch {
            // ignore malformed event chunk
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onError?.(err instanceof Error ? err.message : 'Kurulum bağlantısı kesildi.');
    }
  },

  listWorkspaces(): Promise<{ workspaces: Workspace[]; preferences?: UserPreferences }> {
    return jsonFetch('/api/workspaces');
  },

  getWorkspaceDetail(id: string): Promise<WorkspaceDetail> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`);
  },

  createWorkspace(input: {
    title: string;
    subject: string;
    color: string;
    icon: string;
    studyMode?: StudyMode;
    model?: string;
    quickModel?: string;
  }): Promise<WorkspaceDetail> {
    return jsonFetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  updateWorkspace(
    id: string,
    patch: Partial<
      Omit<
        Pick<
          Workspace,
          'title' | 'subject' | 'color' | 'icon' | 'studyMode' | 'model' | 'quickModel' | 'examLanguage'
        >,
        'model' | 'quickModel'
      > & {
        model?: string | null;
        quickModel?: string | null;
      }
    >,
  ): Promise<{ workspace: Workspace }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  deleteWorkspace(id: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async uploadResources(workspaceId: string, files: File[]): Promise<{ resources: StudyResource[] }> {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/resources`, {
      method: 'POST',
      body: form,
    });
  },

  deleteResource(workspaceId: string, resourceId: string): Promise<{ ok: boolean }> {
    return jsonFetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/resources/${encodeURIComponent(resourceId)}`,
      { method: 'DELETE' },
    );
  },

  linkLocalResource(workspaceId: string, localPath: string): Promise<{ resource: StudyResource }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/resources/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: localPath }),
    });
  },

  browseLocal(dirPath?: string): Promise<LocalBrowseResult> {
    const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    return jsonFetch(`/api/fs/browse${qs}`);
  },

  getLinkedTree(
    resource: StudyResource,
  ): Promise<{ root: string; entries: LinkedTreeEntry[]; truncated: boolean }> {
    return jsonFetch(resource.url);
  },

  /** URL of a file inside a linked folder (relative path with forward slashes). */
  linkedFileUrl(resource: StudyResource, relativePath: string): string {
    return `/api/workspaces/${encodeURIComponent(resource.workspaceId)}/linked/${encodeURIComponent(
      resource.id,
    )}/file?path=${encodeURIComponent(relativePath)}`;
  },

  reorderResources(workspaceId: string, order: string[]): Promise<{ resources: StudyResource[] }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/resources/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
  },

  saveAnnotation(
    workspaceId: string,
    dataUrl: string,
    sourceLabel?: string,
  ): Promise<{ annotation: AnnotationAttachment }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, sourceLabel }),
    });
  },

  updateArtifact(
    workspaceId: string,
    artifactId: string,
    content: string,
  ): Promise<{ artifact: StudyArtifact }> {
    return jsonFetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
    );
  },

  saveWhiteboard(workspaceId: string, whiteboard: WhiteboardState): Promise<{ whiteboard: WhiteboardState }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/whiteboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(whiteboard),
    });
  },

  createSession(
    workspaceId: string,
    title?: string,
    channel?: ChatChannel,
  ): Promise<{
    session: ChatSession;
    sessions: ChatSession[];
    activeSessionId: string;
    messages: ChatMessage[];
    activeTurn: ActiveTurnSnapshot | null;
    activeTurnSessionIds: string[];
  }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(title ? { title } : {}),
        ...(channel ? { channel } : {}),
      }),
    });
  },

  selectSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<{
    session: ChatSession;
    sessions: ChatSession[];
    activeSessionId: string;
    messages: ChatMessage[];
    activeTurn: ActiveTurnSnapshot | null;
    activeTurnSessionIds: string[];
  }> {
    return jsonFetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  renameSession(
    workspaceId: string,
    sessionId: string,
    title: string,
  ): Promise<{ session: ChatSession; sessions: ChatSession[] }> {
    return jsonFetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
  },

  deleteSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<{
    sessions: ChatSession[];
    activeSessionId: string;
    messages: ChatMessage[];
    activeTurn: ActiveTurnSnapshot | null;
    activeTurnSessionIds: string[];
  }> {
    return jsonFetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  },

  abortChat(workspaceId: string, sessionId?: string): Promise<{ aborted: boolean }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/chat/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });
  },

  resetSession(
    workspaceId: string,
    sessionId?: string,
    channel?: ChatChannel,
  ): Promise<{ workspace: Workspace; sessions?: ChatSession[] }> {
    return jsonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/reset-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        ...(channel ? { channel } : {}),
      }),
    });
  },

  async streamChat(
    workspaceId: string,
    payload: {
      message: string;
      sessionId?: string;
      studyMode: StudyMode;
      model?: string | null;
      selectedResourceIds?: string[];
      activeArtifactId?: string;
      annotation?: AnnotationAttachment;
      coStudyAction?: 'check-step' | 'hint' | 'visualize-board' | 'fix-artifact';
      artifactError?: string;
      /** Resource ID (or virtual `<folderId>::<innerPath>`) currently open in the viewer. */
      viewingResourceId?: string;
      /** Path of the file the student is currently looking at in the resource viewer. */
      viewingPath?: string;
      /** 1-based page/slide currently shown for `viewingPath`. */
      viewingPage?: number;
      viewingPageCount?: number;
      /** True when the "Sayfa Senkron" mode is on. */
      pageByPage?: boolean;
    },
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (!res.ok) {
        let msg = `Sohbet başlatılamadı (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          // ignore
        }
        handlers.onError?.(msg);
        return;
      }

      await consumeSseStream(res, handlers);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onError?.(err instanceof Error ? err.message : 'Akış bağlantısı kesildi.');
    }
  },

  async attachChatStream(
    workspaceId: string,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<void> {
    try {
      const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/chat/stream${qs}`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal,
      });

      if (!res.ok) return;
      await consumeSseStream(res, handlers);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onError?.(err instanceof Error ? err.message : 'Devam eden akışa bağlanılamadı.');
    }
  },
};
