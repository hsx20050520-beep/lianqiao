const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lianqiaoNative', {
  applyControl: (payload) => ipcRenderer.invoke('lianqiao:apply-control', payload),
  onEmergencyStop: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('lianqiao:emergency-stop', listener);
    return () => ipcRenderer.removeListener('lianqiao:emergency-stop', listener);
  },
});
