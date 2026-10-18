import { contextBridge, ipcRenderer } from 'electron';
import type { EnsembleAPI } from '../shared/api.js';
const api: EnsembleAPI = {
  catalog: () => ipcRenderer.invoke('ensemble:catalog'),
  plan: (input) => ipcRenderer.invoke('ensemble:plan', input),
  preview: (tools) => ipcRenderer.invoke('ensemble:preview', tools),
  apply: (id) => ipcRenderer.invoke('ensemble:apply', id),
  revert: (id) => ipcRenderer.invoke('ensemble:revert', id),
  refresh: (consent) => ipcRenderer.invoke('ensemble:refresh', consent),
  setKey: (key) => ipcRenderer.invoke('ensemble:key', key),
  copy: (text) => ipcRenderer.invoke('ensemble:copy', text),
};
contextBridge.exposeInMainWorld('ensemble', Object.freeze(api));
