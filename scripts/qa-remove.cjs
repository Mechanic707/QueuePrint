/** Real Electron removal regression using generated files. No print jobs. */
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'remove', randomUUID());

(async () => {
  const fixture = path.join(output, '移出样例');
  const folderA = path.join(fixture, '01-资料'), nested = path.join(folderA, '子目录'), folderB = path.join(fixture, '02-附件');
  await fs.mkdir(nested, { recursive: true }); await fs.mkdir(folderB, { recursive: true });
  const paths = { a: path.join(folderA, '1_A.pdf'), b: path.join(folderA, '2_B.pdf'), c: path.join(nested, '1_C.pdf'),
    d: path.join(folderB, '1_D.png'), e: path.join(folderB, '2_E.pdf'), bad: path.join(folderB, '3_损坏.pdf') };
  for (const key of ['a', 'b', 'c', 'e']) {
    const pdf = await PDFDocument.create();
    const count = key === 'b' ? 2 : 1;
    for (let index = 0; index < count; index++) pdf.addPage([400, 600]).drawText(`QueuePrint removal fixture ${key} ${index + 1}`, { x: 25, y: 550, size: 14 });
    await fs.writeFile(paths[key], await pdf.save());
  }
  await fs.copyFile(path.join(root, 'assets', 'icon.png'), paths.d);
  await fs.writeFile(paths.bad, 'Generated invalid PDF removal fixture');
  const original = new Map(await Promise.all(Object.values(paths).map(async file => [file, await fs.readFile(file)])));
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 60000 });
  const report = { passed: false, actualPrinting: false, screenshots: [] };
  let page;
  try {
    page = await electron.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#qp-file-count').waitFor();
    await page.waitForFunction(() => document.querySelector('#qp-printer')?.options[0]?.textContent !== '正在读取打印机…');
    await electron.evaluate(({ ipcMain, BrowserWindow, dialog }, directory) => {
      if (!globalThis.__queueprintQA) throw new Error('Isolated QA process required.');
      globalThis.__removeQA = { printCalls: 0, pendingPick: null };
      ipcMain.removeHandler('qp:print');
      ipcMain.handle('qp:print', () => { globalThis.__removeQA.printCalls++; throw new Error('Removal QA prohibits printing.'); });
      ipcMain.removeHandler('qp:printers');
      ipcMain.handle('qp:printers', () => [{ name: 'QueuePrint 示例打印机', isDefault: true, color: true, duplex: true,
        paperSizes: [{ name: 'A4', kind: 'A4', width: 827, height: 1169 }, { name: 'A5', kind: 'A5', width: 583, height: 827 }, { name: 'A3', kind: 'A3', width: 1169, height: 1654 }] }]);
      ipcMain.removeHandler('qp:page-layout');
      ipcMain.handle('qp:page-layout', (_event, value) => {
        const sizes = { A4: [827, 1169], A5: [583, 827], A3: [1169, 1654] };
        let [width, height] = sizes[value.settings.paper] || sizes.A4;
        const landscape = value.settings.orientation === 'landscape'; if (landscape) [width, height] = [height, width];
        return { paper: { width, height }, printableArea: { x: 20, y: 20, width: width - 40, height: height - 40 }, landscape, dimensionUnit: 'hundredths-inch' };
      });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1000, 720); window.showInactive();
    }, fixture);
    await page.locator('[data-action="refresh-printers"]').click();
    await page.locator('#qp-printer option[value="QueuePrint 示例打印机"]').waitFor({ state: 'attached' });
    await page.locator('[data-action="import-folder"]').first().click();
    async function count(value) { await page.waitForFunction(value => document.querySelector('#qp-file-count').textContent === String(value), value, { timeout: 60000 }); }
    await count(6);
    const names = await page.locator('.qp-file-name').allTextContents();
    assert.deepEqual(names, ['1_A.pdf', '2_B.pdf', '1_C.pdf', '1_D.png', '2_E.pdf', '3_损坏.pdf']);
    const ids = await page.locator('[data-check-file]').evaluateAll(elements => elements.map(element => element.dataset.checkFile));
    const id = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'bad'].map((key, index) => [key, ids[index]]));
    const fileButton = key => page.locator(`[data-file="${id[key]}"]`);
    const removeButton = key => page.locator(`[data-remove-file="${id[key]}"]`);
    const folderButton = label => page.locator('#qp-tree-items [data-folder]').filter({ hasText: label }).first();
    const folderId = async label => folderButton(label).getAttribute('data-folder');
    const groupA = await folderId('01-资料'), groupB = await folderId('02-附件'), child = await folderId('子目录');
    const picker = page.locator('#qp-preview-file-select');
    async function snapshot() {
      return page.evaluate(() => ({ order: [...document.querySelectorAll('[data-check-file]')].map(el => el.dataset.checkFile),
        checked: [...document.querySelectorAll('[data-check-file]:checked')].map(el => el.dataset.checkFile),
        copies: Object.fromEntries([...document.querySelectorAll('[data-file-copies]')].map(el => [el.dataset.fileCopies, el.value])),
        selected: document.querySelector('.qp-file-row.is-selected')?.dataset.dragFile || null, quantity: document.querySelector('#qp-quantity').value }));
    }
    async function verifyFiltered(before, removed) {
      const after = await snapshot(), keep = list => list.filter(item => !removed.includes(item));
      assert.deepEqual(after.order, keep(before.order), 'Removing an item must preserve the remaining manual print order.');
      assert.deepEqual(after.checked, keep(before.checked), 'Removal must not change another file\'s print selection.');
      assert.deepEqual(after.copies, Object.fromEntries(Object.entries(before.copies).filter(([key]) => !removed.includes(key))));
      assert.equal(after.quantity, before.quantity);
    }
    async function choose(key) { await fileButton(key).click(); }
    async function setCopies(key, value) { const input = page.locator(`[data-file-copies="${id[key]}"]`); await input.fill(String(value)); await input.press('Tab'); }
    async function screenshot(name) { const target = path.join(output, name); await page.screenshot({ path: target, scale: 'css', animations: 'disabled' }); report.screenshots.push(path.relative(root, target).replaceAll('\\', '/')); }
    async function settled(key) { await page.waitForFunction(fileId => { const view = document.querySelector('#qp-preview-view'); return view.dataset.fileId === fileId && view.dataset.loading === 'false'; }, id[key], { timeout: 30000 }); }
    async function importFile(key, expected) {
      await electron.evaluate(({ ipcMain }, filePath) => {
        ipcMain.removeHandler('qp:pick-files');
        ipcMain.handle('qp:pick-files', () => globalThis.__queueprintQA.registry.importPaths([filePath]));
      }, paths[key]);
      await page.locator('[data-action="import-files"]').click(); await count(expected);
    }

    // Preserve a manually reordered, partially selected batch with independent settings.
    await setCopies('a', 3); await page.locator('[data-setting="orientation"]').selectOption('landscape');
    await setCopies('e', 2); await page.locator('[data-setting="paper"]').selectOption('A5');
    await folderButton('02-附件').click(); await page.locator('[data-setting="paper"]').selectOption('A3');
    await choose('b'); await page.locator('[data-action="move-up"]').click();
    await page.locator(`[data-check-file="${id.b}"]`).uncheck();
    await page.locator('#qp-quantity').fill('2'); await page.locator('#qp-quantity').press('Tab');
    await choose('a');
    const before = await snapshot();
    assert.equal(before.selected, id.a); assert.equal(before.order[0], id.b);
    const controls = await page.locator('[data-remove-file],[data-remove-folder]').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(), row = element.closest('tr').getBoundingClientRect();
      return { label: element.getAttribute('aria-label'), width: rect.width, left: rect.left, right: rect.right, rowRight: row.right };
    }));
    assert.ok(controls.length >= 9 && controls.every(control => control.label && control.width >= 20 && control.left >= 0 && control.right <= control.rowRight + 1), 'Each file/folder minus control must be visible and labeled at the minimum window width.');
    report.layouts = [];
    for (const width of [1000, 1360]) {
      await electron.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      report.layouts.push(await page.evaluate(() => {
        const list = document.querySelector('#qp-list-view'), table = list.querySelector('table'), box = list.getBoundingClientRect();
        return { width: innerWidth, clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, tableWidth: table.getBoundingClientRect().width,
          visibleRight: box.left + list.clientLeft + list.clientWidth,
          minusRight: Math.max(...[...list.querySelectorAll('[data-remove-file],[data-remove-folder]')].map(button => button.getBoundingClientRect().right)) };
      }));
    }
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 720));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await screenshot('list-removal-controls.png');
    await removeButton('b').click(); await count(5); await verifyFiltered(before, [id.b]);
    assert.equal((await snapshot()).selected, id.a, 'Removing an unrelated row must retain the focused file.');
    assert.equal(await page.locator('[data-setting="orientation"]').inputValue(), 'landscape');
    assert.equal(await page.locator('[data-scope="file"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await fs.readFile(paths.b), original.get(paths.b));
    await choose('e'); assert.equal(await page.locator('[data-setting="paper"]').inputValue(), 'A5');
    await choose('d'); assert.equal(await page.locator('[data-setting="paper"]').inputValue(), 'A3');
    await choose('a');
    assert.equal(await removeButton('bad').isEnabled(), true, 'A corrupt file must still be removable.');
    const beforeBad = await snapshot(); await removeButton('bad').click(); await count(4); await verifyFiltered(beforeBad, [id.bad]);
    await folderButton('02-附件').click();
    const beforeFolderFocus = await snapshot();
    await removeButton('c').click(); await count(3); await verifyFiltered(beforeFolderFocus, [id.c]);
    assert.equal(await page.locator('[data-scope="folder"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#qp-scope-title').textContent(), '02-附件', 'Removing a file from another folder must retain the current folder property context.');
    assert.equal(await page.locator('[data-setting="paper"]').inputValue(), 'A3');
    await importFile('c', 4); await choose('a');

    // Imports hold a real busy state; even a synthetic click cannot bypass it.
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('qp:pick-files');
      ipcMain.handle('qp:pick-files', () => new Promise(resolve => { globalThis.__removeQA.pendingPick = resolve; }));
    });
    await page.locator('[data-action="import-files"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="import-files"]').disabled);
    assert.equal(await removeButton('a').isDisabled(), true);
    assert.equal(await page.locator(`[data-remove-folder="${groupA}"]`).isDisabled(), true);
    const duringBusy = await snapshot();
    await removeButton('a').evaluate(button => { button.disabled = false; button.click(); });
    assert.deepEqual(await snapshot(), duringBusy, 'Busy-state removal guard must be enforced by the handler.');
    await electron.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (!globalThis.__removeQA.pendingPick) {
        if (Date.now() > deadline) throw new Error('Held import request did not arrive.');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const resolve = globalThis.__removeQA.pendingPick; globalThis.__removeQA.pendingPick = null; resolve({ cancelled: true, files: [] });
    });
    await page.waitForFunction(() => !document.querySelector('[data-action="import-files"]').disabled);

    // Synthetic active-batch progress locks row, folder and preview removal.
    async function emit(status) { await electron.evaluate(({ BrowserWindow }, status) => BrowserWindow.getAllWindows()[0].webContents.send('qp:print-progress', { batchId: 'qa-remove-guard', status, taskCount: 1, taskIndex: 0, totalFiles: 4, totalPages: 4, totalUnits: 4, processedFiles: 0, submittedFiles: 0, processedPages: 0, fileProgress: [], jobs: [] }), status); }
    await page.locator('[data-action="view-preview"]').click(); await page.locator('#qp-preview-mode').selectOption('source'); await settled('a');
    await emit('running');
    await page.waitForFunction(() => document.querySelector('#qp-preview-remove-file').disabled);
    assert.equal(await removeButton('a').isDisabled(), true); assert.equal(await page.locator(`[data-remove-folder="${groupA}"]`).isDisabled(), true);
    const duringPrint = await snapshot();
    await page.locator('#qp-preview-remove-file').evaluate(button => { button.disabled = false; button.click(); });
    assert.deepEqual(await snapshot(), duringPrint, 'An active batch must prevent removal even when a click is dispatched programmatically.');
    await emit('stopped'); await page.waitForFunction(() => !document.querySelector('#qp-preview-remove-file').disabled);

    // Removing the previewed middle item selects its successor, not the first file.
    await picker.selectOption(id.c); await settled('c');
    await page.locator('#qp-preview-remove-file').click(); await count(3); await settled('d');
    assert.equal(await page.locator('#qp-image-preview').isVisible(), true);
    assert.deepEqual(await picker.locator('option').evaluateAll(elements => elements.filter(el => el.value).map(el => el.value)), [id.a, id.d, id.e]);
    await screenshot('preview-removal-controls.png');
    await page.locator('[data-action="view-list"]').click();

    // A removed path can be imported again, with a fresh queue selection/settings.
    await importFile('c', 4);
    assert.equal(await page.locator(`[data-check-file="${id.c}"]`).isChecked(), true);
    assert.equal(await page.locator(`[data-file-copies="${id.c}"]`).inputValue(), '1');
    await choose('e');
    const beforeFolder = await snapshot();
    await page.locator(`[data-remove-folder="${groupA}"]`).click(); await count(2); await verifyFiltered(beforeFolder, [id.a, id.c]);
    assert.equal((await snapshot()).selected, id.e);
    assert.equal(await page.locator('[data-setting="paper"]').inputValue(), 'A5');
    assert.equal(await page.locator(`[data-remove-folder="${groupA}"]`).count(), 0);
    assert.equal((await fs.stat(nested)).isDirectory(), true);

    // Existing focused-folder toolbar removal still supports a subtree.
    await electron.evaluate(({ dialog }, folderPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] }); }, folderA);
    await page.locator('[data-action="import-folder"]').first().click(); await count(5);
    await folderButton('子目录').click(); await page.locator('[data-action="remove-selected"]').click(); await count(4);
    assert.equal(await page.locator(`[data-remove-file="${id.c}"]`).count(), 0);
    await folderButton('02-附件').click(); await page.locator('[data-action="remove-selected"]').click(); await count(2);
    assert.equal(await page.locator(`[data-remove-folder="${groupB}"]`).count(), 0);
    await choose('a');
    assert.equal(await page.locator(`[data-file-copies="${id.a}"]`).inputValue(), '1', 'Removed file overrides must not leak into a later import.');
    assert.equal(await page.locator('[data-setting="orientation"]').inputValue(), 'auto');
    await page.locator('[data-action="view-preview"]').click(); await settled('a');
    await picker.selectOption(id.b); await settled('b');
    await page.locator('#qp-preview-remove-file').click(); await count(1); await settled('a');
    assert.equal(await page.locator('#qp-previous-file').isDisabled(), true); assert.equal(await page.locator('#qp-next-file').isDisabled(), true);
    await page.locator('#qp-preview-remove-file').click(); await count(0);
    assert.equal(await picker.isDisabled(), true); assert.equal(await page.locator('#qp-preview-remove-file').isDisabled(), true);
    assert.equal(await page.locator('#qp-remove-button').isDisabled(), true); assert.equal(await page.locator('#qp-print-button').isDisabled(), true);
    assert.equal(await page.locator('#qp-pdf-canvas').isHidden(), true); assert.equal(await page.locator('#qp-image-preview').isHidden(), true);
    assert.equal(await page.locator('[data-remove-file],[data-remove-folder]').count(), 0);
    for (const [filePath, bytes] of original) assert.deepEqual(await fs.readFile(filePath), bytes, 'Removal must leave every source file unchanged.');
    for (const directory of [fixture, folderA, nested, folderB]) assert.equal((await fs.stat(directory)).isDirectory(), true);
    assert.equal(await electron.evaluate(() => globalThis.__removeQA.printCalls), 0);
    assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, files: names.length, perFileAndFolderRemoval: true, manualOrderAndPrintingSelectionPreserved: true,
      independentSettingsPreserved: true, busyAndBatchGuard: true, previewNextAndPrevious: true, reimportAfterRemoval: true, emptyState: true,
      sourceFilesAndFoldersUnchanged: true, pageErrors: errors });
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const ownedProcess = electron.process();
    await Promise.race([electron.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (ownedProcess.exitCode === null) {
      const { spawn } = require('node:child_process');
      await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(ownedProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', resolve); killer.once('close', resolve); });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
