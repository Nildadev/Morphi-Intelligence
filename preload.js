const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morphi', {
  getToken: () => ipcRenderer.invoke('morphi:token'),
  credentials: {
    set: (providerId, apiKey) => ipcRenderer.invoke('morphi:credentials:set', { providerId, apiKey }),
    delete: (providerId) => ipcRenderer.invoke('morphi:credentials:delete', { providerId }),
    status: () => ipcRenderer.invoke('morphi:credentials:status'),
  },
  window: {
    command: (action) => ipcRenderer.invoke('morphi:window', { action }),
  },
  theme: {
    set: (theme) => ipcRenderer.send('morphi:theme', theme),
  },
  accent: () => ipcRenderer.invoke('morphi:accent'),
  onAccent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('morphi:accent', listener);
    return () => ipcRenderer.removeListener('morphi:accent', listener);
  },
});
