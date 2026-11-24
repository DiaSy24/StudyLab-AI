export type StudyMode = 'visual' | 'socratic' | 'exam';

/** Language of questions/quizzes the tutor asks ('auto' = same language as the course materials). */
export type ExamLanguage = 'auto' | 'en' | 'tr';

export type ArtifactType = '2d-canvas' | '3d-scene' | 'formula-lab' | 'quiz';

export type ChatChannel = 'main' | 'quick';

export interface ChatSession {
  id: string;
  title: string;
  channel?: ChatChannel;
  agyConversationId?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  title: string;
  subject: string;
  color: string;
  icon: string;
  studyMode: StudyMode;
  model?: string;
  /** Separate AI model for Hızlı Chat (Quick Chat). */
  quickModel?: string;
  /** Language for questions, quizzes and exam practice (chat itself stays Turkish). */
  examLanguage?: ExamLanguage;
  agyConversationId?: string;
  activeSessionId?: string;
  /** Active session ID for Hızlı Chat. */
  activeQuickSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudyResource {
  id: string;
  workspaceId: string;
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
  category: 'pdf' | 'image' | 'note' | 'code' | 'document' | 'folder' | 'other';
  url: string;
  /** Path inside the workspace for uploads; absolute path on disk for linked local resources. */
  relativePath: string;
  uploadedAt: string;
  /** 'local' = file/folder linked from the user's computer (read live, never copied). */
  source?: 'upload' | 'local';
  /** Absolute path on disk for linked local resources. */
  localPath?: string;
  /** Client-only: set on files opened from inside a linked folder. */
  folderId?: string;
  /** Client-only: path of the file inside its linked folder (forward slashes). */
  innerPath?: string;
}

export interface LinkedTreeEntry {
  /** Path relative to the linked folder, forward slashes. */
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface LocalBrowseResult {
  path: string;
  parent: string | null;
  roots: string[];
  home: string;
  entries: { name: string; path: string; type: 'dir' | 'file'; size?: number }[];
}

export interface FormulaTerm {
  id: string;
  symbol: string;
  label: string;
  color: string;
  unit?: string;
  meaning: string;
  analogy?: string;
}

export interface FormulaParameter {
  name: string;
  symbol: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: string;
}

export interface FormulaStep {
  title: string;
  latex: string;
  explanation: string;
}

export interface FormulaLabData {
  latex: string;
  subtitle?: string;
  summary: string;
  terms: FormulaTerm[];
  parameters?: FormulaParameter[];
  expression?: string; // JS math expression using parameter names, e.g. "k * q1 * q2 / (r * r)"
  resultLabel?: string;
  resultUnit?: string;
  steps?: FormulaStep[];
}

export interface QuizQuestion {
  id: string;
  type: 'mcq' | 'short-answer';
  prompt: string;
  latex?: string;
  options?: string[];
  correctIndex?: number;
  expectedAnswer?: string;
  hints: string[];
  explanation: string;
}

export interface QuizData {
  topic: string;
  difficulty?: 'kolay' | 'orta' | 'zor';
  questions: QuizQuestion[];
}

export interface StudyArtifact {
  id: string;
  workspaceId: string;
  type: ArtifactType;
  title: string;
  version: number;
  content: string; // HTML/JS for 2d-canvas & 3d-scene, JSON string for formula-lab & quiz
  parsedData?: FormulaLabData | QuizData;
  createdAt: string;
  sourceMessageId?: string;
}

export interface BoardCard {
  id: string;
  author: 'user' | 'ai';
  kind: 'note' | 'hint' | 'step' | 'feedback' | 'formula';
  title: string;
  content: string;
  latex?: string;
  x: number;
  y: number;
  color: string;
  createdAt: string;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface DrawingStroke {
  id: string;
  tool: 'pen' | 'highlighter' | 'eraser' | 'arrow' | 'circle' | 'rect';
  color: string;
  width: number;
  points: StrokePoint[];
}

export interface AnnotationLabel {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface WhiteboardState {
  strokes: DrawingStroke[];
  cards: BoardCard[];
  updatedAt: string;
}

export interface AnnotationAttachment {
  id: string;
  url: string;
  relativePath: string;
  sourceLabel?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
  createdAt: string;
  studyMode?: StudyMode;
  attachedResourceIds?: string[];
  /** Resource ID (or `<folderId>::<innerPath>`) viewed/targeted when this message was created. */
  sourceResourceId?: string;
  /** Path or name of the viewed/targeted resource when this message was created. */
  sourcePath?: string;
  annotation?: AnnotationAttachment;
  artifactIds?: string[];
  boardActionsApplied?: number;
  durationSeconds?: number;
}

export interface AgyModelInfo {
  id: string;
  label: string;
}

export interface UserPreferences {
  lastModel?: string;
  lastQuickModel?: string;
}

export type AgySetupState = 'ready' | 'not_installed' | 'auth_required' | 'error';

export interface AgyStatus {
  available: boolean;
  state: AgySetupState;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  binaryPath?: string;
  models: AgyModelInfo[];
  error?: string;
  authError?: string;
  platform?: string;
  installCommand?: string;
  loginCommand?: string;
  installInProgress?: boolean;
}

export interface ActiveTurnSnapshot {
  sessionId?: string;
  streamingText: string;
  statusMessage: string;
  startedAt: string;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  resources: StudyResource[];
  artifacts: StudyArtifact[];
  sessions: ChatSession[];
  activeSessionId: string;
  messages: ChatMessage[];
  quickSessions: ChatSession[];
  activeQuickSessionId: string;
  quickMessages: ChatMessage[];
  whiteboard: WhiteboardState;
  activeTurn?: ActiveTurnSnapshot | null;
  activeQuickTurn?: ActiveTurnSnapshot | null;
  activeTurnSessionIds?: string[];
}
