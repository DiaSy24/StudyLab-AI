import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../server/index.js';
import { buildStudyPrompt } from '../server/services/agyBridge.js';
import { detectResourceCategory } from '../server/services/localFiles.js';
import { ensureExtractedText, extractText, rtfToText } from '../server/services/textExtract.js';
import type { StudyResource, Workspace } from '../src/types/study.js';

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx(slides: string[]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((t, i) =>
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('document text extraction (Word, PowerPoint, Excel, old formats)', () => {
  let dir: string;
  let dataDir: string;
  let app: Express;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-docs-'));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-docs-data-'));
    await fs.writeFile(path.join(dir, 'Odev.docx'), await makeDocx('Bağlı listeler ödevi'));
    await fs.writeFile(path.join(dir, 'Sunum.pptx'), await makePptx(['Ağaçlar', 'İkili arama']));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Öğrenci', 'Not'], ['Ayşe', 90]]), 'Notlar');
    await fs.writeFile(path.join(dir, 'Notlar.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    await fs.writeFile(
      path.join(dir, 'eski.doc'),
      Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(40), Buffer.from('Eski Word içeriği', 'utf16le'), Buffer.alloc(20)]),
    );
    ({ app } = await createApp({ dataDir, seedDemo: false }));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('extracts text from docx, pptx, xlsx and old binary .doc', async () => {
    expect((await extractText(path.join(dir, 'Odev.docx')))?.text).toContain('Bağlı listeler ödevi');

    const pptx = await extractText(path.join(dir, 'Sunum.pptx'));
    expect(pptx?.text).toContain('=== Slayt 1 ===');
    expect(pptx?.text).toContain('İkili arama');

    const xlsx = await extractText(path.join(dir, 'Notlar.xlsx'));
    expect(xlsx?.text).toContain('=== Sayfa: Notlar ===');
    expect(xlsx?.text).toContain('Ayşe,90');

    const doc = await extractText(path.join(dir, 'eski.doc'));
    expect(doc?.approximate).toBe(true);
    expect(doc?.text).toContain('Eski Word içeriği');

    expect(rtfToText('{\\rtf1\\ansi {\\fonttbl{\\f0 Arial;}}\\f0 Merhaba\\par D\\u252?nya}')).toBe('Merhaba\nDünya');
  });

  it('classifies office files as documents', () => {
    expect(detectResourceCategory('', 'Odev.docx')).toBe('document');
    expect(detectResourceCategory('', 'Sunum.pptx')).toBe('document');
    expect(detectResourceCategory('', 'Notlar.xlsx')).toBe('document');
    expect(detectResourceCategory('video/mp4', 'ders.mp4')).toBe('document');
    expect(detectResourceCategory('', 'defter.ipynb')).toBe('document');
  });

  it('caches extracted text and refreshes it when the source changes', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-ws-'));
    const src = path.join(dir, 'Odev.docx');
    const rel = await ensureExtractedText(ws, 'res-1', src, 'Odev.docx');
    expect(rel).toBe('.extracted/res-1.txt');
    expect(await fs.readFile(path.join(ws, rel!), 'utf-8')).toContain('Bağlı listeler ödevi');

    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(src, await makeDocx('Güncellenmiş ödev'));
    await ensureExtractedText(ws, 'res-1', src, 'Odev.docx');
    expect(await fs.readFile(path.join(ws, rel!), 'utf-8')).toContain('Güncellenmiş ödev');
    await fs.writeFile(src, await makeDocx('Bağlı listeler ödevi'));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('serves extracted text for uploaded and linked-folder documents', async () => {
    const created = await request(app).post('/api/workspaces').send({ title: 'Belgeler' }).expect(201);
    const wsId = created.body.workspace.id;

    const up = await request(app)
      .post(`/api/workspaces/${wsId}/resources`)
      .attach('files', await fs.readFile(path.join(dir, 'Odev.docx')), 'Odev.docx')
      .expect(201);
    const uploaded = up.body.resources[0] as StudyResource;
    expect(uploaded.category).toBe('document');
    const t1 = await request(app).get(`/api/workspaces/${wsId}/resources/${uploaded.id}/text`).expect(200);
    expect(t1.body.text).toContain('Bağlı listeler ödevi');
    expect(t1.body.kind).toBe('Word belgesi');

    const link = await request(app).post(`/api/workspaces/${wsId}/resources/link`).send({ path: dir }).expect(201);
    const folderId = link.body.resource.id;
    const t2 = await request(app)
      .get(`/api/workspaces/${wsId}/resources/${folderId}/text`)
      .query({ path: 'Sunum.pptx' })
      .expect(200);
    expect(t2.body.text).toContain('Ağaçlar');
    await request(app).get(`/api/workspaces/${wsId}/resources/${folderId}/text`).query({ path: '../x' }).expect(400);
  });

  it('points agy to extracted text for documents in linked folders', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-ws-'));
    const folder: StudyResource = {
      id: 'fold',
      workspaceId: 'w',
      name: 'Ders',
      storedName: '',
      mimeType: 'inode/directory',
      size: 0,
      category: 'folder',
      url: '',
      relativePath: dir,
      uploadedAt: new Date().toISOString(),
      source: 'local',
      localPath: dir,
    };
    await buildStudyPrompt(ws, {
      workspace: { title: 'Ders', subject: 'x' } as Workspace,
      userMessage: 'özetle',
      studyMode: 'visual',
      selectedResources: [folder],
    });
    const listing = await fs.readFile(path.join(ws, '.linked-tree-fold.txt'), 'utf-8');
    expect(listing).toMatch(/Odev\.docx \| \d+ → metin: \.extracted\/fold\/Odev\.docx\.txt/);
    expect(await fs.readFile(path.join(ws, '.extracted', 'fold', 'Odev.docx.txt'), 'utf-8')).toContain('Bağlı listeler');
    await fs.rm(ws, { recursive: true, force: true });
  });
});
