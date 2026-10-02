'use strict';

// The title strip's own bridge, and the only one it has. The strip draws our
// window controls (core/ui/titlebar.html) on Windows, so its page needs to reach
// the window; this exposes exactly those three actions and the maximised state,
// and nothing else. macOS loads no preload, because it keeps its traffic lights.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chelaWindowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (listener) => {
    ipcRenderer.on('window:maximize-changed', (_event, isMaximized) => listener(!!isMaximized));
  },
});
