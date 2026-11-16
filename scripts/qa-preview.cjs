/** Real Electron preview checks using generated files. Never sends a print job. */
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'preview', randomUUID());

async function writePdf(file, colors, size) {
  const pdf = await PDFDocument.create();
  colors.forEach((color, index) => {
    const page = pdf.addPage(size);
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(...color) });
    page.drawText(`QueuePrint fixture page ${index + 1}`, { x: 20, y: size[1] - 35, size: 15, color: rgb(1, 1, 1) });
  });
  await fs.writeFile(file, await pdf.save());
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = path.join(output, '预览样例');
  const firstFolder = path.join(fixture, '01-PDF'), secondFolder = path.join(fixture, '02-图片');
  await fs.mkdir(firstFolder, { recursive: true }); await fs.mkdir(secondFolder);
  const firstPdf = path.join(firstFolder, '1_A-three-pages.pdf');
  await writePdf(firstPdf, [[0.85, 0.1, 0.1], [0.1, 0.75, 0.15], [0.1, 0.2, 0.85]], [600, 800]);
  await writePdf(path.join(firstFolder, '2_B-two-pages.pdf'), [[0.65, 0.1, 0.8], [0.9, 0.5, 0.1]], [2384, 3370]);
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(secondFolder, '1_图片.png'));
  await fs.writeFile(path.join(secondFolder, '2_损坏.pdf'), 'Generated invalid PDF fixture');
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 60000 });
  const report = { passed: false, actualPrinting: false, screenshots: [] };
  try {
    const page = await electron.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#qp-file-count').waitFor();
    await page.waitForFunction(() => document.querySelector('#qp-printer')?.options.length > 0 && document.querySelector('#qp-printer').options[0].textContent !== '正在读取打印机…', { timeout: 60000 });
    await electron.evaluate(({ ipcMain, BrowserWindow, dialog }, directory) => {
      const qa = globalThis.__queueprintQA;
      if (!qa) throw new Error('Isolated QA process required.');
      globalThis.__previewQA = { counts: {}, delayFile: null, delayMs: 0 };
      ipcMain.removeHandler('qp:file-bytes');
      ipcMain.handle('qp:file-bytes', async (_event, id) => {
        const control = globalThis.__previewQA;
        control.counts[id] = (control.counts[id] || 0) + 1;
        if (id === control.delayFile) await new Promise(resolve => setTimeout(resolve, control.delayMs));
        return qa.registry.bytes(id);
      });
      ipcMain.removeHandler('qp:printers');
      ipcMain.handle('qp:printers', () => [{ name: 'QueuePrint 示例打印机', isDefault: true, color: true, duplex: true, paperSizes: [{ name: 'A4', kind: 'A4' }] }]);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      BrowserWindow.getAllWindows()[0].showInactive();
    }, fixture);
    await page.locator('[data-action="refresh-printers"]').click();
    await page.locator('#qp-printer option[value="QueuePrint 示例打印机"]').waitFor({ state: 'attached' });
    await page.locator('[data-action="import-folder"]').first().click();
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '4', { timeout: 60000 });
    await page.locator('[data-scope="batch"]').click();
    await page.locator('[data-setting="scale"]').selectOption('shrink');
    const rows = page.locator('input[data-check-file]');
    await rows.nth(1).uncheck();
    await page.locator('input[data-file-copies]').first().fill('2');
    await page.locator('input[data-file-copies]').first().press('Tab');
    async function printSelection() {
      return page.evaluate(() => ({ checked: [...document.querySelectorAll('[data-check-file]:checked')].map(el => el.dataset.checkFile), copies: [...document.querySelectorAll('[data-file-copies]')].map(el => [el.dataset.fileCopies, el.value]), quantity: document.querySelector('#qp-quantity').value, totalPages: document.querySelector('#qp-total-pages').textContent, scale: document.querySelector('[data-setting="scale"]').value }));
    }
    const selection = await printSelection();
    await page.locator('[data-action="view-preview"]').click();
    const picker = page.locator('#qp-preview-file-select'); await picker.waitFor();
    const options = await picker.locator('option').evaluateAll(nodes => nodes.filter(node => node.value).map(node => ({ id: node.value, text: node.textContent })));
    assert.equal(options.length, 4);
    const id = name => options.find(option => option.text.includes(name)).id;
    const a = id('A-three-pages'), b = id('B-two-pages'), photo = id('1_图片.png'), bad = id('2_损坏.pdf');
    async function settled(fileId, pageNumber = 1) {
      await page.waitForFunction(({ fileId, pageNumber }) => {
        const view = document.querySelector('#qp-preview-view');
        return view.dataset.fileId === fileId && view.dataset.loading === 'false' && Number(view.dataset.page) === pageNumber;
      }, { fileId, pageNumber }, { timeout: 30000 });
    }
    async function color(kind) {
      await page.waitForFunction(kind => {
        const canvas = document.querySelector('#qp-pdf-canvas'); if (canvas.hidden || !canvas.width) return false;
        const [r, g, b] = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return kind === 'red' ? r > 180 && g < 90 && b < 90 : kind === 'green' ? g > 150 && r < 90 && b < 100 : kind === 'purple' ? r > 120 && b > 160 && g < 90 : g > 130 && b > 130 && r < 90;
      }, kind, { timeout: 30000 });
    }
    async function choose(fileId, kind) { await picker.selectOption(fileId); await settled(fileId); if (kind) await color(kind); }
    async function zoom(percent) {
      await page.locator('#qp-zoom-percent').fill(String(percent)); await page.locator('#qp-zoom-percent').press('Enter');
      const expected = Math.max(10, Math.min(400, percent));
      await page.waitForFunction(expected => { const view = document.querySelector('#qp-preview-view'); return view.dataset.loading === 'false' && Math.abs(Number(view.dataset.zoomPercent) - expected) < 0.1; }, expected);
    }
    await choose(a, 'red');
    assert.equal(await page.locator('#qp-previous-file').isDisabled(), true);
    const reads = await electron.evaluate(() => ({ ...globalThis.__previewQA.counts }));
    for (const percent of [73, 100, 173, 200]) {
      await zoom(percent);
      const width = await page.locator('#qp-pdf-canvas').evaluate(element => element.getBoundingClientRect().width);
      assert.ok(Math.abs(width - 600 * percent / 100) < 2, `PDF CSS size must follow ${percent}% zoom.`);
    }
    assert.equal(await electron.evaluate((_electron, id) => globalThis.__previewQA.counts[id], a), reads[a], 'Zooming must reuse the loaded PDF.');
    await page.locator('[data-action="next-page"]').click(); await settled(a, 2); await color('green');
    await zoom(125); await color('green');
    await page.locator('#qp-preview-page-number').fill('3'); await page.locator('#qp-preview-page-number').press('Tab'); await settled(a, 3);
    await page.locator('#qp-next-file').click(); await settled(b); await color('purple');
    await page.locator('#qp-previous-file').click(); await settled(a); await color('red');

    // The old A -> B -> A race reused an already-destroyed PDF document.
    await electron.evaluate((_electron, fileId) => { globalThis.__previewQA.delayFile = fileId; globalThis.__previewQA.delayMs = 600; }, b);
    const bReads = await electron.evaluate((_electron, fileId) => globalThis.__previewQA.counts[fileId] || 0, b);
    await picker.selectOption(b);
    await page.locator('#qp-zoom-percent').evaluate(element => { for (const value of ['55', '88', '135', '175']) { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); } });
    await picker.selectOption(a); await settled(a); await color('red');
    await page.waitForTimeout(850); await color('red');
    assert.equal(await picker.inputValue(), a);
    assert.ok(await electron.evaluate((_electron, fileId) => globalThis.__previewQA.counts[fileId] || 0, b) <= bReads + 1, 'Zooming during a load must not start multiple reads/workers.');
    await electron.evaluate(() => { globalThis.__previewQA.delayFile = null; globalThis.__previewQA.delayMs = 0; });

    await zoom(200);
    await page.locator('#qp-paper-stage').evaluate(element => { element.scrollLeft = 240; element.scrollTop = 280; });
    const stage = await page.locator('#qp-paper-stage').boundingBox();
    const pointer = { x: stage.x + stage.width * 0.6, y: stage.y + stage.height * 0.5 };
    async function pointInContent() { return page.locator('#qp-pdf-canvas').evaluate((element, point) => { const rect = element.getBoundingClientRect(); return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height, ratio: window.devicePixelRatio }; }, pointer); }
    const anchor = await pointInContent();
    await page.mouse.move(pointer.x, pointer.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
    await page.waitForFunction(() => { const view = document.querySelector('#qp-preview-view'); return view.dataset.loading === 'false' && Number(view.dataset.zoomPercent) > 200; });
    const after = await pointInContent();
    assert.equal(after.ratio, anchor.ratio, 'Ctrl-wheel must zoom the document, not the application.');
    assert.ok(Math.abs(after.x - anchor.x) < 0.035 && Math.abs(after.y - anchor.y) < 0.035, 'Ctrl-wheel should retain the content under the pointer.');
    const scrollBefore = await page.locator('#qp-paper-stage').evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
    await page.mouse.move(pointer.x, pointer.y); await page.mouse.down(); await page.mouse.move(pointer.x - 100, pointer.y - 80, { steps: 8 }); await page.mouse.up();
    const scrollAfter = await page.locator('#qp-paper-stage').evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
    assert.ok(scrollAfter.x > scrollBefore.x + 50 && scrollAfter.y > scrollBefore.y + 40, 'Dragging enlarged content should pan both axes.');
    await zoom(5000);
    const raster = await page.locator('#qp-pdf-canvas').evaluate(element => ({ width: element.width, height: element.height }));
    assert.ok(raster.width <= 8192 && raster.height <= 8192 && raster.width * raster.height <= 16000000);
    await zoom(0);
    await page.locator('#qp-preview-fit-page').click();
    await page.waitForFunction(() => document.querySelector('#qp-preview-view').dataset.zoomMode === 'page' && document.querySelector('#qp-preview-view').dataset.loading === 'false');
    const fit = await page.evaluate(() => { const stage = document.querySelector('#qp-paper-stage'), canvas = document.querySelector('#qp-pdf-canvas'), style = getComputedStyle(stage); return { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height, availableWidth: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), availableHeight: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) }; });
    assert.ok(fit.width <= fit.availableWidth + 2 && fit.height <= fit.availableHeight + 2, 'Fit-page must show the whole page.');
    await page.locator('#qp-preview-fit-width').click(); await settled(a);
    const oldWidth = await page.locator('#qp-pdf-canvas').evaluate(element => element.getBoundingClientRect().width);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 880));
    await page.waitForFunction(oldWidth => { const view = document.querySelector('#qp-preview-view'), canvas = document.querySelector('#qp-pdf-canvas'); return view.dataset.loading === 'false' && canvas.getBoundingClientRect().width < oldWidth - 20; }, oldWidth);
    assert.ok(await page.locator('#qp-paper-stage').evaluate(element => element.scrollWidth <= element.clientWidth + 2));

    await page.locator('#qp-tree-items [data-folder]').filter({ hasText: '02-图片' }).first().click(); await settled(photo);
    await page.locator('#qp-image-preview').waitFor({ state: 'visible' });
    await page.locator('#qp-preview-actual-size').click(); await settled(photo);
    const imageSource = await page.locator('#qp-image-preview').getAttribute('src');
    await zoom(137);
    const imageSize = await page.locator('#qp-image-preview').evaluate(element => ({ natural: element.naturalWidth, actual: element.getBoundingClientRect().width }));
    assert.ok(Math.abs(imageSize.actual - imageSize.natural * 1.37) < 2);
    assert.equal(await page.locator('#qp-image-preview').getAttribute('src'), imageSource, 'Image zoom must reuse its decoded Blob.');
    await choose(bad); assert.equal(await page.locator('#qp-next-file').isDisabled(), true);
    assert.ok((await page.locator('#qp-preview-message').innerText()).length > 0);
    assert.equal(await page.locator('#qp-pdf-canvas').isHidden(), true);
    await choose(a, 'red');
    assert.deepEqual(await printSelection(), selection, 'Preview navigation and zoom must not alter print selection or properties.');

    // Importing a changed file at the same path keeps its ID but invalidates preview bytes.
    await writePdf(firstPdf, [[0.1, 0.7, 0.75], [0.1, 0.75, 0.15], [0.1, 0.2, 0.85]], [600, 800]);
    await fs.utimes(firstPdf, new Date(), new Date(Date.now() + 5000));
    await page.locator('[data-action="import-folder"]').first().click();
    await page.waitForFunction(() => !document.querySelector('#qp-runtime-status').textContent.includes('正在读取'));
    await settled(a); await color('teal');
    assert.deepEqual(await printSelection(), selection, 'Reimport must retain existing checks/copies.');
    await choose(b, 'purple');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 760));
    await page.locator('#qp-preview-fit-page').click();
    await page.waitForFunction(() => {
      const view = document.querySelector('#qp-preview-view'), stage = document.querySelector('#qp-paper-stage'), canvas = document.querySelector('#qp-pdf-canvas'), css = getComputedStyle(stage);
      const availableHeight = stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
      return view.dataset.loading === 'false' && view.dataset.zoomMode === 'page' && Number(view.dataset.zoomPercent) < 10 && Math.abs(canvas.getBoundingClientRect().height - availableHeight) < 2;
    });
    assert.equal(await page.locator('#qp-zoom-out').isDisabled(), true);
    const largePage = await page.evaluate(() => { const canvas = document.querySelector('#qp-pdf-canvas'), stage = document.querySelector('#qp-paper-stage'), css = getComputedStyle(stage); return { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height, availableWidth: stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), availableHeight: stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), percent: Number(document.querySelector('#qp-preview-view').dataset.zoomPercent), ratio: window.devicePixelRatio }; });
    assert.ok(largePage.width <= largePage.availableWidth + 2 && largePage.height <= largePage.availableHeight + 2, 'Fit-page must work below 10% for an A0 page.');
    const smallStage = await page.locator('#qp-paper-stage').boundingBox();
    await page.mouse.move(smallStage.x + smallStage.width / 2, smallStage.y + smallStage.height / 2);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#qp-preview-view').evaluate(element => Number(element.dataset.zoomPercent)), largePage.percent, 'Zooming out at the manual limit must not unexpectedly zoom in.');
    assert.equal(await page.evaluate(() => window.devicePixelRatio), largePage.ratio);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 880));
    await choose(a, 'teal'); await zoom(25);
    await page.waitForFunction(() => !document.querySelector('#qp-paper-stage').classList.contains('can-pan'));
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 760));
    await page.waitForFunction(() => document.querySelector('#qp-paper-stage').classList.contains('can-pan'));
    const resizedStage = await page.locator('#qp-paper-stage').boundingBox();
    await page.mouse.move(resizedStage.x + resizedStage.width / 2, resizedStage.y + resizedStage.height / 2);
    await page.mouse.down(); await page.mouse.move(resizedStage.x + resizedStage.width / 2, resizedStage.y + resizedStage.height / 2 - 45, { steps: 5 }); await page.mouse.up();
    assert.ok(await page.locator('#qp-paper-stage').evaluate(element => element.scrollTop > 0), 'Shrinking the window at a fixed zoom must enable drag panning when content starts overflowing.');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 880));
    await page.locator('#qp-sort').selectOption('reverse');
    assert.equal((await picker.locator('option').evaluateAll(nodes => nodes.filter(node => node.value).map(node => node.value)))[0], bad);
    await page.locator('#qp-sort').selectOption('natural');
    await choose(a, 'teal'); await page.locator('#qp-preview-fit-page').click(); await settled(a);
    const screenshot = path.join(output, 'preview-navigation.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(path.relative(root, screenshot).replaceAll('\\', '/'));
    await choose(b, 'purple'); await page.locator('[data-action="remove-selected"]').click(); await settled(a); await color('teal');
    assert.equal(await picker.locator('option').count(), 3);
    await page.locator('[data-folder]').filter({ hasText: '预览样例' }).first().click();
    await page.locator('[data-action="remove-selected"]').click();
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '0');
    assert.equal(await picker.isDisabled(), true);
    assert.equal(await page.locator('#qp-pdf-canvas').isHidden(), true);
    assert.equal(await page.locator('#qp-image-preview').isHidden(), true);
    assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, pdfAndImage: true, arbitraryZoom: true, ctrlWheelAnchor: true, dragPan: true, fileAndFolderNavigation: true, rapidSwitching: true, cacheInvalidation: true, corruptFileRecovery: true, printingSelectionUnchanged: true, rasterBudget: raster, pageErrors: errors });
    console.log(JSON.stringify({ passed: true, actualPrinting: false, screenshots: report.screenshots }));
  } catch (error) {
    report.failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
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
