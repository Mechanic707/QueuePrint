const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const output = path.join(root, '.qa'), fixtureRoot = path.join(output, 'fixtures/样例材料');
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'enhancement-user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 45_000 });
  try {
    const page = await electron.firstWindow(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.waitForFunction(() => document.querySelector('#qp-printer').options[0]?.textContent !== '正在读取打印机…');
    const client = await page.context().newCDPSession(page);
    const box = await page.locator('.qp-queue').boundingBox(), x = box.x + box.width / 2, y = box.y + 150;
    async function drop(files, capture = false) {
      const data = { items: [], files, dragOperationsMask: 1 };
      await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
      await client.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      if (capture) {
        await page.locator('#qp-drop-overlay').waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(output, 'drop-target.png') });
      }
      await client.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    }
    await drop([fixtureRoot], true);
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '6', { timeout: 60_000 });
    assert.ok(await page.locator('#qp-drop-overlay').isHidden());
    const names = await page.locator('.qp-file-name').allTextContents();
    assert.deepEqual(names.slice(0, 3), ['1_审批单.pdf', '2_发票.pdf', '10_附件.pdf']);
    await page.locator('[name="qp-quantity-mode"][value="sets"]').check();
    await page.locator('#qp-quantity').fill('1'); await page.locator('#qp-quantity').press('Tab');
    const first = page.locator('input[data-file-copies]').first();
    const firstId = await first.getAttribute('data-file-copies');
    const checkedBefore = await page.locator('input[data-check-file]:checked').count();
    await first.fill('3'); await first.press('Tab');
    assert.equal(await page.locator('#qp-total-pages').innerText(), '16');
    assert.equal(await page.locator('input[data-check-file]:checked').count(), checkedBefore);
    assert.equal(await page.locator('[data-scope="file"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.locator('input[data-file-copies]').evaluateAll((nodes) => nodes.map((node) => node.value)), ['3', '1', '1', '1', '1', '1']);
    await page.locator('#qp-quantity').fill('2'); await page.locator('#qp-quantity').press('Tab');
    assert.equal(await page.locator('#qp-total-pages').innerText(), '32');
    assert.match(await page.locator('#qp-file-copies-hint').innerText(), /6/);
    await page.locator('[data-action="show-order"]').click();
    const order = await page.locator('.qp-order-filename').evaluateAll((nodes) => nodes.map((node) => node.firstChild.textContent));
    assert.equal(order.length, 16);
    assert.deepEqual(order.slice(0, 3), ['1_审批单.pdf', '1_审批单.pdf', '1_审批单.pdf']);
    assert.deepEqual(order.slice(8, 11), ['1_审批单.pdf', '1_审批单.pdf', '1_审批单.pdf']);
    await page.locator('[data-action="close-dialog"]').first().click();
    const excluded = page.locator('input[data-check-file]').nth(1);
    const excludedId = await excluded.getAttribute('data-check-file');
    await excluded.uncheck();
    await drop([fixtureRoot, path.join(fixtureRoot, '01 办公用品'), path.join(fixtureRoot, '01 办公用品/1_审批单.pdf')]);
    await page.waitForFunction(() => !document.querySelector('#qp-runtime-status').textContent.includes('正在读取'), { timeout: 60_000 });
    assert.equal(await page.locator('#qp-file-count').innerText(), '6');
    assert.equal(await page.locator(`[data-file-copies="${firstId}"]`).inputValue(), '3');
    assert.equal(await page.locator(`[data-check-file="${excludedId}"]`).isChecked(), false);
    await page.locator(`[data-check-file="${excludedId}"]`).check();
    const extraRoot = path.join(output, 'drop-fixtures/另一位置/样例材料');
    const loose = path.join(output, 'drop-fixtures/单独图片.png');
    await fs.mkdir(extraRoot, { recursive: true });
    await fs.copyFile(path.join(fixtureRoot, '01 办公用品/2_发票.pdf'), path.join(extraRoot, '1_另一个文件.pdf'));
    await fs.copyFile(path.join(root, 'assets/icon.png'), loose);
    await drop([extraRoot, loose]);
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '8', { timeout: 60_000 });
    assert.match(await page.locator('#qp-tree-items').innerText(), /样例材料 \(2\)/);
    await page.locator('[name="qp-quantity-mode"][value="copies"]').check();
    assert.match(await page.locator('#qp-copies-heading').innerText(), /基础/);
    assert.match(await page.locator('#qp-sequence-hint').innerText(), /2/);
    await page.screenshot({ path: path.join(output, 'enhancements-list.png') });
    const urlBefore = page.url();
    const textData = { items: [{ mimeType: 'text/uri-list', data: 'https://example.com/' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await client.send('Input.dispatchDragEvent', { type, x, y, data: textData });
    assert.equal(page.url(), urlBefore);
    assert.equal(await page.locator('#qp-file-count').innerText(), '8');
    assert.deepEqual(errors, []);
    const report = { passed: true, nativeFolderDrop: true, mixedFolderFileDrop: true, overlappingPathsDeduplicated: true, perFileCopies: 3, batchSets: 2, pagesBeforeExtraDrop: 32, singleFileActualCopies: 6, pageErrors: errors, actualPrinting: false };
    await fs.writeFile(path.join(output, 'enhancements-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await electron.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
