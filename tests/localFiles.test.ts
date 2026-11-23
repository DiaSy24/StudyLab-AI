import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../server/index.js';
import { buildStudyPrompt } from '../server/services/agyBridge.js';
import { detectResourceCategory, isProbablyText } from '../server/services/localFiles.js';
import type { StudyResource, Workspace } from '../src/types/study.js';

describe('code files & linked local resources', () => {
  let tmpDataDir: string;
  let projectDir: string;
  let outsideFile: string;
  let app: Express;
  let wsId: string;

  beforeAll(async () => {
    tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-local-data-'));
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-local-proj-'));
    projectDir = path.join(base, 'MyProject');
    await fs.mkdir(path.join(projectDir, 'src', 'app'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'src', 'app', 'Main.java'),
      'public class Main { public static void main(String[] a) { System.out.println("Merhaba"); } }',
    );
    await fs.writeFile(path.join(projectDir, 'README.md'), '# Proje');
    await fs.writeFile(path.join(projectDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
    outsideFile = path.join(base, 'secret.txt');
    await fs.writeFile(outsideFile, 'gizli');

    const created = await createApp({ dataDir: tmpDataDir, seedDemo: false });
    app = created.app;
    const ws = await request(app).post('/api/workspaces').send({ title: 'Yazılım' }).expect(201);
    wsId = ws.body.workspace.id;
  });

  afterAll(async () => {
    await fs.rm(tmpDataDir, { recursive: true, force: true });
    await fs.rm(path.dirname(projectDir), { recursive: true, force: true });
  });

  it('detects code and plain-text categories', () => {
    expect(detectResourceCategory('', 'Main.java')).toBe('code');
    expect(detectResourceCategory('application/octet-stream', 'script.py')).toBe('code');
    expect(detectResourceCategory('', 'Dockerfile')).toBe('code');
    expect(detectResourceCategory('', 'notlar.md')).toBe('note');
    expect(detectResourceCategory('', 'ders.pdf')).toBe('pdf');
    expect(detectResourceCategory('', 'veri.unknownext', Buffer.from('plain text'))).toBe('code');
    expect(detectResourceCategory('', 'veri.bin', Buffer.from([0, 1, 2, 3]))).toBe('other');
    expect(isProbablyText(Buffer.from('ğüşıöç héllo'))).toBe(true);
  });

  it('uploads a .java file as a code resource', async () => {
    const up = await request(app)
      .post(`/api/workspaces/${wsId}/resources`)
      .attach('files', Buffer.from('class A {}'), { filename: 'A.java', contentType: 'application/octet-stream' })
      .expect(201);
    expect(up.body.resources[0].category).toBe('code');
  });

  it('links a local folder, lists its tree (skipping node_modules) and serves files inside it', async () => {
    const link = await request(app)
      .post(`/api/workspaces/${wsId}/resources/link`)
      .send({ path: projectDir })
      .expect(201);
    const res = link.body.resource as StudyResource;
    expect(res.category).toBe('folder');
    expect(res.source).toBe('local');

    // Linking the same path twice returns the existing resource
    const again = await request(app).post(`/api/workspaces/${wsId}/resources/link`).send({ path: projectDir }).expect(201);
    expect(again.body.resource.id).toBe(res.id);

    const tree = await request(app).get(res.url).expect(200);
    const paths = tree.body.entries.map((e: { path: string }) => e.path);
    expect(paths).toContain('src/app/Main.java');
    expect(paths).toContain('README.md');
    expect(paths.some((p: string) => p.startsWith('node_modules'))).toBe(false);

    const file = await request(app)
      .get(`/api/workspaces/${wsId}/linked/${res.id}/file`)
      .query({ path: 'src/app/Main.java' })
      .expect(200);
    expect(file.text).toContain('System.out.println');

    // Path traversal outside the linked folder is refused
    await request(app)
      .get(`/api/workspaces/${wsId}/linked/${res.id}/file`)
      .query({ path: '../secret.txt' })
      .expect(400);
  });

  it('links a single local file and never deletes it when the link is removed', async () => {
    const javaPath = path.join(projectDir, 'src', 'app', 'Main.java');
    const link = await request(app).post(`/api/workspaces/${wsId}/resources/link`).send({ path: javaPath }).expect(201);
    const res = link.body.resource as StudyResource;
    expect(res.category).toBe('code');
    const body = await request(app).get(res.url).expect(200);
    expect(body.text).toContain('class Main');

    await request(app).delete(`/api/workspaces/${wsId}/resources/${res.id}`).expect(200);
    await expect(fs.readFile(javaPath, 'utf-8')).resolves.toContain('class Main');
  });

  it('returns 404 for a missing path and blocks other websites', async () => {
    await request(app)
      .post(`/api/workspaces/${wsId}/resources/link`)
      .send({ path: path.join(projectDir, 'yok-boyle-bir-sey') })
      .expect(404);

    await request(app)
      .get('/api/fs/browse')
      .query({ path: projectDir })
      .set('Origin', 'https://evil.example.com')
      .expect(403);

    const browse = await request(app).get('/api/fs/browse').query({ path: projectDir }).expect(200);
    const names = browse.body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(['src', 'README.md']));
    expect(browse.body.parent).toBe(path.dirname(projectDir));
  });

  it('tells agy about linked folders via a listing file and absolute paths', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-prompt-'));
    const folder: StudyResource = {
      id: 'res-folder',
      workspaceId: 'ws',
      name: 'MyProject',
      storedName: '',
      mimeType: 'inode/directory',
      size: 0,
      category: 'folder',
      url: '',
      relativePath: projectDir,
      uploadedAt: new Date().toISOString(),
      source: 'local',
      localPath: projectDir,
    };
    const workspace = { title: 'Yazılım', subject: 'Java' } as Workspace;
    const prompt = await buildStudyPrompt(workspaceDir, {
      workspace,
      userMessage: 'Projeyi açıkla',
      studyMode: 'visual',
      selectedResources: [folder],
    });
    expect(prompt).toContain(projectDir);
    expect(prompt).toContain('.linked-tree-res-folder.txt');
    const listing = await fs.readFile(path.join(workspaceDir, '.linked-tree-res-folder.txt'), 'utf-8');
    expect(listing).toContain('src/app/Main.java');
    expect(listing).not.toContain('node_modules');
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
