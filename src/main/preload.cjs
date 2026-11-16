const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('queueprint', {
  getPrinters: invoke('qp:printers'),
  pickFolder: invoke('qp:pick-folder'),
  pickFiles: invoke('qp:pick-files'),
  importDroppedFiles(files) {
    if (!Array.isArray(files)) return Promise.reject(new Error('请拖入本地文件夹或文件。'));
    const paths = [];
    for (const file of files) {
      try {
        const filePath = webUtils.getPathForFile(file);
        if (filePath) paths.push(filePath);
      } catch { /* Browser-created Files and text are not local filesystem selections. */ }
    }
    if (!paths.length) return Promise.reject(new Error('未获取到本地文件路径，请从资源管理器拖入文件夹或文件。'));
    return ipcRenderer.invoke('qp:import-dropped', [...new Set(paths)]);
  },
  getFileBytes: invoke('qp:file-bytes'),
  getPageLayout: invoke('qp:page-layout'),
  loadPreferences: invoke('qp:preferences-load'),
  savePreferences: invoke('qp:preferences-save'),
  showPrinterProperties: invoke('qp:printer-properties'),
  submitPrint: invoke('qp:print'),
  pausePrint: invoke('qp:pause'),
  resumePrint: invoke('qp:resume'),
  stopPrint: invoke('qp:stop'),
  onPrintProgress(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('qp:print-progress', handler);
    return () => ipcRenderer.removeListener('qp:print-progress', handler);
  },
});
