import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface DiscoverBinaryOptions {
  forceRefresh?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  existsSync?: (targetPath: string) => boolean;
}

let cachedBinaryPath: string | null = null;
let installInProgress = false;

export function clearAgyBinaryCache(): void {
  cachedBinaryPath = null;
}

export function isAgyInstallInProgress(): boolean {
  return installInProgress;
}

export function getInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'irm https://antigravity.google/cli/install.ps1 | iex';
  }
  return 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
}

export function getLoginCommand(): string {
  return 'agy';
}

/**
 * Standard installation paths where the official Antigravity CLI (`agy`) installer
 * places the binary, even if the currently running Node process has a stale PATH.
 */
export function getStandardAgyCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, 'AppData', 'Local');
    const userProfile = env.USERPROFILE || homeDir;
    return [
      path.win32.join(localAppData, 'agy', 'bin', 'agy.exe'),
      path.win32.join(userProfile, '.gemini', 'bin', 'agy.exe'),
      path.win32.join(userProfile, '.local', 'bin', 'agy.exe'),
      path.win32.join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
    ];
  }

  return [
    path.posix.join(homeDir, '.local', 'bin', 'agy'),
    path.posix.join(homeDir, '.gemini', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];
}

/**
 * Discovers the `agy` executable across:
 * 1. Explicit `AGY_BIN` environment variable
 * 2. Current `PATH` directories
 * 3. Known standard Windows / macOS / Linux installer locations
 * 4. Platform default binary name fallback (`agy.exe` / `agy`)
 */
export function discoverAgyBinary(options: DiscoverBinaryOptions = {}): string {
  const isDefaultRuntime =
    !options.env && !options.platform && !options.homeDir && !options.existsSync;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const existsSync = options.existsSync ?? fsSync.existsSync;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;

  const explicit = env.AGY_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  if (isDefaultRuntime && !options.forceRefresh && cachedBinaryPath && existsSync(cachedBinaryPath)) {
    return cachedBinaryPath;
  }

  const binName = platform === 'win32' ? 'agy.exe' : 'agy';
  const pathEnv = env.PATH || env.Path || '';
  const pathSep = platform === 'win32' ? ';' : ':';

  for (const rawDir of pathEnv.split(pathSep)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const candidate = pathMod.join(dir, binName);
    if (existsSync(candidate)) {
      if (isDefaultRuntime) cachedBinaryPath = candidate;
      return candidate;
    }
  }

  for (const candidate of getStandardAgyCandidates(platform, env, homeDir)) {
    if (existsSync(candidate)) {
      if (isDefaultRuntime) cachedBinaryPath = candidate;
      return candidate;
    }
  }

  if (isDefaultRuntime) cachedBinaryPath = null;
  return binName;
}

const NETWORK_ERROR_RE =
  /enotfound|eai_again|econnrefused|econnreset|etimedout|err_network|network\s+error|offline|unable\s+to\s+resolve|certificate|proxy|dns|fetch\s+failed|dial\s+tcp/i;

const AUTH_ERROR_RE =
  /login|log\s+in|not\s+logged|sign\s*in|auth|unauthenticated|unauthorized|credential|keyring|token|oauth|401|403|account|oturum|giriş|api\s*key/i;

const NOT_INSTALLED_RE =
  /enoent|not\s+recognized|not\s+found|no\s+such\s+file|cannot\s+find\s+the\s+file|bulunamadı/i;

export function isAgyAuthErrorMessage(msg: string): boolean {
  return AUTH_ERROR_RE.test(msg);
}

export function isAgyNotInstalledErrorMessage(msg: string): boolean {
  return NOT_INSTALLED_RE.test(msg);
}

export interface ModelsFailureClassification {
  state: 'auth_required' | 'error';
  message: string;
  rawDetail?: string;
}

/**
 * Classifies a failed or empty `agy models` invocation into either `auth_required`
 * (installed, but needs Google Sign-In) or `error` (network/connectivity failure).
 */
export function classifyModelsFailure(
  stderr: string,
  stdout: string,
  errorMessage?: string,
): ModelsFailureClassification {
  const combined = [stderr, stdout, errorMessage]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  const rawDetail = combined ? combined.slice(0, 600) : undefined;

  if (combined && NETWORK_ERROR_RE.test(combined)) {
    return {
      state: 'error',
      message:
        'Antigravity sunucularına ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.',
      rawDetail,
    };
  }

  if (!combined || AUTH_ERROR_RE.test(combined)) {
    return {
      state: 'auth_required',
      message:
        'Antigravity CLI (agy) kurulu ancak henüz Google hesabıyla giriş yapılmamış. Giriş yapınca Gemini modelleri otomatik açılır.',
      rawDetail,
    };
  }

  return {
    state: 'auth_required',
    message:
      'Antigravity oturumu doğrulanamadı. Google hesabınızla giriş yapın veya bağlantıyı yeniden kontrol edin.',
    rawDetail,
  };
}

export interface RunAgyInstallOptions {
  onLog: (line: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}

export interface RunAgyInstallResult {
  exitCode: number;
  output: string;
}

/**
 * Runs the official Antigravity CLI installer script and streams log lines back to the caller.
 */
export async function runAgyInstall(options: RunAgyInstallOptions): Promise<RunAgyInstallResult> {
  if (installInProgress) {
    throw new Error('Antigravity CLI kurulumu zaten devam ediyor. Lütfen bitmesini bekleyin.');
  }

  installInProgress = true;
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'powershell.exe' : 'bash';
  const args = isWin
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; irm https://antigravity.google/cli/install.ps1 | iex",
      ]
    : ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'];

  try {
    return await new Promise<RunAgyInstallResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let fullOutput = '';
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const onAbort = () => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const cleanup = () => {
        options.signal?.removeEventListener('abort', onAbort);
      };

      const emitLines = (chunk: string, stream: 'stdout' | 'stderr') => {
        // Strip common ANSI escape sequences so the web log box stays readable
        const clean = chunk.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        fullOutput = (fullOutput + clean).slice(-16_000);
        if (stream === 'stdout') {
          stdoutBuf += clean;
          const lines = stdoutBuf.split(/\r?\n/);
          stdoutBuf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) options.onLog(line, 'stdout');
          }
        } else {
          stderrBuf += clean;
          const lines = stderrBuf.split(/\r?\n/);
          stderrBuf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) options.onLog(line, 'stderr');
          }
        }
      };

      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => emitLines(chunk, 'stdout'));

      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => emitLines(chunk, 'stderr'));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Kurulum betiği başlatılamadı: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutBuf.trim()) options.onLog(stdoutBuf.trim(), 'stdout');
        if (stderrBuf.trim()) options.onLog(stderrBuf.trim(), 'stderr');
        clearAgyBinaryCache();
        if (settled) return;
        settled = true;
        cleanup();
        if (signal || options.signal?.aborted) {
          reject(new Error('Kurulum iptal edildi.'));
          return;
        }
        resolve({ exitCode: code ?? 1, output: fullOutput });
      });
    });
  } finally {
    installInProgress = false;
  }
}

export interface LaunchLoginResult {
  launched: boolean;
  manualCommand: string;
  message: string;
}

/**
 * Opens an interactive terminal window running `agy` so the user can complete
 * Google Sign-In OAuth (or switch accounts via `/logout`) without TTY blocking.
 */
export async function launchAgyInteractiveLogin(binaryPath: string): Promise<LaunchLoginResult> {
  const manualCommand = getLoginCommand();
  const workDir = path.join(os.tmpdir(), 'studylab-agy-login');
  await fs.mkdir(workDir, { recursive: true });

  if (process.platform === 'win32') {
    const escapedBin = binaryPath.replace(/'/g, "''");
    const scriptPath = path.join(workDir, 'agy-login.ps1');
    const scriptContent = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$Host.UI.RawUI.WindowTitle = 'Antigravity (agy) - Google Giris'",
      "Write-Host ''",
      "Write-Host '============================================================' -ForegroundColor Cyan",
      "Write-Host '  StudyLab AI - Antigravity (agy) Google Giris Penceresi' -ForegroundColor Cyan",
      "Write-Host '============================================================' -ForegroundColor Cyan",
      "Write-Host ''",
      "Write-Host '  1) Asagida Google hesabinizla giris secenegini onaylayin.' -ForegroundColor White",
      "Write-Host '  2) Tarayicinizda acilan Google oturum acma ekranini tamamlayin.' -ForegroundColor White",
      "Write-Host '  3) Giris bitince bu pencereyi kapatabilirsiniz;' -ForegroundColor Green",
      "Write-Host '     StudyLab AI girisi otomatik olarak algilayacaktir.' -ForegroundColor Green",
      "Write-Host '  Not: Hesap degistirmek isterseniz agy icinde /logout yazabilirsiniz.' -ForegroundColor DarkGray",
      "Write-Host ''",
      `& '${escapedBin}'`,
      '',
    ].join('\r\n');

    // Write UTF-8 with BOM so Windows PowerShell 5.1 reads Turkish characters cleanly
    await fs.writeFile(scriptPath, `\uFEFF${scriptContent}`, 'utf-8');

    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        'Antigravity (agy) Giris',
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-NoExit',
        '-File',
        scriptPath,
      ],
      {
        cwd: workDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    );
    child.unref();

    return {
      launched: true,
      manualCommand,
      message:
        'Giriş penceresi açıldı! Açılan terminalde Google hesabınızla oturum açın; StudyLab girişi otomatik algılayacak.',
    };
  }

  if (process.platform === 'darwin') {
    try {
      const escaped = binaryPath.replace(/(["\\])/g, '\\$1');
      const child = spawn(
        'osascript',
        ['-e', `tell application "Terminal" to do script "\\"${escaped}\\""`, '-e', 'tell application "Terminal" to activate'],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      return {
        launched: true,
        manualCommand,
        message: 'Terminal açıldı. Google hesabınızla girişi tamamlayın; StudyLab otomatik algılayacak.',
      };
    } catch {
      return {
        launched: false,
        manualCommand,
        message: 'Terminal otomatik açılamadı. Lütfen terminalde `agy` komutunu çalıştırıp giriş yapın.',
      };
    }
  }

  return {
    launched: false,
    manualCommand,
    message: 'Lütfen terminalinizde `agy` komutunu çalıştırıp Google hesabınızla giriş yapın.',
  };
}
