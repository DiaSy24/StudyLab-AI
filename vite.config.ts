import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Copies Three.js + OrbitControls + KaTeX vendor assets into `dist/vendor/...`
 * during `vite build` so Cloudflare Pages serves them directly from CDN for
 * sandboxed 3D/formula iframes.
 */
function copyVendorAssetsPlugin(): Plugin {
  return {
    name: 'studylab-copy-vendor-assets',
    apply: 'build',
    async closeBundle() {
      const distVendor = path.resolve(__dirname, 'dist', 'vendor');
      const copies: Array<[string, string]> = [
        [
          path.resolve(__dirname, 'node_modules', 'three', 'build'),
          path.join(distVendor, 'three', 'build'),
        ],
        [
          path.resolve(__dirname, 'node_modules', 'three', 'examples', 'jsm'),
          path.join(distVendor, 'three', 'addons'),
        ],
        [
          path.resolve(__dirname, 'node_modules', 'katex', 'dist'),
          path.join(distVendor, 'katex'),
        ],
      ];

      await Promise.all(
        copies.map(async ([src, dest]) => {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.cp(src, dest, { recursive: true, force: true });
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyVendorAssetsPlugin()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    // agy CLI and the API server write into data/ at runtime; watching it causes full page reloads.
    watch: {
      ignored: ['**/data/**', '**/dist/**', '**/dist-electron/**', '**/release/**', '**/server/**', '**/electron/**', '**/tests/**'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/vendor': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
    },
  },
  // Pre-bundle heavy deps up front so late discovery never triggers an optimizer reload.
  optimizeDeps: {
    include: ['pdfjs-dist', 'katex', 'marked', 'highlight.js', 'lucide-react'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) {
            return 'vendor-icons';
          }
          if (/[\\/]node_modules[\\/]highlight\.js[\\/]/.test(id)) {
            return 'vendor-highlight';
          }
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) {
            return 'vendor-katex';
          }
          if (/[\\/]node_modules[\\/]marked[\\/]/.test(id)) {
            return 'vendor-markdown';
          }
          if (/[\\/]node_modules[\\/]pdfjs-dist[\\/]/.test(id)) {
            return 'vendor-pdf';
          }
          if (/[\\/]node_modules[\\/](mammoth|jszip|docx-preview|pptx-preview|xlsx)[\\/]/.test(id)) {
            return 'vendor-docs';
          }
          return undefined;
        },
      },
    },
  },
});
