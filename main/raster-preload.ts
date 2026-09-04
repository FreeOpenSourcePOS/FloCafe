export {};
const { contextBridge, ipcRenderer } = require('electron');
let readySent = false;

/** The raster surface exposes only request delivery and result submission. */
contextBridge.exposeInMainWorld('__floRaster', {
  onRequest: (callback: (request: unknown) => void) => {
    const handler = (_event: unknown, request: unknown) => callback(request);
    ipcRenderer.on('flo:raster-request', handler);
    if (!readySent) {
      readySent = true;
      ipcRenderer.send('flo:raster-ready');
    }
    return () => ipcRenderer.removeListener('flo:raster-request', handler);
  },
  sendResult: (result: unknown) => ipcRenderer.send('flo:raster-result', result),
});
