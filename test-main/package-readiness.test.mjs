import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readiness from '../scripts/ensure-native.cjs';

const { REQUIRED_NATIVE_FILES, checkNativePublish, assertNativePublish } = readiness;
const scriptPath = fileURLToPath(new URL('../scripts/ensure-native.cjs', import.meta.url));
const targetName = '.NETCoreApp,Version=v8.0/win-x64';

function temporaryPublish(t, { complete = true } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'queueprint-native-readiness-'));
  t.after(() => {
    const relative = path.relative(tempRoot, directory);
    // Verify the resolved delete target is our own explicitly named fixture.
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('queueprint-native-readiness-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (complete) {
    for (const name of REQUIRED_NATIVE_FILES) fs.writeFileSync(path.join(directory, name), 'fixture only; never execute');
    writeJson(directory, 'QueuePrint.Host.runtimeconfig.json', {
      runtimeOptions: {
        tfm: 'net8.0',
        includedFrameworks: [
          { name: 'Microsoft.NETCore.App', version: '8.0.0' },
          { name: 'Microsoft.WindowsDesktop.App', version: '8.0.0' },
        ],
      },
    });
    writeJson(directory, 'QueuePrint.Host.deps.json', {
      runtimeTarget: { name: targetName },
      targets: {
        [targetName]: {
          'QueuePrint.Host/1.0.0': { runtime: { 'QueuePrint.Host.dll': {} } },
          'runtimepack.Microsoft.NETCore.App.Runtime.win-x64/8.0.0': {
            runtime: { 'System.Private.CoreLib.dll': {} }, native: { 'coreclr.dll': {} },
          },
          'runtimepack.Microsoft.WindowsDesktop.App.Runtime.win-x64/8.0.0': {
            runtime: { 'System.Drawing.Common.dll': {} },
          },
          'bblanchon.PDFium.Win32/159.0.8152': {
            native: { 'runtimes/win-x64/native/pdfium.dll': {}, '_._': {} },
          },
        },
      },
    });
  }
  return directory;
}

function writeJson(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
}

test('complete self-contained publish passes without executing fake host files', t => {
  const directory = temporaryPublish(t);
  const result = assertNativePublish(directory);
  assert.equal(result.ok, true);
  assert.ok(result.requiredFiles.includes('pdfium.dll'));
  assert.equal(result.requiredFiles.some(name => name.startsWith('runtimes/')), false);
  const cli = spawnSync(process.execPath, [scriptPath, directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /Native component ready/);
});

test('exe-only bundle fails packaging with a specific rebuild instruction', t => {
  const directory = temporaryPublish(t, { complete: false });
  fs.writeFileSync(path.join(directory, 'QueuePrint.Host.exe'), 'fixture only; never execute');
  const result = checkNativePublish(directory);
  assert.equal(result.ok, false);
  for (const name of ['QueuePrint.Host.dll', 'pdfium.dll', 'hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'System.Private.CoreLib.dll']) {
    assert.ok(result.missing.includes(name), name);
  }
  assert.throws(() => assertNativePublish(directory), error => error.code === 'NATIVE_PUBLISH_INCOMPLETE' && /npm run native:build/.test(error.message));
  const cli = spawnSync(process.execPath, [scriptPath, directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /npm run native:build/);
});

test('dependency manifest finds missing managed assets beyond the fixed minimum', t => {
  const directory = temporaryPublish(t);
  const deps = JSON.parse(fs.readFileSync(path.join(directory, 'QueuePrint.Host.deps.json'), 'utf8'));
  deps.targets[targetName]['QueuePrint.Host/1.0.0'].runtime['lib/net8.0/Extra.Print.Dependency.dll'] = {};
  writeJson(directory, 'QueuePrint.Host.deps.json', deps);
  const result = checkNativePublish(directory);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('Extra.Print.Dependency.dll'));
  fs.writeFileSync(path.join(directory, 'Extra.Print.Dependency.dll'), 'fixture');
  assert.equal(checkNativePublish(directory).ok, true);
});

test('empty runtime files and directories cannot pass a filename-only check', t => {
  const directory = temporaryPublish(t);
  fs.writeFileSync(path.join(directory, 'hostfxr.dll'), '');
  fs.unlinkSync(path.join(directory, 'System.Private.CoreLib.dll'));
  fs.mkdirSync(path.join(directory, 'System.Private.CoreLib.dll'));
  const result = checkNativePublish(directory);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.some(item => item.file === 'hostfxr.dll' && /为空/.test(item.reason)));
  assert.ok(result.invalid.some(item => item.file === 'System.Private.CoreLib.dll' && /普通文件/.test(item.reason)));
});

test('framework-dependent configuration and corrupt dependency manifests are rejected', t => {
  const directory = temporaryPublish(t);
  writeJson(directory, 'QueuePrint.Host.runtimeconfig.json', {
    runtimeOptions: { tfm: 'net8.0', framework: { name: 'Microsoft.NETCore.App', version: '8.0.0' } },
  });
  fs.writeFileSync(path.join(directory, 'QueuePrint.Host.deps.json'), '{ incomplete');
  const result = checkNativePublish(directory);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.some(item => item.file === 'QueuePrint.Host.runtimeconfig.json' && /self-contained/.test(item.reason)));
  assert.ok(result.invalid.some(item => item.file === 'QueuePrint.Host.deps.json' && /JSON/.test(item.reason)));
});

test('wrong architecture and a truncated runtime dependency set fail before packaging', t => {
  const directory = temporaryPublish(t);
  const deps = JSON.parse(fs.readFileSync(path.join(directory, 'QueuePrint.Host.deps.json'), 'utf8'));
  delete deps.targets[targetName]['runtimepack.Microsoft.WindowsDesktop.App.Runtime.win-x64/8.0.0'];
  writeJson(directory, 'QueuePrint.Host.deps.json', deps);
  assert.ok(checkNativePublish(directory).invalid.some(item => /Microsoft.WindowsDesktop.App/.test(item.reason)));
  deps.runtimeTarget.name = '.NETCoreApp,Version=v8.0/win-arm64';
  writeJson(directory, 'QueuePrint.Host.deps.json', deps);
  assert.ok(checkNativePublish(directory).invalid.some(item => /win-x64/.test(item.reason)));
});
