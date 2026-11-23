import React, { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js';

const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_HIGHLIGHT_CHARS = 300_000;

const LANGUAGE_ALIASES: Record<string, string> = {
  vue: 'xml',
  svelte: 'xml',
  htm: 'xml',
  html: 'xml',
  xaml: 'xml',
  xsd: 'xml',
  jsonc: 'json',
  ipynb: 'json',
  kts: 'kotlin',
  gradle: 'groovy',
  mts: 'typescript',
  cts: 'typescript',
  mjs: 'javascript',
  cjs: 'javascript',
  h: 'c',
  hh: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  psm1: 'powershell',
  sv: 'verilog',
  v: 'verilog',
  vhd: 'vhdl',
  tf: 'ini',
  env: 'bash',
  gitignore: 'bash',
  editorconfig: 'ini',
};

/** Picks a highlight.js language for a filename, or null for plain text. */
export function languageForFilename(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile' || base === 'cmakelists.txt') return base === 'makefile' ? 'makefile' : 'cmake';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : '';
  if (!ext || ext === 'txt' || ext === 'csv' || ext === 'tsv' || ext === 'log') return null;
  const candidate = LANGUAGE_ALIASES[ext] || ext;
  return hljs.getLanguage(candidate) ? candidate : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface CodeViewProps {
  url: string;
  filename: string;
  /** Font-size multiplier (1 = 12px). */
  fontScale?: number;
  onLoaded?: () => void;
  /** Rendered instead of the code when the file turns out to be binary. */
  binaryFallback?: React.ReactNode;
}

/** Fetches a text file and shows it with line numbers and syntax highlighting. */
export const CodeView: React.FC<CodeViewProps> = ({ url, filename, fontScale = 1, onLoaded, binaryFallback }) => {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    setBinary(false);
    setTruncated(false);
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) {
          let msg = `Dosya okunamadı (${r.status})`;
          try {
            const body = await r.json();
            if (body?.error) msg = body.error;
          } catch {
            // ignore
          }
          throw new Error(msg);
        }
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const bytes = new Uint8Array(buf);
        const sample = bytes.subarray(0, 8192);
        if (sample.includes(0)) {
          setBinary(true);
          return;
        }
        const isTruncated = bytes.length > MAX_VIEW_BYTES;
        setTruncated(isTruncated);
        setText(new TextDecoder('utf-8').decode(isTruncated ? bytes.subarray(0, MAX_VIEW_BYTES) : bytes));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) onLoaded?.();
      });
    return () => {
      cancelled = true;
    };
    // onLoaded intentionally excluded: only refetch when the file changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const language = useMemo(() => languageForFilename(filename), [filename]);

  const html = useMemo(() => {
    if (text === null) return '';
    if (language && text.length <= MAX_HIGHLIGHT_CHARS) {
      try {
        return hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } catch {
        // fall through to plain text
      }
    }
    return escapeHtml(text);
  }, [text, language]);

  const lineCount = useMemo(() => (text === null ? 0 : text.split('\n').length), [text]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">{error}</div>
    );
  }
  if (binary && binaryFallback) return <>{binaryFallback}</>;
  if (binary) {
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 text-center text-xs text-slate-400">
        <p>Bu dosya metin değil (ikili dosya), burada önizlenemiyor.</p>
        <p className="text-[11px] text-slate-500">AI yine de dosya adını ve konumunu bilir.</p>
      </div>
    );
  }
  if (text === null) {
    return <div className="flex h-full min-h-40 items-center justify-center text-xs text-slate-400">Dosya yükleniyor...</div>;
  }

  const fontSize = Math.round(12 * fontScale * 10) / 10;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1117] shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
        <span className="font-mono">{language || 'düz metin'}</span>
        <span>
          {lineCount} satır{truncated ? ' • ilk 2 MB gösteriliyor' : ''}
        </span>
      </div>
      <div className="flex overflow-x-auto" style={{ fontSize, lineHeight: 1.55 }}>
        <pre
          aria-hidden="true"
          className="sticky left-0 shrink-0 select-none border-r border-slate-800 bg-[#0d1117] px-3 py-3 text-right font-mono text-slate-600"
        >
          {lineNumbers}
        </pre>
        <pre className="min-w-0 flex-1 px-4 py-3 font-mono">
          <code className={`hljs ${language ? `language-${language}` : ''}`} style={{ background: 'transparent', padding: 0 }} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  );
};
