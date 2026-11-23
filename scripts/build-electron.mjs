import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'dist-electron');
const BUILD_RES_DIR = path.join(PROJECT_ROOT, 'build');

// --- Pure-JS 256x256 PNG + ICO generator so electron-builder always has a crisp Windows icon ---
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createStudyLabPng(size = 256) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      // Rounded square SDF
      const qx = Math.abs(x + 0.5 - cx) - (size * 0.44 - radius);
      const qy = Math.abs(y + 0.5 - cy) - (size * 0.44 - radius);
      const dist =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;

      if (dist > 1) {
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
        continue;
      }

      const alpha = dist <= 0 ? 255 : Math.max(0, Math.round((1 - dist) * 255));
      const t = (x + y) / (2 * size);
      // Deep indigo (#3730a3) -> bright indigo (#6366f1) -> cyan (#06b6d4)
      let r = Math.round(55 * (1 - t) + 14 * t);
      let g = Math.round(48 * (1 - t) + 165 * t);
      let b = Math.round(163 * (1 - t) + 233 * t);

      // Subtle inner border highlight
      if (dist > -4 && dist <= 0) {
        r = Math.min(255, r + 35);
        g = Math.min(255, g + 35);
        b = Math.min(255, b + 35);
      }

      // Draw crisp white 4-point AI spark emblem at center + small secondary star
      const dx = (x - cx) / size;
      const dy = (y - cy) / size;
      const starDist = Math.pow(Math.abs(dx), 0.55) + Math.pow(Math.abs(dy), 0.55);
      const inMainStar = starDist < 0.44;

      const s2x = (x - size * 0.72) / size;
      const s2y = (y - size * 0.28) / size;
      const smallStar = Math.pow(Math.abs(s2x), 0.58) + Math.pow(Math.abs(s2y), 0.58) < 0.19;

      if (inMainStar || smallStar) {
        r = 248;
        g = 250;
        b = 252;
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = alpha;
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIcoFromPng(pngBuf) {
  // Modern Windows ICO supports embedded 256x256 PNG directly
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // count: 1 image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256px width (0 means 256)
  entry[1] = 0; // 256px height
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // image size
  entry.writeUInt32LE(22, 12); // offset (6 + 16)

  return Buffer.concat([header, entry, pngBuf]);
}

async function ensureAppIcons() {
  await fs.mkdir(BUILD_RES_DIR, { recursive: true });
  const pngPath = path.join(BUILD_RES_DIR, 'icon.png');
  const icoPath = path.join(BUILD_RES_DIR, 'icon.ico');

  let needGenerate = false;
  try {
    await fs.access(pngPath);
    await fs.access(icoPath);
  } catch {
    needGenerate = true;
  }

  if (needGenerate) {
    const png = createStudyLabPng(256);
    const ico = createIcoFromPng(png);
    await fs.writeFile(pngPath, png);
    await fs.writeFile(icoPath, ico);
    console.log('Generated default app icons in build/icon.png and build/icon.ico');
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await ensureAppIcons();

  // Bundle Electron main process + embedded Express backend into dist-electron/main.cjs
  await esbuild.build({
    entryPoints: [path.join(PROJECT_ROOT, 'electron', 'main.ts')],
    outfile: path.join(OUT_DIR, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'electron-updater'],
    sourcemap: false,
    logLevel: 'info',
  });

  // Bundle Electron preload script into dist-electron/preload.cjs
  await esbuild.build({
    entryPoints: [path.join(PROJECT_ROOT, 'electron', 'preload.ts')],
    outfile: path.join(OUT_DIR, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'info',
  });

  console.log('✅ Electron main & preload built successfully.');
}

main().catch((err) => {
  console.error('❌ Electron build failed:', err);
  process.exit(1);
});
