"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
/** 通知窗口仅能操作当前提案，不提供主窗口的业务 Bridge，也不接收任意通道名。 */
electron_1.contextBridge.exposeInMainWorld('averyNotice', {
    action: (action) => { if (['open', 'dismiss', 'pause', 'resume'].includes(action))
        electron_1.ipcRenderer.send('task-notice:action', action); },
    submit: (payload) => electron_1.ipcRenderer.invoke('task-notice:submit', payload),
    resize: (height) => { if (Number.isFinite(height) && height > 0 && height <= 2000)
        electron_1.ipcRenderer.send('task-notice:resize', height); },
});
