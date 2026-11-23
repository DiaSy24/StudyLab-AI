import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createApp } from '../server/index.js';
import { agySessionPool } from '../server/services/agySessionPool.js';
import { DesktopUpdater } from './updater.js';

const HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 12;

function getPreferredPort(): number {
  if (process.env.STUDYLAB_PORT?.trim()) {
    const parsed = Number(process.env.STUDYLAB_PORT);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Use a dedicated port in packaged builds so it never collides with `npm run dev` on 3456
  return app.isPackaged ? 43456 : 3456;
}

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

let mainWindow: BrowserWindow | null = null;
let httpServer: http.Server | null = null;
let activeDataDir = '';
let isQuitting = false;

const updater = new DesktopUpdater(() => mainWindow);

function resolveDataDir(): string {
  if (process.env.STUDYLAB_DATA_DIR?.trim()) {
    return path.resolve(process.env.STUDYLAB_DATA_DIR.trim());
  }
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  // In development, keep using the workspace's `data/` folder so existing courses stay visible
  return path.resolve(app.getAppPath(), 'data');
}

function resolveDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web');
  }
  return path.resolve(app.getAppPath(), 'dist');
}

function resolveIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.ico'), path.join(process.resourcesPath, 'icon.png')]
    : [
        path.resolve(app.getAppPath(), 'build', 'icon.ico'),
        path.resolve(app.getAppPath(), 'build', 'icon.png'),
      ];
  return candidates[0];
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

async function loadWindowBounds(): Promise<WindowBounds> {
  try {
    const raw = await fs.readFile(getWindowStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    return {
      width: typeof parsed.width === 'number' && parsed.width >= 900 ? parsed.width : 1440,
      height: typeof parsed.height === 'number' && parsed.height >= 640 ? parsed.height : 900,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      isMaximized: Boolean(parsed.isMaximized),
    };
  } catch {
    return { width: 1440, height: 900 };
  }
}

async function saveWindowBounds(win: BrowserWindow): Promise<void> {
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowBounds = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    await fs.mkdir(path.dirname(getWindowStatePath()), { recursive: true });
    await fs.writeFile(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

/**
 * Starts the embedded Express API/Web server strictly on `127.0.0.1`.
 * Prefers `PREFERRED_PORT` (3456) so `localStorage` origin stays stable across launches,
 * stepping up by 1 if busy and finally falling back to an OS-assigned free port.
 */
async function startEmbeddedServer(
  dataDir: string,
  distDir: string,
  serveFrontend: boolean,
): Promise<{ server: http.Server; port: number }> {
  const { app: expressApp } = await createApp({
    dataDir,
    seedDemo: true,
    distDir,
    serveFrontend,
  });

  const tryListen = (port: number): Promise<{ server: http.Server; port: number }> =>
    new Promise((resolve, reject) => {
      const server = http.createServer(expressApp);
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          // ignore
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ server, port: actualPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host: HOST, exclusive: true });
    });

  const preferredPort = getPreferredPort();
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const candidate = preferredPort + i;
    try {
      return await tryListen(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw err;
      }
    }
  }

  return tryListen(0);
}

function registerIpcHandlers(): void {
  ipcMain.handle('studylab:get-app-info', () => ({
    isDesktop: true as const,
    version: app.getVersion(),
    platform: process.platform,
    dataDir: activeDataDir,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('studylab:check-updates', () => updater.checkForUpdates(true));
  ipcMain.handle('studylab:download-update', () => updater.downloadUpdate());
  ipcMain.handle('studylab:install-update', () => {
    isQuitting = true;
    agySessionPool.disposeAll();
    updater.installUpdate();
  });
  ipcMain.handle('studylab:open-data-folder', async () => {
    if (activeDataDir) {
      await shell.openPath(activeDataDir);
    }
  });
}

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Uygulama',
      submenu: [
        {
          label: 'Güncellemeleri Kontrol Et',
          click: () => {
            void updater.checkForUpdates(true);
          },
        },
        {
          label: 'Veri Klasörünü Aç',
          click: () => {
            if (activeDataDir) void shell.openPath(activeDataDir);
          },
        },
        { type: 'separator' },
        { label: 'Çıkış', role: 'quit' },
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { label: 'Geri Al', role: 'undo' },
        { label: 'Yinele', role: 'redo' },
        { type: 'separator' },
        { label: 'Kes', role: 'cut' },
        { label: 'Kopyala', role: 'copy' },
        { label: 'Yapıştır', role: 'paste' },
        { label: 'Tümünü Seç', role: 'selectAll' },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Yenile', role: 'reload' },
        { label: 'Yakınlaştır', role: 'zoomIn' },
        { label: 'Uzaklaştır', role: 'zoomOut' },
        { label: 'Varsayılan Yakınlaştırma', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Tam Ekran', role: 'togglefullscreen' },
        { label: 'Geliştirici Araçları', role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(startUrl: string): Promise<void> {
  const bounds = await loadWindowBounds();
  const preloadPath = path.join(__dirname, 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#020617',
    title: 'StudyLab AI — Etkileşimli Ders Çalışma Stüdyosu',
    icon: resolveIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (bounds.isMaximized) {
    mainWindow.maximize();
  }

  // Open external links (Google OAuth, docs, GitHub releases, etc.) in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const isSelf =
          (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
          url.startsWith(startUrl.split('#')[0]);
        if (!isSelf) {
          void shell.openExternal(url);
          return { action: 'deny' };
        }
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleBoundsSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void saveWindowBounds(mainWindow);
      }
    }, 350);
  };
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      void saveWindowBounds(mainWindow);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(startUrl);
}

// Single-instance lock so clicking the desktop icon focuses the running window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      activeDataDir = resolveDataDir();
      const distDir = resolveDistDir();
      const devClientUrl = process.env.STUDYLAB_DEV_URL?.trim();

      buildAppMenu();
      registerIpcHandlers();
      updater.init();

      let startUrl: string;
      if (devClientUrl) {
        // Dev mode: Vite dev server proxies /api and /vendor to the embedded Express server
        await startEmbeddedServer(activeDataDir, distDir, false);
        startUrl = devClientUrl;
      } else {
        const { server, port } = await startEmbeddedServer(activeDataDir, distDir, true);
        httpServer = server;
        startUrl = `http://${HOST}:${port}`;
      }

      await createMainWindow(startUrl);
      updater.scheduleStartupCheck(5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox('StudyLab AI Başlatılamadı', `Uygulama başlatılırken bir hata oluştu:\n\n${msg}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (isQuitting) return;
    isQuitting = true;
    agySessionPool.disposeAll();
    if (httpServer) {
      try {
        httpServer.close();
      } catch {
        // ignore
      }
      httpServer = null;
    }
  });
}
