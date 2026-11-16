import { app, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runNative, findNativeHost } from './native-host.mjs';
import { FileRegistry } from './files.mjs';
import { PrintQueue } from './print-queue.mjs';
import { isSameRendererUrl } from './renderer-url.mjs';

const mainDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(mainDir, '../..');
const rendererPath = path.join(appRoot, 'src/renderer/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
let win, quitting = false, printerCache = [];
let preferenceWrites = Promise.resolve();

app.setName('QueuePrint');
if (process.env.QUEUEPRINT_TEST_USER_DATA) app.setPath('userData', process.env.QUEUEPRINT_TEST_USER_DATA);
const singleInstance = process.env.QUEUEPRINT_QA === '1' || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

const native = (request, options) => {
  if (process.env.QUEUEPRINT_QA === '1' && ['print', 'properties', 'cancel'].includes(request.command)) {
    throw new Error('自动检查进程禁止实际打印、修改驱动属性和取消真实任务。');
  }
  return runNative(findNativeHost(appRoot, process.resourcesPath, { packaged: app.isPackaged }), request, options);
};
const registry = new FileRegistry((paths) => native({ command: 'inspect', paths }, { timeout: 5 * 60_000 }));
const queue = new PrintQueue({
  registry, runNative: native,
  emit: (event) => { if (win && !win.isDestroyed()) win.webContents.send('qp:print-progress', event); },
  audit: (event) => {
    const record = { time: new Date().toISOString(), batchId: event.batchId, status: event.status, taskIndex: event.taskIndex, taskCount: event.taskCount,
      processedFiles: event.processedFiles, submittedFiles: event.submittedFiles, totalFiles: event.totalFiles,
      processedUnits: event.processedUnits, submittedUnits: event.submittedUnits, totalUnits: event.totalUnits, message: event.message, jobs: event.jobs };
    void fs.appendFile(path.join(app.getPath('userData'), 'print-history.jsonl'), JSON.stringify(record) + '\n', 'utf8').catch(() => {});
  },
});

function guard(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !isSameRendererUrl(event.senderFrame.url, rendererUrl)) {
    throw new Error('无效的应用请求。');
  }
}
function handle(channel, action) { ipcMain.handle(channel, (event, ...args) => { guard(event); return action(...args); }); }

async function getPrinters() {
  const response = await native({ command: 'printers' }, { timeout: 60_000 });
  const printers = Array.isArray(response) ? response : response?.printers || [];
  printerCache = printers.map((p) => ({
    ...p, name: p.name || p.printerName, isDefault: !!(p.isDefault ?? p.default),
    color: !!(p.color ?? p.supportsColor), duplex: !!(p.duplex ?? p.canDuplex ?? p.supportsDuplex),
  })).filter((p) => p.name);
  return printerCache;
}

async function pick(folders) {
  if (queue.isBusy()) throw new Error('请先完成本批次，再修改导入文件。');
  const result = await dialog.showOpenDialog(win, {
    title: folders ? '导入包含子文件夹的打印材料' : '添加 PDF 或图片',
    properties: folders ? ['openDirectory', 'multiSelections', 'dontAddToRecent'] : ['openFile', 'multiSelections', 'dontAddToRecent'],
    ...(folders ? {} : { filters: [{ name: 'PDF 和图片', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }] }),
  });
  if (result.canceled) return { cancelled: true, files: [] };
  return registry.importPaths(result.filePaths, { folders });
}

async function loadPreferences() {
  try { return JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'preferences.json'), 'utf8')); }
  catch { return {}; }
}

async function savePreferences(value) {
  if (!value || typeof value !== 'object') throw new Error('设置格式无效。');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 1_000_000) throw new Error('保存的打印方案过多，请精简后重试。');
  preferenceWrites = preferenceWrites.catch(() => {}).then(async () => {
    const target = path.join(app.getPath('userData'), 'preferences.json'), temporary = target + '.tmp';
    await fs.writeFile(temporary, json, 'utf8');
    await fs.rename(temporary, target);
  });
  await preferenceWrites;
  return { saved: true };
}

function registerIpc() {
  handle('qp:printers', getPrinters);
  handle('qp:pick-folder', () => pick(true));
  handle('qp:pick-files', () => pick(false));
  handle('qp:import-dropped', async (paths) => {
    if (queue.isBusy()) throw new Error('请先完成当前打印批次，再拖入文件。');
    if (!Array.isArray(paths) || !paths.length || paths.length > 10_000 ||
      paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new Error('拖入的本地文件路径无效。');
    }
    return registry.importDroppedPaths(paths);
  });
  handle('qp:file-bytes', (id) => registry.bytes(id));
  handle('qp:preferences-load', loadPreferences);
  handle('qp:preferences-save', savePreferences);
  handle('qp:printer-properties', async (value) => {
    if (queue.isBusy()) throw new Error('请先完成当前批次，再修改打印机属性。');
    if (!printerCache.some((p) => p.name === value?.printerName)) throw new Error('请选择有效的打印机。');
    const handleBuffer = win.getNativeWindowHandle();
    const ownerWindow = handleBuffer.length >= 8 ? Number(handleBuffer.readBigUInt64LE()) : handleBuffer.readUInt32LE();
    if (!Number.isSafeInteger(ownerWindow)) throw new Error('无法读取打印机属性窗口的父窗口句柄。');
    return native({ command: 'properties', printerName: value.printerName, devModeBase64: value.devModeBase64 || value.devmode, ownerWindow }, { timeout: 20 * 60_000 });
  });
  handle('qp:print', async (plan) => {
    const printers = await getPrinters();
    if (!printers.some((p) => p.name === plan?.printerName)) throw new Error('所选打印机已不可用，请刷新打印机列表。');
    if (queue.batch?.needsConfirmation) {
      const choice = await dialog.showMessageBox(win, {
        type: 'warning', title: '确认是否重新提交',
        message: '上次有任务的提交状态不明。',
        detail: '请先检查 Windows 打印队列和实际出纸情况。继续提交可能重复打印已接收的内容。',
        buttons: ['返回检查', '已检查，继续提交'], defaultId: 0, cancelId: 0,
      });
      if (choice.response !== 1) throw new Error('已保留原状态，请检查后再提交。');
    }
    return queue.submit(plan);
  });
  handle('qp:pause', () => queue.pause());
  handle('qp:resume', () => queue.resume());
  handle('qp:stop', () => queue.stop());
}

async function createWindow() {
  const preferences = await loadPreferences();
  win = new BrowserWindow({
    width: 1360, height: 940, minWidth: 1000, minHeight: 720,
    title: '序印 · 批量打印', show: false, autoHideMenuBar: true,
    icon: path.join(appRoot, 'assets/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#20242e' : '#ffffff',
    webPreferences: { preload: path.join(mainDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  if (preferences.windowMaximized) win.maximize();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!isSameRendererUrl(url, rendererUrl)) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.once('ready-to-show', () => { if (process.env.QUEUEPRINT_QA !== '1') win.show(); });
  win.on('close', async (event) => {
    if (queue.isBusy() && !quitting) {
      event.preventDefault();
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: '打印任务仍在提交', message: '是否停止后续任务并退出？',
        detail: '当前已提交的任务可能继续出纸。软件会等待当前任务完成提交后退出。',
        buttons: ['返回工作台', '停止后续并退出'], defaultId: 0, cancelId: 0,
      });
      if (result.response === 1) { queue.stop(); await queue.done; quitting = true; win.close(); }
    }
  });
  await win.loadFile(rendererPath);
  return win;
}

if (singleInstance) {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    registerIpc(); await createWindow();
  }).catch((error) => { dialog.showErrorBox('序印启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

// Only available to the isolated QA process; never exposed through the renderer bridge.
export const qa = process.env.QUEUEPRINT_QA === '1' ? { registry, queue, native, getPrinters } : undefined;
if (qa) globalThis.__queueprintQA = qa;
