import { v4 as uuidv4 } from 'uuid';
import type {
  ArtifactType,
  BoardCard,
  FormulaLabData,
  QuizData,
  StudyArtifact,
} from '../../src/types/study.js';

export interface ParsedArtifactDraft {
  type: ArtifactType;
  title: string;
  content: string;
  parsedData?: FormulaLabData | QuizData;
}

export interface ParsedBoardAction {
  kind: BoardCard['kind'];
  title: string;
  content: string;
  latex?: string;
  color?: string;
}

export interface ParsedResponseResult {
  displayContent: string;
  artifactDrafts: ParsedArtifactDraft[];
  boardActions: ParsedBoardAction[];
}

const VALID_ARTIFACT_TYPES = new Set<ArtifactType>([
  '2d-canvas',
  '3d-scene',
  'formula-lab',
  'quiz',
]);

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = value;
  }
  return attrs;
}

function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Attempt to strip accidental trailing commas or leading/trailing non-JSON noise
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Extracts ```study-artifact ...``` and ```study-board-action``` fenced blocks
 * from AI markdown output and produces clean display markdown alongside typed drafts.
 */
export function parseStudyResponse(rawMarkdown: string): ParsedResponseResult {
  const artifactDrafts: ParsedArtifactDraft[] = [];
  const boardActions: ParsedBoardAction[] = [];

  // Match fenced blocks of type study-artifact or study-board-action.
  // Supports 3 or more backticks so nested code blocks inside HTML/JS don't prematurely break parsing.
  const lines = rawMarkdown.split(/\r?\n/);
  const outputLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const artifactOpen = line.match(/^(`{3,})\s*study-artifact\s*(.*)$/i);
    const boardOpen = line.match(/^(`{3,})\s*study-board-action\s*(.*)$/i);

    if (artifactOpen || boardOpen) {
      const fence = (artifactOpen ?? boardOpen)![1];
      const metaRaw = (artifactOpen ?? boardOpen)![2] ?? '';
      const isArtifact = Boolean(artifactOpen);
      const bodyLines: string[] = [];
      i++;

      const closeRegex = new RegExp(`^\\s*${fence}\\s*$`);
      while (i < lines.length && !closeRegex.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      // Advance past closing fence if found
      if (i < lines.length) {
        i++;
      }

      const body = bodyLines.join('\n').trim();
      if (isArtifact) {
        const attrs = parseAttributes(metaRaw);
        const typeCandidate = (attrs.type || '2d-canvas') as ArtifactType;
        const type: ArtifactType = VALID_ARTIFACT_TYPES.has(typeCandidate)
          ? typeCandidate
          : '2d-canvas';
        const title = attrs.title || getDefaultTitle(type);

        let parsedData: FormulaLabData | QuizData | undefined;
        if (type === 'formula-lab') {
          parsedData = tryParseJson<FormulaLabData>(body);
        } else if (type === 'quiz') {
          parsedData = tryParseJson<QuizData>(body);
        }

        artifactDrafts.push({
          type,
          title,
          content: body,
          parsedData,
        });
      } else {
        const parsed = tryParseJson<ParsedBoardAction | ParsedBoardAction[]>(body);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.content) {
              boardActions.push(normalizeBoardAction(item));
            }
          }
        } else if (parsed && parsed.content) {
          boardActions.push(normalizeBoardAction(parsed));
        }
      }
    } else {
      outputLines.push(line);
      i++;
    }
  }

  return {
    displayContent: outputLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    artifactDrafts,
    boardActions,
  };
}

function getDefaultTitle(type: ArtifactType): string {
  switch (type) {
    case '3d-scene':
      return 'Etkileşimli 3D Model';
    case 'formula-lab':
      return 'Formül Laboratuvarı';
    case 'quiz':
      return 'Etkileşimli Alıştırma';
    case '2d-canvas':
    default:
      return 'Etkileşimli 2D Görselleştirme';
  }
}

function normalizeBoardAction(raw: Partial<ParsedBoardAction>): ParsedBoardAction {
  const validKinds: BoardCard['kind'][] = ['note', 'hint', 'step', 'feedback', 'formula'];
  const kind = raw.kind && validKinds.includes(raw.kind) ? raw.kind : 'hint';
  return {
    kind,
    title: raw.title || (kind === 'hint' ? 'AI İpucu' : kind === 'feedback' ? 'Adım Değerlendirmesi' : 'Ortak Adım'),
    content: raw.content || '',
    latex: raw.latex,
    color: raw.color,
  };
}

export function materializeArtifacts(
  workspaceId: string,
  drafts: ParsedArtifactDraft[],
  existingArtifacts: StudyArtifact[],
  sourceMessageId?: string,
): StudyArtifact[] {
  const now = new Date().toISOString();
  const created: StudyArtifact[] = [];

  for (const draft of drafts) {
    const sameTitleCount =
      existingArtifacts.filter((a) => a.title === draft.title && a.type === draft.type).length +
      created.filter((a) => a.title === draft.title && a.type === draft.type).length;

    created.push({
      id: uuidv4(),
      workspaceId,
      type: draft.type,
      title: draft.title,
      version: sameTitleCount + 1,
      content: draft.content,
      parsedData: draft.parsedData,
      createdAt: now,
      sourceMessageId,
    });
  }

  return created;
}

export function materializeBoardCards(
  actions: ParsedBoardAction[],
  existingCards: BoardCard[],
): BoardCard[] {
  const now = new Date().toISOString();
  const colorByKind: Record<BoardCard['kind'], string> = {
    hint: '#f59e0b',
    feedback: '#10b981',
    step: '#6366f1',
    formula: '#ec4899',
    note: '#38bdf8',
  };

  return actions.map((action, idx) => {
    const slot = existingCards.length + idx;
    const col = slot % 2;
    const row = Math.floor(slot / 2);
    return {
      id: uuidv4(),
      author: 'ai',
      kind: action.kind,
      title: action.title,
      content: action.content,
      latex: action.latex,
      x: 40 + col * 320,
      y: 40 + row * 210,
      color: action.color || colorByKind[action.kind],
      createdAt: now,
    };
  });
}
