/** Real Electron sheet-preview checks with generated files; printing is blocked. */
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { PDFDocument, rgb } = require('pdf-lib');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'paper-preview', randomUUID());
const printerName = 'QueuePrint 纸张预览测试';

async function writePdf(file) {
  const pdf = await PDFDocument.create();
  for (const [size, color] of [[[360, 180], [0.85, 0.1, 0.1]], [[180, 360], [0.1, 0.75, 0.15]], [[1440, 720], [0.1, 0.2, 0.85]]]) {
    const page = pdf.addPage(size);
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(...color) });
  }
  await fs.writeFile(file, await pdf.save());
}

// A 240 × 120 px magenta PNG tagged at 120 DPI, therefore 2 × 1 inches.
function imageFixture() {
  const crc32 = data => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(240); header.writeUInt32BE(120, 4); header[8] = 8; header[9] = 2;
  const density = Buffer.alloc(9); density.writeUInt32BE(4724); density.writeUInt32BE(4724, 4); density[8] = 1;
  const pixels = Buffer.alloc(120 * (1 + 240 * 3));
  for (let y = 0; y < 120; y++) for (let x = 0; x < 240; x++) {
    const index = y * (1 + 240 * 3) + 1 + x * 3; pixels[index] = 210; pixels[index + 1] = 35; pixels[index + 2] = 200;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('pHYs', density), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = path.join(output, '纸张预览样例'); await fs.mkdir(fixture);
  await writePdf(path.join(fixture, '1_纸张效果.pdf'));
  await fs.writeFile(path.join(fixture, '2_120dpi图片.png'), imageFixture());
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') }; delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 60000 });
  const report = { passed: false, actualPrinting: false, screenshots: [] };
  let page;
  try {
    page = await electron.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#qp-file-count').waitFor();
    await page.waitForFunction(() => document.querySelector('#qp-printer')?.options.length > 0 && document.querySelector('#qp-printer').options[0].textContent !== '正在读取打印机…', null, { timeout: 60000 });
    await electron.evaluate(({ ipcMain, BrowserWindow, dialog }, { directory, name }) => {
      const qa = globalThis.__queueprintQA; if (!qa) throw new Error('Isolated QA process required.');
      globalThis.__paperPreviewQA = { reads: {}, layouts: [], failGeometry: false, holdGeometry: false, pendingGeometry: [], printCalls: 0 };
      for (const channel of ['qp:file-bytes', 'qp:printers', 'qp:page-layout', 'qp:print']) ipcMain.removeHandler(channel);
      ipcMain.handle('qp:file-bytes', (_event, id) => { const state = globalThis.__paperPreviewQA; state.reads[id] = (state.reads[id] || 0) + 1; return qa.registry.bytes(id); });
      const papers = [{ name: 'A4', kind: 'A4', width: 827, height: 1169 }, { name: 'A3', kind: 'A3', width: 1169, height: 1654 }, { name: 'A5', kind: 'A5', width: 583, height: 827 }, { name: 'Legal', kind: 'Legal', width: 850, height: 1400 }];
      ipcMain.handle('qp:printers', () => [{ name, isDefault: true, color: true, duplex: true, paperSizes: papers }]);
      ipcMain.handle('qp:page-layout', async (_event, request) => {
        const state = globalThis.__paperPreviewQA; state.layouts.push(request);
        if (state.failGeometry) throw new Error('Generated driver geometry unavailable fixture');
        if (state.holdGeometry) await new Promise(resolve => state.pendingGeometry.push(resolve));
        const paper = papers.find(p => p.kind === request.settings.paper) || papers[0];
        const landscape = request.settings.orientation === 'landscape';
        const width = landscape ? paper.height : paper.width, height = landscape ? paper.width : paper.height;
        return { paper: { width, height }, printableArea: { x: 25, y: 25, width: width - 50, height: height - 50 }, landscape, dimensionUnit: 'hundredths-inch' };
      });
      ipcMain.handle('qp:print', () => { globalThis.__paperPreviewQA.printCalls++; throw new Error('Actual printing is disabled in this QA.'); });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      BrowserWindow.getAllWindows()[0].showInactive();
    }, { directory: fixture, name: printerName });
    await page.locator('[data-action="refresh-printers"]').click();
    await page.locator(`#qp-printer option[value="${printerName}"]`).waitFor({ state: 'attached' });
    await page.locator('[data-action="import-folder"]').first().click();
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '2', null, { timeout: 60000 });
    await page.locator('[data-scope="batch"]').click();
    await page.locator('[data-setting="color"]').selectOption('color');
    await page.locator('[data-action="view-preview"]').click();

    const content = page.locator('#qp-preview-content'), view = page.locator('#qp-preview-view');
    const picker = page.locator('#qp-preview-file-select');
    const options = await picker.locator('option').evaluateAll(nodes => nodes.filter(node => node.value).map(node => ({ id: node.value, name: node.textContent })));
    const pdfId = options.find(option => option.name.endsWith('.pdf')).id, imageId = options.find(option => option.name.endsWith('.png')).id;
    async function settled() {
      await page.waitForFunction(() => {
        const view = document.querySelector('#qp-preview-view');
        return view.dataset.loading === 'false' && !view.dataset.error && !document.querySelector('#qp-preview-content').hidden;
      }, null, { timeout: 30000 });
    }
    async function geometry(expected) {
      await page.waitForFunction(expected => {
        const view = document.querySelector('#qp-preview-view'), values = document.querySelector('#qp-preview-content').dataset;
        return view.dataset.loading === 'false' && Object.entries(expected).every(([key, value]) => Math.abs(Number(values[key]) - value) < 0.2);
      }, expected, { timeout: 30000 });
      return content.evaluate(element => ({ ...element.dataset }));
    }
    async function setting(key, value) { await page.locator(`[data-setting="${key}"]`).selectOption(value); await settled(); }
    async function pageNumber(number) { await fitWholeSheet(); await page.locator('#qp-preview-page-number').fill(String(number)); await page.locator('#qp-preview-page-number').press('Tab'); await page.waitForFunction(number => document.querySelector('#qp-preview-view').dataset.loading === 'false' && Number(document.querySelector('#qp-preview-view').dataset.page) === number, number); }
    async function fitWholeSheet() {
      await page.waitForFunction(() => {
        const view = document.querySelector('#qp-preview-view'), stage = document.querySelector('#qp-paper-stage'), content = document.querySelector('#qp-preview-content'), css = getComputedStyle(stage);
        const width = content.getBoundingClientRect().width, height = content.getBoundingClientRect().height;
        const availableWidth = stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), availableHeight = stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        return view.dataset.loading === 'false' && view.dataset.zoomMode === 'page' && width <= availableWidth + 2 && height <= availableHeight + 2 && (Math.abs(width - availableWidth) < 2 || Math.abs(height - availableHeight) < 2) && stage.scrollWidth <= stage.clientWidth + 2 && stage.scrollHeight <= stage.clientHeight + 2;
      }, null, { timeout: 30000 });
    }
    async function pixelAt(x, y) {
      return page.locator('#qp-pdf-canvas').evaluate((canvas, { x, y }) => [...canvas.getContext('2d').getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data].slice(0, 3), { x, y });
    }
    async function screenshot(name) { const target = path.join(output, name + '.png'); await page.screenshot({ path: target }); report.screenshots.push(path.relative(root, target).replaceAll('\\', '/')); }

    await settled();
    assert.equal(await page.locator('#qp-preview-mode').inputValue(), 'print', 'First preview must show the configured print sheet.');
    assert.equal(await view.getAttribute('data-zoom-mode'), 'page', 'Whole-page fitting is the default.');
    await geometry({ paperWidth: 1169, paperHeight: 827 });
    await fitWholeSheet();
    assert.match(await page.locator('#qp-preview-sheet-info').innerText(), /A4/);
    assert.equal(await page.locator('#qp-preview-printable-area').isVisible(), true);

    // Automatic orientation must be resolved for each PDF page, not only page 1.
    await pageNumber(2); await geometry({ paperWidth: 827, paperHeight: 1169 }); await fitWholeSheet();
    await pageNumber(1); await geometry({ paperWidth: 1169, paperHeight: 827 });
    await setting('orientation', 'portrait');
    await geometry({ paperWidth: 827, paperHeight: 1169, destinationX: 25, destinationY: 390.25, destinationWidth: 777, destinationHeight: 388.5 });
    const reads = await electron.evaluate((_electron, id) => globalThis.__paperPreviewQA.reads[id], pdfId);
    const white = await pixelAt(0.5, 0.05), red = await pixelAt(0.5, 0.5);
    assert.ok(white.every(channel => channel >= 250), 'Unused sheet space must remain white.');
    assert.ok(red[0] > 180 && red[1] < 90 && red[2] < 90, 'The source must be composited at the physical sheet destination.');
    await screenshot('a4-portrait-fit');

    await setting('scale', 'actual');
    await geometry({ destinationX: 163.5, destinationY: 459.5, destinationWidth: 500, destinationHeight: 250 });
    await setting('scale', 'shrink');
    await geometry({ destinationWidth: 500, destinationHeight: 250 });
    await setting('scale', 'fit');
    await setting('paper', 'A3');
    await geometry({ paperWidth: 1169, paperHeight: 1654, destinationX: 25, destinationY: 547.25, destinationWidth: 1119, destinationHeight: 559.5 });
    await fitWholeSheet();
    assert.equal(await electron.evaluate((_electron, id) => globalThis.__paperPreviewQA.reads[id], pdfId), reads, 'Paper, direction and scale changes must reuse source bytes.');

    // ResizeObserver must recalculate both dimensions without resetting layout.
    const originalSize = await content.boundingBox();
    await page.locator('#qp-paper-stage').evaluate(stage => {
      const height = Math.max(80, stage.clientHeight - 80);
      stage.style.width = Math.max(180, stage.clientWidth - 100) + 'px'; stage.style.height = height + 'px'; stage.style.flex = `0 0 ${height}px`; stage.style.alignSelf = 'flex-start';
    });
    await fitWholeSheet();
    const smallerSize = await content.boundingBox();
    assert.ok(smallerSize.width < originalSize.width - 5 || smallerSize.height < originalSize.height - 5, 'Whole-sheet fit must follow the available preview viewport.');
    await geometry({ paperWidth: 1169, paperHeight: 1654, destinationWidth: 1119, destinationHeight: 559.5 });
    await page.locator('#qp-paper-stage').evaluate(stage => { stage.style.width = ''; stage.style.height = ''; stage.style.flex = ''; stage.style.alignSelf = ''; });
    await fitWholeSheet();
    const bounds = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; const bounds = window.getBounds(); window.setSize(1000, 720, false); return bounds; });
    await page.waitForFunction(() => window.innerWidth <= 1000);
    await fitWholeSheet();
    assert.ok(await page.locator('#qp-paper-stage').evaluate(stage => stage.clientHeight >= 160), 'Preview must retain useful paper space at the supported minimum window size.');
    await screenshot('minimum-window-whole-sheet');
    await electron.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds, false), bounds);
    await fitWholeSheet();

    // Oversized actual-size pages must clip at the hardware printable boundary.
    await setting('paper', 'A4'); await setting('scale', 'actual'); await pageNumber(3);
    await geometry({ paperWidth: 827, paperHeight: 1169, destinationX: -586.5, destinationY: 84.5, destinationWidth: 2000, destinationHeight: 1000 });
    const edge = await pixelAt(10 / 827, 0.5), blue = await pixelAt(0.5, 0.5);
    assert.ok(edge.every(channel => channel >= 250), 'Content outside the hardware printable region must be clipped.');
    assert.ok(blue[2] > 180 && blue[0] < 90, 'Oversized page center must still render.');
    assert.match(await page.locator('#qp-preview-print-note').innerText(), /裁|截|超出/);
    await screenshot('a4-actual-size-clipped');

    await picker.selectOption(imageId); await settled();
    await page.locator('[data-scope="batch"]').click();
    await geometry({ paperWidth: 827, paperHeight: 1169, destinationWidth: 200, destinationHeight: 100 });
    assert.equal(await page.locator('#qp-pdf-canvas').isVisible(), true, 'Image sheet preview uses the same white-paper compositor.');
    const imageReads = await electron.evaluate((_electron, id) => globalThis.__paperPreviewQA.reads[id], imageId);
    await setting('scale', 'fit');
    await geometry({ destinationWidth: 777, destinationHeight: 388.5 });
    await page.locator('#qp-preview-mode').selectOption('source'); await settled();
    assert.equal(await page.locator('#qp-image-preview').isVisible(), true);
    assert.equal(await page.locator('#qp-preview-printable-area').isVisible(), false);
    const sourceSize = await content.boundingBox(); assert.ok(Math.abs(sourceSize.width / sourceSize.height - 2) < .01, 'Source mode retains original image aspect ratio.');
    await page.locator('#qp-preview-mode').selectOption('print'); await settled();
    await geometry({ paperWidth: 827, paperHeight: 1169, destinationWidth: 777, destinationHeight: 388.5 });
    assert.equal(await electron.evaluate((_electron, id) => globalThis.__paperPreviewQA.reads[id], imageId), imageReads, 'Switching sheet/source views must reuse image bytes.');

    // File-level paper overrides must display for that file and not leak to others.
    await page.locator('[data-scope="file"]').click(); await setting('paper', 'A3');
    await geometry({ paperWidth: 1169, paperHeight: 1654 });
    await picker.selectOption(pdfId); await settled();
    await geometry({ paperWidth: 827, paperHeight: 1169 });
    await picker.selectOption(imageId); await settled();
    await geometry({ paperWidth: 1169, paperHeight: 1654 });

    // A driver query failure keeps a useful sheet fallback and labels unknown margins.
    await electron.evaluate(() => { globalThis.__paperPreviewQA.failGeometry = true; });
    await setting('paper', 'A5');
    await geometry({ paperWidth: 583, paperHeight: 827 });
    assert.match(await page.locator('#qp-preview-print-note').innerText(), /边距|可打印区域/);
    await fitWholeSheet();

    // Keep a driver response pending until source mode is completely visible.
    // This proves cancellation without relying on fast/slow CI wall-clock timing.
    await electron.evaluate(() => { globalThis.__paperPreviewQA.failGeometry = false; globalThis.__paperPreviewQA.holdGeometry = true; });
    await page.locator('[data-setting="paper"]').selectOption('Legal');
    await page.waitForFunction(() => document.querySelector('#qp-preview-view').dataset.loading === 'true');
    assert.equal(await electron.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (!globalThis.__paperPreviewQA.pendingGeometry.length) {
        if (Date.now() > deadline) throw new Error('Held driver query did not arrive.');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      return globalThis.__paperPreviewQA.pendingGeometry.length;
    }), 1);
    await page.locator('#qp-preview-mode').selectOption('source'); await settled();
    assert.equal(await page.locator('#qp-image-preview').isVisible(), true, 'Pending driver lookup must not block source mode.');
    assert.equal(await electron.evaluate(() => globalThis.__paperPreviewQA.pendingGeometry.length), 1, 'Source mode must settle before the driver response resolves.');
    await electron.evaluate(() => { const state = globalThis.__paperPreviewQA; state.holdGeometry = false; state.pendingGeometry.splice(0).forEach(resolve => resolve()); });
    await page.locator('#qp-preview-mode').selectOption('print'); await settled();
    await geometry({ paperWidth: 850, paperHeight: 1400 }); await fitWholeSheet();
    assert.equal(await electron.evaluate(() => globalThis.__paperPreviewQA.printCalls), 0);
    assert.deepEqual(errors, []);
    await screenshot('paper-preview');
    Object.assign(report, { passed: true, defaultWholeSheet: true, perPageAutomaticOrientation: true, livePaperAndScale: true, hardwareMarginsAndClipping: true, imageDpi: true, fileOverrideIsolation: true, sourceMode: true, resize: true, minimumWindow: true, driverFallback: true, slowDriverCancellation: true, sourceBytesReused: true, pageErrors: errors });
    console.log(JSON.stringify({ passed: true, actualPrinting: false, screenshots: report.screenshots }));
  } catch (error) {
    report.failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
    if (page) { const screenshot = path.join(output, 'failure.png'); await page.screenshot({ path: screenshot }).catch(() => {}); report.screenshots.push(path.relative(root, screenshot).replaceAll('\\', '/')); }
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
