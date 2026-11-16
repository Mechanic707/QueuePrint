/**
 * Exercise the FINAL portable launcher, including a second single-instance start.
 * No print, properties, or cancel command is sent. A fresh user-data directory
 * isolates this run from normal application preferences and submission history.
 *
 * Do not use Playwright's Electron launcher here: NSIS does not forward the
 * child's Node inspector announcement. Start the portable and attach over CDP.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.QUEUEPRINT_PLAYWRIGHT || 'playwright');
const { PDFDocument } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const artifact = path.resolve(process.env.QUEUEPRINT_QA_EXE || process.argv[2] || path.join(root, `release/QueuePrint-${version}-win-x64.exe`));
const output = path.join(root, '.qa', 'portable', randomUUID());
const reportPath = path.join(output, 'report.json');
const report = { artifact: path.basename(artifact), passed: false, physicalPrinting: false, stages: [] };

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
async function persist() { await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, code) { if (!value) throw new Error(code); }
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode });
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeout);
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.code || 'SPAWN_FAILED' }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code }); });
  });
}
async function stopOwnedLauncher(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  // Only PIDs obtained from this script's own spawn calls can reach this branch.
  await new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve); killer.once('close', resolve);
  });
}
function readOnlyNative(executable, request) {
  if (!['ping', 'printers', 'inspect', 'render'].includes(request.command)) throw new Error('NATIVE_COMMAND_NOT_ALLOWED');
  return new Promise(resolve => {
    const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderrPresent = false, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, code: 'NATIVE_TIMEOUT' }); }, 60000);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => { stderrPresent = true; });
    child.once('error', error => finish({ ok: false, code: error.code || 'SPAWN_FAILED' }));
    child.once('close', code => {
      const replies = stdout.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line.replace(/^\uFEFF/, ''))]; } catch { return []; } });
      finish(replies.findLast(reply => typeof reply.ok === 'boolean') || { ok: false, code: 'NO_JSON_RESPONSE', exitCode: code, stderrPresent });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request) + '\n', 'utf8');
  });
}
async function awaitCdp(port, launcher) {
  for (let attempt = 0; attempt < 150; attempt++) {
    assert(launcher.exitCode === null, 'PORTABLE_EXITED_BEFORE_CDP');
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(600) }); if (response.ok) return; } catch {}
    await delay(500);
  }
  throw new Error('PORTABLE_CDP_TIMEOUT');
}

(async () => {
  let browser, launcher, second;
  await fs.mkdir(output, { recursive: true });
  try {
    assert(process.platform === 'win32', 'WINDOWS_REQUIRED');
    assert(await exists(artifact), 'PORTABLE_ARTIFACT_MISSING');
    const fixture = path.join(output, 'sample.pdf'), png = path.join(output, 'rendered.png');
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('QueuePrint portable regression', { x: 18, y: 340, size: 15 });
    await fs.writeFile(fixture, await pdf.save());
    const env = { ...process.env, QUEUEPRINT_TEST_USER_DATA: path.join(output, 'user-data') };
    // QUEUEPRINT_QA bypasses the single-instance lock. This regression must keep
    // the real lock enabled; the explicit command whitelist above prevents print.
    delete env.QUEUEPRINT_QA; delete env.ELECTRON_RUN_AS_NODE;
    const port = await freePort();
    launcher = spawn(artifact, [`--remote-debugging-port=${port}`], { env, windowsHide: true, shell: false, stdio: 'ignore' });
    launcher.on('error', () => {});
    await awaitCdp(port, launcher);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15000 });
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.includes('/app.asar/'), { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');
    const html = fileURLToPath(page.url());
    assert(html.includes('app.asar'), 'FINAL_PACKAGED_APP_REQUIRED');
    const resources = path.dirname(path.dirname(path.dirname(path.dirname(html))));
    const relativeTemp = path.relative(os.tmpdir(), resources);
    assert(relativeTemp && !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp), 'PORTABLE_TEMP_EXTRACTION_REQUIRED');
    assert(!resources.toLowerCase().includes('win-unpacked'), 'UNPACKED_APP_NOT_ALLOWED');
    report.title = await page.title(); report.packaged = true; report.temporaryExtraction = true;
    const executable = path.join(resources, 'native', 'QueuePrint.Host.exe');
    const pdfium = path.join(resources, 'native', 'pdfium.dll');
    const client = await context.newCDPSession(page);
    async function minimize() { try { const { windowId } = await client.send('Browser.getWindowForTarget'); await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); } catch {} }
    await minimize();
    async function check(stage) {
      const result = { stage, hostExists: await exists(executable), pdfiumExists: await exists(pdfium) };
      if (result.hostExists) {
        result.ping = (await readOnlyNative(executable, { command: 'ping' })).ok;
        const printers = await readOnlyNative(executable, { command: 'printers' });
        const list = printers.data?.printers || printers.data;
        result.printers = printers.ok && Array.isArray(list); result.printerCount = result.printers ? list.length : 0;
        const inspected = await readOnlyNative(executable, { command: 'inspect', paths: [fixture] });
        result.inspect = inspected.ok && inspected.data?.files?.[0]?.pages === 1;
        const rendered = await readOnlyNative(executable, { command: 'render', paths: [fixture], outputPath: png, pageNumber: 1, renderDpi: 96 });
        result.render = rendered.ok && await exists(png) && (await fs.stat(png)).size > 0;
      }
      result.ipcBridgeAvailable = await page.evaluate(() => typeof window.queueprint?.getPrinters === 'function');
      try {
        const list = await page.evaluate(() => window.queueprint.getPrinters());
        result.ipcPrinters = Array.isArray(list); result.ipcPrinterCount = list?.length;
        if (!result.ipcPrinters) result.ipcFailure = 'UNEXPECTED_REPLY';
      } catch (error) {
        result.ipcPrinters = false;
        result.ipcFailure = !result.ipcBridgeAvailable ? 'BRIDGE_UNAVAILABLE'
          : error.message.includes('无效的应用请求') ? 'FRAME_GUARD_REJECTED'
          : error.message.includes('本地打印组件') ? 'NATIVE_COMPONENT_ERROR'
          : error.message.includes('JSON') ? 'NATIVE_PROTOCOL_ERROR'
          : error.message.includes('timeout') || error.message.includes('超时') ? 'IPC_TIMEOUT'
          : 'IPC_EXECUTION_ERROR';
      }
      report.stages.push(result); await persist();
      // Print only aggregate results. Do not print device names or private paths.
      console.log(JSON.stringify(result));
      return result;
    }
    const initial = await check('before-second-launch');
    assert(['hostExists', 'pdfiumExists', 'ping', 'printers', 'inspect', 'render', 'ipcPrinters'].every(key => initial[key]), 'INITIAL_PORTABLE_NATIVE_CHECK_FAILED');
    second = spawn(artifact, [], { env, windowsHide: true, shell: false, stdio: 'ignore' });
    const secondExit = await waitForExit(second, 75000);
    report.secondLaunch = { ...secondExit, sameUserData: true, singleInstanceEnabled: true };
    await persist();
    assert(!secondExit.timedOut && !secondExit.error && secondExit.code === 0, 'SECOND_PORTABLE_START_DID_NOT_EXIT_CLEANLY');
    await delay(1500); await minimize();
    report.originalWindowAlive = !page.isClosed();
    const after = await check('after-second-exit');
    assert(report.originalWindowAlive, 'ORIGINAL_APP_EXITED');
    assert(['hostExists', 'pdfiumExists', 'ping', 'printers', 'inspect', 'render', 'ipcPrinters'].every(key => after[key]), 'ORIGINAL_NATIVE_RESOURCES_LOST_AFTER_SECOND_EXIT');
    report.passed = true;
    console.log('PASS: final portable remains usable after a second single-instance launch.');
  } catch (error) {
    report.failure = { code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.code || error.name || 'PORTABLE_QA_FAILED' };
    process.exitCode = 1;
    console.error('FAIL:', report.failure.code);
  } finally {
    // Persist before closing the app: all evidence survives a disconnected CDP.
    await persist();
    console.log('Report:', path.relative(root, reportPath).replaceAll('\\', '/'));
    if (second && second.exitCode === null) await stopOwnedLauncher(second);
    if (browser) {
      try { const session = await browser.newBrowserCDPSession(); await Promise.race([session.send('Browser.close'), delay(2500)]); } catch {}
      await Promise.race([browser.close().catch(() => {}), delay(2500)]);
    }
    if (launcher && launcher.exitCode === null) {
      const closed = await waitForExit(launcher, 4000);
      if (closed.timedOut) await stopOwnedLauncher(launcher);
    }
  }
})().catch(error => { console.error('Portable QA failed:', error.code || error.name); process.exitCode = 1; });
