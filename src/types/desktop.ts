export type DesktopUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'downloading'; version?: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'not-available'; version?: string }
  | { state: 'error'; message: string; silent?: boolean };

export interface DesktopAppInfo {
  isDesktop: true;
  version: string;
  platform: string;
  dataDir: string;
  isPackaged: boolean;
}

export interface StudyLabDesktopApi {
  isDesktop: true;
  getAppInfo: () => Promise<DesktopAppInfo>;
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  installUpdate: () => Promise<void>;
  openDataFolder: () => Promise<void>;
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    studyLabDesktop?: StudyLabDesktopApi;
  }
}
