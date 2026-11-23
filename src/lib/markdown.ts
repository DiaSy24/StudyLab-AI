import hljs from 'highlight.js';
import katex from 'katex';
import { Marked } from 'marked';

const marked = new Marked({
  gfm: true,
  breaks: true,
});

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const highlighted = hljs.highlight(text, { language }).value;
      return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
    },
  },
});

export function renderLatex(expr: string, displayMode = false): string {
  try {
    return katex.renderToString(expr.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return expr;
  }
}

/**
 * Renders Markdown with KaTeX display math ($$...$$) and inline math ($...$).
 * Preserves fenced code blocks and inline code spans before math replacement.
 */
export function renderStudyMarkdown(markdown: string): string {
  if (!markdown) return '';

  // Hide unfinished study-artifact/study-board-action blocks cleanly while streaming
  let sanitized = markdown.replace(
    /```study-artifact[^\n]*\n[\s\S]*?(```|$)/g,
    '\n> 🎨 *Etkileşimli materyal oluşturuluyor...*\n',
  );
  sanitized = sanitized.replace(
    /```study-board-action[^\n]*\n[\s\S]*?(```|$)/g,
    '\n> 🧩 *Ortak çalışma tahtasına not ekleniyor...*\n',
  );

  const mathPlaceholders: string[] = [];
  const codePlaceholders: string[] = [];

  // 1. Protect fenced code blocks & inline code
  sanitized = sanitized.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(match);
    return `@@CODE_BLOCK_${idx}@@`;
  });

  // 2. Replace display math $$...$$
  sanitized = sanitized.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push(renderLatex(expr, true));
    return `@@MATH_BLOCK_${idx}@@`;
  });

  // 3. Replace inline math $...$
  sanitized = sanitized.replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (_m, expr: string) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push(renderLatex(expr, false));
    return `@@MATH_BLOCK_${idx}@@`;
  });

  // 4. Restore code blocks so marked renders them normally
  sanitized = sanitized.replace(/@@CODE_BLOCK_(\d+)@@/g, (_m, i: string) => codePlaceholders[Number(i)] ?? '');

  // 5. Parse Markdown
  let html = marked.parse(sanitized) as string;

  // 6. Restore KaTeX HTML
  html = html.replace(/@@MATH_BLOCK_(\d+)@@/g, (_m, i: string) => mathPlaceholders[Number(i)] ?? '');

  return html;
}

const CODE_LANGUAGES = ['java', 'python', 'c', 'cpp', 'csharp', 'javascript'];
const CODE_KEYWORD_START =
  /^(int|long|short|byte|char|float|double|boolean|bool|void|var|let|const|String|Integer|static|public|private|protected|final|class|interface|for|while|do|if|else|switch|case|default|return|try|catch|def|import|from|print|printf|System\.|#include|using|new)\b/;

/** Heuristic: does a single line look like source code rather than prose? */
function isCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/[;{}]$/.test(trimmed)) return true;
  if (/^[})\]]/.test(trimmed)) return true;
  if (/^(\t| {2,})\S/.test(line)) return true;
  if (/^\/\/|^#\s|^\/\*/.test(trimmed)) return true;
  // Python-style block headers: "def f(x):", "for i in range(3):"
  if (/^(def|for|while|if|elif|else|class|try|except|with)\b.*:$/.test(trimmed)) return true;
  // Keyword start + code punctuation, e.g. "print(x)" or "int x = 5"
  return CODE_KEYWORD_START.test(trimmed) && /[()=]/.test(trimmed) && !/[.?!]$/.test(trimmed);
}

/** True if a short text (e.g. an MCQ option) is a code snippet. */
export function looksLikeCode(text: string): boolean {
  if (!text) return false;
  return text.split('\n').some(isCodeLine);
}

function guessLanguage(code: string): string {
  if (/System\.(out|in)|\bString\b|\bArrayList\b|\bInteger\b|\bboolean\b|Arrays\.|\bextends\b|\bimplements\b|->|\bstatic\s+\w+(\[\])?\s+\w+\s*\(|\bstack\.(push|pop)\(/.test(code)) {
    return 'java';
  }
  if (/^\s*(def|elif|import)\b|\bprint\(|:\s*$/m.test(code)) return 'python';
  if (/#include|std::|cout\s*<</.test(code)) return 'cpp';
  if (/\bConsole\.Write|\bnamespace\b|\busing System\b/.test(code)) return 'csharp';
  if (/\bconsole\.log|\b(let|const)\s+\w+\s*=|=>/.test(code)) return 'javascript';
  return hljs.highlightAuto(code, CODE_LANGUAGES).language ?? 'plaintext';
}

/** Highlights a raw code snippet as inline HTML (for MCQ options). */
export function highlightCodeSnippet(code: string): string {
  return hljs.highlight(code, { language: guessLanguage(code) }).value;
}

/**
 * Renders quiz text (question prompts, hints, explanations).
 * Code written as plain newline-separated lines (no ``` fences) is detected and
 * wrapped into fenced blocks so it renders like a code file: monospace,
 * indented, line by line, syntax highlighted.
 */
export function renderQuizText(text: string): string {
  if (!text) return '';
  if (text.includes('```') || !text.includes('\n')) return renderStudyMarkdown(text);

  const lines = text.split('\n');
  const isCode = lines.map(isCodeLine);

  // Blank lines between two code lines belong to the code block.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() || isCode[i]) continue;
    const nextIdx = lines.findIndex((l, j) => j > i && l.trim() !== '');
    if (i > 0 && isCode[i - 1] && nextIdx !== -1 && isCode[nextIdx]) isCode[i] = true;
  }

  // One language per question, guessed from all of its code together.
  const language = guessLanguage(lines.filter((_l, idx) => isCode[idx]).join('\n'));

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isCode[i]) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && isCode[i]) block.push(lines[i++]);
    out.push('', '```' + language, block.join('\n'), '```', '');
  }
  return renderStudyMarkdown(out.join('\n'));
}
