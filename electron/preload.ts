import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAppInfo, DesktopUpdateStatus, StudyLabDesktopApi } from '../src/types/desktop.js';

const UPDATE_CHANNEL = 'studylab:update-status';

const desktopApi: StudyLabDesktopApi = {
  isDesktop: true,
  getAppInfo: () => ipcRenderer.invoke('studylab:get-app-info') as Promise<DesktopAppInfo>,
  checkForUpdates: () =>
    ipcRenderer.invoke('studylab:check-updates') as Promise<{ ok: boolean; reason?: string }>,
  downloadUpdate: () =>
    ipcRenderer.invoke('studylab:download-update') as Promise<{ ok: boolean; reason?: string }>,
  installUpdate: () => ipcRenderer.invoke('studylab:install-update') as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke('studylab:open-data-folder') as Promise<void>,
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => {
      listener(status);
    };
    ipcRenderer.on(UPDATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(UPDATE_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld('studyLabDesktop', desktopApi);
