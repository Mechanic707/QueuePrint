import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRegistry } from '../src/main/files.mjs';

test('folder import retains root and nested paths, ignores unrelated formats and detects changed files', async () => {
  const qaRoot = path.resolve('.qa'), target = path.join(qaRoot, 'registry-' + randomUUID());
  await fs.mkdir(path.join(target, '材料', '子目录'), { recursive: true });
  try {
    await fs.writeFile(path.join(target, '材料', '1.pdf'), '%PDF fixture');
    await fs.writeFile(path.join(target, '材料', '子目录', '2.png'), 'fixture image');
    await fs.writeFile(path.join(target, '材料', 'skip.txt'), 'ignore');
    const registry = new FileRegistry(async (paths) => paths.map((file) => ({ path: file, pages: 1 })));
    const first = await registry.importPaths([path.join(target, '材料')], { folders: true });
    assert.deepEqual(first.files.map((f) => f.relativePath), ['材料/1.pdf', '材料/子目录/2.png']);
    const again = await registry.importPaths([path.join(target, '材料')], { folders: true });
    assert.equal(first.files[0].id, again.files[0].id);
    const loose = await registry.importPaths([first.files[0].path]);
    assert.equal(loose.files[0].relativePath, '材料/1.pdf');
    const other = path.join(target, '另一处', '材料');
    await fs.mkdir(other, { recursive: true }); await fs.writeFile(path.join(other, '1.pdf'), '%PDF other');
    const differentRoot = await registry.importPaths([other], { folders: true });
    assert.equal(differentRoot.files[0].relativePath, '材料 (2)/1.pdf');
    await fs.writeFile(first.files[0].path, 'changed content');
    await assert.rejects(registry.assertUnchanged(first.files[0].id), /文件已发生变化/);
  } finally {
    if (!path.resolve(target).startsWith(qaRoot + path.sep)) throw new Error('invalid cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
});

test('mixed folder drop keeps roots separate and deduplicates overlapping folders and loose files', async () => {
  const qaRoot = path.resolve('.qa'), target = path.join(qaRoot, 'drop-' + randomUUID());
  const rootA = path.join(target, '位置一', '材料'), rootB = path.join(target, '位置二', '材料');
  const child = path.join(rootA, '子目录'), loose = path.join(target, 'loose.jpg');
  await fs.mkdir(child, { recursive: true }); await fs.mkdir(rootB, { recursive: true });
  try {
    const fileA = path.join(rootA, '1.pdf'), ignored = path.join(target, 'skip.txt');
    await fs.writeFile(fileA, 'pdf'); await fs.writeFile(path.join(child, '2.png'), 'png');
    await fs.writeFile(path.join(rootB, '10.pdf'), 'pdf'); await fs.writeFile(loose, 'jpg'); await fs.writeFile(ignored, 'txt');
    const calls = [];
    const registry = new FileRegistry(async (paths) => { calls.push(paths); return paths.map((file) => ({ path: file, pages: 1 })); });
    const result = await registry.importDroppedPaths([rootA, child, fileA, rootB, loose, loose, ignored, path.join(target, 'missing.pdf')]);
    assert.deepEqual(result.files.map((file) => file.relativePath), ['材料/1.pdf', '材料/子目录/2.png', '材料 (2)/10.pdf', '添加的文件/loose.jpg']);
    assert.equal(new Set(result.files.map((file) => file.id)).size, 4);
    assert.equal(result.skipped, 1); assert.equal(result.warnings.length, 1); assert.equal(calls.length, 2);
    const repeated = await registry.importDroppedPaths([fileA]);
    assert.equal(repeated.files[0].id, result.files[0].id);
    assert.equal(repeated.files[0].relativePath, '材料/1.pdf');
    await assert.rejects(registry.importDroppedPaths(['relative.pdf']), /本地/);
    await assert.rejects(registry.importDroppedPaths(['https://example.com/not-local.pdf']), /本地/);
  } finally {
    if (!path.resolve(target).startsWith(qaRoot + path.sep)) throw new Error('invalid cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  }
});
