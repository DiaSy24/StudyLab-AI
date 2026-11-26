import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');

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

function readPublishRepo() {
  const fallback = { owner: 'DiaSy24', repo: 'StudyLab-AI' };
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'electron-builder.yml'), 'utf-8');
    const owner = raw.match(/^\s*owner:\s*([^\s#]+)/m)?.[1]?.trim();
    const repo = raw.match(/^\s*repo:\s*([^\s#]+)/m)?.[1]?.trim();
    if (owner && repo) return { owner, repo };
  } catch {
    // fall back to default
  }
  return fallback;
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

function computeFileSha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return { sha512: hash.digest('base64'), size: buf.length };
}

/**
 * Writes a fresh `release/latest.yml` matching electron-updater's exact schema
 * using the newly built installer's actual size and sha512 digest.
 */
function writeLatestYml(version, exeName, exePath) {
  const { sha512, size } = computeFileSha512Base64(exePath);
  const releaseDate = new Date().toISOString();
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${exeName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  const ymlPath = path.join(RELEASE_DIR, 'latest.yml');
  fs.writeFileSync(ymlPath, yml, 'utf-8');
  return { ymlPath, sha512, size };
}

function verifyLocalReleaseArtifacts(version, expectedSha512, expectedSize) {
  const exeName = `StudyLab-AI-Setup-${version}.exe`;
  const blockmapName = `${exeName}.blockmap`;
  const expectedFiles = [exeName, blockmapName, 'latest.yml'];

  const missing = [];
  console.log('\n📦 Yerel release çıktı doğrulaması (delta güncelleme dosyaları):');
  for (const name of expectedFiles) {
    const fullPath = path.join(RELEASE_DIR, name);
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

  const latestRaw = fs.readFileSync(path.join(RELEASE_DIR, 'latest.yml'), 'utf-8');
  if (
    !latestRaw.includes(`version: ${version}`) ||
    !latestRaw.includes(`sha512: ${expectedSha512}`) ||
    !latestRaw.includes(`size: ${expectedSize}`)
  ) {
    console.error('❌ latest.yml doğrulaması başarısız: sürüm/sha512/boyut eşleşmiyor.');
    process.exit(1);
  }

  return expectedFiles;
}

async function ghApi(url, token, init = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'StudyLab-AI-Release-Script',
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} (${init.method || 'GET'} ${url}): ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Publishes all release artifacts atomically:
 * 1. Creates (or reuses) a draft release for `v<version>` so updater never sees half-uploaded files
 * 2. Uploads `.exe`, `.exe.blockmap`, and `latest.yml` sequentially (avoiding electron-builder's
 *    parallel duplicate-release race condition on GitHub)
 * 3. Verifies all 3 assets exist on GitHub
 * 4. Marks the release published + latest only once every file is uploaded
 */
async function publishReleaseAtomically({ owner, repo, version, token, fileNames }) {
  const tag = `v${version}`;
  const baseApi = `https://api.github.com/repos/${owner}/${repo}`;

  console.log(`\n☁️  GitHub Release hazırlanıyor (${owner}/${repo} @ ${tag})...`);
  const releases = await ghApi(`${baseApi}/releases?per_page=30`, token);
  let release = releases.find((r) => r.tag_name === tag) || null;

  if (!release) {
    release = await ghApi(`${baseApi}/releases`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: version,
        draft: true,
        prerelease: false,
      }),
    });
    console.log(`   📝 Taslak release oluşturuldu (id: ${release.id})`);
  } else {
    console.log(`   ♻️  Mevcut release bulundu (id: ${release.id}, draft: ${release.draft})`);
  }

  const uploadBase = String(release.upload_url).replace(/\{[^}]*\}/g, '');
  const existingAssets = Array.isArray(release.assets) ? release.assets : [];

  for (const name of fileNames) {
    const fullPath = path.join(RELEASE_DIR, name);
    const prev = existingAssets.find((a) => a.name === name);
    if (prev) {
      await ghApi(`${baseApi}/releases/assets/${prev.id}`, token, { method: 'DELETE' });
    }
    const contentType = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    const data = fs.readFileSync(fullPath);
    console.log(`   ⬆️  Yükleniyor: ${name} (${(data.length / (1024 * 1024)).toFixed(2)} MB)...`);
    await ghApi(`${uploadBase}?name=${encodeURIComponent(name)}`, token, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
      },
      body: data,
    });
  }

  // Verify every required asset is actually attached before publishing
  const verified = await ghApi(`${baseApi}/releases/${release.id}`, token);
  const uploadedNames = new Set((verified.assets || []).map((a) => a.name));
  const missingRemote = fileNames.filter((n) => !uploadedNames.has(n));
  if (missingRemote.length > 0) {
    throw new Error(`GitHub Release doğrulaması başarısız; eksik dosyalar: ${missingRemote.join(', ')}`);
  }

  const published = await ghApi(`${baseApi}/releases/${release.id}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      draft: false,
      prerelease: false,
      make_latest: 'true',
    }),
  });

  console.log(`\n✅ Release yayınlandı ve doğrulandı: ${published.html_url}`);
  for (const name of fileNames) {
    console.log(`   ✅ [GitHub] ${name}`);
  }
}

async function main() {
  const token = resolveGitHubToken();
  if (!token) {
    console.error('❌ GitHub token bulunamadı. `gh auth login` yapın veya GH_TOKEN ortam değişkenini ayarlayın.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  const version = String(pkg.version || '1.0.0');
  const { owner, repo } = readPublishRepo();

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

  // Build installer + .blockmap locally without letting electron-builder publish directly
  execFileSync(builderBin, ['--win', '--publish', 'never'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const exeName = `StudyLab-AI-Setup-${version}.exe`;
  const exePath = path.join(RELEASE_DIR, exeName);
  if (!fs.existsSync(exePath)) {
    console.error(`❌ Kurulum dosyası oluşturulamadı: ${exePath}`);
    process.exit(1);
  }

  const { sha512, size } = writeLatestYml(version, exeName, exePath);
  const fileNames = verifyLocalReleaseArtifacts(version, sha512, size);

  await publishReleaseAtomically({ owner, repo, version, token, fileNames });
}

main().catch((err) => {
  console.error('❌ Release başarısız oldu:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
