import type { StudyResource } from '../types/study';

const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/;
const VIDEO_RE = /\.(mp4|webm|ogv|mov|m4v|mkv)$/;
/** Rich/binary documents shown by the document viewer. */
const DOCUMENT_RE =
  /\.(docx|docm|dotx|doc|odt|rtf|epub|pptx|pptm|ppsx|ppt|odp|xlsx|xlsm|xlsb|xls|ods|ipynb|zip|jar|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|mp4|webm|ogv|mov|m4v|mkv)$/;

/** Viewer category for a file inside a linked folder, decided by its name. */
export function categoryForFilename(filename: string): StudyResource['category'] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) return 'image';
  if (/\.(md|markdown|txt|tex|rst)$/.test(lower)) return 'note';
  if (DOCUMENT_RE.test(lower)) return 'document';
  // Everything else opens in the code viewer, which detects binary files itself.
  return 'code';
}

export type DocumentKind = 'docx' | 'pptx' | 'sheet' | 'audio' | 'video' | 'notebook' | 'text';

/** How the document viewer renders a file; 'text' = server-extracted text (old/unknown formats). */
export function documentKindForFilename(filename: string): DocumentKind {
  const lower = filename.toLowerCase();
  if (/\.(docx|docm|dotx)$/.test(lower)) return 'docx';
  if (/\.(pptx|pptm|ppsx)$/.test(lower)) return 'pptx';
  if (/\.(xlsx|xlsm|xlsb|xls|ods)$/.test(lower)) return 'sheet';
  if (lower.endsWith('.ipynb')) return 'notebook';
  if (AUDIO_RE.test(lower)) return 'audio';
  if (VIDEO_RE.test(lower)) return 'video';
  return 'text';
}

/** URL of the server endpoint that returns a resource's readable text. */
export function resourceTextUrl(resource: StudyResource): string {
  const ws = encodeURIComponent(resource.workspaceId);
  if (resource.folderId && resource.innerPath) {
    return `/api/workspaces/${ws}/resources/${encodeURIComponent(resource.folderId)}/text?path=${encodeURIComponent(
      resource.innerPath,
    )}`;
  }
  return `/api/workspaces/${ws}/resources/${encodeURIComponent(resource.id)}/text`;
}

/**
 * Builds a "virtual" resource for a file inside a linked folder so the regular
 * resource viewer (PDF pages, zoom, code highlighting, annotation) can show it.
 */
export function folderFileResource(folder: StudyResource, relativePath: string): StudyResource {
  const name = relativePath.split('/').pop() || relativePath;
  const root = folder.localPath || folder.relativePath;
  const sep = root.includes('\\') ? '\\' : '/';
  const absolute = `${root.replace(/[\\/]+$/, '')}${sep}${relativePath.split('/').join(sep)}`;
  return {
    ...folder,
    id: `${folder.id}::${relativePath}`,
    name,
    category: categoryForFilename(name),
    url: `/api/workspaces/${encodeURIComponent(folder.workspaceId)}/linked/${encodeURIComponent(
      folder.id,
    )}/file?path=${encodeURIComponent(relativePath)}`,
    relativePath: absolute,
    localPath: absolute,
    size: 0,
    folderId: folder.id,
    innerPath: relativePath,
  };
}
