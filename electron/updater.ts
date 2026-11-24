import fsSync from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import updaterPkg from 'electron-updater';
import type { DesktopUpdateStatus } from '../src/types/desktop.js';

const { autoUpdater } = updaterPkg;

const UPDATE_CHANNEL = 'studylab:update-status';
const DEFAULT_PERIODIC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_LOG_FILE_BYTES = 512 * 1024; // 512 KB

interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message?: unknown): void;
}

function createUpdaterFileLogger(): UpdaterLogger {
  let logFilePath: string | null = null;
  let dirReady = false;

  const resolveLogFile = (): string | null => {
    if (logFilePath) return logFilePath;
    try {
      const userData = app.getPath('userData');
      if (!userData) return null;
      logFilePath = path.join(userData, 'logs', 'updater.log');
      return logFilePath;
    } catch {
      return null;
    }
  };

  const writeLine = (level: string, message: unknown): void => {
    const text =
      message instanceof Error
        ? message.stack || message.message
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;

    if (!app.isPackaged) {
      if (level === 'ERROR') console.error('[updater]', text);
      else if (level === 'WARN') console.warn('[updater]', text);
      else console.info('[updater]', text);
      return;
    }

    const file = resolveLogFile();
    if (!file) return;
    try {
      if (!dirReady) {
        fsSync.mkdirSync(path.dirname(file), { recursive: true });
        dirReady = true;
      }
      if (fsSync.existsSync(file)) {
        const stat = fsSync.statSync(file);
        if (stat.size > MAX_LOG_FILE_BYTES) {
          fsSync.truncateSync(file, 0);
        }
      }
      fsSync.appendFileSync(file, line, 'utf-8');
    } catch {
      // Logging must never break update flow
    }
  };

  return {
    info: (msg) => writeLine('INFO', msg),
    warn: (msg) => writeLine('WARN', msg),
    error: (msg) => writeLine('ERROR', msg),
    debug: (msg) => writeLine('DEBUG', msg),
  };
}

export class DesktopUpdater {
  private getWindow: () => BrowserWindow | null;
  private initialized = false;
  private manualCheckInFlight = false;
  private installing = false;
  private lastDownloadedBytes: number | undefined;
  private startupTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private lastStatus: DesktopUpdateStatus = { state: 'idle' };

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  private emit(status: DesktopUpdateStatus): void {
    this.lastStatus = status;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(UPDATE_CHANNEL, status);
    }
  }

  getLastStatus(): DesktopUpdateStatus {
    return this.lastStatus;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Seamless background delta download + silent install without NSIS setup wizard
    autoUpdater.logger = createUpdaterFileLogger();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.disableWebInstaller = true;

    autoUpdater.on('checking-for-update', () => {
      this.emit({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      this.manualCheckInFlight = false;
      this.lastDownloadedBytes = undefined;
      const notes =
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n')
            : undefined;
      this.emit({
        state: 'available',
        version: info.version,
        releaseNotes: notes,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      const prevVersion =
        this.lastStatus.state === 'available' || this.lastStatus.state === 'downloading'
          ? this.lastStatus.version
          : undefined;
      const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : undefined;
      const transferred =
        typeof progress.transferred === 'number' && progress.transferred >= 0
          ? progress.transferred
          : undefined;
      const bytesPerSecond =
        typeof progress.bytesPerSecond === 'number' && progress.bytesPerSecond >= 0
          ? progress.bytesPerSecond
          : undefined;

      if (total !== undefined) {
        this.lastDownloadedBytes = total;
      } else if (transferred !== undefined) {
        this.lastDownloadedBytes = transferred;
      }

      this.emit({
        state: 'downloading',
        version: prevVersion,
        percent,
        transferred,
        total,
        bytesPerSecond,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.manualCheckInFlight = false;
      this.emit({
        state: 'downloaded',
        version: info.version,
        downloadedBytes: this.lastDownloadedBytes,
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      const wasManual = this.manualCheckInFlight;
      this.manualCheckInFlight = false;
      if (wasManual) {
        this.emit({ state: 'not-available', version: info?.version || app.getVersion() });
      } else {
        this.emit({ state: 'idle' });
      }
    });

    autoUpdater.on('error', (err) => {
      const wasManual = this.manualCheckInFlight;
      this.manualCheckInFlight = false;
      const raw = err instanceof Error ? err.message : String(err || 'Bilinmeyen güncelleme hatası');
      this.emit({
        state: 'error',
        message: raw,
        silent: !wasManual,
      });
    });
  }

  /**
   * Schedules a silent background check shortly after startup (only in packaged builds).
   */
  scheduleStartupCheck(delayMs = 5000): void {
    if (!app.isPackaged) return;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates(false);
    }, delayMs);
    this.startupTimer.unref();
  }

  /**
   * Periodically checks for updates in the background during long sessions.
   */
  startPeriodicChecks(intervalMs = DEFAULT_PERIODIC_INTERVAL_MS): void {
    if (!app.isPackaged) return;
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
    }
    this.periodicTimer = setInterval(() => {
      if (
        this.installing ||
        this.lastStatus.state === 'downloading' ||
        this.lastStatus.state === 'downloaded' ||
        this.lastStatus.state === 'checking'
      ) {
        return;
      }
      void this.checkForUpdates(false);
    }, intervalMs);
    this.periodicTimer.unref();
  }

  dispose(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  async checkForUpdates(manual = true): Promise<{ ok: boolean; reason?: string }> {
    if (!app.isPackaged) {
      if (manual) {
        this.emit({
          state: 'not-available',
          version: app.getVersion(),
        });
      }
      return { ok: false, reason: 'Otomatik güncelleme yalnızca kurulu (.exe) sürümde çalışır.' };
    }

    if (this.installing) {
      return { ok: false, reason: 'Güncelleme şu anda uygulanıyor.' };
    }

    if (this.lastStatus.state === 'downloaded') {
      if (manual) {
        this.emit(this.lastStatus);
      }
      return { ok: true };
    }

    if (this.lastStatus.state === 'downloading') {
      if (manual) {
        this.emit(this.lastStatus);
      }
      return { ok: true };
    }

    this.init();
    this.manualCheckInFlight = manual;
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      this.manualCheckInFlight = false;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ state: 'error', message, silent: !manual });
      return { ok: false, reason: message };
    }
  }

  async downloadUpdate(): Promise<{ ok: boolean; reason?: string }> {
    if (!app.isPackaged) {
      return { ok: false, reason: 'Geliştirme modunda indirme devre dışı.' };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Silently applies the downloaded update without showing any NSIS setup wizard (`/S --force-run`)
   * and automatically relaunches StudyLab AI once extraction finishes.
   */
  installUpdate(): void {
    if (!app.isPackaged || this.installing) return;
    this.installing = true;
    const version = this.lastStatus.state === 'downloaded' ? this.lastStatus.version : undefined;
    this.emit({ state: 'installing', version });
    autoUpdater.quitAndInstall(true, true);
  }
}
