import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintQueue, nativeSettings } from '../src/main/print-queue.mjs';

const files = { a: { id: 'a', name: 'A.pdf', path: 'D:/trusted/A.pdf', pages: 2 }, b: { id: 'b', name: 'B.pdf', path: 'D:/trusted/B.pdf', pages: 1 } };
const registry = { async assertUnchanged(id) { if (!files[id]) throw new Error('未导入'); return files[id]; } };
const task = (id) => ({ settings: { paper: 'A4', duplex: 'long', color: 'mono' }, segments: [{ fileId: id, path: 'D:/untrusted/replaced.pdf', pages: [1], appendBlank: true }] });
const plan = (ids) => ({ ready: true, printerName: 'Test Printer', tasks: ids.map(task) });

test('native settings preserve orientation and per-job driver data', () => {
  assert.deepEqual(nativeSettings({ duplex: 'short', orientation: 'auto', scale: 'shrink', color: 'mono', devModeBase64: 'YQ==' }), {
    duplex: 'shortEdge', scale: 'shrink', orientation: 'auto', color: false, paperSize: 'A4', devModeBase64: 'YQ==',
  });
});

test('main process replaces renderer paths with registered paths', async () => {
  const requests = [], events = [];
  const q = new PrintQueue({ registry, emit: (e) => events.push(e), runNative: async (r) => { requests.push(r); return { jobs: [{ jobId: 1 }] }; } });
  await q.submit(plan(['a', 'b'])); await q.done;
  assert.equal(requests[0].documents[0].path, files.a.path);
  assert.deepEqual(requests[0].documents[0].pages, [1]);
  assert.equal(requests[0].documents[0].appendBlank, true);
  assert.equal(events.at(-1).status, 'submitted');
  assert.equal(events.at(-1).submittedFiles, 2);
});

test('file completion waits for every planned copy', async () => {
  const events = [];
  const q = new PrintQueue({ registry, emit: (e) => events.push(e), runNative: async () => ({ jobs: [] }) });
  await q.submit(plan(['a', 'a'])); await q.done;
  const afterFirst = events.find((e) => e.taskIndex === 1);
  assert.equal(afterFirst.submittedFiles, 0);
  assert.equal(events.at(-1).submittedFiles, 1);
});

test('pause stops only later tasks and resume preserves order', async () => {
  let releaseFirst;
  const pending = new Promise((resolve) => { releaseFirst = resolve; }), calls = [];
  const q = new PrintQueue({ registry, emit() {}, runNative: async (r) => { calls.push(r); if (calls.length === 1) await pending; return { jobs: [] }; } });
  await q.submit(plan(['a', 'b'])); q.pause(); releaseFirst();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1); assert.equal(q.batch.status, 'paused');
  q.resume(); await q.done;
  assert.deepEqual(calls.map((r) => r.documents[0].fileId), ['a', 'b']);
});

test('stop never re-submits the current task', async () => {
  let releaseFirst;
  const pending = new Promise((resolve) => { releaseFirst = resolve; }), calls = [];
  const q = new PrintQueue({ registry, emit() {}, runNative: async (r) => { calls.push(r); await pending; return { jobs: [] }; } });
  await q.submit(plan(['a', 'b'])); q.stop(); releaseFirst(); await q.done;
  assert.equal(calls.length, 1); assert.equal(q.batch.status, 'stopped');
});

test('uncertain native failure requires confirmation and is never retried', async () => {
  let calls = 0;
  const q = new PrintQueue({ registry, emit() {}, runNative: async () => { calls++; throw new Error('pipe closed'); } });
  await q.submit(plan(['a', 'b'])); await q.done;
  assert.equal(calls, 1); assert.equal(q.batch.status, 'failed'); assert.equal(q.batch.needsConfirmation, true);
});

test('invalid or unknown page ranges are rejected before native printing', async () => {
  let calls = 0;
  const q = new PrintQueue({ registry, emit() {}, runNative: async () => { calls++; } });
  const invalid = plan(['b']); invalid.tasks[0].segments[0].pages = [2];
  await assert.rejects(q.submit(invalid), /页码/); assert.equal(calls, 0);
});

test('a second submission cannot enter during asynchronous file validation', async () => {
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const slowRegistry = { async assertUnchanged(id) { await pending; return files[id]; } };
  const q = new PrintQueue({ registry: slowRegistry, emit() {}, runNative: async () => { calls++; return { jobs: [] }; } });
  const first = q.submit(plan(['a']));
  await assert.rejects(q.submit(plan(['a'])), /已有批次/);
  release(); await first; await q.done;
  assert.equal(calls, 1);
});

test('stop during preparation prevents the first native submission', async () => {
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const slowRegistry = { async assertUnchanged(id) { await pending; return files[id]; } };
  const q = new PrintQueue({ registry: slowRegistry, emit() {}, runNative: async () => { calls++; } });
  const first = q.submit(plan(['a'])); q.stop(); release();
  await assert.rejects(first, /未提交任何任务/); assert.equal(calls, 0);
});
