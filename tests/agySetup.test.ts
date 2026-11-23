import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';
import { inspectAgyStatus, invalidateAgyStatusCache } from '../server/services/agyBridge.js';
import {
  classifyModelsFailure,
  discoverAgyBinary,
  getInstallCommand,
} from '../server/services/agySetup.js';

describe('agySetup binary discovery & status classification', () => {
  it('prefers AGY_BIN over PATH and standard directories', () => {
    const found = discoverAgyBinary({
      env: {
        AGY_BIN: 'C:\\custom\\agy.exe',
        PATH: 'C:\\bin',
        LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      },
      platform: 'win32',
      homeDir: 'C:\\Users\\Test',
      existsSync: () => true,
    });
    expect(found).toBe('C:\\custom\\agy.exe');
  });

  it('finds agy.exe in Windows standard install directories even when missing from PATH', () => {
    const expected = path.join('C:\\Users\\Fresh\\AppData\\Local', 'agy', 'bin', 'agy.exe');
    const found = discoverAgyBinary({
      env: {
        PATH: 'C:\\Windows\\System32',
        LOCALAPPDATA: 'C:\\Users\\Fresh\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\Fresh',
      },
      platform: 'win32',
      homeDir: 'C:\\Users\\Fresh',
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
  });

  it('falls back to ~/.gemini/bin/agy.exe on Windows when LocalAppData/agy is absent', () => {
    const expected = path.join('C:\\Users\\Fresh', '.gemini', 'bin', 'agy.exe');
    const found = discoverAgyBinary({
      env: {
        PATH: 'C:\\Windows\\System32',
        LOCALAPPDATA: 'C:\\Users\\Fresh\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\Fresh',
      },
      platform: 'win32',
      homeDir: 'C:\\Users\\Fresh',
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
  });

  it('finds agy on POSIX standard paths and returns platform-specific install commands', () => {
    const expected = '/Users/dev/.local/bin/agy';
    const found = discoverAgyBinary({
      env: { PATH: '/usr/bin' },
      platform: 'darwin',
      homeDir: '/Users/dev',
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
    expect(getInstallCommand('win32')).toContain('install.ps1');
    expect(getInstallCommand('darwin')).toContain('install.sh');
  });

  it('classifies auth_required vs network error accurately', () => {
    const auth = classifyModelsFailure('Error: Not logged in. Please sign in first.', '');
    expect(auth.state).toBe('auth_required');

    const empty = classifyModelsFailure('', '');
    expect(empty.state).toBe('auth_required');

    const net = classifyModelsFailure('dial tcp: lookup antigravity.google: ENOTFOUND', '');
    expect(net.state).toBe('error');
  });

  it('inspects not_installed, auth_required, error, and ready states deterministically', async () => {
    const notInstalled = await inspectAgyStatus(
      'agy.exe',
      async () => {
        const err = Object.assign(new Error('spawn agy.exe ENOENT'), { code: 'ENOENT' });
        throw err;
      },
      'win32',
    );
    expect(notInstalled.state).toBe('not_installed');
    expect(notInstalled.installed).toBe(false);
    expect(notInstalled.authenticated).toBe(false);
    expect(notInstalled.available).toBe(false);

    const authRequired = await inspectAgyStatus(
      'C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe',
      async (_bin, args) => {
        if (args[0] === '--version') return { stdout: '1.12.0\n' };
        const err = Object.assign(new Error('Command failed'), {
          stderr: 'Authentication required. Please run agy to sign in.',
        });
        throw err;
      },
      'win32',
    );
    expect(authRequired.state).toBe('auth_required');
    expect(authRequired.installed).toBe(true);
    expect(authRequired.authenticated).toBe(false);
    expect(authRequired.available).toBe(false);
    expect(authRequired.version).toBe('1.12.0');

    const ready = await inspectAgyStatus(
      'C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe',
      async (_bin, args) => {
        if (args[0] === '--version') return { stdout: '1.12.0\n' };
        return { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash\ngemini-4-neon-high\tGemini 4 Neon\n' };
      },
      'win32',
    );
    expect(ready.state).toBe('ready');
    expect(ready.installed).toBe(true);
    expect(ready.authenticated).toBe(true);
    expect(ready.available).toBe(true);
    expect(ready.models).toHaveLength(2);
  });

  it('stays ready when --version fails but models are listed', async () => {
    let versionCalls = 0;
    const status = await inspectAgyStatus(
      'C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe',
      async (_bin, args) => {
        if (args[0] === '--version') {
          versionCalls++;
          throw Object.assign(new Error('Command failed: agy.exe --version\n'), { code: 1 });
        }
        return { stdout: 'gemini-4-neon-high\tGemini 4 Neon\n' };
      },
      'win32',
    );
    expect(versionCalls).toBe(2);
    expect(status.state).toBe('ready');
    expect(status.available).toBe(true);
    expect(status.version).toBe('unknown');
  });

  it('retries --version once and shows exit code and output when agy is unusable', async () => {
    let versionCalls = 0;
    const retried = await inspectAgyStatus(
      'agy.exe',
      async (_bin, args) => {
        if (args[0] === '--version') {
          versionCalls++;
          if (versionCalls === 1) throw Object.assign(new Error('Command failed'), { code: 1 });
          return { stdout: '1.5.15\n' };
        }
        return { stdout: 'gemini-4-neon-high\tGemini 4 Neon\n' };
      },
      'win32',
    );
    expect(retried.version).toBe('1.5.15');

    const broken = await inspectAgyStatus(
      'agy.exe',
      async () => {
        throw Object.assign(new Error('Command failed: agy.exe --version\n'), {
          code: 3221225781,
          stdout: 'boom',
        });
      },
      'win32',
    );
    expect(broken.state).toBe('error');
    expect(broken.error).toContain('çıkış kodu: 3221225781');
    expect(broken.error).toContain('boom');
  });
});

describe('agy setup HTTP endpoints', () => {
  it('blocks non-local Origin on /api/agy/install and /api/agy/login', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-setup-api-'));
    try {
      const { app } = await createApp({ dataDir: tmpDir, seedDemo: false });

      const installRes = await request(app)
        .post('/api/agy/install')
        .set('Host', '127.0.0.1:3456')
        .set('Origin', 'https://evil.example.com');
      expect(installRes.status).toBe(403);

      const loginRes = await request(app)
        .post('/api/agy/login')
        .set('Host', '127.0.0.1:3456')
        .set('Origin', 'https://evil.example.com');
      expect(loginRes.status).toBe(403);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 from /api/agy/login when agy is not installed', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studylab-setup-missing-'));
    const prevAgyBin = process.env.AGY_BIN;
    process.env.AGY_BIN = path.join(tmpDir, 'nonexistent-agy-binary.exe');
    invalidateAgyStatusCache();

    try {
      const { app } = await createApp({ dataDir: tmpDir, seedDemo: false });

      const statusRes = await request(app).get('/api/agy/status?refresh=1');
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.state).toBe('not_installed');
      expect(statusRes.body.installed).toBe(false);

      const loginRes = await request(app)
        .post('/api/agy/login')
        .set('Host', '127.0.0.1:3456')
        .set('Origin', 'http://127.0.0.1:5173');
      expect(loginRes.status).toBe(400);
      expect(loginRes.body.error).toContain('kurulu değil');
    } finally {
      if (prevAgyBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgyBin;
      invalidateAgyStatusCache();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
