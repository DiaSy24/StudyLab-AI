import { app, type BrowserWindow } from 'electron';
import updaterPkg from 'electron-updater';
import type { DesktopUpdateStatus } from '../src/types/desktop.js';

const { autoUpdater } = updaterPkg;

const UPDATE_CHANNEL = 'studylab:update-status';

export class DesktopUpdater {
  private getWindow: () => BrowserWindow | null;
  private initialized = false;
  private manualCheckInFlight = false;
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

    // Seamless background download; user decides when to restart & apply
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      this.emit({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      this.manualCheckInFlight = false;
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
      this.emit({
        state: 'downloading',
        version: prevVersion,
        percent,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.manualCheckInFlight = false;
      this.emit({
        state: 'downloaded',
        version: info.version,
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
    setTimeout(() => {
      void this.checkForUpdates(false);
    }, delayMs).unref();
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

  installUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
  }
}
