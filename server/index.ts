import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createChatRouter } from './routes/chat.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { browseDirectory, requireLocalOrigin } from './services/localFiles.js';
import { WorkspaceStore } from './services/workspaceStore.js';

const __filename =
  typeof __dirname === 'undefined' ? fileURLToPath(import.meta.url) : path.join(__dirname, 'index.js');
const CURRENT_DIR = typeof __dirname === 'undefined' ? path.dirname(__filename) : __dirname;
const PROJECT_ROOT = path.resolve(CURRENT_DIR, '..');

export interface CreateAppOptions {
  dataDir?: string;
  seedDemo?: boolean;
  /** Optional directory containing built frontend (`index.html`, `assets/`, `vendor/`). */
  distDir?: string;
  /** Serve built frontend static files (defaults to `true` when `distDir` is provided or NODE_ENV=production). */
  serveFrontend?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: Express;
  store: WorkspaceStore;
}> {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, 'data');
  const store = new WorkspaceStore(dataDir);
  await store.init(options.seedDemo ?? true);

  const distDir = options.distDir || path.join(PROJECT_ROOT, 'dist');
  const shouldServeFrontend =
    options.serveFrontend ?? (Boolean(options.distDir) || process.env.NODE_ENV === 'production');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '25mb' }));

  // Local offline vendor assets for sandboxed artifact iframes (Three.js + OrbitControls + KaTeX).
  // Prefer pre-copied `dist/vendor` (used in packaged Electron builds) and fall back to `node_modules` in dev.
  const vendorCors = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  };

  const resolveVendorDir = (distSub: string, nodeModSub: string[]): string => {
    const inDist = path.join(distDir, 'vendor', distSub);
    if (fsSync.existsSync(inDist)) return inDist;
    return path.join(PROJECT_ROOT, 'node_modules', ...nodeModSub);
  };

  app.use(
    '/vendor/three/build',
    vendorCors,
    express.static(resolveVendorDir(path.join('three', 'build'), ['three', 'build'])),
  );
  app.use(
    '/vendor/three/addons',
    vendorCors,
    express.static(resolveVendorDir(path.join('three', 'addons'), ['three', 'examples', 'jsm'])),
  );
  app.use(
    '/vendor/katex',
    vendorCors,
    express.static(resolveVendorDir('katex', ['katex', 'dist'])),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'studylab-ai' });
  });

  // Local file picker for "link from computer" (localhost-only)
  app.get('/api/fs/browse', requireLocalOrigin, async (req, res, next) => {
    try {
      const requested = typeof req.query.path === 'string' ? req.query.path : undefined;
      res.json(await browseDirectory(requested));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number };
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        res.status(404).json({ error: 'Klasör bulunamadı.' });
        return;
      }
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        res.status(403).json({ error: 'Bu klasöre erişim izni yok.' });
        return;
      }
      if (e.status === 400) {
        res.status(400).json({ error: e.message });
        return;
      }
      next(err);
    }
  });

  app.use('/api/workspaces', createWorkspacesRouter(store));
  app.use('/api', createChatRouter(store));

  // Serve built frontend in Electron / production mode
  if (shouldServeFrontend && fsSync.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api|\/vendor).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Centralized error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[StudyLab Server Error]', err);
    res.status(500).json({ error: err.message || 'Beklenmeyen sunucu hatası.' });
  });

  return { app, store };
}

// Start server when run directly via `tsx server/index.ts` (ignored when bundled inside Electron main)
const isMain =
  typeof __dirname === 'undefined' &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const PORT = Number(process.env.PORT || 3456);
  const HOST = process.env.HOST || '127.0.0.1';
  createApp()
    .then(({ app }) => {
      app.listen(PORT, HOST, () => {
        console.log(`StudyLab AI sunucusu çalışıyor: http://${HOST}:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Sunucu başlatılamadı:', err);
      process.exit(1);
    });
}
