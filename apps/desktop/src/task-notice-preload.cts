import { contextBridge, ipcRenderer } from 'electron';

/** 通知窗口仅能操作当前提案，不提供主窗口的业务 Bridge，也不接收任意通道名。 */
contextBridge.exposeInMainWorld('averyNotice', {
  action: (action: string) => { if (['open', 'dismiss', 'pause', 'resume'].includes(action)) ipcRenderer.send('task-notice:action', action); },
  submit: (payload: unknown) => ipcRenderer.invoke('task-notice:submit', payload),
  resize: (height: number) => { if (Number.isFinite(height) && height > 0 && height <= 2000) ipcRenderer.send('task-notice:resize', height); },
});
