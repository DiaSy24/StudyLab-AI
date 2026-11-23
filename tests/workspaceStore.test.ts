import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';
import type { Express } from 'express';

describe('Workspaces API & Storage', () => {
  let tmpDataDir: string;
  let app: Express;

  beforeAll(async () => {
    tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-test-'));
    const created = await createApp({ dataDir: tmpDataDir, seedDemo: true });
    app = created.app;
  });

  afterAll(async () => {
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  });

  it('seeds the demo workspace with 3D scene, formula lab, quiz, and study note', async () => {
    const listRes = await request(app).get('/api/workspaces').expect(200);
    expect(listRes.body.workspaces).toHaveLength(1);
    const demoId = listRes.body.workspaces[0].id;

    const detailRes = await request(app).get(`/api/workspaces/${demoId}`).expect(200);
    expect(detailRes.body.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(detailRes.body.resources.length).toBeGreaterThanOrEqual(1);
    expect(detailRes.body.whiteboard.cards.length).toBeGreaterThanOrEqual(1);
  });

  it('creates a workspace, uploads a resource, saves an annotation PNG, and persists whiteboard', async () => {
    const createRes = await request(app)
      .post('/api/workspaces')
      .send({
        title: 'Organik Kimya',
        subject: 'Kimya',
        color: '#10b981',
        icon: 'flask',
      })
      .expect(201);

    const wsId = createRes.body.workspace.id;
    expect(wsId).toMatch(/^ws-/);

    // Upload a study note file
    const uploadRes = await request(app)
      .post(`/api/workspaces/${wsId}/resources`)
      .attach('files', Buffer.from('# Alkanlar\nGenel formül: CnH2n+2'), {
        filename: 'alkanlar.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    expect(uploadRes.body.resources).toHaveLength(1);
    const resUrl = uploadRes.body.resources[0].url;
    const downloadRes = await request(app).get(resUrl).expect(200);
    expect(downloadRes.text).toContain('CnH2n+2');

    // Save an annotation PNG (1x1 transparent PNG)
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const annRes = await request(app)
      .post(`/api/workspaces/${wsId}/annotations`)
      .send({ dataUrl: tinyPng, sourceLabel: 'alkanlar.md' })
      .expect(201);

    expect(annRes.body.annotation.relativePath).toMatch(/^annotations\/snap-.*\.png$/);
    await request(app).get(annRes.body.annotation.url).expect(200);

    // Save whiteboard state
    const wbRes = await request(app)
      .put(`/api/workspaces/${wsId}/whiteboard`)
      .send({
        strokes: [
          {
            id: 's1',
            tool: 'pen',
            color: '#f43f5e',
            width: 3,
            points: [
              { x: 10, y: 10 },
              { x: 50, y: 50 },
            ],
          },
        ],
        cards: [],
        updatedAt: new Date().toISOString(),
      })
      .expect(200);
    expect(wbRes.body.whiteboard.strokes).toHaveLength(1);

    // Delete workspace cleanly
    await request(app).delete(`/api/workspaces/${wsId}`).expect(200);
    await request(app).get(`/api/workspaces/${wsId}`).expect(404);
  });

  it('supports multiple chat sessions per workspace with clean context and history switching', async () => {
    const listRes = await request(app).get('/api/workspaces').expect(200);
    const demoId = listRes.body.workspaces[0].id;

    // Initial legacy chat.json is automatically migrated to the first session
    const detail1 = await request(app).get(`/api/workspaces/${demoId}`).expect(200);
    expect(detail1.body.sessions).toHaveLength(1);
    const firstSessionId = detail1.body.activeSessionId;
    expect(detail1.body.messages.length).toBeGreaterThanOrEqual(2);

    // Create a brand new chat session (clean context)
    const createSessRes = await request(app)
      .post(`/api/workspaces/${demoId}/sessions`)
      .send({})
      .expect(201);
    const secondSessionId = createSessRes.body.session.id;
    expect(createSessRes.body.session.agyConversationId).toBeUndefined();
    expect(createSessRes.body.messages).toHaveLength(0);
    expect(createSessRes.body.sessions).toHaveLength(2);

    // Switch back to the previous session and verify old history is intact
    const switchBackRes = await request(app)
      .get(`/api/workspaces/${demoId}/sessions/${firstSessionId}`)
      .expect(200);
    expect(switchBackRes.body.activeSessionId).toBe(firstSessionId);
    expect(switchBackRes.body.messages.length).toBeGreaterThanOrEqual(2);

    // Delete the empty second session cleanly
    const delRes = await request(app)
      .delete(`/api/workspaces/${demoId}/sessions/${secondSessionId}`)
      .expect(200);
    expect(delRes.body.sessions).toHaveLength(1);
    expect(delRes.body.activeSessionId).toBe(firstSessionId);
  });

  it('keeps Hızlı Chat (quick) sessions and quickModel completely isolated from main chat', async () => {
    const createRes = await request(app)
      .post('/api/workspaces')
      .send({ title: 'Hızlı Chat Testi' })
      .expect(201);
    const wsId = createRes.body.workspace.id;

    // Initial detail has 1 main session and 1 quick session
    expect(createRes.body.sessions).toHaveLength(1);
    expect(createRes.body.quickSessions).toHaveLength(1);
    const mainSessionId = createRes.body.activeSessionId;
    const initialQuickId = createRes.body.activeQuickSessionId;
    expect(initialQuickId).toMatch(/^qsess-/);
    expect(createRes.body.quickMessages).toEqual([]);

    // Set independent models for main and quick chat
    const patchRes = await request(app)
      .patch(`/api/workspaces/${wsId}`)
      .send({ model: 'gemini-pro', quickModel: 'gemini-flash' })
      .expect(200);
    expect(patchRes.body.workspace.model).toBe('gemini-pro');
    expect(patchRes.body.workspace.quickModel).toBe('gemini-flash');

    // Clearing quickModel via null resets only quickModel without touching main model
    const clearQuickRes = await request(app)
      .patch(`/api/workspaces/${wsId}`)
      .send({ quickModel: null })
      .expect(200);
    expect(clearQuickRes.body.workspace.model).toBe('gemini-pro');
    expect(clearQuickRes.body.workspace.quickModel).toBeUndefined();

    // Create a second quick session — main sessions and activeSessionId remain untouched
    const createQuickRes = await request(app)
      .post(`/api/workspaces/${wsId}/sessions`)
      .send({ channel: 'quick' })
      .expect(201);
    const secondQuickId = createQuickRes.body.session.id;
    expect(secondQuickId).toMatch(/^qsess-/);
    expect(createQuickRes.body.session.channel).toBe('quick');
    expect(createQuickRes.body.sessions).toHaveLength(2);

    const detailAfter = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(detailAfter.body.sessions).toHaveLength(1);
    expect(detailAfter.body.activeSessionId).toBe(mainSessionId);
    expect(detailAfter.body.quickSessions).toHaveLength(2);
    expect(detailAfter.body.activeQuickSessionId).toBe(secondQuickId);

    // Switch back to initial quick session
    const selectQuickRes = await request(app)
      .get(`/api/workspaces/${wsId}/sessions/${initialQuickId}`)
      .expect(200);
    expect(selectQuickRes.body.activeSessionId).toBe(initialQuickId);
    expect(selectQuickRes.body.sessions).toHaveLength(2);

    // Delete second quick session — leaves 1 quick session and 1 untouched main session
    const delQuickRes = await request(app)
      .delete(`/api/workspaces/${wsId}/sessions/${secondQuickId}`)
      .expect(200);
    expect(delQuickRes.body.sessions).toHaveLength(1);
    expect(delQuickRes.body.activeSessionId).toBe(initialQuickId);

    const finalDetail = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(finalDetail.body.sessions).toHaveLength(1);
    expect(finalDetail.body.activeSessionId).toBe(mainSessionId);
    expect(finalDetail.body.quickSessions).toHaveLength(1);
    expect(finalDetail.body.activeQuickSessionId).toBe(initialQuickId);
  });

  it('reorders resources and persists the new order', async () => {
    const createRes = await request(app)
      .post('/api/workspaces')
      .send({ title: 'Sıralama Testi' })
      .expect(201);
    const wsId = createRes.body.workspace.id;

    const ids: string[] = [];
    for (const name of ['a.md', 'b.md', 'c.md']) {
      const up = await request(app)
        .post(`/api/workspaces/${wsId}/resources`)
        .attach('files', Buffer.from(`# ${name}`), { filename: name, contentType: 'text/markdown' })
        .expect(201);
      ids.push(up.body.resources[0].id);
    }
    const [a, b, c] = ids;

    // Unknown ids are ignored, missing ids are appended in their existing order
    const reorderRes = await request(app)
      .put(`/api/workspaces/${wsId}/resources/order`)
      .send({ order: [a, 'does-not-exist', b] })
      .expect(200);
    expect(reorderRes.body.resources.map((r: { id: string }) => r.id)).toEqual([a, b, c]);

    const detail = await request(app).get(`/api/workspaces/${wsId}`).expect(200);
    expect(detail.body.resources.map((r: { id: string }) => r.id)).toEqual([a, b, c]);

    await request(app)
      .put(`/api/workspaces/${wsId}/resources/order`)
      .send({ order: 'nope' })
      .expect(400);
  });

  it('remembers last selected main and quick models in preferences and applies them to new workspaces', async () => {
    const first = await request(app)
      .post('/api/workspaces')
      .send({ title: 'Ders 1' })
      .expect(201);

    await request(app)
      .patch(`/api/workspaces/${first.body.workspace.id}`)
      .send({ model: 'gemini-4-neon-high', quickModel: 'gemini-3.8-flash-low' })
      .expect(200);

    const listRes = await request(app).get('/api/workspaces').expect(200);
    expect(listRes.body.preferences).toEqual({
      lastModel: 'gemini-4-neon-high',
      lastQuickModel: 'gemini-3.8-flash-low',
    });

    // Newly created workspace inherits the remembered models automatically
    const second = await request(app)
      .post('/api/workspaces')
      .send({ title: 'Ders 2' })
      .expect(201);
    expect(second.body.workspace.model).toBe('gemini-4-neon-high');
    expect(second.body.workspace.quickModel).toBe('gemini-3.8-flash-low');

    // Resetting main model back to default (null) is also remembered without touching quickModel
    await request(app)
      .patch(`/api/workspaces/${second.body.workspace.id}`)
      .send({ model: null })
      .expect(200);

    const listAfterReset = await request(app).get('/api/workspaces').expect(200);
    expect(listAfterReset.body.preferences.lastModel).toBeUndefined();
    expect(listAfterReset.body.preferences.lastQuickModel).toBe('gemini-3.8-flash-low');
  });

  it('serves local Three.js vendor module with CORS headers for sandboxed iframes', async () => {
    const res = await request(app).get('/vendor/three/build/three.module.js').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.text.length).toBeGreaterThan(1000);
  });
});
