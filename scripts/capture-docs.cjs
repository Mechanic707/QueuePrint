// Reproducible public documentation screenshots. Never invokes a print command.
// Run: npm run native:build && node scripts/capture-docs.cjs
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'images');
const qaRoot = path.join(root, '.qa');
const userData = path.join(qaRoot, 'docs-user-data');
const fixtureRoot = path.join(qaRoot, 'fixtures', '样例材料');
const demoName = '示例双面激光打印机';
const demoPrinters = [
  { name: demoName, isDefault: true, color: true, duplex: true,
    paperSizes: ['A4', 'A5', 'A3', 'Letter'].map(name => ({ name, kind: name })) },
  { name: '示例彩色喷墨打印机', isDefault: false, color: true, duplex: false,
    paperSizes: ['A4', 'A5', 'Letter'].map(name => ({ name, kind: name })) },
];

(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  // These documents are generated from scratch; no personal files are imported.
  execFileSync(process.execPath, [path.join(root, 'scripts', 'create-fixtures.mjs')], { cwd: root, stdio: 'pipe' });
  await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({
    version: 1, printerName: demoName, quantityMode: 'sets', boundary: true,
    globalSettings: { paper: 'A4', orientation: 'auto', color: 'mono', duplex: 'long', scale: 'fit' },
    driverSettings: {}, presets: [],
  }));
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({
    executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'),
    args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 45_000,
  });
  const errors = [];
  try {
    const page = await electron.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#qp-file-count').waitFor();
    // Let the initial startup request finish before replacing the handler, so a
    // late real-device response cannot overwrite the anonymous demonstration UI.
    await page.waitForFunction(() => document.querySelector('#qp-printer').options[0]?.textContent !== '正在读取打印机…', { timeout: 70_000 });
    await electron.evaluate(({ ipcMain, BrowserWindow, nativeTheme }, printers) => {
      if (process.env.QUEUEPRINT_QA !== '1') throw new Error('Documentation capture requires isolated QA mode.');
      ipcMain.removeHandler('qp:printers');
      ipcMain.handle('qp:printers', async () => printers);
      ipcMain.removeHandler('qp:page-layout');
      ipcMain.handle('qp:page-layout', (_event, value) => {
        const landscape = value.settings.orientation === 'landscape';
        const paper = landscape ? { width: 1169, height: 827 } : { width: 827, height: 1169 };
        return { paper, printableArea: { x: 20, y: 20, width: paper.width - 40, height: paper.height - 40 }, landscape, dimensionUnit: 'hundredths-inch' };
      });
      nativeTheme.themeSource = 'light';
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1360, 960);
      window.showInactive();
    }, demoPrinters);
    await page.locator('[data-action="refresh-printers"]').click();
    await page.waitForFunction(name => document.querySelector('#qp-printer').value === name, demoName);
    assert.deepEqual(await page.locator('#qp-printer option').allTextContents(), [demoName + '（默认）', '示例彩色喷墨打印机']);
    assert.equal(await page.locator('#qp-file-count').innerText(), '0');

    async function settleTransientUi() {
      if (await page.locator('#qp-announcement').isVisible()) await page.locator('#qp-announcement').waitFor({ state: 'hidden', timeout: 8_000 });
      await page.mouse.move(940, 34); // Keep tooltips with local file paths out of captures.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function assertAnonymous() {
      const text = await page.locator('body').innerText();
      assert.ok(!/[A-Z]:[\\/]|file:\/\/|Users[\\/]/i.test(text), 'Public screenshot contains a local path.');
      assert.deepEqual(await page.locator('#qp-printer option').allTextContents(), [demoName + '（默认）', '示例彩色喷墨打印机']);
      assert.ok(text.includes(demoName), 'Anonymous demonstration printer is missing.');
    }
    async function capture(name) {
      await assertAnonymous();
      await page.screenshot({ path: path.join(output, name), scale: 'css', animations: 'disabled' });
    }

    // Chromium's native file drag payload includes a real external directory;
    // do not synthesize an HTML overlay or modify product markup for this image.
    const client = await page.context().newCDPSession(page);
    const box = await page.locator('.qp-queue').boundingBox();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + 190);
    const data = { items: [], files: [fixtureRoot], dragOperationsMask: 1 };
    await settleTransientUi();
    await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await client.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await page.locator('#qp-drop-overlay').waitFor({ state: 'visible' });
    assert.match(await page.locator('#qp-drop-title').innerText(), /松开/);
    await capture('folder-drop.png');
    await client.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '6', { timeout: 60_000 });
    await page.locator('#qp-drop-overlay').waitFor({ state: 'hidden' });
    assert.deepEqual((await page.locator('.qp-file-name').allTextContents()).slice(0, 3), ['1_审批单.pdf', '2_发票.pdf', '10_附件.pdf']);

    await page.locator('[name="qp-quantity-mode"][value="sets"]').check();
    const copies = page.locator('input[data-file-copies]').first();
    await copies.fill('3');
    await copies.press('Tab');
    await page.locator('#qp-quantity').fill('2');
    await page.locator('#qp-quantity').press('Tab');
    await page.locator('[data-scope="batch"]').click();
    await page.locator('.qp-settings').evaluate(element => { element.scrollTop = 0; });
    await settleTransientUi();
    assert.equal(await copies.inputValue(), '3');
    assert.equal(await page.locator('#qp-quantity').inputValue(), '2');
    assert.equal(await page.locator('#qp-total-pages').innerText(), '32');
    assert.equal(await page.locator('[data-scope="batch"]').getAttribute('aria-pressed'), 'true');
    await capture('workspace.png');

    await page.locator('[data-action="view-preview"]').click();
    await page.locator('#qp-pdf-canvas').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#qp-preview-fit-page').click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#qp-pdf-canvas');
      return document.querySelector('#qp-preview-view').dataset.loading === 'false' && document.querySelector('#qp-preview-content').dataset.geometrySource === 'driver' && !canvas.hidden;
    });
    const canvas = await page.locator('#qp-pdf-canvas').evaluate(element => ({
      width: element.width, height: element.height,
      hasInk: element.getContext('2d').getImageData(20, 20, element.width - 40, element.height - 40).data.some((value, index) => index % 4 < 3 && value < 230),
    }));
    assert.ok(canvas.width > 100 && canvas.height > 100 && canvas.hasInk, 'Preview must contain an actually rendered PDF page.');
    const canvasBox = await page.locator('#qp-pdf-canvas').boundingBox();
    const stageBox = await page.locator('#qp-paper-stage').boundingBox();
    assert.ok(canvasBox.y >= stageBox.y && canvasBox.y + canvasBox.height <= stageBox.y + stageBox.height,
      'Documentation preview must show the entire PDF page without vertical clipping.');
    await page.locator('[data-scope="batch"]').click();
    await settleTransientUi();
    await capture('preview.png');
    assert.deepEqual(errors, []);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const report = {
      passed: true, images: ['workspace.png', 'folder-drop.png', 'preview.png'].map(name => ({ path: 'docs/images/' + name, ...dimensions })),
      anonymousPrinters: true, syntheticDocumentsOnly: true, externalFolderDrag: true,
      perFileCopies: 3, batchSets: 2, pages: 32, renderedPdfCanvas: canvas,
      actualPrinting: false, pageErrors: errors,
    };
    await fs.writeFile(path.join(qaRoot, 'docs-capture-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await electron.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
