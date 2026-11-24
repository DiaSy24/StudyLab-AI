import path from 'node:path';
import { Router, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { ChatMessage } from '../../src/types/study.js';
import {
  activeTurnManager,
  makeTurnKey,
  writeSseEvent,
} from '../services/activeTurnManager.js';
import {
  abortWorkspaceTurn,
  buildStudyPrompt,
  checkAgyStatus,
  disposeAgySession,
  hasWarmSession,
  invalidateAgyStatusCache,
  isWorkspaceBusy,
  runAgyTurn,
  type ChangedPromptContext,
} from '../services/agyBridge.js';
import {
  isAgyAuthErrorMessage,
  isAgyNotInstalledErrorMessage,
  launchAgyInteractiveLogin,
  runAgyInstall,
} from '../services/agySetup.js';
import { requireLocalOrigin } from '../services/localFiles.js';
import {
  materializeArtifacts,
  materializeBoardCards,
  parseStudyResponse,
} from '../services/artifactParser.js';
import type { WorkspaceStore } from '../services/workspaceStore.js';

const chatRequestSchema = z.object({
  message: z.string().min(1, 'Mesaj boş olamaz.'),
  sessionId: z.string().optional(),
  studyMode: z.enum(['visual', 'socratic', 'exam']).optional(),
  model: z.string().nullable().optional(),
  selectedResourceIds: z.array(z.string()).optional(),
  activeArtifactId: z.string().optional(),
  annotation: z
    .object({
      id: z.string(),
      url: z.string(),
      relativePath: z.string(),
      sourceLabel: z.string().optional(),
      createdAt: z.string(),
    })
    .optional(),
  coStudyAction: z
    .enum(['check-step', 'hint', 'visualize-board', 'fix-artifact'])
    .optional(),
  artifactError: z.string().optional(),
  viewingResourceId: z.string().max(1024).optional(),
  viewingPath: z.string().max(4096).optional(),
  viewingPage: z.number().int().positive().max(100000).optional(),
  viewingPageCount: z.number().int().positive().max(100000).optional(),
  pageByPage: z.boolean().optional(),
});

function initSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

interface SessionContextSignature {
  conversationId?: string;
  studyMode: string;
  examLanguage: string;
  resourceSig: string;
  activeArtifactId?: string;
}

export function createChatRouter(store: WorkspaceStore): Router {
  const router = Router();
  const sessionContextSignatures = new Map<string, SessionContextSignature>();

  router.get('/agy/status', async (req, res, next) => {
    try {
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const status = await checkAgyStatus(refresh);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.post('/agy/install', requireLocalOrigin, async (req, res) => {
    initSseHeaders(res);
    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    writeSseEvent(res, 'status', { message: 'Antigravity CLI (agy) kurulum betiği indiriliyor...' });

    try {
      const result = await runAgyInstall({
        signal: controller.signal,
        onLog: (line, stream) => {
          if (!res.writableEnded) {
            writeSseEvent(res, 'log', { line, stream });
          }
        },
      });

      invalidateAgyStatusCache();
      const status = await checkAgyStatus(true);

      if (result.exitCode !== 0 && !status.installed) {
        writeSseEvent(res, 'error', {
          error: `Kurulum betiği ${result.exitCode} koduyla sonlandı. Aşağıdaki komutu terminalde elle çalıştırabilirsiniz.`,
          status,
        });
      } else {
        writeSseEvent(res, 'done', { status, exitCode: result.exitCode });
      }
    } catch (err) {
      invalidateAgyStatusCache();
      const status = await checkAgyStatus(true).catch(() => undefined);
      if (!res.writableEnded) {
        writeSseEvent(res, 'error', {
          error: err instanceof Error ? err.message : 'Antigravity CLI kurulumu başarısız oldu.',
          status,
        });
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  router.post('/agy/login', requireLocalOrigin, async (_req, res, next) => {
    try {
      const status = await checkAgyStatus(true);
      if (!status.installed || !status.binaryPath) {
        res.status(400).json({
          error: 'Antigravity CLI (agy) henüz kurulu değil. Önce 1. adımdan kurulumu tamamlayın.',
        });
        return;
      }

      const result = await launchAgyInteractiveLogin(status.binaryPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Re-attaches a refreshed browser tab or switched session to an in-progress AI turn.
   */
  router.get('/workspaces/:id/chat/stream', async (req, res) => {
    const workspaceId = String(req.params.id);
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
      return;
    }

    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId
        ? req.query.sessionId
        : workspace.activeSessionId;

    initSseHeaders(res);

    const attached = activeTurnManager.subscribe(workspaceId, res, true, sessionId);
    if (!attached) {
      writeSseEvent(res, 'sync', { needReload: true, sessionId });
      res.end();
    }
  });

  router.post('/workspaces/:id/chat/abort', async (req, res) => {
    const workspaceId = String(req.params.id);
    const sessionId =
      typeof req.body?.sessionId === 'string' && req.body.sessionId
        ? req.body.sessionId
        : (await store.getWorkspace(workspaceId))?.activeSessionId;
    const key = makeTurnKey(workspaceId, sessionId);
    const aborted = abortWorkspaceTurn(key) || abortWorkspaceTurn(workspaceId);
    res.json({ aborted });
  });

  router.post('/workspaces/:id/reset-session', async (req, res, next) => {
    try {
      const workspaceId = String(req.params.id);
      const workspace = await store.getWorkspace(workspaceId);
      if (!workspace) {
        res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
        return;
      }
      const requestedChannel = req.body?.channel === 'quick' ? 'quick' : 'main';
      const sessionId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId
          ? req.body.sessionId
          : requestedChannel === 'quick'
            ? workspace.activeQuickSessionId
            : workspace.activeSessionId;

      const targetSession = sessionId ? await store.getSession(workspaceId, sessionId) : null;
      const actualChannel = targetSession?.channel === 'quick' ? 'quick' : requestedChannel;

      if (sessionId) {
        const key = makeTurnKey(workspaceId, sessionId);
        disposeAgySession(key);
        sessionContextSignatures.delete(key);
        await store.updateSession(workspaceId, sessionId, { agyConversationId: undefined });
      }
      const updated =
        actualChannel === 'main'
          ? await store.updateWorkspace(workspaceId, { agyConversationId: undefined })
          : workspace;
      const sessions = await store.listSessions(workspaceId, actualChannel);
      res.json({ workspace: updated || workspace, sessions });
    } catch (err) {
      next(err);
    }
  });

  router.post('/workspaces/:id/chat', async (req, res) => {
    const workspaceId = String(req.params.id);
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Çalışma alanı bulunamadı.' });
      return;
    }

    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Geçersiz sohbet isteği.' });
      return;
    }

    const payload = parsed.data;
    const session = await store.getSession(workspaceId, payload.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Sohbet oturumu bulunamadı.' });
      return;
    }

    const sessionId = session.id;
    const turnKey = makeTurnKey(workspaceId, sessionId);

    if (isWorkspaceBusy(turnKey) || activeTurnManager.isActive(workspaceId, sessionId)) {
      res.status(409).json({
        error: 'Bu sohbet oturumunda şu an devam eden bir AI yanıtı var.',
      });
      return;
    }

    const isQuick = session.channel === 'quick';
    const studyMode = payload.studyMode || workspace.studyMode;
    const model =
      payload.model !== undefined
        ? payload.model || undefined
        : isQuick
          ? workspace.quickModel
          : workspace.model;

    // Persist user message immediately into this session
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: payload.message,
      createdAt: new Date().toISOString(),
      studyMode,
      attachedResourceIds: payload.selectedResourceIds,
      sourceResourceId: payload.viewingResourceId,
      sourcePath: payload.viewingPath,
      annotation: payload.annotation,
    };
    const [appendResult, allResources] = await Promise.all([
      store.appendMessage(workspaceId, userMsg, sessionId),
      store.listResources(workspaceId),
    ]);
    const { session: updatedSessionAfterUser, sessions: sessionsAfterUser } = appendResult;

    const selectedSet = new Set(payload.selectedResourceIds || []);
    const selectedResources = allResources.filter((r) => selectedSet.has(r.id));
    const workspaceDir = store.getWorkspaceDir(workspaceId);
    const extraDirs = selectedResources
      .filter((r) => r.source === 'local' && r.localPath)
      .map((r) => (r.category === 'folder' ? r.localPath! : path.dirname(r.localPath!)));

    const isWarm = hasWarmSession(turnKey, {
      workspaceDir,
      conversationId: session.agyConversationId,
      model,
      extraDirs,
    });
    const initialStatus = isWarm ? 'Mesaj Gemini’ye iletiliyor...' : 'Kaynaklar hazırlanıyor...';

    // Initialize decoupled active turn keyed by workspace + session
    activeTurnManager.startTurn(workspaceId, initialStatus, sessionId);

    initSseHeaders(res);
    activeTurnManager.subscribe(workspaceId, res, false, sessionId);

    writeSseEvent(res, 'user_message', {
      message: userMsg,
      session: updatedSessionAfterUser,
      sessions: sessionsAfterUser,
    });
    writeSseEvent(res, 'status', { message: initialStatus });

    // Run agy detached from this single HTTP response lifecycle
    void (async () => {
      let allArtifacts = await store.listArtifacts(workspaceId);
      try {
        const activeArtifact = payload.activeArtifactId
          ? allArtifacts.find((a) => a.id === payload.activeArtifactId) || null
          : null;

        const resourceSig = selectedResources
          .map((r) => `${r.id}:${r.localPath || r.relativePath}`)
          .sort()
          .join('|');
        const currentSig: SessionContextSignature = {
          conversationId: session.agyConversationId,
          studyMode,
          examLanguage: workspace.examLanguage || 'auto',
          resourceSig,
          activeArtifactId: activeArtifact?.id,
        };
        const prevSig = sessionContextSignatures.get(turnKey);
        const isFollowUp = Boolean(session.agyConversationId);
        const changedContext: ChangedPromptContext | undefined = isFollowUp
          ? {
              studyMode: !prevSig || prevSig.studyMode !== currentSig.studyMode,
              examLanguage: !prevSig || prevSig.examLanguage !== currentSig.examLanguage,
              resources: !prevSig
                ? selectedResources.length > 0
                : prevSig.resourceSig !== currentSig.resourceSig,
              activeArtifact:
                Boolean(activeArtifact) && prevSig?.activeArtifactId !== currentSig.activeArtifactId,
            }
          : undefined;

        const prompt = await buildStudyPrompt(workspaceDir, {
          workspace,
          userMessage: payload.message,
          studyMode,
          selectedResources,
          annotation: payload.annotation,
          activeArtifact,
          coStudyAction: payload.coStudyAction,
          artifactError: payload.artifactError,
          viewingPath: payload.viewingPath,
          viewingPage: payload.viewingPage,
          viewingPageCount: payload.viewingPageCount,
          pageByPage: payload.pageByPage,
          isQuickChat: isQuick,
          isFollowUp,
          changedContext,
        });

        if (!isWarm) {
          activeTurnManager.setStatus(workspaceId, 'Antigravity (agy) bağlanıyor...', sessionId);
        }

        const agyResult = await runAgyTurn(turnKey, {
          workspaceDir,
          prompt,
          conversationId: session.agyConversationId,
          model,
          extraDirs,
          onEvent: (ev) => {
            if (ev.type === 'delta' && ev.text) {
              activeTurnManager.appendDelta(workspaceId, ev.text, sessionId);
            } else if (ev.type === 'status' && ev.statusMessage) {
              activeTurnManager.setStatus(workspaceId, ev.statusMessage, sessionId);
            } else if (ev.type === 'init') {
              activeTurnManager.setStatus(
                workspaceId,
                ev.statusMessage || 'Gemini oturumu hazır...',
                sessionId,
              );
            }
          },
        });

        sessionContextSignatures.set(turnKey, {
          ...currentSig,
          conversationId: agyResult.conversationId || session.agyConversationId,
        });

        if (agyResult.conversationId && agyResult.conversationId !== session.agyConversationId) {
          await store.updateSession(workspaceId, sessionId, {
            agyConversationId: agyResult.conversationId,
          });
        }
        if (isQuick) {
          if (payload.model !== undefined && model !== workspace.quickModel) {
            await store.updateWorkspace(workspaceId, { quickModel: model ?? null });
          }
        } else if (
          studyMode !== workspace.studyMode ||
          (payload.model !== undefined && model !== workspace.model)
        ) {
          await store.updateWorkspace(workspaceId, {
            studyMode,
            ...(payload.model !== undefined ? { model: model ?? null } : {}),
          });
        }

        const parsedResp = parseStudyResponse(agyResult.response);
        const assistantMessageId = uuidv4();

        allArtifacts = await store.listArtifacts(workspaceId);
        const newArtifacts = materializeArtifacts(
          workspaceId,
          parsedResp.artifactDrafts,
          allArtifacts,
          assistantMessageId,
        );
        if (newArtifacts.length > 0) {
          await store.appendArtifacts(workspaceId, newArtifacts);
        }

        let updatedWhiteboard = null;
        if (parsedResp.boardActions.length > 0) {
          const currentWb = await store.getWhiteboard(workspaceId);
          const newCards = materializeBoardCards(parsedResp.boardActions, currentWb.cards);
          updatedWhiteboard = await store.appendBoardCards(workspaceId, newCards);
        }

        const assistantMsg: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: agyResult.response,
          displayContent: parsedResp.displayContent || agyResult.response,
          createdAt: new Date().toISOString(),
          studyMode,
          sourceResourceId: payload.viewingResourceId,
          sourcePath: payload.viewingPath,
          artifactIds: newArtifacts.map((a) => a.id),
          boardActionsApplied: parsedResp.boardActions.length,
          durationSeconds: agyResult.durationSeconds,
        };
        const { session: finalSession, sessions: finalSessions } = await store.appendMessage(
          workspaceId,
          assistantMsg,
          sessionId,
        );

        activeTurnManager.finishTurn(
          workspaceId,
          'done',
          {
            message: assistantMsg,
            artifacts: newArtifacts,
            whiteboard: updatedWhiteboard,
            conversationId: agyResult.conversationId,
            session: finalSession,
            sessions: finalSessions,
          },
          sessionId,
        );
      } catch (err) {
        const rawError =
          err instanceof Error ? err.message : 'AI yanıtı alınırken hata oluştu.';
        let errorMessage = rawError;
        if (isAgyNotInstalledErrorMessage(rawError)) {
          invalidateAgyStatusCache();
          errorMessage =
            'Antigravity CLI (agy) bulunamadı. Kurulum Sihirbazı ile tek tıkla kurup tekrar deneyebilirsiniz.';
        } else if (isAgyAuthErrorMessage(rawError)) {
          invalidateAgyStatusCache();
          errorMessage =
            'Antigravity (agy) oturumu açık değil veya süresi dolmuş. Kurulum / Giriş Sihirbazı üzerinden Google hesabınızla giriş yapın.';
        }
        const partialText = activeTurnManager.getStreamingText(workspaceId, sessionId).trim();

        if (partialText.length > 0) {
          const parsedPartial = parseStudyResponse(partialText);
          const assistantMessageId = uuidv4();
          const noteSuffix = '\n\n> *Yanıt kesildi — o ana kadar üretilen kısım kaydedildi.*';
          const partialMsg: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: partialText,
            displayContent: `${parsedPartial.displayContent || partialText}${noteSuffix}`,
            createdAt: new Date().toISOString(),
            studyMode,
            sourceResourceId: payload.viewingResourceId,
            sourcePath: payload.viewingPath,
          };
          const { session: finalSession, sessions: finalSessions } = await store.appendMessage(
            workspaceId,
            partialMsg,
            sessionId,
          );
          activeTurnManager.finishTurn(
            workspaceId,
            'done',
            {
              message: partialMsg,
              artifacts: [],
              whiteboard: null,
              session: finalSession,
              sessions: finalSessions,
            },
            sessionId,
          );
          return;
        }

        activeTurnManager.finishTurn(workspaceId, 'error', { error: errorMessage }, sessionId);
      }
    })();
  });

  return router;
}
