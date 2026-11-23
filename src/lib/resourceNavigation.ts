import type { LinkedTreeEntry, StudyResource } from '../types/study';

export interface SiblingNavigation {
  /** 0-based index of the current resource in its sibling list. */
  index: number;
  /** Total number of navigable sibling resources. */
  total: number;
  /** Display name of the previous sibling (used for tooltips). */
  prevLabel?: string;
  /** Display name of the next sibling (used for tooltips). */
  nextLabel?: string;
  /** Navigate to a 0-based index in the sibling list. */
  onNavigate: (index: number) => void;
}

/** Parent directory of a forward-slash relative path inside a linked folder ('' for root). */
export function parentDirOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash >= 0 ? relativePath.slice(0, slash) : '';
}

/** File basename of a forward-slash relative path. */
export function fileNameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
}

/**
 * Returns all file entries that live in the exact same directory as `currentPath`
 * (excluding subdirectories and files in parent/child folders), preserving tree order.
 */
export function getSameDirFiles(
  entries: LinkedTreeEntry[],
  currentPath: string,
): LinkedTreeEntry[] {
  const dir = parentDirOf(currentPath);
  return entries.filter((entry) => entry.type === 'file' && parentDirOf(entry.path) === dir);
}

/**
 * Returns top-level workspace resources that can be viewed directly (skips folder roots),
 * preserving the user's current sidebar order.
 */
export function getNavigableWorkspaceResources(resources: StudyResource[]): StudyResource[] {
  return resources.filter((resource) => resource.category !== 'folder');
}

export interface NavKeyEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const IGNORED_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], audio, video, [role="dialog"]';

/**
 * Returns true when an ArrowLeft/ArrowRight keydown should NOT trigger viewer navigation
 * (e.g. typing in chat/inputs, seeking media, holding modifier keys, or modal open).
 */
export function shouldIgnoreNavKeyEvent(
  event: NavKeyEventLike,
  hasOpenDialog = false,
): boolean {
  if (hasOpenDialog || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return true;
  }

  const target = event.target as ElementLike | null;
  if (!target || typeof target !== 'object') {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  if (typeof target.closest === 'function' && target.closest(IGNORED_TARGET_SELECTOR)) {
    return true;
  }

  if (target.tagName && /^(INPUT|TEXTAREA|SELECT|AUDIO|VIDEO)$/i.test(target.tagName)) {
    return true;
  }

  return false;
}
