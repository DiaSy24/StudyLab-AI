import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { activeTurnManager, makeTurnKey } from '../services/activeTurnManager.js';
import {
  checkAgyStatus,
  disposeAgySession,
  disposeWorkspaceSessions,
  getCachedAgyStatus,
  warmAgySession,
} from '../services/agyBridge.js';
import {
  invalidateTreeCache,
  listTree,
  requireLocalOrigin,
  resolveInside,
} from '../services/localFiles.js';
import { extractText } from '../services/textExtract.js';
import type { WorkspaceStore } from '../services/workspaceStore.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per study resource
  },
});

const createWorkspaceSchema = z.object({
  title: z.string().min(1, 'Başlık gerekli').max(120),
  subject: z.string().max(80).optional(),
  color: z.string().max(32).optional(),
  icon: z.string().max(32).optional(),
  studyMode: z.enum(['visual', 'socratic', 'exam']).optional(),
  model: z.string().max(120).nullable().optional(),
  quickModel: z.string().max(120).nullable().optional(),
  examLanguage: z.enum(['auto', 'en', 'tr']).optional(),
});

const updateWorkspaceSchema = createWorkspaceSchema.partial();

const linkResourceSchema = z.object({
  path: z.string().min(1, 'Yol gerekli').max(4096),
});

const reorderResourcesSchema = z.object({
  order: z.array(z.string().min(1).max(120)).max(2000),
});

const annotationSchema = z.object({
  dataUrl: z.string().min(30),
  sourceLabel: z.string().max(200).optional(),
});

export function createWorkspacesRouter(store: WorkspaceStore): Router {
  const router = Router();

  const shouldPrewarm = (): boolean =>
    !process.env.VITEST && process.env.NODE_ENV !== 'test' && process.env.AGY_DISABLE_WARM_POOL !== '1';

  const maybePrewarmSession = async (
    wsId: string,
    sessionId: string | undefined,
    channel: 'main' | 'quick' = 'main',
  ): Promise<void> => {
    if (!shouldPrewarm() || !sessionId) return;
    try {
      const agyStatus = getCachedAgyStatus() ?? (await checkAgyStatus());
      if (!agyStatus.available) return;
      const [ws, session, resources, prefs] = await Promise.all([
        store.getWorkspace(wsId),
        store.getSession(wsId, sessionId, channel),
        store.listResources(wsId),
        store.getPreferences(),
      ]);
      if (!ws || !session) return;
      const isQuick = session.channel === 'quick' || channel === 'quick';
      const extraDirs = resources
        .filter((r) => r.source === 'local' && r.localPath)
        .map((r) => (r.category === 'folder' ? r.localPath! : path.dirname(r.localPath!)));
      await warmAgySession(makeTurnKey(wsId, session.id), {
        workspaceDir: store.getWorkspaceDir(wsId),
        conversationId: session.agyConversationId,
        model: isQuick ? (ws.quickModel ?? prefs.lastQuickModel) : (ws.model ?? prefs.lastModel),
        extraDirs,
      });
    } catch {
      // Best-effort pre-warm; never fail HTTP requests
    }
  };

  router.get('/', async (_req, res, next) => {
    try {
      const [workspaces, preferences] = await Promise.all([
        store.listWorkspaces(),
        store.getPreferences(),
      ]);
      res.json({ workspaces, preferences });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Geçersiz veri.' });
        return;
      }
      const workspace = await store.createWorkspace(parsed.data);
      const detail = await store.getWorkspaceDetail(workspace.id);
      res.status(201).json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const requestedSessionId =
        typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const detail = await store.getWorkspaceDetail(wsId, requestedSessionId);
      if (!detail) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      void maybePrewarmSession(wsId, detail.activeSessionId, 'main');
      res.json({
        ...detail,
        activeTurn: activeTurnManager.getSnapshot(wsId, detail.activeSessionId),
        activeQuickTurn: activeTurnManager.getSnapshot(wsId, detail.activeQuickSessionId, true),
        activeTurnSessionIds: activeTurnManager.getActiveSessionIds(wsId),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const parsed = updateWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Geçersiz güncelleme.' });
        return;
      }
      const updated = await store.updateWorkspace(req.params.id, parsed.data);
      if (!updated) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      if ('model' in parsed.data && updated.activeSessionId) {
        void maybePrewarmSession(req.params.id, updated.activeSessionId, 'main');
      }
      if ('quickModel' in parsed.data && updated.activeQuickSessionId) {
        void maybePrewarmSession(req.params.id, updated.activeQuickSessionId, 'quick');
      }
      res.json({ workspace: updated });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const deleted = await store.deleteWorkspace(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      disposeWorkspaceSessions(req.params.id);
      invalidateTreeCache();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Resources ---
  router.post('/:id/resources', upload.array('files', 50), async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const ws = await store.getWorkspace(wsId);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Yüklenecek dosya bulunamadı.' });
        return;
      }

      const uploaded = [];
      for (const file of files) {
        // Fix UTF-8 filenames from multipart headers
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const originalname = decodedName.includes('\uFFFD') ? file.originalname : decodedName;
        const resource = await store.addResource(wsId, {
          originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        });
        uploaded.push(resource);
      }

      res.status(201).json({ resources: uploaded });
    } catch (err) {
      next(err);
    }
  });

  // --- Linked local files/folders (stay on the user's computer) ---
  router.post('/:id/resources/link', requireLocalOrigin, async (req, res, next) => {
    try {
      const parsed = linkResourceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Geçersiz yol.' });
        return;
      }
      const ws = await store.getWorkspace(String(req.params.id));
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      try {
        const resource = await store.linkLocalResource(String(req.params.id), parsed.data.path);
        invalidateTreeCache();
        res.status(201).json({ resource });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          res.status(404).json({ error: 'Bu yolda bir dosya veya klasör bulunamadı.' });
          return;
        }
        if (code === 'EACCES' || code === 'EPERM') {
          res.status(403).json({ error: 'Bu dosyaya erişim izni yok.' });
          return;
        }
        if ((err as { status?: number }).status === 400) {
          res.status(400).json({ error: (err as Error).message });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/linked/:resourceId/tree', requireLocalOrigin, async (req, res, next) => {
    try {
      const resource = await store.getResource(String(req.params.id), String(req.params.resourceId));
      if (!resource || resource.source !== 'local' || !resource.localPath || resource.category !== 'folder') {
        res.status(404).json({ error: 'Bağlı klasör bulunamadı.' });
        return;
      }
      const { entries, truncated } = await listTree(resource.localPath);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ root: resource.localPath, entries, truncated });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Klasör artık bilgisayarda bulunamıyor.' });
        return;
      }
      next(err);
    }
  });

  router.get('/:id/linked/:resourceId/file', requireLocalOrigin, async (req, res, next) => {
    try {
      const resource = await store.getResource(String(req.params.id), String(req.params.resourceId));
      if (!resource || resource.source !== 'local' || !resource.localPath) {
        res.status(404).json({ error: 'Bağlı kaynak bulunamadı.' });
        return;
      }
      let target: string | null = resource.localPath;
      if (resource.category === 'folder') {
        const rel = typeof req.query.path === 'string' ? req.query.path : '';
        target = rel ? await resolveInside(resource.localPath, rel) : null;
        if (!target) {
          res.status(400).json({ error: 'Geçersiz dosya yolu.' });
          return;
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(target, { dotfiles: 'allow' }, (err) => {
        if (!err || res.headersSent) return;
        const code = (err as NodeJS.ErrnoException).code;
        res.status(code === 'ENOENT' || code === 'EISDIR' ? 404 : 500).json({
          error: code === 'ENOENT' ? 'Dosya artık bilgisayarda bulunamıyor.' : 'Dosya okunamadı.',
        });
      });
    } catch (err) {
      next(err);
    }
  });

  // Readable text of any resource (Word/PowerPoint/Excel/old formats/unknown binaries)
  router.get('/:id/resources/:resourceId/text', requireLocalOrigin, async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const resource = await store.getResource(wsId, String(req.params.resourceId));
      if (!resource) {
        res.status(404).json({ error: 'Kaynak bulunamadı.' });
        return;
      }
      let filePath: string | null;
      let filename = resource.name;
      if (resource.source === 'local' && resource.localPath) {
        if (resource.category === 'folder') {
          const rel = typeof req.query.path === 'string' ? req.query.path : '';
          filePath = rel ? await resolveInside(resource.localPath, rel) : null;
          filename = rel.split('/').pop() || rel;
        } else {
          filePath = resource.localPath;
        }
      } else {
        filePath = store.getResourceFilePath(wsId, resource.storedName);
      }
      if (!filePath) {
        res.status(400).json({ error: 'Geçersiz dosya yolu.' });
        return;
      }
      const extracted = await extractText(filePath, filename);
      res.setHeader('Cache-Control', 'no-store');
      res.json(extracted || { text: '', kind: 'boş' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Dosya bulunamadı.' });
        return;
      }
      next(err);
    }
  });

  router.put('/:id/resources/order', async (req, res, next) => {
    try {
      const parsed = reorderResourcesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Geçersiz sıralama.' });
        return;
      }
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const resources = await store.reorderResources(req.params.id, parsed.data.order);
      res.json({ resources });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/resources/:filename', async (req, res, next) => {
    try {
      const filePath = store.getResourceFilePath(req.params.id, req.params.filename);
      await fs.access(filePath);
      res.sendFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Kaynak dosyası bulunamadı.' });
        return;
      }
      next(err);
    }
  });

  router.delete('/:id/resources/:resourceId', async (req, res, next) => {
    try {
      const deleted = await store.deleteResource(req.params.id, req.params.resourceId);
      if (!deleted) {
        res.status(404).json({ error: 'Kaynak bulunamadı.' });
        return;
      }
      invalidateTreeCache();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Annotations ---
  router.post('/:id/annotations', async (req, res, next) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const parsed = annotationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Geçersiz işaretli görsel verisi.' });
        return;
      }
      const annotation = await store.saveAnnotationSnapshot(
        req.params.id,
        parsed.data.dataUrl,
        parsed.data.sourceLabel,
      );
      res.status(201).json({ annotation });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/annotations/:filename', async (req, res, next) => {
    try {
      const filePath = store.getAnnotationFilePath(req.params.id, req.params.filename);
      await fs.access(filePath);
      res.sendFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'İşaretli görsel bulunamadı.' });
        return;
      }
      next(err);
    }
  });

  // --- Artifacts ---
  router.patch('/:id/artifacts/:artifactId', async (req, res, next) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : null;
      if (content === null) {
        res.status(400).json({ error: 'İçerik gerekli.' });
        return;
      }
      const updated = await store.updateArtifactContent(req.params.id, req.params.artifactId, content);
      if (!updated) {
        res.status(404).json({ error: 'Artefakt bulunamadı.' });
        return;
      }
      res.json({ artifact: updated });
    } catch (err) {
      next(err);
    }
  });

  // --- Chat Sessions ---
  router.get('/:id/sessions', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const ws = await store.getWorkspace(wsId);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const channel = req.query.channel === 'quick' ? 'quick' : 'main';
      const sessions = await store.listSessions(wsId, channel);
      const activeId =
        channel === 'quick'
          ? ws.activeQuickSessionId || sessions[0]?.id
          : ws.activeSessionId || sessions[0]?.id;
      res.json({
        sessions,
        activeSessionId: activeId,
        activeTurnSessionIds: activeTurnManager.getActiveSessionIds(wsId),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/sessions', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const ws = await store.getWorkspace(wsId);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
      const channel = req.body?.channel === 'quick' ? 'quick' : 'main';
      const { session, sessions } = await store.createSession(wsId, title, channel);
      void maybePrewarmSession(wsId, session.id, channel);
      res.status(201).json({
        session,
        sessions,
        activeSessionId: session.id,
        messages: [],
        activeTurn: null,
        activeTurnSessionIds: activeTurnManager.getActiveSessionIds(wsId),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/sessions/:sessionId', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const sessionId = String(req.params.sessionId);
      const session = await store.getSession(wsId, sessionId);
      if (!session) {
        res.status(404).json({ error: 'Sohbet oturumu bulunamadı.' });
        return;
      }
      const channel = session.channel === 'quick' ? 'quick' : 'main';
      await store.updateWorkspace(
        wsId,
        channel === 'quick' ? { activeQuickSessionId: sessionId } : { activeSessionId: sessionId },
      );
      const [messages, sessions] = await Promise.all([
        store.listMessages(wsId, sessionId),
        store.listSessions(wsId, channel),
      ]);
      void maybePrewarmSession(wsId, sessionId, channel);
      res.json({
        session,
        sessions,
        activeSessionId: sessionId,
        messages,
        activeTurn: activeTurnManager.getSnapshot(wsId, sessionId, channel === 'quick'),
        activeTurnSessionIds: activeTurnManager.getActiveSessionIds(wsId),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/sessions/:sessionId', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const sessionId = String(req.params.sessionId);
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        res.status(400).json({ error: 'Oturum başlığı boş olamaz.' });
        return;
      }
      const updated = await store.updateSession(wsId, sessionId, { title });
      if (!updated) {
        res.status(404).json({ error: 'Sohbet oturumu bulunamadı.' });
        return;
      }
      const channel = updated.channel === 'quick' ? 'quick' : 'main';
      const sessions = await store.listSessions(wsId, channel);
      res.json({ session: updated, sessions });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id/sessions/:sessionId', async (req, res, next) => {
    try {
      const wsId = String(req.params.id);
      const sessionId = String(req.params.sessionId);
      const result = await store.deleteSession(wsId, sessionId);
      if (!result) {
        res.status(404).json({ error: 'Sohbet oturumu bulunamadı.' });
        return;
      }
      disposeAgySession(makeTurnKey(wsId, sessionId));
      res.json({
        ...result,
        activeTurn: activeTurnManager.getSnapshot(
          wsId,
          result.activeSessionId,
          result.channel === 'quick',
        ),
        activeTurnSessionIds: activeTurnManager.getActiveSessionIds(wsId),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Whiteboard ---
  router.put('/:id/whiteboard', async (req, res, next) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const whiteboard = await store.saveWhiteboard(req.params.id, req.body);
      res.json({ whiteboard });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
