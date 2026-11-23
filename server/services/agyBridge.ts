import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgyModelInfo,
  AgyStatus,
  AnnotationAttachment,
  StudyArtifact,
  StudyMode,
  StudyResource,
  Workspace,
} from '../../src/types/study.js';
import { agySessionPool, ensureAgyIsolationBoundary } from './agySessionPool.js';
import {
  classifyModelsFailure,
  clearAgyBinaryCache,
  discoverAgyBinary,
  getInstallCommand,
  getLoginCommand,
  isAgyInstallInProgress,
} from './agySetup.js';
import { listTreeCached } from './localFiles.js';
import { ensureExtractedText, isExtractable } from './textExtract.js';

const execFileAsync = promisify(execFile);

export interface AgyStreamEvent {
  type: 'init' | 'delta' | 'status' | 'result' | 'error';
  conversationId?: string;
  text?: string;
  statusMessage?: string;
  durationSeconds?: number;
  error?: string;
}

export interface RunAgyOptions {
  workspaceDir: string;
  prompt: string;
  conversationId?: string;
  model?: string;
  /** Extra directories agy may read (e.g. folders linked from the user's computer). */
  extraDirs?: string[];
  onEvent: (event: AgyStreamEvent) => void;
}

export interface RunAgyResult {
  response: string;
  conversationId?: string;
  durationSeconds?: number;
  reusedWarmSession?: boolean;
}

export interface WarmAgyOptions {
  workspaceDir: string;
  conversationId?: string;
  model?: string;
  extraDirs?: string[];
}

const activeFallbackProcesses = new Map<string, ChildProcess>();

export function resolveAgyBinary(forceRefresh = false): string {
  return discoverAgyBinary({ forceRefresh });
}

function isHighEffortModel(model?: string): boolean {
  if (!model) return false;
  return /-(high|xhigh|max)$/i.test(model.trim());
}

function humanizeStepType(stepType: string): string | null {
  switch (stepType) {
    case 'view_file':
    case 'read_file':
      return 'Kaynak veya işaretli görsel inceleniyor...';
    case 'list_dir':
    case 'find_by_name':
    case 'grep_search':
      return 'Çalışma alanı dosyaları taranıyor...';
    case 'search_web':
    case 'read_url_content':
      return 'Ek bilgi araştırılıyor...';
    case 'agent_response':
      return 'Yanıt ve etkileşimli materyal hazırlanıyor...';
    default:
      return null;
  }
}

/**
 * Parses a single NDJSON line emitted by `agy --output-format stream-json`.
 */
export function parseAgyStreamLine(line: string, model?: string): AgyStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const eventName = obj.event as string | undefined;

    if (eventName === 'init') {
      const conversationId = obj.conversation_id as string | undefined;
      return {
        type: 'init',
        conversationId,
        statusMessage: 'Gemini oturumu hazır...',
      };
    }

    if (eventName === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
      const su = obj.step_update as Record<string, unknown>;
      const conversationId = su.conversation_id as string | undefined;
      const stepType = String(su.step_type || '');
      const state = String(su.state || '');
      const textDelta = typeof su.text_delta === 'string' ? su.text_delta : '';

      if (textDelta) {
        return {
          type: 'delta',
          conversationId,
          text: textDelta,
        };
      }

      // Surface thinking/reasoning steps explicitly so the UI never looks stuck connecting
      const hasThought =
        typeof su.thought_delta === 'string' ||
        typeof su.thinking === 'string' ||
        typeof su.thought === 'string' ||
        /think|reason|plan/i.test(stepType);
      if (hasThought) {
        return {
          type: 'status',
          conversationId,
          statusMessage: 'Gemini derin düşünüyor...',
        };
      }

      // `user_input` DONE means agy has received the prompt and handed it off to Gemini
      if (stepType === 'user_input' && state === 'DONE') {
        return {
          type: 'status',
          conversationId,
          statusMessage: isHighEffortModel(model)
            ? 'Gemini derin düşünüyor...'
            : 'Gemini düşünüyor...',
        };
      }

      const statusMsg = humanizeStepType(stepType);
      if (statusMsg && state === 'ACTIVE') {
        return {
          type: 'status',
          conversationId,
          statusMessage: statusMsg,
        };
      }
      return null;
    }

    if (eventName === 'result' && obj.result && typeof obj.result === 'object') {
      const res = obj.result as Record<string, unknown>;
      const status = String(res.status || 'SUCCESS');
      const conversationId = res.conversation_id as string | undefined;
      const durationSeconds =
        typeof res.duration_seconds === 'number' ? res.duration_seconds : undefined;

      if (status !== 'SUCCESS' && res.error) {
        return {
          type: 'error',
          conversationId,
          error: String(res.error),
        };
      }

      return {
        type: 'result',
        conversationId,
        text: typeof res.response === 'string' ? res.response : '',
        durationSeconds,
      };
    }

    if (eventName === 'error') {
      return {
        type: 'error',
        error: String(obj.error || obj.message || 'Bilinmeyen agy hatası'),
      };
    }
  } catch {
    return null;
  }

  return null;
}

let cachedStatus: { value: AgyStatus; fetchedAt: number } | null = null;

export function invalidateAgyStatusCache(): void {
  cachedStatus = null;
  clearAgyBinaryCache();
}

export function getCachedAgyStatus(): AgyStatus | null {
  return cachedStatus?.value ?? null;
}

export function parseModelsOutput(modelsOut: string): AgyModelInfo[] {
  return modelsOut
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Fetching'))
    .map((line) => {
      const parts = line.split(/\t+/);
      if (parts.length >= 2) {
        return { id: parts[0].trim(), label: parts.slice(1).join(' ').trim() };
      }
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx > 0) {
        return { id: line.slice(0, spaceIdx).trim(), label: line.slice(spaceIdx + 1).trim() };
      }
      return { id: line, label: line };
    });
}

export type AgyExecFn = (
  bin: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr?: string }>;

function extractExecErrorInfo(err: unknown): {
  code?: string;
  message: string;
  stdout: string;
  stderr: string;
} {
  const e = err as {
    code?: string | number;
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  return {
    code: e?.code !== undefined ? String(e.code) : undefined,
    message: e?.message || String(err || ''),
    stdout: typeof e?.stdout === 'string' ? e.stdout : e?.stdout?.toString('utf-8') || '',
    stderr: typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString('utf-8') || '',
  };
}

/** Readable failure text: first line of the message plus exit code and any output agy printed. */
function describeExecFailure(info: ReturnType<typeof extractExecErrorInfo>): string {
  const parts = [info.message.split(/\r?\n/)[0].trim()];
  if (info.code) parts.push(`çıkış kodu: ${info.code}`);
  const output = [info.stderr, info.stdout].map((s) => s.trim()).filter(Boolean).join(' | ');
  if (output) parts.push(output.slice(0, 300));
  return parts.join(' — ');
}

/**
 * Pure status inspection helper (injectable for deterministic unit tests).
 */
export async function inspectAgyStatus(
  bin: string,
  execFn: AgyExecFn = (cmd, args, opts) => execFileAsync(cmd, args, opts),
  platform: NodeJS.Platform = process.platform,
): Promise<AgyStatus> {
  const baseMeta = {
    platform,
    installCommand: getInstallCommand(platform),
    loginCommand: getLoginCommand(),
    installInProgress: isAgyInstallInProgress(),
  };

  const runVersion = async () => {
    try {
      return await execFn(bin, ['--version'], { timeout: 8_000 });
    } catch (err) {
      // One retry: agy self-updates replace the exe in place, which can make a single call fail.
      if (extractExecErrorInfo(err).code === 'ENOENT') throw err;
      await new Promise((r) => setTimeout(r, 750));
      return execFn(bin, ['--version'], { timeout: 8_000 });
    }
  };

  const [versionSettled, modelsSettled] = await Promise.allSettled([
    runVersion(),
    execFn(bin, ['models'], { timeout: 12_000 }),
  ]);

  // `--version` is informational only: if `models` still lists models, agy is usable.
  const modelsListed =
    modelsSettled.status === 'fulfilled' &&
    parseModelsOutput(modelsSettled.value.stdout || '').length > 0;

  if (versionSettled.status === 'rejected' && !modelsListed) {
    const info = extractExecErrorInfo(versionSettled.reason);
    const isMissing =
      info.code === 'ENOENT' ||
      /enoent|not\s+recognized|not\s+found|no\s+such\s+file/i.test(info.message);

    return {
      available: false,
      state: isMissing ? 'not_installed' : 'error',
      installed: false,
      authenticated: false,
      models: [],
      error: isMissing
        ? 'Antigravity CLI (agy) bu bilgisayarda kurulu değil.'
        : `Antigravity CLI (agy) çalıştırılamadı: ${describeExecFailure(info)}`,
      ...baseMeta,
    };
  }

  const version =
    versionSettled.status === 'fulfilled'
      ? versionSettled.value.stdout.trim().split(/\r?\n/)[0] || 'unknown'
      : 'unknown';

  if (modelsSettled.status === 'fulfilled') {
    const models = modelsSettled.value.stdout ? parseModelsOutput(modelsSettled.value.stdout) : [];
    if (models.length > 0) {
      return {
        available: true,
        state: 'ready',
        installed: true,
        authenticated: true,
        version,
        binaryPath: bin,
        models,
        ...baseMeta,
      };
    }

    const classified = classifyModelsFailure(
      modelsSettled.value.stderr || '',
      modelsSettled.value.stdout || '',
    );
    return {
      available: false,
      state: classified.state,
      installed: true,
      authenticated: false,
      version,
      binaryPath: bin,
      models: [],
      authError: classified.rawDetail,
      error: classified.message,
      ...baseMeta,
    };
  }

  const modelsErr = extractExecErrorInfo(modelsSettled.reason);
  const classified = classifyModelsFailure(
    modelsErr.stderr,
    modelsErr.stdout,
    modelsErr.message,
  );

  return {
    available: false,
    state: classified.state,
    installed: true,
    authenticated: false,
    version,
    binaryPath: bin,
    models: [],
    authError: classified.rawDetail,
    error: classified.message,
    ...baseMeta,
  };
}

export async function checkAgyStatus(forceRefresh = false): Promise<AgyStatus> {
  if (!forceRefresh && cachedStatus) {
    const ttl = cachedStatus.value.available ? 30_000 : 5_000;
    if (Date.now() - cachedStatus.fetchedAt < ttl) {
      return {
        ...cachedStatus.value,
        installInProgress: isAgyInstallInProgress(),
      };
    }
  }

  const bin = resolveAgyBinary(forceRefresh);
  const status = await inspectAgyStatus(bin);
  cachedStatus = { value: status, fetchedAt: Date.now() };
  return status;
}

/** Rules for the language of questions/quizzes, independent of the (Turkish) conversation. */
export function examLanguageInstruction(lang: Workspace['examLanguage']): string {
  if (lang === 'tr') {
    return 'SORU / SINAV DİLİ: TÜRKÇE. Alıştırma, quiz ve sınav sorularını Türkçe sor; teknik terimlerin İngilizcesini ilk geçtiği yerde parantez içinde ver.';
  }
  const englishRules = [
    'Sohbet ve konu anlatımı Türkçe kalır; ANCAK öğrenciye yönelttiğin TÜM SORULAR İNGİLİZCE olmalı, çünkü kaynaklar ve gerçek sınav İngilizce:',
    '   - `study-artifact type="quiz"` içindeki her şey İngilizce: başlık (title), "topic", her "prompt", tüm "options", "hints" ve "explanation". "explanation" İngilizce yazılır; gerekirse sonuna tek satırlık kısa bir Türkçe not ("TR: ...") ekleyebilirsin.',
    '   - Sohbet içinde sorduğun pratik, alıştırma ve sınav tarzı sorular (ör. "Soru 1: ...") İngilizce yazılır; soruyu Türkçeye ÇEVİRME.',
    '   - Kaynaklardaki İngilizce terimleri ve gösterimi aynen kullan (ör. "node voltage", "Thevenin equivalent", "time complexity"). Türkçe anlatırken bir terimi ilk kullandığında İngilizcesini parantez içinde ver: "düğüm gerilimi (node voltage)".',
    '   - Öğrenci İngilizce bir soruya Türkçe cevap verirse cevabı normal şekilde değerlendir; geri bildirimi Türkçe ver ama doğru cevabı/terimi İngilizce de yaz.',
    '   - Sokratik moddaki kısa yönlendirici sohbet soruları Türkçe olabilir; ama çözülmesi istenen problem/soru metni İngilizce olmalı.',
  ];
  if (lang === 'en') {
    return ['SORU / SINAV DİLİ: İNGİLİZCE.', ...englishRules].join('\n');
  }
  return [
    'SORU / SINAV DİLİ: KAYNAKLARIN DİLİ. Öğrencinin ders kaynakları hangi dildeyse soruları o dilde sor. Kaynaklar İngilizceyse aşağıdaki kurallar geçerlidir:',
    ...englishRules,
  ].join('\n');
}

const MODE_INSTRUCTIONS: Record<StudyMode, string> = {
  visual:
    'Çalışma Modu: GÖRSEL VE DETAYLI ANLATIM. Kavramları sezgisel benzetmelerle, temiz LaTeX matematikle ($...$ ve $$...$$) anlat. Konu görselleştirmeye uygunsa mutlaka etkileşimli 2D çizim, 3D Three.js modeli veya Formül Laboratuvarı artefaktı üret.',
  socratic:
    'Çalışma Modu: SOKRATİK ORTAK ÇALIŞMA. Doğrudan cevabı vermek yerine öğrenciyle adım adım ilerle. Önce öğrencinin doğru yaptığı yerleri vurgula, takıldığı yer için yol gösterici sorular sor ve mümkünse ortak tahtaya (study-board-action) kısa bir ipucu/adım kartı ekle.',
  exam:
    'Çalışma Modu: SINAV KOÇU VE ALIŞTIRMA. Öğrencinin kaynaklarına veya konusuna uygun, öğretici sorular üret (`study-artifact type="quiz"`), sık yapılan hataları belirt ve çözüm stratejisi ver.',
};

export interface ChangedPromptContext {
  studyMode?: boolean;
  examLanguage?: boolean;
  resources?: boolean;
  activeArtifact?: boolean;
}

export interface BuildPromptParams {
  workspace: Workspace;
  userMessage: string;
  studyMode: StudyMode;
  selectedResources: StudyResource[];
  annotation?: AnnotationAttachment;
  activeArtifact?: StudyArtifact | null;
  coStudyAction?: 'check-step' | 'hint' | 'visualize-board' | 'fix-artifact';
  artifactError?: string;
  /** File the student currently has open in the resource viewer. */
  viewingPath?: string;
  /** 1-based page (or slide) of `viewingPath` currently shown in the viewer. */
  viewingPage?: number;
  /** Total page/slide count of `viewingPath`, when known. */
  viewingPageCount?: number;
  /** True when the client's "Sayfa Senkron" (page-by-page) mode is on. */
  pageByPage?: boolean;
  /** True when the question comes from the focused Hızlı Chat channel. */
  isQuickChat?: boolean;
  /** True when continuing an existing agy conversation that already received the full system prompt. */
  isFollowUp?: boolean;
  /** Which context facets changed since the previous turn (used when isFollowUp is true). */
  changedContext?: ChangedPromptContext;
}

/** Shared rule describing the page heading format the client splits on (see src/lib/pageSections.ts). */
export const PAGE_BY_PAGE_RULE =
  'SAYFA SAYFA ANLATIM: Öğrenci bir kaynağı "sayfa sayfa", "slayt slayt" veya "her sayfayı" anlatmanı isterse, her sayfanın açıklamasını AYRI bir Markdown başlığıyla başlat: `## Sayfa N` (sunumlarda `## Slayt N`), istersen sonrasına kısa konu ekle (ör. `## Sayfa 3 — Türevin tanımı`). Birlikte anlatılan ardışık sayfalar için `## Sayfa 3-4` yaz. N, dosyadaki FİZİKSEL sayfa sırasıdır (1. sayfa = dosyanın ilk sayfası); sayfanın üzerinde basılı sayfa numarasını kullanma. Her başlığın altında yalnızca o sayfanın içeriğini anlat, başka hiçbir yerde bu biçimde başlık kullanma.';

const PAGE_BY_PAGE_REQUEST_RE = /sayfa\s+sayfa|slayt\s+slayt|her\s+(?:bir\s+)?(?:sayfa|slayt)|page\s+by\s+page|slide\s+by\s+slide/i;

export function wantsPageByPage(message: string): boolean {
  return PAGE_BY_PAGE_REQUEST_RE.test(message);
}

const EXTRACT_CONCURRENCY = 8;

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === content) return;
  } catch {
    // file does not exist yet
  }
  await fs.writeFile(filePath, content, 'utf-8');
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** If the file is a binary document (Word, PowerPoint, Excel...), extract its text and explain where it is. */
async function extractedTextHint(
  workspaceDir: string,
  key: string,
  absolutePath: string,
  name: string,
): Promise<string> {
  if (!isExtractable(name)) return '';
  try {
    const rel = await ensureExtractedText(workspaceDir, key, absolutePath, name);
    return rel
      ? ` Bu dosya ikili bir belge olduğu için \`view_file\` ile doğrudan okunamaz; METNİ \`${rel}\` dosyasına çıkarıldı — onu \`view_file\` ile oku.`
      : '';
  } catch {
    return '';
  }
}

async function formatResourceSection(
  workspaceDir: string,
  selectedResources: StudyResource[],
): Promise<string[]> {
  if (selectedResources.length === 0) return [];

  const lines: string[] = [
    '',
    'BAĞLAMDAKİ DERS KAYNAKLARI (yalnızca bu soru için gerekliyse ve bu oturumda henüz okumadıysan `view_file` ile incele):',
  ];

  const resourceDescriptions = await runWithConcurrency(
    selectedResources,
    4,
    async (res): Promise<string> => {
      if (res.source === 'local' && res.localPath && res.category === 'folder') {
        const treeFile = `.linked-tree-${res.id}.txt`;
        let fileCount = 0;
        let listing = '';
        try {
          const { entries, truncated } = await listTreeCached(res.localPath);
          const files = entries.filter((e) => e.type === 'file');
          fileCount = files.length;

          const extractableFiles = files.filter((x) => isExtractable(x.path)).slice(0, 150);
          const extractedFor = new Map<string, string>();
          await runWithConcurrency(extractableFiles, EXTRACT_CONCURRENCY, async (f) => {
            try {
              const rel = await ensureExtractedText(
                workspaceDir,
                `${res.id}/${f.path}`,
                path.join(res.localPath!, ...f.path.split('/')),
                f.path,
              );
              if (rel) extractedFor.set(f.path, rel);
            } catch {
              // skip unreadable documents
            }
          });

          listing = [
            `Bağlı klasör: ${res.localPath}`,
            `Dosya sayısı: ${fileCount}${truncated ? ' (liste kısaltıldı)' : ''}`,
            'Not: "→ metin:" yazan belgeler (Word/PowerPoint/Excel) ikili dosyalardır; onların yerine belirtilen metin dosyasını oku.',
            '--- DOSYALAR (klasöre göre göreli yol | bayt) ---',
            ...files.map((f) => {
              const extracted = extractedFor.get(f.path);
              return `${f.path} | ${f.size ?? '?'}${extracted ? ` → metin: ${extracted}` : ''}`;
            }),
          ].join('\n');
        } catch {
          listing = `Bağlı klasör okunamadı: ${res.localPath}`;
        }
        await writeFileIfChanged(path.join(workspaceDir, treeFile), listing);
        return (
          `- ${res.name} → kullanıcının bilgisayarındaki KLASÖR: \`${res.localPath}\` (${fileCount} dosya). ` +
          `Tüm dosya listesi \`${treeFile}\` içinde. Dosyaları tam yollarıyla (\`${res.localPath}${path.sep}<göreli yol>\`) yalnızca gerekliyse \`view_file\` ile oku.`
        );
      }

      if (res.source === 'local' && res.localPath) {
        return (
          `- ${res.name} → kullanıcının bilgisayarındaki dosya: \`${res.localPath}\` (${res.category}). Gerekiyorsa ve henüz okumadıysan \`view_file\` ile incele.` +
          (await extractedTextHint(workspaceDir, res.id, res.localPath, res.name))
        );
      }

      if (res.category === 'code') {
        return `- ${res.name} → kaynak kod/metin dosyası: \`${res.relativePath}\`. Gerekiyorsa ve henüz okumadıysan \`view_file\` ile incele.`;
      }

      return (
        `- ${res.name} → dosya yolu: \`${res.relativePath}\` (${res.category}).` +
        (await extractedTextHint(
          workspaceDir,
          res.id,
          path.join(workspaceDir, res.relativePath),
          res.name,
        ))
      );
    },
  );

  lines.push(...resourceDescriptions);
  return lines;
}

export async function buildStudyPrompt(
  workspaceDir: string,
  params: BuildPromptParams,
): Promise<string> {
  const {
    workspace,
    userMessage,
    studyMode,
    selectedResources,
    annotation,
    activeArtifact,
    coStudyAction,
    artifactError,
    viewingPath,
    viewingPage,
    viewingPageCount,
    pageByPage,
    isQuickChat,
    isFollowUp,
    changedContext,
  } = params;

  const sections: string[] = [];

  if (!isFollowUp) {
    // First turn in conversation: send full teacher persona, mode, language, and artifact templates
    sections.push(
      `Sen "StudyLab AI" içinde çalışan üst düzey, sabırlı ve etkileşimli bir Türkçe ders öğretmenisin.`,
      `Çalışma Alanı: "${workspace.title}" (Ders: ${workspace.subject})`,
      MODE_INSTRUCTIONS[studyMode],
      ...(isQuickChat
        ? [
            '',
            'HIZLI CHAT MODU: Öğrenci hızlı ve odaklı bir soru sordu (genellikle bir PDF, görsel veya sahne üzerinde kalemle işaretleyerek). Doğrudan işaretlenen noktaya ve soruya odaklan; net, özlü ve anlaşılır yanıt ver. Öğrenci özellikle etkileşimli 2D/3D çizim, formül laboratuvarı veya quiz istemedikçe gereksiz artefakt üretme (isterse normal şekilde üret).',
          ]
        : []),
      '',
      examLanguageInstruction(workspace.examLanguage),
      '',
      'ÖNEMLİ KURALLAR:',
      '1. Disk üzerinde hiçbir dosya oluşturma, düzenleme veya terminal komutu çalıştırma. Yalnızca aşağıda belirtilen kaynak veya işaretli görsel dosyalarını okumak için `view_file` aracını kullan.',
      '2. Yanıtını (soru/sınav dili kuralı hariç) Türkçe, anlaşılır, yapılandırılmış Markdown ve KaTeX/LaTeX ($x^2$, $$\\int f(x)dx$$) formatında yaz.',
      '3. Etkileşimli görsel, 3D model, formül laboratuvarı veya test oluşturacağında yanıtının içine aşağıdaki özel kod bloklarından uygun olanını doğrudan ekle:',
      '',
      '   a) Etkileşimli 2D çizim / simülasyon için:',
      '      ```study-artifact type="2d-canvas" title="Kısa Türkçe Başlık"',
      '      <!doctype html><html>... (tek dosya, koyu modern tema #0b1120, HTML5 Canvas/SVG, etkileşimli slider/butonlar, Türkçe etiketler) ...</html>',
      '      ```',
      '',
      '   b) Etkileşimli 3D model için (Three.js — yerel sunucudan yüklenir, CDN kullanma!):',
      '      ```study-artifact type="3d-scene" title="Kısa Türkçe Başlık"',
      '      <!doctype html><html>... <script type="module">',
      '      import * as THREE from "three";',
      '      import { OrbitControls } from "three/addons/controls/OrbitControls.js";',
      '      // WebGLRenderer MUTLAKA { antialias: true, preserveDrawingBuffer: true } ile oluşturulmalıdır!',
      '      // Etkileşimli HUD kaydırıcıları ve Türkçe açıklamalar ekle.',
      '      </script></html>',
      '      ```',
      '',
      '   c) Etkileşimli Formül Laboratuvarı için (geçerli JSON):',
      '      ```study-artifact type="formula-lab" title="Formül Başlığı"',
      '      {"latex":"...","subtitle":"...","summary":"...","terms":[{"id":"t1","symbol":"F","label":"Kuvvet","color":"#f43f5e","unit":"N","meaning":"...","analogy":"..."}],"parameters":[{"name":"m","symbol":"m","label":"Kütle","min":1,"max":10,"step":0.5,"defaultValue":2,"unit":"kg"}],"expression":"m * 9.8","resultLabel":"Sonuç","resultUnit":"N","steps":[{"title":"Adım 1","latex":"...","explanation":"..."}]}',
      '      ```',
      '',
      '   d) Etkileşimli Alıştırma / Quiz için (geçerli JSON):',
      '      ```study-artifact type="quiz" title="Alıştırma Başlığı"',
      '      {"topic":"...","difficulty":"orta","questions":[{"id":"q1","type":"mcq","prompt":"...","latex":"...","options":["A","B","C","D"],"correctIndex":0,"hints":["İpucu 1"],"explanation":"..."}]}',
      '      ```',
      '      KOD İÇEREN SORULAR: "prompt" içindeki kodu MUTLAKA dil etiketli bir Markdown kod bloğuna koy (JSON string içinde: "Ne yazdırır?\\n```java\\nint x = 5;\\nif (x > 3) {\\n    System.out.println(x);\\n}\\n```"). Her kod satırını \\n ile ayır, girintiyi (4 boşluk) koru; kodu asla tek satıra sıkıştırma. Şıklarda, ipuçlarında ve açıklamada kısa kod parçalarını `backtick` içine al; çok satırlı kod gerekirse yine ```dil bloğu kullan.',
      '',
      '   e) Ortak Çalışma Tahtasına ipucu/geri bildirim kartı eklemek için (geçerli JSON):',
      '      ```study-board-action',
      '      {"kind":"hint","title":"İpucu","content":"...","latex":"..."}',
      '      ```',
      '',
      `4. ${PAGE_BY_PAGE_RULE}`,
    );
  } else {
    // Follow-up turn in an ongoing conversation: send only changed context deltas
    if (changedContext?.studyMode) {
      sections.push(`GÜNCEL ${MODE_INSTRUCTIONS[studyMode]}`);
    }
    if (changedContext?.examLanguage) {
      sections.push(examLanguageInstruction(workspace.examLanguage));
    }
  }

  const shouldIncludeResources = !isFollowUp || Boolean(changedContext?.resources);
  if (shouldIncludeResources && selectedResources.length > 0) {
    sections.push(...(await formatResourceSection(workspaceDir, selectedResources)));
  }

  if (viewingPath) {
    sections.push(
      '',
      `ÖĞRENCİ ŞU AN EKRANDA ŞU DOSYAYA BAKIYOR: \`${viewingPath}\`. "Bu dosya", "bu kod", "bu sayfa" gibi ifadeler bu dosyayı kastediyor; gerekirse \`view_file\` ile oku.` +
        (await extractedTextHint(
          workspaceDir,
          `viewing/${path.basename(viewingPath)}`,
          path.isAbsolute(viewingPath) ? viewingPath : path.join(workspaceDir, viewingPath),
          viewingPath,
        )),
    );
    if (viewingPage && viewingPage > 0) {
      sections.push(
        `Öğrenci bu dosyanın ${viewingPage}${viewingPageCount ? `/${viewingPageCount}` : ''}. sayfasını (fiziksel sayfa sırası) görüntülüyor; "bu sayfa" ifadesi bu sayfayı kastediyor.`,
      );
    }
  }

  const pageByPageRequested = Boolean(pageByPage) || wantsPageByPage(userMessage);
  if (pageByPageRequested) {
    const startPage = viewingPage && viewingPage > 0 ? viewingPage : 1;
    sections.push(
      '',
      ...(isFollowUp ? [PAGE_BY_PAGE_RULE] : []),
      pageByPage
        ? `ÖZEL GÖREV (SAYFA SENKRON MODU AÇIK): Öğrenci kaynağı sayfa sayfa takip ediyor; ekranda anlatımın ilgili sayfayla eşleştirilecek. Kaynakla ilgili açıklamalarını mutlaka \`## Sayfa N\` başlıklarıyla sayfalara böl. Öğrenci belirli sayfa/aralık belirtmediyse ${startPage}. sayfadan başla; tek cevapta en fazla 8 sayfa anlat ve sonda "devam" diyerek sonraki sayfalara geçebileceğini belirt.`
        : `Bu istek sayfa sayfa anlatım istiyor: açıklamaları \`## Sayfa N\` başlıklarıyla sayfalara böl (öğrenci aralık belirtmediyse ${startPage}. sayfadan başla, tek cevapta en fazla 8 sayfa).`,
    );
  }

  if (annotation) {
    sections.push(
      '',
      'KULLANICININ ELLE İŞARETLEDİĞİ GÖRSEL (MUTLAKA `view_file` İLE İNCELE!):',
      `- Dosya yolu: \`${annotation.relativePath}\``,
      annotation.sourceLabel ? `- Kaynak sahne: ${annotation.sourceLabel}` : '',
      '- Kullanıcının kırmızı/renkli kalemle daire içine aldığı, okla gösterdiği veya üzerine yazdığı bölgeye özellikle odaklan. Önce neyi işaretlediğini fark ettiğini belli et, sonra o kısmı daha anlaşılır ve gerekirse farklı bir yöntem/görselleştirme ile açıkla.',
    );
  }

  const shouldIncludeArtifact =
    Boolean(activeArtifact) &&
    (!isFollowUp ||
      Boolean(changedContext?.activeArtifact) ||
      coStudyAction === 'fix-artifact' ||
      Boolean(artifactError));

  if (shouldIncludeArtifact && activeArtifact) {
    const ctxFile = '.active_artifact_context.txt';
    const ctxText = [
      `Aktif Artefakt Başlığı: ${activeArtifact.title}`,
      `Tür: ${activeArtifact.type} (v${activeArtifact.version})`,
      artifactError ? `Çalışma Zamanı Hatası: ${artifactError}` : '',
      '--- İÇERİK ---',
      activeArtifact.content,
    ]
      .filter(Boolean)
      .join('\n');
    await writeFileIfChanged(path.join(workspaceDir, ctxFile), ctxText);
    sections.push(
      '',
      `ŞU AN EKRANDA AÇIK OLAN ARTEFAKT: "${activeArtifact.title}" (${activeArtifact.type}, v${activeArtifact.version}).`,
      `Gerekirse mevcut kodunu \`${ctxFile}\` dosyasını \`view_file\` ile okuyabilirsin.`,
    );
  }

  if (coStudyAction === 'check-step') {
    sections.push(
      '',
      'ÖZEL GÖREV (ORTAK TAHTA ADIM KONTROLÜ): Kullanıcının tahtaya yazdığı/çizdiği çözüm adımlarını incele. Doğru yaptığı yerleri öv, hata varsa cevabı tamamen vermek yerine nerede sapma olduğunu nazikçe göster ve bir `study-board-action` (kind: "feedback") kartı ekle.',
    );
  } else if (coStudyAction === 'hint') {
    sections.push(
      '',
      'ÖZEL GÖREV (SOKRATİK İPUCU): Doğrudan nihai cevabı verme! Öğrencinin bir sonraki adımı kendi bulması için net ama küçük bir ipucu ver ve bir `study-board-action` (kind: "hint") kartı ekle.',
    );
  } else if (coStudyAction === 'visualize-board') {
    sections.push(
      '',
      'ÖZEL GÖREV (TAHTAYI GÖRSELLEŞTİR): Tahtadaki problemi ve adımları analiz edip öğrencinin kavramasını kolaylaştıracak etkileşimli bir `2d-canvas` veya `3d-scene` artefaktı üret.',
    );
  } else if (coStudyAction === 'fix-artifact') {
    sections.push(
      '',
      `ÖZEL GÖREV (ARTEFAKT HATA DÜZELTME): Aktif artefakt çalıştırılırken şu hata oluştu: "${artifactError || 'Bilinmeyen hata'}". Lütfen \`.active_artifact_context.txt\` dosyasını okuyup hatasız çalışan yeni versiyonunu aynı türde bir \`study-artifact\` bloğu olarak üret.`,
    );
  }

  if (sections.length === 0) {
    return userMessage;
  }

  sections.push('', 'ÖĞRENCİNİN MESAJI:', userMessage);
  return sections.filter((s) => s !== undefined).join('\n');
}

export function isWorkspaceBusy(turnKey: string): boolean {
  return agySessionPool.isBusy(turnKey) || activeFallbackProcesses.has(turnKey);
}

export function hasWarmSession(turnKey: string, opts: WarmAgyOptions): boolean {
  if (process.env.AGY_DISABLE_WARM_POOL === '1') return false;
  return agySessionPool.hasWarmSession(turnKey, {
    binary: resolveAgyBinary(),
    workspaceDir: opts.workspaceDir,
    conversationId: opts.conversationId,
    model: opts.model,
    extraDirs: opts.extraDirs,
  });
}

export async function warmAgySession(turnKey: string, opts: WarmAgyOptions): Promise<void> {
  if (process.env.AGY_DISABLE_WARM_POOL === '1') return;
  try {
    await agySessionPool.warm(turnKey, {
      binary: resolveAgyBinary(),
      workspaceDir: opts.workspaceDir,
      conversationId: opts.conversationId,
      model: opts.model,
      extraDirs: opts.extraDirs,
    });
  } catch {
    // Background pre-warm is best-effort; errors will be surfaced on an actual chat turn
  }
}

export function disposeAgySession(turnKey: string): void {
  agySessionPool.dispose(turnKey);
  const fallback = activeFallbackProcesses.get(turnKey);
  if (fallback) {
    fallback.kill();
    activeFallbackProcesses.delete(turnKey);
  }
}

export function disposeWorkspaceSessions(workspaceId: string): void {
  agySessionPool.disposeByPrefix(workspaceId);
  const prefix = `${workspaceId}:`;
  for (const [key, proc] of Array.from(activeFallbackProcesses.entries())) {
    if (key === workspaceId || key.startsWith(prefix)) {
      proc.kill();
      activeFallbackProcesses.delete(key);
    }
  }
}

export function abortWorkspaceTurn(turnKey: string): boolean {
  const poolAborted = agySessionPool.abort(turnKey);
  const proc = activeFallbackProcesses.get(turnKey);
  if (proc) {
    proc.kill();
    activeFallbackProcesses.delete(turnKey);
    return true;
  }
  return poolAborted;
}

/**
 * Classic one-shot `agy -p` execution kept as an automatic fallback if persistent
 * `--input-format stream-json` mode ever fails before producing output.
 */
async function runAgyOneShot(turnKey: string, options: RunAgyOptions): Promise<RunAgyResult> {
  await ensureAgyIsolationBoundary(options.workspaceDir);
  const bin = resolveAgyBinary();
  const args: string[] = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--add-dir',
    options.workspaceDir,
  ];

  for (const dir of new Set(options.extraDirs || [])) {
    if (dir && dir !== options.workspaceDir) args.push('--add-dir', dir);
  }

  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }

  const startedAt = Date.now();

  return new Promise<RunAgyResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    activeFallbackProcesses.set(turnKey, child);

    let buffer = '';
    let stderrText = '';
    let streamedText = '';
    let finalResponse = '';
    let conversationId = options.conversationId;
    let durationSeconds: number | undefined;
    let settled = false;

    const finishResolve = (res: RunAgyResult) => {
      if (settled) return;
      settled = true;
      activeFallbackProcesses.delete(turnKey);
      resolve(res);
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      activeFallbackProcesses.delete(turnKey);
      reject(err);
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseAgyStreamLine(line, options.model);
        if (!parsed) continue;
        if (parsed.conversationId) {
          conversationId = parsed.conversationId;
        }
        if (parsed.type === 'delta' && parsed.text) {
          streamedText += parsed.text;
        }
        if (parsed.type === 'result') {
          if (parsed.text) finalResponse = parsed.text;
          durationSeconds = parsed.durationSeconds;
        }
        options.onEvent(parsed);
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });

    child.on('error', (err) => {
      options.onEvent({ type: 'error', error: err.message });
      finishReject(new Error(`agy çalıştırılamadı: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (buffer.trim()) {
        const parsed = parseAgyStreamLine(buffer, options.model);
        if (parsed) {
          if (parsed.conversationId) conversationId = parsed.conversationId;
          if (parsed.type === 'delta' && parsed.text) streamedText += parsed.text;
          if (parsed.type === 'result') {
            if (parsed.text) finalResponse = parsed.text;
            durationSeconds = parsed.durationSeconds;
          }
          options.onEvent(parsed);
        }
      }

      if (signal) {
        finishReject(new Error('AI yanıtı kullanıcı tarafından durduruldu.'));
        return;
      }

      const responseText = (finalResponse || streamedText).trim();
      if (code !== 0 && !responseText) {
        const errMsg = stderrText.trim() || `agy ${code} koduyla sonlandı.`;
        options.onEvent({ type: 'error', error: errMsg });
        finishReject(new Error(errMsg));
        return;
      }

      finishResolve({
        response: responseText,
        conversationId,
        durationSeconds: durationSeconds ?? Math.max(0.01, (Date.now() - startedAt) / 1000),
        reusedWarmSession: false,
      });
    });
  });
}

export async function runAgyTurn(
  turnKey: string,
  options: RunAgyOptions,
): Promise<RunAgyResult> {
  if (isWorkspaceBusy(turnKey)) {
    throw new Error('Bu çalışma alanında devam eden bir AI yanıtı var. Lütfen bitmesini bekleyin veya durdurun.');
  }

  if (process.env.AGY_DISABLE_WARM_POOL === '1') {
    return runAgyOneShot(turnKey, options);
  }

  let receivedAnyDelta = false;
  try {
    return await agySessionPool.runTurn(turnKey, {
      binary: resolveAgyBinary(),
      workspaceDir: options.workspaceDir,
      prompt: options.prompt,
      conversationId: options.conversationId,
      model: options.model,
      extraDirs: options.extraDirs,
      parseLine: parseAgyStreamLine,
      onEvent: (ev) => {
        if (ev.type === 'delta') receivedAnyDelta = true;
        // Suppress transient pre-fallback error events; only emit once fatal
        if (ev.type === 'error' && !receivedAnyDelta) return;
        options.onEvent(ev);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Do not retry if the user explicitly aborted or partial output already streamed
    if (receivedAnyDelta || msg.includes('durduruldu') || msg.includes('devam eden')) {
      throw err;
    }
    // Graceful fallback to classic one-shot `-p` mode
    options.onEvent({ type: 'status', statusMessage: 'Antigravity (agy) bağlanıyor...' });
    return runAgyOneShot(turnKey, options);
  }
}
