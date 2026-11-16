const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const playwrightPath = process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright';
const { _electron } = require(playwrightPath);
const root = path.resolve(__dirname, '..');

(async () => {
  const output = path.join(root, '.qa'); await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 45_000 });
  try {
    const page = await electron.firstWindow(); const errors = [], consoleErrors = [];
    await electron.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].showInactive(); });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.locator('#qp-file-count').waitFor();
    await page.waitForFunction(() => document.querySelector('#qp-printer').options[0]?.textContent !== '正在读取打印机…', { timeout: 60_000 });
    assert.equal(await page.locator('#qp-file-count').innerText(), '0');
    const printers = await page.locator('#qp-printer option').allTextContents();
    await page.screenshot({ path: path.join(output, 'desktop-empty.png') });
    const importPath = path.join(root, '.qa/fixtures/样例材料');
    await electron.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, importPath);
    await page.locator('[data-action="import-folder"]').first().click();
    await page.waitForFunction(() => Number(document.querySelector('#qp-file-count').textContent) >= 6, { timeout: 60_000 });
    const names = await page.locator('.qp-file-name').allTextContents();
    assert.deepEqual(names.slice(0, 3), ['1_审批单.pdf', '2_发票.pdf', '10_附件.pdf']);
    assert.equal(await page.locator('#qp-total-pages').innerText(), '12');
    await page.locator('[data-action="view-preview"]').click();
    await page.locator('#qp-preview-mode').selectOption('source');
    await page.locator('#qp-pdf-canvas').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('#qp-preview-view').dataset.loading === 'false');
    const canvas = await page.locator('#qp-pdf-canvas').evaluate((element) => ({ width: element.width, height: element.height }));
    assert.ok(canvas.width > 50 && canvas.height > 50);
    const fitWidth = await page.locator('#qp-paper-stage').evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(fitWidth.scroll <= fitWidth.width + 1, 'fit-to-width preview must not overflow horizontally');
    await page.screenshot({ path: path.join(output, 'desktop-preview.png') });
    await page.locator('[data-action="view-list"]').click();
    await page.locator('.qp-file-open').filter({ hasText: '1_图片.png' }).click();
    await page.locator('[data-action="view-preview"]').click();
    await page.locator('#qp-image-preview').waitFor({ state: 'visible' });
    await page.locator('#qp-preview-actual-size').click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#qp-image-preview').getBoundingClientRect().width - 512) < 1);
    await page.locator('[data-action="view-list"]').click();
    await page.locator('#qp-printer').selectOption({ label: printers.find((name) => name.includes('Microsoft Print to PDF')) || printers[0] });
    await page.locator('[data-action="confirm-print"]').click();
    await page.locator('#qp-dialog-title').filter({ hasText: '确认' }).waitFor();
    assert.ok(await page.locator('[data-action="submit-print"]').isVisible());
    await page.screenshot({ path: path.join(output, 'desktop-confirm.png') });
    // Deliberately never click submit-print: this test must not send a physical job.
    await page.locator('[data-action="close-dialog"]').first().click();
    await page.locator('#qp-sort').selectOption('reverse');
    const reversed = await page.locator('.qp-file-name').allTextContents();
    assert.equal(reversed.at(-1), '1_审批单.pdf');
    await page.locator('#qp-sort').selectOption('natural');
    await page.screenshot({ path: path.join(output, 'desktop-list.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors.filter((message) => !message.includes('DevTools')), []);
    const report = { passed: true, printers, files: names, pages: 12, preview: canvas, imagePreview: true, pageErrors: errors, consoleErrors, actualPrinting: false };
    await fs.writeFile(path.join(output, 'desktop-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await electron.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
