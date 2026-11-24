import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStudyPrompt,
  checkAgyStatus,
  examLanguageInstruction,
  parseAgyStreamLine,
  wantsPageByPage,
} from '../server/services/agyBridge.js';
import { AgySessionPool, ensureAgyIsolationBoundary } from '../server/services/agySessionPool.js';

describe('agyBridge', () => {
  it('parses init, step_update delta, tool status, and result NDJSON lines', () => {
    const initEv = parseAgyStreamLine(
      '{"event":"init","conversation_id":"conv-123","init":{"cwd":"D:\\\\ws"}}',
    );
    expect(initEv?.type).toBe('init');
    expect(initEv?.conversationId).toBe('conv-123');

    const toolEv = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"conversation_id":"conv-123","state":"ACTIVE","step_type":"view_file"}}',
    );
    expect(toolEv?.type).toBe('status');
    expect(toolEv?.statusMessage).toContain('inceleniyor');

    const deltaEv = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"conversation_id":"conv-123","state":"ACTIVE","step_type":"agent_response","text_delta":"Merhaba"}}',
    );
    expect(deltaEv?.type).toBe('delta');
    expect(deltaEv?.text).toBe('Merhaba');

    const resEv = parseAgyStreamLine(
      '{"event":"result","result":{"conversation_id":"conv-123","status":"SUCCESS","response":"Merhaba dünya","duration_seconds":2.4}}',
    );
    expect(resEv?.type).toBe('result');
    expect(resEv?.text).toBe('Merhaba dünya');
    expect(resEv?.durationSeconds).toBe(2.4);
  });

  it('ignores non-JSON lines safely', () => {
    expect(parseAgyStreamLine('warning: something')).toBeNull();
    expect(parseAgyStreamLine('')).toBeNull();
  });

  it('builds a structured study prompt referencing selected resources and annotations', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-prompt-'));
    try {
      const prompt = await buildStudyPrompt(tmpDir, {
        workspace: {
          id: 'ws-test',
          title: 'Kalkülüs I',
          subject: 'Matematik',
          color: '#6366f1',
          icon: 'sigma',
          studyMode: 'visual',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        userMessage: 'Türevin geometrik anlamını göster',
        studyMode: 'visual',
        selectedResources: [
          {
            id: 'r1',
            workspaceId: 'ws-test',
            name: 'turev.pdf',
            storedName: '1-turev.pdf',
            mimeType: 'application/pdf',
            size: 1024,
            category: 'pdf',
            url: '/api/workspaces/ws-test/resources/1-turev.pdf',
            relativePath: 'resources/1-turev.pdf',
            uploadedAt: new Date().toISOString(),
          },
        ],
        annotation: {
          id: 'a1',
          url: '/api/workspaces/ws-test/annotations/snap-1.png',
          relativePath: 'annotations/snap-1.png',
          sourceLabel: 'turev.pdf',
          createdAt: new Date().toISOString(),
        },
      });

      expect(prompt).toContain('resources/1-turev.pdf');
      expect(prompt).toContain('annotations/snap-1.png');
      expect(prompt).toContain('study-artifact type="3d-scene"');
      expect(prompt).toContain('Türevin geometrik anlamını göster');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('checks local agy CLI availability', async () => {
    const status = await checkAgyStatus(true);
    expect(typeof status.available).toBe('boolean');
    if (status.available) {
      expect(status.version).toBeTruthy();
    }
  });
  it('asks questions in English when the exam language is English, keeping chat Turkish', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-lang-'));
    const prompt = await buildStudyPrompt(workspaceDir, {
      workspace: { title: 'Electronics', subject: 'EE', examLanguage: 'en' } as never,
      userMessage: 'Alıştırma oluştur',
      studyMode: 'exam',
      selectedResources: [],
    });
    expect(prompt).toContain('SORU / SINAV DİLİ: İNGİLİZCE');
    expect(prompt).toContain('quiz');
    expect(prompt).toContain('soruyu Türkçeye ÇEVİRME');
    expect(examLanguageInstruction('tr')).toContain('TÜRKÇE');
    expect(examLanguageInstruction(undefined)).toContain('KAYNAKLARIN DİLİ');
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('maps user_input DONE and thinking step_updates to Turkish thinking statuses', () => {
    const stdThink = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"user_input"}}',
      'gemini-3.8-flash-low',
    );
    expect(stdThink?.type).toBe('status');
    expect(stdThink?.statusMessage).toBe('Gemini düşünüyor...');

    const deepThink = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"DONE","step_type":"user_input"}}',
      'gemini-4-neon-high',
    );
    expect(deepThink?.type).toBe('status');
    expect(deepThink?.statusMessage).toBe('Gemini derin düşünüyor...');

    const thoughtDelta = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"conversation_id":"c1","state":"ACTIVE","step_type":"planner_response","thought_delta":"Analiz..."}}',
    );
    expect(thoughtDelta?.type).toBe('status');
    expect(thoughtDelta?.statusMessage).toBe('Gemini derin düşünüyor...');
  });

  it('builds a compact delta prompt on follow-up turns and only includes changed context', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-delta-'));
    try {
      const ws = {
        id: 'ws-delta',
        title: 'Fizik',
        subject: 'Fizik',
        color: '#6366f1',
        icon: 'atom',
        studyMode: 'visual',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never;

      const fullPrompt = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'İlk soru',
        studyMode: 'visual',
        selectedResources: [],
        isFollowUp: false,
      });
      const unchangedFollowUp = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Bunu daha basit anlat',
        studyMode: 'visual',
        selectedResources: [],
        isFollowUp: true,
        changedContext: { studyMode: false, examLanguage: false, resources: false },
      });
      const modeChangedFollowUp = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Şimdi test yap',
        studyMode: 'exam',
        selectedResources: [],
        isFollowUp: true,
        changedContext: { studyMode: true, examLanguage: false, resources: false },
      });

      expect(fullPrompt.length).toBeGreaterThan(2000);
      expect(unchangedFollowUp).toBe('Bunu daha basit anlat');
      expect(unchangedFollowUp).not.toContain('study-artifact type="3d-scene"');
      expect(modeChangedFollowUp).toContain('SINAV KOÇU');
      expect(modeChangedFollowUp).toContain('Şimdi test yap');
      expect(modeChangedFollowUp).not.toContain('study-artifact type="3d-scene"');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('adds page-by-page rules, the viewed page and the sync-mode task to the prompt', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-pages-'));
    try {
      const ws = { title: 'Analiz', subject: 'Matematik' } as never;
      const first = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Merhaba',
        studyMode: 'visual',
        selectedResources: [],
      });
      expect(first).toContain('SAYFA SAYFA ANLATIM');
      expect(first).not.toContain('SAYFA SENKRON MODU');

      const synced = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Anlat',
        studyMode: 'visual',
        selectedResources: [],
        viewingPath: 'resources/ders.pdf',
        viewingPage: 4,
        viewingPageCount: 20,
        pageByPage: true,
        isFollowUp: true,
        changedContext: {},
      });
      expect(synced).toContain('4/20. sayfasını');
      expect(synced).toContain('SAYFA SENKRON MODU AÇIK');
      expect(synced).toContain('4. sayfadan başla');
      expect(synced).toContain('<!-- kaynak: resources/ders.pdf -->');
      expect(synced).toContain('## Sayfa N');

      const noViewerOpen = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Hafta2.pdf kaynağını anlat',
        studyMode: 'visual',
        selectedResources: [],
        pageByPage: true,
        isFollowUp: true,
        changedContext: {},
      });
      expect(noViewerOpen).toContain('SAYFA SENKRON MODU AÇIK');
      expect(noViewerOpen).toContain('<!-- kaynak: DOSYA_YOLU -->');

      const asked = await buildStudyPrompt(tmpDir, {
        workspace: ws,
        userMessage: 'Bu PDFi sayfa sayfa anlatır mısın?',
        studyMode: 'visual',
        selectedResources: [],
        isFollowUp: true,
        changedContext: {},
      });
      expect(asked).toContain('SAYFA SAYFA ANLATIM');
      expect(wantsPageByPage('slayt slayt geç')).toBe(true);
      expect(wantsPageByPage('bu sayfayı anlat')).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates an isolation .git boundary at the workspaces root without touching parent folders', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-iso-'));
    const wsDir = path.join(root, 'workspaces', 'ws-1');
    await fs.mkdir(wsDir, { recursive: true });
    try {
      await ensureAgyIsolationBoundary(wsDir);
      const stat = await fs.stat(path.join(root, 'workspaces', '.git'));
      expect(stat.isDirectory()).toBe(true);
      await expect(fs.stat(path.join(root, '.git'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reuses a warm persistent agy process across turns and respawns on model change', async () => {
    const { spawn } = await import('node:child_process');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-pool-'));
    const mockScript = path.join(tmpDir, 'mock-agy.mjs');
    await fs.writeFile(
      mockScript,
      `
import readline from 'node:readline';
const convId = 'conv-' + process.pid;
console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = msg.message?.content || '';
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: convId, state: 'DONE', step_type: 'user_input' } }));
  const reply = 'pid:' + process.pid + ':' + text;
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: convId, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: reply, duration_seconds: 99 } }));
});
`,
      'utf-8',
    );

    const pool = new AgySessionPool({
      idleTtlMs: 30_000,
      maxSessions: 2,
      spawnFn: (_bin, _args, opts) => spawn(process.execPath, [mockScript], opts as never),
    });

    try {
      // Pre-warm and wait briefly for init
      await pool.warm('ws:s1', {
        binary: 'mock-agy',
        workspaceDir: tmpDir,
        model: 'gemini-4-neon-high',
      });
      await new Promise((r) => setTimeout(r, 120));

      const turn1 = await pool.runTurn('ws:s1', {
        binary: 'mock-agy',
        workspaceDir: tmpDir,
        model: 'gemini-4-neon-high',
        prompt: 'merhaba',
        parseLine: parseAgyStreamLine,
        onEvent: () => {},
      });
      expect(turn1.reusedWarmSession).toBe(true);
      expect(turn1.response).toMatch(/^pid:\d+:merhaba$/);
      expect(turn1.durationSeconds).toBeLessThan(10); // per-turn wall clock, not mock's cumulative 99

      const turn2 = await pool.runTurn('ws:s1', {
        binary: 'mock-agy',
        workspaceDir: tmpDir,
        conversationId: turn1.conversationId,
        model: 'gemini-4-neon-high',
        prompt: 'devam',
        parseLine: parseAgyStreamLine,
        onEvent: () => {},
      });
      expect(turn2.reusedWarmSession).toBe(true);
      expect(turn2.conversationId).toBe(turn1.conversationId);
      expect(turn2.response.split(':')[1]).toBe(turn1.response.split(':')[1]); // same PID!

      // Changing model must cleanly spawn a fresh process (new PID)
      const turn3 = await pool.runTurn('ws:s1', {
        binary: 'mock-agy',
        workspaceDir: tmpDir,
        conversationId: turn1.conversationId,
        model: 'gemini-3.8-flash-low',
        prompt: 'hizli',
        parseLine: parseAgyStreamLine,
        onEvent: () => {},
      });
      expect(turn3.reusedWarmSession).toBe(false);
      expect(turn3.response.split(':')[1]).not.toBe(turn1.response.split(':')[1]);
    } finally {
      pool.disposeAll();
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 40 });
    }
  });
});
