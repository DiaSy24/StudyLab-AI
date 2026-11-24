import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveGitHubToken() {
  const existing = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (existing) return existing;

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }
  return null;
}

function ensureVersionTag(version) {
  const tag = `v${version}`;
  try {
    execFileSync('git', ['rev-parse', tag], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  } catch {
    console.log(`🏷️  Creating git tag ${tag}...`);
    execFileSync('git', ['tag', '-a', tag, '-m', `Release ${tag}`], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  }
  console.log(`🚀 Pushing git tag ${tag} to origin...`);
  execFileSync('git', ['push', 'origin', tag], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
}

function main() {
  const token = resolveGitHubToken();
  if (!token) {
    console.error('❌ GitHub token bulunamadı. `gh auth login` yapın veya GH_TOKEN ortam değişkenini ayarlayın.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  const version = String(pkg.version || '1.0.0');

  ensureVersionTag(version);

  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const builderBin = path.join(
    PROJECT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  );

  execFileSync(npmBin, ['run', 'build:desktop'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  execFileSync(builderBin, ['--win', '--publish', 'always'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      GH_TOKEN: token,
    },
  });

  verifyReleaseArtifacts(version);
}

function verifyReleaseArtifacts(version) {
  const releaseDir = path.join(PROJECT_ROOT, 'release');
  const expectedFiles = [
    `StudyLab-AI-Setup-${version}.exe`,
    `StudyLab-AI-Setup-${version}.exe.blockmap`,
    'latest.yml',
  ];

  const missing = [];
  console.log('\n📦 Release çıktı doğrulaması (delta güncelleme dosyaları):');
  for (const name of expectedFiles) {
    const fullPath = path.join(releaseDir, name);
    if (!fs.existsSync(fullPath)) {
      missing.push(name);
      continue;
    }
    const bytes = fs.statSync(fullPath).size;
    const sizeLabel =
      bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
    console.log(`   ✅ ${name} (${sizeLabel})`);
  }

  if (missing.length > 0) {
    console.error(`❌ Eksik release dosyaları: ${missing.join(', ')}`);
    process.exit(1);
  }
}

main();
