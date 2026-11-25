import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PoolStreamEvent {
  type: 'init' | 'delta' | 'status' | 'result' | 'error';
  conversationId?: string;
  text?: string;
  statusMessage?: string;
  durationSeconds?: number;
  error?: string;
}

export interface WarmSessionConfig {
  binary: string;
  workspaceDir: string;
  conversationId?: string;
  model?: string;
  extraDirs?: string[];
}

export interface PoolTurnOptions extends WarmSessionConfig {
  prompt: string;
  onEvent: (event: PoolStreamEvent) => void;
  parseLine: (line: string, model?: string) => PoolStreamEvent | null;
}

export interface PoolTurnResult {
  response: string;
  conversationId?: string;
  durationSeconds?: number;
  reusedWarmSession: boolean;
}

interface PendingTurn {
  startedAt: number;
  streamedText: string;
  finalResponse: string;
  conversationId?: string;
  reusedWarmSession: boolean;
  parseLine: (line: string, model?: string) => PoolStreamEvent | null;
  onEvent: (event: PoolStreamEvent) => void;
  resolve: (result: PoolTurnResult) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

interface WarmProcessEntry {
  key: string;
  workspaceDir: string;
  configKey: string;
  model?: string;
  child: ChildProcess;
  conversationId?: string;
  initialized: boolean;
  buffer: string;
  stderrText: string;
  activeTurn: PendingTurn | null;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  aborted: boolean;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_WARM_SESSIONS = 2;

const isolatedDirs = new Set<string>();

/**
 * Prevents `agy` from walking up out of study-studio's runtime workspace directory
 * into parent directories (e.g. a parent WorkSpace/.agents/plugins folder with
 * unrelated Playwright/RemotePlay MCP servers and hooks).
 *
 * Places a lightweight `.git` directory boundary inside `data/workspaces/` (never
 * touching the project root or any parent folder).
 */
export async function ensureAgyIsolationBoundary(workspaceDir: string): Promise<void> {
  const parent = path.dirname(workspaceDir);
  const boundaryRoot = path.basename(parent) === 'workspaces' ? parent : workspaceDir;
  if (isolatedDirs.has(boundaryRoot)) return;
  try {
    await fs.mkdir(path.join(boundaryRoot, '.git'), { recursive: true });
    isolatedDirs.add(boundaryRoot);
  } catch {
    // Non-fatal: continue even if filesystem is read-only
  }
}

function buildConfigKey(cfg: WarmSessionConfig): string {
  const extra = Array.from(new Set((cfg.extraDirs || []).filter((d) => d && d !== cfg.workspaceDir)))
    .sort()
    .join('\0');
  return [cfg.binary, path.resolve(cfg.workspaceDir), cfg.model || '', extra].join('|');
}

function buildPersistentArgs(cfg: WarmSessionConfig): string[] {
  const args: string[] = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--add-dir',
    cfg.workspaceDir,
  ];
  for (const dir of new Set(cfg.extraDirs || [])) {
    if (dir && dir !== cfg.workspaceDir) {
      args.push('--add-dir', dir);
    }
  }
  if (cfg.conversationId) {
    args.push('--conversation', cfg.conversationId);
  }
  if (cfg.model) {
    args.push('--model', cfg.model);
  }
  return args;
}

export type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class AgySessionPool {
  private readonly entries = new Map<string, WarmProcessEntry>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly spawnFn: SpawnProcessFn;
  private exitHookRegistered = false;

  constructor(opts?: { idleTtlMs?: number; maxSessions?: number; spawnFn?: SpawnProcessFn }) {
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_WARM_SESSIONS;
    this.spawnFn = opts?.spawnFn ?? ((cmd, args, options) => spawn(cmd, args, options));
  }

  private ensureExitHooks(): void {
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    const cleanup = () => {
      this.disposeAll();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
  }

  private resetIdleTimer(entry: WarmProcessEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.closed || entry.activeTurn) return;
    entry.idleTimer = setTimeout(() => {
      if (!entry.activeTurn) {
        this.disposeEntry(entry, false);
      }
    }, this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private evictIfNeeded(preserveKey: string): void {
    if (this.entries.size < this.maxSessions) return;
    let oldestIdle: WarmProcessEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.key === preserveKey || entry.activeTurn) continue;
      if (!oldestIdle || entry.lastUsedAt < oldestIdle.lastUsedAt) {
        oldestIdle = entry;
      }
    }
    if (oldestIdle) {
      this.disposeEntry(oldestIdle, false);
    }
  }

  private disposeEntry(entry: WarmProcessEntry, markAborted: boolean): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    if (markAborted) {
      entry.aborted = true;
    }
    if (!entry.closed) {
      entry.closed = true;
      try {
        entry.child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        entry.child.kill();
      } catch {
        // ignore
      }
    }
  }

  private matches(entry: WarmProcessEntry, cfg: WarmSessionConfig): boolean {
    if (entry.closed || entry.child.killed || entry.child.exitCode !== null) return false;
    if (entry.configKey !== buildConfigKey(cfg)) return false;
    if (cfg.conversationId && entry.conversationId && entry.conversationId !== cfg.conversationId) {
      return false;
    }
    if (cfg.conversationId && !entry.conversationId) {
      return false;
    }
    return true;
  }

  private spawnEntry(key: string, cfg: WarmSessionConfig): WarmProcessEntry {
    this.ensureExitHooks();
    this.evictIfNeeded(key);

    const existing = this.entries.get(key);
    if (existing) {
      this.disposeEntry(existing, false);
    }

    const args = buildPersistentArgs(cfg);
    const child = this.spawnFn(cfg.binary, args, {
      cwd: cfg.workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const entry: WarmProcessEntry = {
      key,
      workspaceDir: cfg.workspaceDir,
      configKey: buildConfigKey(cfg),
      model: cfg.model,
      child,
      conversationId: cfg.conversationId,
      initialized: false,
      buffer: '',
      stderrText: '',
      activeTurn: null,
      lastUsedAt: Date.now(),
      idleTimer: null,
      closed: false,
      aborted: false,
    };

    this.entries.set(key, entry);

    const handleLine = (line: string) => {
      const turn = entry.activeTurn;
      // Even when idle (pre-warming), capture the initial conversation_id from `init`
      if (!turn) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            if (obj.event === 'init') {
              entry.initialized = true;
              if (typeof obj.conversation_id === 'string' && obj.conversation_id) {
                entry.conversationId = obj.conversation_id;
              }
            }
          } catch {
            // ignore non-JSON output during pre-warm
          }
        }
        return;
      }

      const parsed = turn.parseLine(line, entry.model);
      if (!parsed) return;

      if (parsed.type === 'init') {
        entry.initialized = true;
      }
      if (parsed.conversationId) {
        entry.conversationId = parsed.conversationId;
        turn.conversationId = parsed.conversationId;
      }
      if (parsed.type === 'delta' && parsed.text) {
        turn.streamedText += parsed.text;
      }

      if (parsed.type === 'error') {
        turn.onEvent(parsed);
        if (!turn.settled) {
          turn.settled = true;
          entry.activeTurn = null;
          entry.lastUsedAt = Date.now();
          this.resetIdleTimer(entry);
          turn.reject(new Error(parsed.error || 'Bilinmeyen agy hatası'));
        }
        return;
      }

      if (parsed.type === 'result') {
        if (parsed.text) {
          turn.finalResponse = parsed.text;
        }
        turn.onEvent(parsed);
        if (!turn.settled) {
          turn.settled = true;
          const responseText = (turn.finalResponse || turn.streamedText).trim();
          const durationSeconds = Math.max(0.01, (Date.now() - turn.startedAt) / 1000);
          entry.activeTurn = null;
          entry.lastUsedAt = Date.now();
          this.resetIdleTimer(entry);
          turn.resolve({
            response: responseText,
            conversationId: turn.conversationId || entry.conversationId,
            durationSeconds,
            reusedWarmSession: turn.reusedWarmSession,
          });
        }
        return;
      }

      turn.onEvent(parsed);
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      entry.buffer += chunk;
      const lines = entry.buffer.split(/\r?\n/);
      entry.buffer = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep stderr bounded so long-lived sessions don't accumulate memory
      entry.stderrText = (entry.stderrText + chunk).slice(-4096);
    });

    child.on('error', (err) => {
      entry.closed = true;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      const turn = entry.activeTurn;
      entry.activeTurn = null;
      if (turn && !turn.settled) {
        turn.settled = true;
        turn.onEvent({ type: 'error', error: err.message });
        turn.reject(new Error(`agy çalıştırılamadı: ${err.message}`));
      }
    });

    child.on('close', (code, signal) => {
      entry.closed = true;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }

      if (entry.buffer.trim()) {
        handleLine(entry.buffer);
        entry.buffer = '';
      }

      const turn = entry.activeTurn;
      entry.activeTurn = null;
      if (!turn || turn.settled) return;

      turn.settled = true;
      if (entry.aborted || signal) {
        turn.reject(new Error('AI yanıtı kullanıcı tarafından durduruldu.'));
        return;
      }

      const responseText = (turn.finalResponse || turn.streamedText).trim();
      if (responseText && code === 0) {
        turn.resolve({
          response: responseText,
          conversationId: turn.conversationId || entry.conversationId,
          durationSeconds: Math.max(0.01, (Date.now() - turn.startedAt) / 1000),
          reusedWarmSession: turn.reusedWarmSession,
        });
        return;
      }

      const errMsg = entry.stderrText.trim() || `agy ${code ?? 'unknown'} koduyla beklenmedik biçimde sonlandı.`;
      turn.onEvent({ type: 'error', error: errMsg });
      turn.reject(new Error(errMsg));
    });

    this.resetIdleTimer(entry);
    return entry;
  }

  /**
   * Returns true if a warm, matching, ready process is currently alive for this key.
   */
  hasWarmSession(key: string, cfg: WarmSessionConfig): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && this.matches(entry, cfg));
  }

  isBusy(key: string): boolean {
    return Boolean(this.entries.get(key)?.activeTurn);
  }

  /**
   * Pre-warms a persistent `agy` process in the background so the first message
   * skips the ~3.5s cold-start delay.
   */
  async warm(key: string, cfg: WarmSessionConfig): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.activeTurn) return;
      if (this.matches(existing, cfg)) {
        existing.lastUsedAt = Date.now();
        this.resetIdleTimer(existing);
        return;
      }
    }
    await ensureAgyIsolationBoundary(cfg.workspaceDir);
    this.spawnEntry(key, cfg);
  }

  /**
   * Sends a single turn over a warm persistent `agy` process (spawning one if needed).
   */
  async runTurn(key: string, options: PoolTurnOptions): Promise<PoolTurnResult> {
    await ensureAgyIsolationBoundary(options.workspaceDir);

    let entry = this.entries.get(key);
    if (entry?.activeTurn) {
      throw new Error('Bu çalışma alanında devam eden bir AI yanıtı var. Lütfen bitmesini bekleyin veya durdurun.');
    }

    let reusedWarmSession = false;
    if (entry && this.matches(entry, options)) {
      reusedWarmSession = true;
    } else {
      entry = this.spawnEntry(key, options);
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.lastUsedAt = Date.now();
    entry.stderrText = '';

    const activeEntry = entry;

    return new Promise<PoolTurnResult>((resolve, reject) => {
      const turn: PendingTurn = {
        startedAt: Date.now(),
        streamedText: '',
        finalResponse: '',
        conversationId: options.conversationId || activeEntry.conversationId,
        reusedWarmSession,
        parseLine: options.parseLine,
        onEvent: options.onEvent,
        resolve,
        reject,
        settled: false,
      };
      activeEntry.activeTurn = turn;

      if (reusedWarmSession && activeEntry.initialized) {
        options.onEvent({
          type: 'init',
          conversationId: activeEntry.conversationId,
          statusMessage: 'Mesaj Gemini’ye iletiliyor...',
        });
      }

      const payload = JSON.stringify({
        event: 'user',
        message: { content: options.prompt },
      });

      try {
        const stdin = activeEntry.child.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
          throw new Error('agy oturum giriş kanalı kapalı.');
        }
        stdin.write(`${payload}\n`, 'utf-8', (writeErr) => {
          if (writeErr && !turn.settled) {
            turn.settled = true;
            activeEntry.activeTurn = null;
            this.disposeEntry(activeEntry, false);
            reject(writeErr);
          }
        });
      } catch (err) {
        if (!turn.settled) {
          turn.settled = true;
          activeEntry.activeTurn = null;
          this.disposeEntry(activeEntry, false);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  abort(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || !entry.activeTurn) return false;
    this.disposeEntry(entry, true);
    return true;
  }

  dispose(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.disposeEntry(entry, Boolean(entry.activeTurn));
    return true;
  }

  disposeByPrefix(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (key === workspaceId || key.startsWith(prefix)) {
        this.disposeEntry(entry, Boolean(entry.activeTurn));
      }
    }
  }

  disposeAll(): void {
    for (const entry of Array.from(this.entries.values())) {
      this.disposeEntry(entry, false);
    }
  }
}

export const agySessionPool = new AgySessionPool();
