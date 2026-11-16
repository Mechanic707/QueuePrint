import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findNativeHost } from '../src/main/native-host.mjs';

async function fixtureDirectory(t, prefix) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, prefix));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith(prefix));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('native host lookup detects resources removed after a successful lookup', async (t) => {
  const root = await fixtureDirectory(t, 'queueprint-host-');
  const resources = path.join(root, 'resources');
  const host = path.join(resources, 'native', 'QueuePrint.Host.exe');
  await fs.mkdir(path.dirname(host), { recursive: true });
  await fs.writeFile(host, 'fixture');
  assert.equal(findNativeHost(root, resources, { packaged: true }), host);
  await fs.unlink(host);
  assert.throws(() => findNativeHost(root, resources, { packaged: true }), (error) => {
    assert.equal(error.code, 'NATIVE_HOST_MISSING');
    assert.equal(error.submissionStarted, false);
    assert.match(error.message, /重新打开/);
    assert.doesNotMatch(error.message, /npm/);
    return true;
  });
});

test('source startup still locates the locally built native host', async (t) => {
  const root = await fixtureDirectory(t, 'queueprint-source-host-');
  const host = path.join(root, 'native', 'publish', 'QueuePrint.Host.exe');
  await fs.mkdir(path.dirname(host), { recursive: true });
  await fs.writeFile(host, 'fixture');
  assert.equal(findNativeHost(root, path.join(root, 'electron-resources')), host);
  await fs.unlink(host);
  assert.throws(() => findNativeHost(root, path.join(root, 'electron-resources')), /npm run native:build/);
});
