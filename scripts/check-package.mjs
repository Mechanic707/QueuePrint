import { extractFile } from '@electron/asar';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = path.resolve('.'), archive = path.join(root, 'release/win-unpacked/resources/app.asar');
const hash = (value) => createHash('sha256').update(value).digest('hex');
let checked = 0;
async function visit(directory) {
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(relative);
    else if (!entry.name.endsWith('.test.mjs')) {
      assert.equal(hash(extractFile(archive, relative)), hash(await fs.readFile(path.join(root, relative))), `Stale packaged source: ${relative}`);
      checked++;
    }
  }
}
await visit('src');
let nativeChecked = 0;
async function visitNative(directory = '') {
  for (const entry of await fs.readdir(path.join(root, 'native/publish', directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await visitNative(relative);
    else if (!entry.name.endsWith('.pdb')) {
      assert.equal(hash(await fs.readFile(path.join(root, 'native/publish', relative))), hash(await fs.readFile(path.join(root, 'release/win-unpacked/resources/native', relative))), `Missing or stale native resource: ${relative}`);
      nativeChecked++;
    }
  }
}
await visitNative();
assert.ok(nativeChecked > 0, 'Native publish directory must not be empty');
console.log(JSON.stringify({ packagedSourcesMatch: checked, nativeResourcesMatch: nativeChecked }));
