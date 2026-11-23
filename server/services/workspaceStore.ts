import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type {
  AnnotationAttachment,
  BoardCard,
  ChatChannel,
  ChatMessage,
  ChatSession,
  StudyArtifact,
  StudyMode,
  StudyResource,
  UserPreferences,
  WhiteboardState,
  Workspace,
  WorkspaceDetail,
} from '../../src/types/study.js';
import {
  buildDemoWorkspaceSeed,
  DEMO_STUDY_NOTE,
  DEMO_WORKSPACE_ID,
} from './demoSeed.js';
import { detectResourceCategory, readSample } from './localFiles.js';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${uuidv4().slice(0, 8)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function sanitizeFilename(original: string): string {
  const ext = path.extname(original);
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-\u00C0-\u024F\u011E\u011F\u0130\u0131\u015E\u015F]/g, '_');
  const safeBase = base.slice(0, 64) || 'dosya';
  return `${Date.now()}-${safeBase}${ext.toLowerCase()}`;
}

export class WorkspaceStore {
  public readonly rootDir: string;
  private readonly prefsFile: string;

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, 'workspaces');
    this.prefsFile = path.join(dataDir, 'preferences.json');
  }

  async getPreferences(): Promise<UserPreferences> {
    return readJson<UserPreferences>(this.prefsFile, {});
  }

  async updatePreferences(patch: {
    lastModel?: string | null;
    lastQuickModel?: string | null;
  }): Promise<UserPreferences> {
    const existing = await this.getPreferences();
    const next: UserPreferences = { ...existing };
    if ('lastModel' in patch) {
      next.lastModel = patch.lastModel || undefined;
    }
    if ('lastQuickModel' in patch) {
      next.lastQuickModel = patch.lastQuickModel || undefined;
    }
    await writeJsonAtomic(this.prefsFile, next);
    return next;
  }

  async init(seedDemo = true): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    if (seedDemo) {
      const existing = await this.listWorkspaces();
      if (existing.length === 0) {
        await this.seedDemoWorkspace();
      }
    }
  }

  getWorkspaceDir(workspaceId: string): string {
    const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId || safeId !== workspaceId) {
      throw new Error('Geçersiz çalışma alanı kimliği.');
    }
    return path.join(this.rootDir, safeId);
  }

  private async ensureWorkspaceFolders(workspaceId: string): Promise<string> {
    const dir = this.getWorkspaceDir(workspaceId);
    await Promise.all([
      fs.mkdir(path.join(dir, 'resources'), { recursive: true }),
      fs.mkdir(path.join(dir, 'annotations'), { recursive: true }),
      fs.mkdir(path.join(dir, 'artifacts'), { recursive: true }),
      fs.mkdir(path.join(dir, 'sessions'), { recursive: true }),
    ]);
    return dir;
  }

  private getSessionFilePath(workspaceId: string, sessionId: string): string {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeSessionId || safeSessionId !== sessionId) {
      throw new Error('Geçersiz oturum kimliği.');
    }
    return path.join(this.getWorkspaceDir(workspaceId), 'sessions', `${safeSessionId}.json`);
  }

  private deriveTitleFromMessage(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Yeni Sohbet';
    return cleaned.length > 48 ? `${cleaned.slice(0, 48).trimEnd()}…` : cleaned;
  }

  private getSessionChannel(session: Pick<ChatSession, 'channel'>): ChatChannel {
    return session.channel === 'quick' ? 'quick' : 'main';
  }

  /**
   * Ensures every workspace has `sessions/index.json` initialized for the requested channel.
   * Losslessly migrates legacy `chat.json` + `workspace.agyConversationId` into the initial main session.
   */
  private async ensureSessionsReady(
    workspaceId: string,
    channel: ChatChannel = 'main',
  ): Promise<{
    sessions: ChatSession[];
    allSessions: ChatSession[];
    activeSessionId: string;
  }> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const indexPath = path.join(dir, 'sessions', 'index.json');
    let allSessions = await readJson<ChatSession[]>(indexPath, []);
    const workspace = await this.getWorkspace(workspaceId);
    let indexChanged = false;

    const hasMain = allSessions.some((s) => this.getSessionChannel(s) === 'main');
    if (channel === 'main' && !hasMain) {
      const legacyMessages = await readJson<ChatMessage[]>(path.join(dir, 'chat.json'), []);
      const firstUser = legacyMessages.find((m) => m.role === 'user');
      const now = workspace?.updatedAt || new Date().toISOString();
      const createdAt = workspace?.createdAt || now;
      const initialId = 'sess-initial';

      const initialSession: ChatSession = {
        id: initialId,
        title: firstUser ? this.deriveTitleFromMessage(firstUser.content) : 'İlk Oturum',
        channel: 'main',
        agyConversationId: workspace?.agyConversationId,
        messageCount: legacyMessages.length,
        createdAt,
        updatedAt: now,
      };

      allSessions = [initialSession, ...allSessions];
      await writeJsonAtomic(this.getSessionFilePath(workspaceId, initialId), legacyMessages);
      indexChanged = true;
    }

    const hasQuick = allSessions.some((s) => this.getSessionChannel(s) === 'quick');
    if (channel === 'quick' && !hasQuick) {
      const now = new Date().toISOString();
      const initialQuickId = 'qsess-initial';
      const initialQuick: ChatSession = {
        id: initialQuickId,
        title: 'Hızlı Sohbet',
        channel: 'quick',
        agyConversationId: undefined,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      allSessions = [...allSessions, initialQuick];
      await writeJsonAtomic(this.getSessionFilePath(workspaceId, initialQuickId), []);
      indexChanged = true;
    }

    allSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (indexChanged) {
      await writeJsonAtomic(indexPath, allSessions);
    }

    const channelSessions = allSessions.filter((s) => this.getSessionChannel(s) === channel);
    const activeField = channel === 'quick' ? 'activeQuickSessionId' : 'activeSessionId';
    const currentActive = workspace?.[activeField];
    const activeSessionId =
      currentActive && channelSessions.some((s) => s.id === currentActive)
        ? currentActive
        : channelSessions[0].id;

    if (workspace && workspace[activeField] !== activeSessionId) {
      await this.updateWorkspace(workspaceId, { [activeField]: activeSessionId });
    }

    return { sessions: channelSessions, allSessions, activeSessionId };
  }

  async seedDemoWorkspace(): Promise<Workspace> {
    const seed = buildDemoWorkspaceSeed();
    const dir = await this.ensureWorkspaceFolders(seed.workspace.id);

    await writeJsonAtomic(path.join(dir, 'workspace.json'), seed.workspace);
    await writeJsonAtomic(path.join(dir, 'chat.json'), seed.messages);
    await writeJsonAtomic(path.join(dir, 'artifacts', 'index.json'), seed.artifacts);

    const noteFilename = 'ders_notu_01_lorentz.md';
    await fs.writeFile(path.join(dir, 'resources', noteFilename), DEMO_STUDY_NOTE, 'utf-8');
    const noteStat = await fs.stat(path.join(dir, 'resources', noteFilename));

    const demoResource: StudyResource = {
      id: 'demo-res-note',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Ders Notu 01 — Lorentz Kuvveti.md',
      storedName: noteFilename,
      mimeType: 'text/markdown',
      size: noteStat.size,
      category: 'note',
      url: `/api/workspaces/${DEMO_WORKSPACE_ID}/resources/${encodeURIComponent(noteFilename)}`,
      relativePath: `resources/${noteFilename}`,
      uploadedAt: seed.workspace.createdAt,
    };
    await writeJsonAtomic(path.join(dir, 'resources', 'index.json'), [demoResource]);

    const whiteboard: WhiteboardState = {
      strokes: [],
      cards: seed.cards,
      updatedAt: seed.workspace.createdAt,
    };
    await writeJsonAtomic(path.join(dir, 'whiteboard.json'), whiteboard);

    return seed.workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const workspaces: Workspace[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsFile = path.join(this.rootDir, entry.name, 'workspace.json');
      if (await exists(wsFile)) {
        const ws = await readJson<Workspace | null>(wsFile, null);
        if (ws) workspaces.push(ws);
      }
    }

    return workspaces.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const dir = this.getWorkspaceDir(workspaceId);
    return readJson<Workspace | null>(path.join(dir, 'workspace.json'), null);
  }

  async getWorkspaceDetail(
    workspaceId: string,
    requestedSessionId?: string,
  ): Promise<WorkspaceDetail | null> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) return null;

    // Initialize main & quick channels sequentially so index.json/workspace.json writes never race
    const mainReady = await this.ensureSessionsReady(workspaceId, 'main');
    const quickReady = await this.ensureSessionsReady(workspaceId, 'quick');

    const activeSessionId =
      requestedSessionId && mainReady.sessions.some((s) => s.id === requestedSessionId)
        ? requestedSessionId
        : mainReady.activeSessionId;

    if (
      requestedSessionId &&
      activeSessionId === requestedSessionId &&
      workspace.activeSessionId !== activeSessionId
    ) {
      await this.updateWorkspace(workspaceId, { activeSessionId });
    }

    const activeQuickSessionId = quickReady.activeSessionId;

    const [resources, artifacts, messages, quickMessages, whiteboard, refreshedWorkspace] =
      await Promise.all([
        this.listResources(workspaceId),
        this.listArtifacts(workspaceId),
        this.listMessages(workspaceId, activeSessionId),
        this.listMessages(workspaceId, activeQuickSessionId),
        this.getWhiteboard(workspaceId),
        this.getWorkspace(workspaceId),
      ]);

    return {
      workspace: refreshedWorkspace || workspace,
      resources,
      artifacts,
      sessions: mainReady.sessions,
      activeSessionId,
      messages,
      quickSessions: quickReady.sessions,
      activeQuickSessionId,
      quickMessages,
      whiteboard,
    };
  }

  async createWorkspace(input: {
    title: string;
    subject?: string;
    color?: string;
    icon?: string;
    studyMode?: StudyMode;
    model?: string | null;
    quickModel?: string | null;
    examLanguage?: Workspace['examLanguage'];
  }): Promise<Workspace> {
    const now = new Date().toISOString();
    const id = `ws-${uuidv4().slice(0, 8)}`;
    const prefs = await this.getPreferences();
    const resolvedModel =
      input.model !== undefined ? input.model || undefined : prefs.lastModel;
    const resolvedQuickModel =
      input.quickModel !== undefined ? input.quickModel || undefined : prefs.lastQuickModel;

    const workspace: Workspace = {
      id,
      title: input.title.trim(),
      subject: (input.subject || 'Genel Ders').trim(),
      color: input.color || '#6366f1',
      icon: input.icon || 'book',
      studyMode: input.studyMode || 'visual',
      model: resolvedModel,
      quickModel: resolvedQuickModel,
      examLanguage: input.examLanguage,
      createdAt: now,
      updatedAt: now,
    };

    const dir = await this.ensureWorkspaceFolders(id);
    await Promise.all([
      writeJsonAtomic(path.join(dir, 'workspace.json'), workspace),
      writeJsonAtomic(path.join(dir, 'chat.json'), []),
      writeJsonAtomic(path.join(dir, 'resources', 'index.json'), []),
      writeJsonAtomic(path.join(dir, 'artifacts', 'index.json'), []),
      writeJsonAtomic(path.join(dir, 'whiteboard.json'), {
        strokes: [],
        cards: [],
        updatedAt: now,
      } satisfies WhiteboardState),
    ]);

    return workspace;
  }

  async updateWorkspace(
    workspaceId: string,
    patch: Partial<
      Omit<
        Pick<
          Workspace,
          | 'title'
          | 'subject'
          | 'color'
          | 'icon'
          | 'studyMode'
          | 'model'
          | 'quickModel'
          | 'examLanguage'
          | 'agyConversationId'
          | 'activeSessionId'
          | 'activeQuickSessionId'
        >,
        'model' | 'quickModel'
      > & {
        model?: string | null;
        quickModel?: string | null;
      }
    >,
  ): Promise<Workspace | null> {
    const existing = await this.getWorkspace(workspaceId);
    if (!existing) return null;

    const normalized: Partial<Workspace> = {
      ...(patch as Partial<Workspace>),
    };
    if ('model' in patch) {
      normalized.model = patch.model || undefined;
    }
    if ('quickModel' in patch) {
      normalized.quickModel = patch.quickModel || undefined;
    }

    const updated: Workspace = {
      ...existing,
      ...normalized,
      updatedAt: new Date().toISOString(),
    };
    const dir = this.getWorkspaceDir(workspaceId);
    await writeJsonAtomic(path.join(dir, 'workspace.json'), updated);

    if ('model' in patch || 'quickModel' in patch) {
      await this.updatePreferences({
        ...('model' in patch ? { lastModel: patch.model ?? null } : {}),
        ...('quickModel' in patch ? { lastQuickModel: patch.quickModel ?? null } : {}),
      });
    }

    return updated;
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const dir = this.getWorkspaceDir(workspaceId);
    if (!(await exists(dir))) return false;
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }

  // --- Resources ---
  async listResources(workspaceId: string): Promise<StudyResource[]> {
    const dir = this.getWorkspaceDir(workspaceId);
    return readJson<StudyResource[]>(path.join(dir, 'resources', 'index.json'), []);
  }

  async addResource(
    workspaceId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<StudyResource> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const storedName = sanitizeFilename(file.originalname);
    const fullPath = path.join(dir, 'resources', storedName);
    await fs.writeFile(fullPath, file.buffer);

    const resource: StudyResource = {
      id: uuidv4(),
      workspaceId,
      name: file.originalname,
      storedName,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      category: detectResourceCategory(file.mimetype || '', file.originalname, file.buffer.subarray(0, 8192)),
      url: `/api/workspaces/${workspaceId}/resources/${encodeURIComponent(storedName)}`,
      relativePath: `resources/${storedName}`,
      uploadedAt: new Date().toISOString(),
    };

    const list = await this.listResources(workspaceId);
    list.unshift(resource);
    await writeJsonAtomic(path.join(dir, 'resources', 'index.json'), list);
    await this.updateWorkspace(workspaceId, {});
    return resource;
  }

  async deleteResource(workspaceId: string, resourceId: string): Promise<boolean> {
    const dir = this.getWorkspaceDir(workspaceId);
    const list = await this.listResources(workspaceId);
    const target = list.find((r) => r.id === resourceId);
    if (!target) return false;

    // Linked local files/folders belong to the user: only forget the link, never delete them.
    if (target.source !== 'local' && target.storedName) {
      const filePath = path.join(dir, 'resources', target.storedName);
      if (await exists(filePath)) {
        await fs.unlink(filePath);
      }
    }

    const remaining = list.filter((r) => r.id !== resourceId);
    await writeJsonAtomic(path.join(dir, 'resources', 'index.json'), remaining);
    return true;
  }

  /**
   * Links a file or folder that stays on the user's computer (read live, never copied).
   */
  async linkLocalResource(workspaceId: string, absolutePath: string): Promise<StudyResource> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const localPath = path.resolve(absolutePath);
    const stat = await fs.stat(localPath);
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) {
      throw Object.assign(new Error('Yalnızca dosya veya klasör bağlanabilir.'), { status: 400 });
    }

    const list = await this.listResources(workspaceId);
    const existing = list.find(
      (r) => r.source === 'local' && r.localPath && path.resolve(r.localPath) === localPath,
    );
    if (existing) return existing;

    const id = uuidv4();
    const name = path.basename(localPath) || localPath;
    const category: StudyResource['category'] = isDir
      ? 'folder'
      : detectResourceCategory('', name, await readSample(localPath).catch(() => undefined));
    const base = `/api/workspaces/${workspaceId}/linked/${id}`;
    const resource: StudyResource = {
      id,
      workspaceId,
      name,
      storedName: '',
      mimeType: isDir ? 'inode/directory' : 'application/octet-stream',
      size: isDir ? 0 : stat.size,
      category,
      url: isDir ? `${base}/tree` : `${base}/file`,
      relativePath: localPath,
      uploadedAt: new Date().toISOString(),
      source: 'local',
      localPath,
    };

    list.unshift(resource);
    await writeJsonAtomic(path.join(dir, 'resources', 'index.json'), list);
    await this.updateWorkspace(workspaceId, {});
    return resource;
  }

  async getResource(workspaceId: string, resourceId: string): Promise<StudyResource | null> {
    const list = await this.listResources(workspaceId);
    return list.find((r) => r.id === resourceId) || null;
  }

  /**
   * Reorders resources by the given id list. Unknown ids are ignored and
   * resources missing from the list keep their relative order at the end.
   */
  async reorderResources(workspaceId: string, orderedIds: string[]): Promise<StudyResource[]> {
    const dir = this.getWorkspaceDir(workspaceId);
    const list = await this.listResources(workspaceId);
    const byId = new Map(list.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const ordered: StudyResource[] = [];
    for (const id of orderedIds) {
      const res = byId.get(id);
      if (res && !seen.has(id)) {
        ordered.push(res);
        seen.add(id);
      }
    }
    for (const res of list) {
      if (!seen.has(res.id)) ordered.push(res);
    }
    await writeJsonAtomic(path.join(dir, 'resources', 'index.json'), ordered);
    return ordered;
  }

  getResourceFilePath(workspaceId: string, storedName: string): string {
    const safeName = path.basename(storedName);
    return path.join(this.getWorkspaceDir(workspaceId), 'resources', safeName);
  }

  // --- Annotations ---
  async saveAnnotationSnapshot(
    workspaceId: string,
    dataUrl: string,
    sourceLabel?: string,
  ): Promise<AnnotationAttachment> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!match) {
      throw new Error('Geçersiz görsel formatı (base64 data URL bekleniyor).');
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const id = uuidv4();
    const filename = `snap-${Date.now()}-${id.slice(0, 6)}.${ext}`;
    const fullPath = path.join(dir, 'annotations', filename);
    const buffer = Buffer.from(match[2], 'base64');
    await fs.writeFile(fullPath, buffer);

    return {
      id,
      url: `/api/workspaces/${workspaceId}/annotations/${encodeURIComponent(filename)}`,
      relativePath: `annotations/${filename}`,
      sourceLabel,
      createdAt: new Date().toISOString(),
    };
  }

  getAnnotationFilePath(workspaceId: string, filename: string): string {
    const safeName = path.basename(filename);
    return path.join(this.getWorkspaceDir(workspaceId), 'annotations', safeName);
  }

  // --- Artifacts ---
  async listArtifacts(workspaceId: string): Promise<StudyArtifact[]> {
    const dir = this.getWorkspaceDir(workspaceId);
    return readJson<StudyArtifact[]>(path.join(dir, 'artifacts', 'index.json'), []);
  }

  async appendArtifacts(workspaceId: string, items: StudyArtifact[]): Promise<StudyArtifact[]> {
    if (items.length === 0) return [];
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const existing = await this.listArtifacts(workspaceId);
    const updated = [...existing, ...items];
    await writeJsonAtomic(path.join(dir, 'artifacts', 'index.json'), updated);
    await this.updateWorkspace(workspaceId, {});
    return items;
  }

  async updateArtifactContent(
    workspaceId: string,
    artifactId: string,
    content: string,
  ): Promise<StudyArtifact | null> {
    const dir = this.getWorkspaceDir(workspaceId);
    const existing = await this.listArtifacts(workspaceId);
    const idx = existing.findIndex((a) => a.id === artifactId);
    if (idx === -1) return null;
    existing[idx] = { ...existing[idx], content };
    await writeJsonAtomic(path.join(dir, 'artifacts', 'index.json'), existing);
    return existing[idx];
  }

  // --- Sessions & Messages ---
  async listSessions(workspaceId: string, channel: ChatChannel = 'main'): Promise<ChatSession[]> {
    const { sessions } = await this.ensureSessionsReady(workspaceId, channel);
    return sessions;
  }

  async getSession(
    workspaceId: string,
    sessionId?: string,
    defaultChannel: ChatChannel = 'main',
  ): Promise<ChatSession | null> {
    if (!sessionId) {
      const { sessions, activeSessionId } = await this.ensureSessionsReady(
        workspaceId,
        defaultChannel,
      );
      return sessions.find((s) => s.id === activeSessionId) || null;
    }

    const mainReady = await this.ensureSessionsReady(workspaceId, 'main');
    const foundInMain = mainReady.allSessions.find((s) => s.id === sessionId);
    if (foundInMain) return foundInMain;

    const quickReady = await this.ensureSessionsReady(workspaceId, 'quick');
    return quickReady.allSessions.find((s) => s.id === sessionId) || null;
  }

  async createSession(
    workspaceId: string,
    title?: string,
    channel: ChatChannel = 'main',
  ): Promise<{
    session: ChatSession;
    sessions: ChatSession[];
  }> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const { allSessions } = await this.ensureSessionsReady(workspaceId, channel);
    const now = new Date().toISOString();
    const isQuick = channel === 'quick';
    const session: ChatSession = {
      id: `${isQuick ? 'qsess' : 'sess'}-${uuidv4().slice(0, 8)}`,
      title: (title || (isQuick ? 'Yeni Hızlı Sohbet' : 'Yeni Sohbet')).trim(),
      channel,
      agyConversationId: undefined,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const nextAll = [session, ...allSessions];
    const nextChannelSessions = nextAll.filter((s) => this.getSessionChannel(s) === channel);
    const activePatch = isQuick
      ? { activeQuickSessionId: session.id }
      : { activeSessionId: session.id };

    await Promise.all([
      writeJsonAtomic(this.getSessionFilePath(workspaceId, session.id), []),
      writeJsonAtomic(path.join(dir, 'sessions', 'index.json'), nextAll),
      this.updateWorkspace(workspaceId, activePatch),
    ]);

    return { session, sessions: nextChannelSessions };
  }

  async updateSession(
    workspaceId: string,
    sessionId: string,
    patch: Partial<Pick<ChatSession, 'title' | 'agyConversationId' | 'messageCount'>>,
  ): Promise<ChatSession | null> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    let { allSessions } = await this.ensureSessionsReady(workspaceId, 'main');
    let idx = allSessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      ({ allSessions } = await this.ensureSessionsReady(workspaceId, 'quick'));
      idx = allSessions.findIndex((s) => s.id === sessionId);
    }
    if (idx === -1) return null;

    const updated: ChatSession = {
      ...allSessions[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    allSessions[idx] = updated;
    allSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await writeJsonAtomic(path.join(dir, 'sessions', 'index.json'), allSessions);
    return updated;
  }

  async deleteSession(workspaceId: string, sessionId: string): Promise<{
    sessions: ChatSession[];
    activeSessionId: string;
    messages: ChatMessage[];
    channel: ChatChannel;
  } | null> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    let { allSessions } = await this.ensureSessionsReady(workspaceId, 'main');
    let target = allSessions.find((s) => s.id === sessionId);
    if (!target) {
      ({ allSessions } = await this.ensureSessionsReady(workspaceId, 'quick'));
      target = allSessions.find((s) => s.id === sessionId);
    }
    if (!target) return null;

    const channel = this.getSessionChannel(target);
    const isQuick = channel === 'quick';
    const workspace = await this.getWorkspace(workspaceId);
    const currentActiveId = isQuick ? workspace?.activeQuickSessionId : workspace?.activeSessionId;

    const sessionFile = this.getSessionFilePath(workspaceId, sessionId);
    if (await exists(sessionFile)) {
      await fs.unlink(sessionFile);
    }

    const nextAll = allSessions.filter((s) => s.id !== sessionId);
    let remainingInChannel = nextAll.filter((s) => this.getSessionChannel(s) === channel);
    let nextActiveId = currentActiveId || '';

    if (remainingInChannel.length === 0) {
      const now = new Date().toISOString();
      const fresh: ChatSession = {
        id: `${isQuick ? 'qsess' : 'sess'}-${uuidv4().slice(0, 8)}`,
        title: isQuick ? 'Yeni Hızlı Sohbet' : 'Yeni Sohbet',
        channel,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      nextAll.unshift(fresh);
      remainingInChannel = [fresh];
      nextActiveId = fresh.id;
      await writeJsonAtomic(this.getSessionFilePath(workspaceId, fresh.id), []);
    } else if (!nextActiveId || nextActiveId === sessionId || !remainingInChannel.some((s) => s.id === nextActiveId)) {
      nextActiveId = remainingInChannel[0].id;
    }

    await writeJsonAtomic(path.join(dir, 'sessions', 'index.json'), nextAll);
    await this.updateWorkspace(
      workspaceId,
      isQuick ? { activeQuickSessionId: nextActiveId } : { activeSessionId: nextActiveId },
    );
    const messages = await this.listMessages(workspaceId, nextActiveId);
    return { sessions: remainingInChannel, activeSessionId: nextActiveId, messages, channel };
  }

  async listMessages(workspaceId: string, sessionId?: string): Promise<ChatMessage[]> {
    if (sessionId) {
      return readJson<ChatMessage[]>(this.getSessionFilePath(workspaceId, sessionId), []);
    }
    const { activeSessionId } = await this.ensureSessionsReady(workspaceId, 'main');
    return readJson<ChatMessage[]>(this.getSessionFilePath(workspaceId, activeSessionId), []);
  }

  async appendMessage(
    workspaceId: string,
    message: ChatMessage,
    sessionId?: string,
  ): Promise<{ message: ChatMessage; session: ChatSession; sessions: ChatSession[] }> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    let { allSessions, activeSessionId } = await this.ensureSessionsReady(workspaceId, 'main');
    const targetId = sessionId || activeSessionId;

    let idx = allSessions.findIndex((s) => s.id === targetId);
    if (idx === -1 && sessionId) {
      ({ allSessions } = await this.ensureSessionsReady(workspaceId, 'quick'));
      idx = allSessions.findIndex((s) => s.id === targetId);
    }

    const sessionFile = this.getSessionFilePath(workspaceId, targetId);
    const messages = await readJson<ChatMessage[]>(sessionFile, []);
    messages.push(message);
    await writeJsonAtomic(sessionFile, messages);

    const now = new Date().toISOString();
    let updatedSession: ChatSession;
    let channel: ChatChannel = 'main';

    if (idx !== -1) {
      const current = allSessions[idx];
      channel = this.getSessionChannel(current);
      const shouldAutoTitle =
        message.role === 'user' &&
        (current.title === 'Yeni Sohbet' ||
          current.title === 'İlk Oturum' ||
          current.title === 'Hızlı Sohbet' ||
          current.title === 'Yeni Hızlı Sohbet') &&
        messages.filter((m) => m.role === 'user').length === 1;

      updatedSession = {
        ...current,
        title: shouldAutoTitle ? this.deriveTitleFromMessage(message.content) : current.title,
        messageCount: messages.length,
        updatedAt: now,
      };
      allSessions[idx] = updatedSession;
    } else {
      channel = targetId.startsWith('qsess-') ? 'quick' : 'main';
      updatedSession = {
        id: targetId,
        title:
          message.role === 'user'
            ? this.deriveTitleFromMessage(message.content)
            : channel === 'quick'
              ? 'Hızlı Sohbet'
              : 'Yeni Sohbet',
        channel,
        messageCount: messages.length,
        createdAt: now,
        updatedAt: now,
      };
      allSessions.unshift(updatedSession);
    }

    allSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await writeJsonAtomic(path.join(dir, 'sessions', 'index.json'), allSessions);
    await this.updateWorkspace(
      workspaceId,
      channel === 'quick' ? { activeQuickSessionId: targetId } : { activeSessionId: targetId },
    );

    const channelSessions = allSessions.filter((s) => this.getSessionChannel(s) === channel);
    return { message, session: updatedSession, sessions: channelSessions };
  }

  // --- Whiteboard ---
  async getWhiteboard(workspaceId: string): Promise<WhiteboardState> {
    const dir = this.getWorkspaceDir(workspaceId);
    return readJson<WhiteboardState>(path.join(dir, 'whiteboard.json'), {
      strokes: [],
      cards: [],
      updatedAt: new Date().toISOString(),
    });
  }

  async saveWhiteboard(workspaceId: string, state: WhiteboardState): Promise<WhiteboardState> {
    const dir = await this.ensureWorkspaceFolders(workspaceId);
    const next: WhiteboardState = {
      strokes: state.strokes || [],
      cards: state.cards || [],
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(dir, 'whiteboard.json'), next);
    return next;
  }

  async appendBoardCards(workspaceId: string, cards: BoardCard[]): Promise<WhiteboardState> {
    const current = await this.getWhiteboard(workspaceId);
    return this.saveWhiteboard(workspaceId, {
      ...current,
      cards: [...current.cards, ...cards],
    });
  }
}
