/** Actual Electron UI regression with synthetic progress. Never invokes native print. */
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { _electron } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'progress', randomUUID());

(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = path.join(output, '进度示例'); await fs.mkdir(fixture);
  const pdf = await PDFDocument.create(); pdf.addPage([300, 400]).drawText('Synthetic progress fixture', { x: 20, y: 340, size: 16 });
  const bytes = await pdf.save();
  await Promise.all(Array.from({ length: 115 }, (_, index) => fs.writeFile(path.join(fixture, `${String(index + 1).padStart(3, '0')}_材料.pdf`), bytes)));
  const env = { ...process.env, QUEUEPRINT_QA: '1', QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') }; delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: process.env.QUEUEPRINT_QA_EXE || require('electron'), args: process.env.QUEUEPRINT_QA_EXE ? [] : [root], env, timeout: 60000 });
  const report = { passed: false, actualPrinting: false, syntheticProgress: true, screenshots: [] };
  try {
    const page = await electron.firstWindow(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#qp-printer')?.options[0]?.textContent !== '正在读取打印机…');
    await electron.evaluate(({ ipcMain, BrowserWindow, dialog }, fixturePath) => {
      // Replace the real submission handler BEFORE any UI print confirmation.
      globalThis.__queueprintProgressMock = { submissions: [], batchId: null, controlCalls: [] };
      ipcMain.removeHandler('qp:print');
      ipcMain.handle('qp:print', (_event, plan) => {
        const mock = globalThis.__queueprintProgressMock;
        mock.submissions.push(plan); mock.batchId = 'qa-progress-' + mock.submissions.length;
        return { batchId: mock.batchId };
      });
      for (const channel of ['qp:pause', 'qp:resume', 'qp:stop']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => { globalThis.__queueprintProgressMock.controlCalls.push(channel); return { mocked: true }; });
      }
      ipcMain.removeHandler('qp:printers');
      ipcMain.handle('qp:printers', () => [{ name: 'QueuePrint 示例打印机', isDefault: true, color: true, duplex: true, paperSizes: [{ name: 'A4', kind: 'A4' }] }]);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] });
      BrowserWindow.getAllWindows()[0].showInactive();
    }, fixture);
    await page.locator('[data-action="refresh-printers"]').click();
    await page.locator('#qp-printer option[value="QueuePrint 示例打印机"]').waitFor({ state: 'attached' });
    console.log('Progress QA: synthetic printer ready.');
    await page.locator('[data-action="import-folder"]').first().click();
    await page.waitForFunction(() => document.querySelector('#qp-file-count').textContent === '115', { timeout: 60000 });
    console.log('Progress QA: 115 synthetic files imported.');
    await page.locator('input[data-file-copies]').first().fill('2'); await page.locator('input[data-file-copies]').first().press('Tab');
    await page.locator('[data-action="confirm-print"]').click(); await page.locator('[data-action="submit-print"]').click();
    await page.locator('#qp-file-progress-bar').waitFor();
    assert.equal(await page.locator('#qp-processed-files').innerText(), '0 / 115');
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '0 / 115');
    assert.equal(await page.locator('#qp-processed-units').innerText(), '0 / 116');
    assert.equal(await page.locator('[data-progress-file]').count(), 100);
    assert.match(await page.locator('#qp-progress-list-more').innerText(), /15/);
    assert.equal(await page.locator('#qp-windows-details').evaluate(element => element.open), false);
    const captured = await electron.evaluate(() => {
      const mock = globalThis.__queueprintProgressMock;
      const plan = mock.submissions.at(-1);
      return { batchId: mock.batchId, taskCount: plan.tasks.length, units: plan.units };
    });
    assert.equal(captured.taskCount, 1, 'multiple files must remain in one Windows task in this scenario');
    const byFile = new Map();
    for (const unit of captured.units) {
      if (!byFile.has(unit.fileId)) byFile.set(unit.fileId, { fileId: unit.fileId, name: unit.name, relativePath: unit.relativePath, totalUnits: 0, processedUnits: 0, submittedUnits: 0, uncertainUnits: 0 });
      byFile.get(unit.fileId).totalUnits++;
    }
    const sourceFiles = [...byFile.values()], firstFile = sourceFiles[0], secondFile = sourceFiles[1];
    function packet(overrides = {}) { return { batchId: captured.batchId, status: 'running', taskIndex: 0, totalTasks: 1, taskCount: 1, totalFiles: 115, submittedFiles: 0, totalUnits: 116, submittedUnits: 0, processedFiles: 0, processedUnits: 0, processedPages: 0, totalPages: 116, fileProgressLimit: 100, fileProgress: sourceFiles.slice(0, 100).map(item => ({ ...item })), currentFile: null, jobs: [], ...overrides }; }
    async function emit(value) { await electron.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('qp:print-progress', event), value); await page.waitForTimeout(80); }
    async function screenshot(name) { await page.screenshot({ path: path.join(output, name), animations: 'disabled', scale: 'css' }); report.screenshots.push(path.relative(root, path.join(output, name)).replaceAll('\\', '/')); }

    await emit(packet({ processedUnits: 1, processedPages: 1, fileProgress: sourceFiles.slice(0, 100).map((item, index) => ({ ...item, processedUnits: index === 0 ? 1 : 0 })), currentFile: { ...firstFile, copyIndex: 2, processedPages: 0, contentPages: 1, blank: false, setIndex: 1 } }));
    assert.equal(await page.locator('#qp-processed-files').innerText(), '0 / 115', 'one of two copies must not complete a source file');
    assert.equal(await page.locator('#qp-processed-units').innerText(), '1 / 116');
    assert.match(await page.locator('#qp-current-file-pages').innerText(), /2 \/ 2 份/);
    assert.equal(await page.locator('[data-progress-file]').first().getAttribute('data-state'), 'running');
    await emit(packet({ processedUnits: 1, processedPages: 1, fileProgress: sourceFiles.slice(0, 100).map((item, index) => ({ ...item, processedUnits: index === 0 ? 1 : 0 })), currentFile: { ...secondFile, copyIndex: 1, processedPages: 0, contentPages: 1, blank: false, setIndex: 1 } }));
    assert.equal(await page.locator('[data-progress-file]').first().getAttribute('data-state'), 'partial-processed');
    assert.equal(await page.locator('[data-progress-file]').first().locator('.qp-progress-file-state').innerText(), '部分已处理');
    await emit(packet({ processedUnits: 1, processedPages: 1, submittedUnits: 1, fileProgress: sourceFiles.slice(0, 100).map((item, index) => ({ ...item, processedUnits: index === 0 ? 1 : 0, submittedUnits: index === 0 ? 1 : 0 })), currentFile: { ...secondFile, copyIndex: 1, processedPages: 0, contentPages: 1, blank: false, setIndex: 2 }, jobs: [{ jobId: 9000, status: 'submitted' }] }));
    assert.equal(await page.locator('[data-progress-file]').first().getAttribute('data-state'), 'partial-submitted');
    assert.equal(await page.locator('[data-progress-file]').first().locator('.qp-progress-file-state').innerText(), '部分已提交');
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '0 / 115');
    assert.match(await page.locator('#qp-windows-task-count').textContent(), /1 \/ 1 已确认提交/);
    await page.locator('#qp-windows-details').evaluate(element => { element.open = true; });
    const before = await page.locator('#qp-progress-list').evaluate(element => { element.scrollTop = 90; window.__queueprintProgressList = element; return element.scrollTop; });
    await emit(packet({ processedFiles: 1, processedUnits: 2, processedPages: 2, fileProgress: sourceFiles.slice(0, 100).map((item, index) => ({ ...item, processedUnits: index === 0 ? 2 : 0 })), currentFile: { ...secondFile, copyIndex: 1, processedPages: 0, contentPages: 1, blank: false, setIndex: 1 } }));
    assert.equal(await page.locator('#qp-processed-files').innerText(), '1 / 115');
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '0 / 115');
    assert.equal(await page.locator('[data-progress-file]').first().getAttribute('data-state'), 'processed');
    assert.equal(await page.locator('[data-progress-file]').first().locator('.qp-progress-file-state').innerText(), '已处理待提交');
    assert.equal(await page.locator('#qp-windows-details').evaluate(element => element.open), true);
    assert.deepEqual(await page.locator('#qp-progress-list').evaluate(element => ({ sameNode: window.__queueprintProgressList === element, scroll: element.scrollTop })), { sameNode: true, scroll: before });
    await page.locator('#qp-windows-details').evaluate(element => { element.open = false; });
    await page.locator('#qp-progress-list').evaluate(element => { element.scrollTop = 0; });
    await screenshot('file-processing.png');

    // Native completion events clear currentFile before the next document starts.
    // Those boundaries must not collapse the status card or move the dialog/list.
    await page.locator('#qp-windows-details').evaluate(element => { element.open = true; });
    const baseline = await page.evaluate(() => {
      const list = document.querySelector('#qp-progress-list'); list.scrollTop = 160;
      window.__queueprintStableProgress = { list, row: list.firstElementChild, paperOption: document.querySelector('[data-setting="paper"] option') };
      const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { dialog: bounds('.qp-dialog'), list: bounds('#qp-progress-list'), actions: bounds('#qp-dialog-actions'), scrollTop: list.scrollTop };
    });
    const boundaryProgress = sourceFiles.slice(0, 100).map((item, index) => ({ ...item, processedUnits: index === 0 ? 2 : 0 }));
    for (let index = 0; index < 12; index++) {
      await emit(packet({ processedFiles: 1, processedUnits: 2, processedPages: 2, fileProgress: boundaryProgress, currentFile: index % 2 ? null : { ...secondFile, copyIndex: 1, processedPages: 0, contentPages: 1, blank: false, setIndex: index + 1 } }));
      const frame = await page.evaluate(() => {
        const refs = window.__queueprintStableProgress, list = document.querySelector('#qp-progress-list');
        const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { dialog: bounds('.qp-dialog'), list: bounds('#qp-progress-list'), actions: bounds('#qp-dialog-actions'), scrollTop: list.scrollTop, sameList: refs.list === list, sameRow: refs.row === list.firstElementChild, samePaperOption: refs.paperOption === document.querySelector('[data-setting="paper"] option'), expanded: document.querySelector('#qp-windows-details').open, idle: document.querySelector('#qp-current-file').dataset.idle };
      });
      for (const element of ['dialog', 'list', 'actions']) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(frame[element][key] - baseline[element][key]) < 1, `${element}.${key} moved at document boundary ${index}: ${frame[element][key]} vs ${baseline[element][key]}`);
      assert.equal(frame.scrollTop, baseline.scrollTop, 'progress updates must retain the viewed list position');
      assert.equal(frame.sameList && frame.sameRow && frame.samePaperOption && frame.expanded, true, 'progress must retain queue DOM, printer options, and expanded Windows details');
      assert.equal(frame.idle, String(Boolean(index % 2)));
    }
    // Check a burst is coalesced without losing its final progress state.
    await electron.evaluate(({ BrowserWindow }, events) => { const contents = BrowserWindow.getAllWindows()[0].webContents; for (const event of events) contents.send('qp:print-progress', event); }, Array.from({ length: 30 }, (_, index) => packet({ processedPages: index === 29 ? 5 : 2, currentFile: index === 29 ? { ...secondFile, copyIndex: 1, processedPages: 1, contentPages: 1, blank: false, setIndex: 30 } : null })));
    await page.waitForFunction(() => document.querySelector('#qp-current-file-pages')?.textContent.includes('第 30 套'));
    assert.equal(await page.locator('#qp-processed-pages').innerText(), '5 / 116');
    await page.locator('#qp-windows-details').evaluate(element => { element.open = false; });
    await page.locator('#qp-progress-list').evaluate(element => { element.scrollTop = 0; });

    await page.locator('#qp-pause-progress-button').click();
    await emit(packet({ status: 'paused' }));
    assert.equal(await page.locator('#qp-pause-progress-button').getAttribute('data-action'), 'resume-print');
    assert.equal(await page.locator('#qp-pause-progress-button').isEnabled(), true);
    assert.equal(await page.locator('[data-setting="paper"]').isDisabled(), true);
    assert.match(await page.locator('#qp-batch-status').innerText(), /已暂停/);
    await page.locator('#qp-pause-progress-button').click();
    await emit(packet({ status: 'running' }));
    assert.equal(await page.locator('#qp-pause-progress-button').getAttribute('data-action'), 'pause-print');
    assert.match(await page.locator('#qp-batch-status').innerText(), /正在有序提交/);

    const processed = sourceFiles.slice(0, 100).map(item => ({ ...item, processedUnits: item.totalUnits }));
    await page.locator('#qp-close-progress-button').click();
    await emit(packet({ processedFiles: 115, processedUnits: 116, processedPages: 116, fileProgress: processed }));
    assert.equal(await page.locator('#qp-overlay').isHidden(), true, 'background progress must not reopen a closed queue');
    await page.locator('[data-action="show-queue"]').click();
    assert.equal(await page.locator('#qp-file-progress-percent').innerText(), '100%');
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '0 / 115');
    assert.match(await page.locator('#qp-progress-feedback').innerText(), /等待 Windows 确认/);
    assert.equal(await page.locator('#qp-current-file').isVisible(), true, 'idle status keeps its layout slot between documents');
    assert.equal(await page.locator('#qp-current-file').getAttribute('data-idle'), 'true');
    await screenshot('processed-waiting-for-confirmation.png');

    await page.locator('#qp-close-progress-button').click();
    await emit(packet({ status: 'failed', processedFiles: 115, processedUnits: 116, processedPages: 116, fileProgress: processed.map(item => ({ ...item, uncertainUnits: item.totalUnits })), needsConfirmation: true, message: '模拟 EndDoc 失败：本作业的提交状态待核对。', error: 'QA_SUBMISSION_UNCERTAIN' }));
    assert.equal(await page.locator('#qp-overlay').isVisible(), true, 'failure must reopen the queue even when no frame was scheduled');
    assert.equal(await page.locator('#qp-file-progress-percent').innerText(), '100%');
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '0 / 115');
    assert.equal(await page.locator('#qp-progress-feedback').getAttribute('class').then(value => value.includes('is-error')), true);
    assert.equal(await page.locator('[data-progress-file][data-state="uncertain"]').count(), 100);
    assert.ok(!(await page.locator('#qp-dialog-body').innerText()).includes('全部文件已确认提交'));
    await screenshot('processing-complete-submission-uncertain.png');

    await page.locator('#qp-close-progress-button').click();
    await page.locator('[data-action="confirm-print"]').click(); await page.locator('[data-action="submit-print"]').click();
    await page.waitForFunction(() => document.querySelector('#qp-processed-files')?.textContent === '0 / 115');
    captured.batchId = await electron.evaluate(() => globalThis.__queueprintProgressMock.batchId);
    await emit(packet({ status: 'submitted', taskIndex: 1, processedFiles: 115, submittedFiles: 115, processedUnits: 116, submittedUnits: 116, processedPages: 116, fileProgress: processed.map(item => ({ ...item, submittedUnits: item.totalUnits })), jobs: [{ jobId: 9001, documentName: 'QueuePrint_QA_JOB_ONLY', status: 'submitted' }] }));
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '115 / 115');
    assert.equal(await page.locator('[data-progress-file][data-state="submitted"]').count(), 100);
    assert.equal(await page.locator('#qp-windows-details').evaluate(element => element.open), false);
    assert.ok(!(await page.locator('#qp-dialog-body').innerText()).includes('QueuePrint_QA_JOB_ONLY'));
    await screenshot('files-submitted.png');
    await page.locator('#qp-windows-details').evaluate(element => { element.open = true; });
    assert.equal(await page.locator('.qp-windows-job-state').innerText(), '已提交');
    assert.match(await page.locator('#qp-windows-jobs').innerText(), /9001/);

    // A twelve-file terminal list reproduces the reported screen without using
    // the user's names, documents, printer, or real submission handlers.
    await page.locator('#qp-close-progress-button').click();
    await page.locator('input[data-file-copies]').first().fill('1'); await page.locator('input[data-file-copies]').first().press('Tab');
    await page.locator('#qp-check-all').uncheck();
    for (let index = 0; index < 12; index++) await page.locator('input[data-check-file]').nth(index).check();
    await page.locator('[data-action="confirm-print"]').click(); await page.locator('[data-action="submit-print"]').click();
    await page.waitForFunction(() => document.querySelector('#qp-processed-files')?.textContent === '0 / 12');
    captured.batchId = await electron.evaluate(() => globalThis.__queueprintProgressMock.batchId);
    const twelve = sourceFiles.slice(0, 12).map(item => ({ ...item, totalUnits: 1, processedUnits: 1, submittedUnits: 1 }));
    const startingBounds = await page.locator('.qp-dialog').boundingBox();
    const terminal = packet({ status: 'submitted', taskIndex: 3, totalTasks: 3, taskCount: 3, totalFiles: 12, submittedFiles: 12, totalUnits: 12, submittedUnits: 12, processedFiles: 12, processedUnits: 12, processedPages: 12, totalPages: 12, fileProgress: twelve, jobs: [9002, 9003, 9004].map(jobId => ({ jobId, documentName: 'QueuePrint_QA_JOB_ONLY', status: 'submitted' })) });
    await emit(terminal);
    assert.equal(await page.locator('#qp-submitted-files').innerText(), '12 / 12');
    assert.equal(await page.locator('[data-progress-file]').count(), 12);
    assert.equal(await page.locator('#qp-windows-details').evaluate(element => element.open), false);
    assert.equal(await page.locator('#qp-stop-progress-button').isHidden(), true);
    assert.equal(await page.locator('#qp-pause-progress-button').isHidden(), true);
    assert.equal(await page.locator('#qp-close-progress-button').isVisible(), true);
    const terminalBounds = await page.locator('.qp-dialog').boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(startingBounds[key] - terminalBounds[key]) < 1, `terminal transition changed dialog.${key}`);
    assert.match(await page.locator('#qp-announcement').innerText(), /所有任务已提交/);
    await page.locator('#qp-progress-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await screenshot('twelve-files-submitted.png');

    // The stop action remains usable after coalesced progress, and the two
    // controls are disabled while stopping then hidden when stopped.
    await page.locator('#qp-close-progress-button').click();
    await page.locator('[data-action="confirm-print"]').click(); await page.locator('[data-action="submit-print"]').click();
    await page.waitForFunction(() => document.querySelector('#qp-processed-files')?.textContent === '0 / 12');
    captured.batchId = await electron.evaluate(() => globalThis.__queueprintProgressMock.batchId);
    await emit(packet({ totalFiles: 12, totalUnits: 12, totalPages: 12, fileProgress: twelve.map(item => ({ ...item, processedUnits: 0, submittedUnits: 0 })) }));
    await page.locator('#qp-stop-progress-button').click();
    await emit({ ...terminal, batchId: captured.batchId, status: 'stopping' });
    assert.equal(await page.locator('#qp-stop-progress-button').isDisabled(), true);
    assert.equal(await page.locator('#qp-pause-progress-button').isDisabled(), true);
    await emit({ ...terminal, batchId: captured.batchId, status: 'stopped' });
    assert.equal(await page.locator('#qp-stop-progress-button').isHidden(), true);
    assert.equal(await page.locator('#qp-pause-progress-button').isHidden(), true);
    assert.match(await page.locator('#qp-batch-status').innerText(), /已停止/);
    assert.equal(await page.locator('[data-setting="paper"]').isEnabled(), true);
    assert.deepEqual(await electron.evaluate(() => globalThis.__queueprintProgressMock.controlCalls), ['qp:pause', 'qp:resume', 'qp:stop']);
    assert.deepEqual(pageErrors, []);
    report.passed = true; report.uniqueFiles = 115; report.totalUnits = 116; report.windowsTasks = 1; report.longListLimit = 100; report.expansionAndScrollPreserved = true; report.stableDocumentBoundaries = 12; report.finalBurstStateRetained = true; report.hiddenModalLatestState = true; report.pauseResumeStopControls = true; report.twelveFileTerminalGeometry = true; report.processedIsNotSubmitted = true; report.pageErrors = pageErrors;
    console.log(JSON.stringify({ passed: true, uniqueFiles: 115, totalUnits: 116, actualPrinting: false, screenshots: report.screenshots }, null, 2));
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    console.error('Progress QA failure:', error.message);
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const closed = await Promise.race([electron.close().then(() => true).catch(() => false), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed && electron.process()?.exitCode === null) electron.process().kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
