import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';
import { activeTurnManager } from '../server/services/activeTurnManager.js';

describe('ActiveTurnManager & Refresh Re-attach', () => {
  let tmpDataDir: string;
  let app: Express;
  let wsId: string;

  beforeAll(async () => {
    tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-turn-'));
    const created = await createApp({ dataDir: tmpDataDir, seedDemo: true });
    app = created.app;
    const listRes = await request(app).get('/api/workspaces').expect(200);
    wsId = listRes.body.workspaces[0].id;
  });

  afterAll(async () => {
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  it('exposes activeTurn snapshot on GET /api/workspaces/:id and replays it on /chat/stream', async () => {
    activeTurnManager.startTurn(wsId, '3D model hazırlanıyor...');
    activeTurnManager.appendDelta(wsId, 'Merhaba! İlk kısım ');
    activeTurnManager.appendDelta(wsId, 'üretildi.');

    // Simulate page refresh fetching workspace detail mid-turn
    const detailRes = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(detailRes.body.activeTurn).toBeTruthy();
    expect(detailRes.body.activeTurn.streamingText).toBe('Merhaba! İlk kısım üretildi.');
    expect(detailRes.body.activeTurn.statusMessage).toBe('3D model hazırlanıyor...');

    // Simulate refreshed client attaching to /chat/stream while turn continues and finishes
    setTimeout(() => {
      activeTurnManager.appendDelta(wsId, ' Devamı geldi!');
      activeTurnManager.finishTurn(wsId, 'done', {
        message: {
          id: 'msg-done-1',
          role: 'assistant',
          content: 'Merhaba! İlk kısım üretildi. Devamı geldi!',
          displayContent: 'Merhaba! İlk kısım üretildi. Devamı geldi!',
          createdAt: new Date().toISOString(),
        },
        artifacts: [],
        whiteboard: null,
      });
    }, 40);

    const streamRes = await request(app)
      .get(`/api/workspaces/${wsId}/chat/stream`)
      .expect(200);

    expect(streamRes.text).toContain('event: snapshot');
    expect(streamRes.text).toContain('Merhaba! İlk kısım üretildi.');
    expect(streamRes.text).toContain('event: delta');
    expect(streamRes.text).toContain(' Devamı geldi!');
    expect(streamRes.text).toContain('event: done');
  });

  it('emits sync event on /chat/stream if turn already completed before re-attach', async () => {
    const streamRes = await request(app)
      .get(`/api/workspaces/${wsId}/chat/stream`)
      .expect(200);
    expect(streamRes.text).toContain('event: sync');
  });

  it('tracks independent concurrent active turns for main chat and Hızlı Chat', async () => {
    const detail0 = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    const mainId = detail0.body.activeSessionId as string;
    const quickId = detail0.body.activeQuickSessionId as string;

    activeTurnManager.startTurn(wsId, 'Ana sohbet hazırlanıyor...', mainId);
    activeTurnManager.appendDelta(wsId, 'Ana yanıt metni', mainId);

    activeTurnManager.startTurn(wsId, 'Hızlı Chat yanıtlıyor...', quickId);
    activeTurnManager.appendDelta(wsId, 'Hızlı yanıt metni', quickId);

    const detailMid = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(detailMid.body.activeTurn?.sessionId).toBe(mainId);
    expect(detailMid.body.activeTurn?.streamingText).toBe('Ana yanıt metni');
    expect(detailMid.body.activeQuickTurn?.sessionId).toBe(quickId);
    expect(detailMid.body.activeQuickTurn?.streamingText).toBe('Hızlı yanıt metni');
    expect(detailMid.body.activeTurnSessionIds).toEqual(expect.arrayContaining([mainId, quickId]));

    // Finish quick turn while main turn continues
    activeTurnManager.finishTurn(wsId, 'done', { message: null }, quickId);
    const detailAfterQuick = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(detailAfterQuick.body.activeQuickTurn).toBeNull();
    expect(detailAfterQuick.body.activeTurn?.sessionId).toBe(mainId);

    // Clean up main turn
    activeTurnManager.finishTurn(wsId, 'done', { message: null }, mainId);
  });
});
