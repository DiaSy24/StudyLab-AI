import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateStatus } from '../src/types/desktop.js';

class MockAutoUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  disableDifferentialDownload = true;
  disableWebInstaller = false;
  logger: unknown = null;
  checkForUpdates = vi.fn().mockResolvedValue(null);
  downloadUpdate = vi.fn().mockResolvedValue([]);
  quitAndInstall = vi.fn();
}

const mockAutoUpdater = new MockAutoUpdater();
const mockApp = {
  isPackaged: true,
  getVersion: vi.fn(() => '1.0.3'),
  getPath: vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming\\study-studio'),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: mockAutoUpdater,
  },
}));

describe('DesktopUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAutoUpdater.removeAllListeners();
    mockAutoUpdater.autoDownload = false;
    mockAutoUpdater.autoInstallOnAppQuit = false;
    mockAutoUpdater.autoRunAppAfterInstall = false;
    mockAutoUpdater.disableDifferentialDownload = true;
    mockAutoUpdater.disableWebInstaller = false;
    mockAutoUpdater.logger = null;
    mockAutoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
    mockAutoUpdater.downloadUpdate.mockReset().mockResolvedValue([]);
    mockAutoUpdater.quitAndInstall.mockReset();
    mockApp.isPackaged = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createHarness() {
    const sent: DesktopUpdateStatus[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, status: DesktopUpdateStatus) => {
          sent.push(status);
        }),
      },
    };
    const { DesktopUpdater } = await import('../electron/updater.js');
    const updater = new DesktopUpdater(() => fakeWindow as never);
    return { updater, sent, fakeWindow };
  }

  it('configures background differential downloads and silent install on quit', async () => {
    const { updater } = await createHarness();
    updater.init();

    expect(mockAutoUpdater.autoDownload).toBe(true);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mockAutoUpdater.autoRunAppAfterInstall).toBe(true);
    expect(mockAutoUpdater.disableDifferentialDownload).toBe(false);
    expect(mockAutoUpdater.disableWebInstaller).toBe(true);
    expect(mockAutoUpdater.logger).toBeTruthy();
  });

  it('installs silently without NSIS wizard and relaunches app', async () => {
    const { updater, sent } = await createHarness();
    updater.init();

    mockAutoUpdater.emit('update-available', { version: '1.0.4' });
    mockAutoUpdater.emit('download-progress', {
      percent: 50,
      transferred: 1_200_000,
      total: 2_400_000,
      bytesPerSecond: 600_000,
    });
    mockAutoUpdater.emit('update-downloaded', { version: '1.0.4' });

    updater.installUpdate();
    // Second call while installing should be ignored
    updater.installUpdate();

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(sent.at(-1)).toEqual({ state: 'installing', version: '1.0.4' });
  });

  it('emits delta byte progress and remembers downloaded delta size', async () => {
    const { updater, sent } = await createHarness();
    updater.init();

    mockAutoUpdater.emit('update-available', { version: '1.0.4' });
    mockAutoUpdater.emit('download-progress', {
      percent: 42.4,
      transferred: 1_048_576,
      total: 2_621_440,
      bytesPerSecond: 524_288,
    });
    mockAutoUpdater.emit('update-downloaded', { version: '1.0.4' });

    expect(sent).toContainEqual({
      state: 'downloading',
      version: '1.0.4',
      percent: 42,
      transferred: 1_048_576,
      total: 2_621_440,
      bytesPerSecond: 524_288,
    });
    expect(updater.getLastStatus()).toEqual({
      state: 'downloaded',
      version: '1.0.4',
      downloadedBytes: 2_621_440,
    });
  });

  it('keeps background errors silent and surfaces manual check errors', async () => {
    const { updater, sent } = await createHarness();
    updater.init();

    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network timeout'));
    await updater.checkForUpdates(false);
    expect(sent.at(-1)).toEqual({
      state: 'error',
      message: 'network timeout',
      silent: true,
    });

    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('rate limit'));
    await updater.checkForUpdates(true);
    expect(sent.at(-1)).toEqual({
      state: 'error',
      message: 'rate limit',
      silent: false,
    });
  });

  it('runs periodic checks only when idle and cleans up timers on dispose', async () => {
    const { updater } = await createHarness();
    updater.init();
    updater.startPeriodicChecks(60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // Once an update is already downloaded, periodic checks should not re-trigger
    mockAutoUpdater.emit('update-downloaded', { version: '1.0.4' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.dispose();
  });

  it('skips redundant checkForUpdates when an update is already downloaded', async () => {
    const { updater, sent } = await createHarness();
    updater.init();
    mockAutoUpdater.emit('update-downloaded', { version: '1.0.4' });

    const res = await updater.checkForUpdates(true);
    expect(res).toEqual({ ok: true });
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({
      state: 'downloaded',
      version: '1.0.4',
      downloadedBytes: undefined,
    });
  });
});
