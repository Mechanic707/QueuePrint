import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintQueue } from '../src/main/print-queue.mjs';

const sources = {
  a: { id: 'a', name: 'A.pdf', relativePath: '样例/A.pdf', path: 'D:/synthetic/A.pdf', pages: 2 },
  b: { id: 'b', name: 'B.pdf', relativePath: '样例/B.pdf', path: 'D:/synthetic/B.pdf', pages: 1 },
};
const segment = (fileId, options = {}) => ({
  fileId, path: sources[fileId].path, pages: fileId === 'a' ? [1, 2] : [1],
  appendBlank: false, startOnFront: true, ...options,
});
const task = (...segments) => ({ settings: { paper: 'A4', color: 'mono', duplex: 'long' }, segments });
const plan = (...tasks) => ({ ready: true, printerName: 'Synthetic test printer', tasks });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Controls native acknowledgements without starting a native process or reading a file. */
function controlledQueue(t) {
  const events = [], calls = [], available = [], waiting = [];
  const queue = new PrintQueue({
    registry: {
      async assertUnchanged(fileId) {
        if (!sources[fileId]) throw new Error('Unknown synthetic document');
        return { ...sources[fileId] };
      },
    },
    emit(event) { events.push(structuredClone(event)); },
    runNative(request, { onEvent }) {
      const result = deferred();
      const call = {
        request,
        event(value) { onEvent(value); },
        resolve(value = { jobs: [] }) { result.resolve(value); },
        reject(error) { result.reject(error); },
      };
      calls.push(call);
      if (waiting.length) waiting.shift()(call);
      else available.push(call);
      return result.promise;
    },
  });
  t.after(async () => {
    queue.stop();
    calls.forEach(call => call.resolve());
    await queue.done;
  });
  return {
    queue, events,
    nextCall() { return available.length ? Promise.resolve(available.shift()) : new Promise(resolve => waiting.push(resolve)); },
    snapshot() { return queue.batch.progress.snapshot(); },
    latest() { return events.at(-1); },
  };
}

function processing(call, documentIndex, extra = {}) {
  const document = call.request.documents[documentIndex];
  call.event({
    event: 'document-processing', groupIndex: 0, documentIndex,
    fileId: document.fileId, processedPages: 0, contentPages: document.pages.length,
    blank: false, documentComplete: false, ...extra,
  });
}

function progress(call, documentIndex, processedPages, extra = {}) {
  const document = call.request.documents[documentIndex];
  call.event({
    event: 'document-progress', groupIndex: 0, documentIndex,
    fileId: document.fileId, processedPages, contentPages: document.pages.length,
    blank: false, documentComplete: processedPages === document.pages.length && !document.appendBlank,
    ...extra,
  });
}

function job(call, documentIndices, extra = {}) {
  const receipt = {
    status: 'submitted', groupIndex: 0, documentIndices,
    documentName: 'Synthetic Windows job', jobId: 123, ...extra,
  };
  call.event({ event: 'job-submitted', job: receipt });
  return receipt;
}

const fileState = (snapshot, fileId) => snapshot.fileProgress.find(file => file.fileId === fileId);
const uncertainFailure = () => Object.assign(new Error('Synthetic pipe failure after submission began'), { submissionStarted: true });

test('merged task exposes per-file processing before its Windows job is confirmed', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('b'))));
  const call = await h.nextCall();
  processing(call, 0);
  assert.equal(h.latest().currentFile.fileId, 'a');
  assert.equal(h.latest().currentFile.name, 'A.pdf');
  assert.equal(h.latest().currentFile.relativePath, '样例/A.pdf');
  assert.equal(h.latest().totalPages, 3);
  progress(call, 0, 1);
  // Intermediate page updates may be throttled, but tracker state must be current.
  assert.equal(h.snapshot().processedPages, 1);
  assert.equal(h.snapshot().processedFiles, 0);
  progress(call, 0, 2);
  assert.equal(h.latest().processedFiles, 1);
  assert.equal(h.latest().processedUnits, 1);
  assert.equal(h.latest().submittedFiles, 0);
  assert.equal(h.latest().submittedUnits, 0);
  assert.equal(fileState(h.latest(), 'a').processedUnits, 1);
  processing(call, 1);
  assert.equal(h.latest().currentFile.fileId, 'b');
  progress(call, 1, 1);
  assert.equal(h.latest().processedFiles, 2);
  assert.equal(h.latest().processedPages, 3);
  assert.equal(h.latest().submittedFiles, 0);
  const receipt = job(call, [0, 1]);
  assert.equal(h.latest().submittedFiles, 2);
  call.resolve({ jobs: [receipt] });
  await h.queue.done;
  assert.equal(h.latest().status, 'submitted');
  assert.equal(h.latest().submittedUnits, 2);
});

test('the same file completes only after every occurrence across merged and separate tasks', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(
    task(segment('a', { pages: [1], setIndex: 1 }), segment('a', { pages: [1], setIndex: 1 })),
    task(segment('a', { pages: [1], setIndex: 2 }), segment('b', { setIndex: 2 })),
  ));
  const first = await h.nextCall();
  progress(first, 0, 1);
  assert.equal(h.latest().processedFiles, 0);
  processing(first, 1);
  assert.equal(h.latest().currentFile.copyIndex, 2);
  assert.equal(h.latest().currentFile.totalUnits, 3);
  progress(first, 1, 1);
  assert.equal(h.latest().processedFiles, 0);
  assert.equal(fileState(h.latest(), 'a').processedUnits, 2);
  const receipt1 = job(first, [0, 1], { jobId: 1, documentName: 'Synthetic set 1' });
  assert.equal(h.latest().submittedFiles, 0);
  assert.equal(fileState(h.latest(), 'a').submittedUnits, 2);
  first.resolve({ jobs: [receipt1] });
  const second = await h.nextCall();
  processing(second, 0);
  assert.equal(h.latest().currentFile.copyIndex, 3);
  assert.equal(h.latest().currentFile.totalUnits, 3);
  assert.equal(h.latest().currentFile.setIndex, 2);
  progress(second, 0, 1);
  assert.equal(h.latest().processedFiles, 1);
  assert.equal(h.latest().submittedFiles, 0);
  progress(second, 1, 1);
  assert.equal(h.latest().processedFiles, 2);
  const receipt2 = job(second, [0, 1], { jobId: 2, documentName: 'Synthetic set 2' });
  second.resolve({ jobs: [receipt2] });
  await h.queue.done;
  assert.equal(h.latest().totalUnits, 4);
  assert.equal(h.latest().processedUnits, 4);
  assert.equal(h.latest().submittedUnits, 4);
  assert.equal(h.latest().submittedFiles, 2);
  assert.equal(h.latest().processedPages, 4);
});

test('duplicate or stale progress and repeated receipts plus final response are idempotent', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('b'))));
  const call = await h.nextCall();
  progress(call, 0, 1);
  progress(call, 0, 1);
  assert.equal(h.snapshot().processedPages, 1);
  progress(call, 0, 2);
  processing(call, 1);
  progress(call, 0, 1); // A stale event must not regress counters or the current file.
  assert.equal(h.snapshot().processedPages, 2);
  assert.equal(h.snapshot().currentFile.fileId, 'b');
  progress(call, 0, 2);
  progress(call, 1, 1);
  progress(call, 1, 1);
  assert.equal(h.snapshot().processedFiles, 2);
  assert.equal(h.snapshot().processedUnits, 2);
  assert.equal(h.snapshot().processedPages, 3);
  const receipt = job(call, [0, 1]);
  call.event({ event: 'job-submitted', job: receipt });
  call.event({ event: 'job-submitted', job: receipt });
  call.resolve({ jobs: [receipt, receipt] });
  await h.queue.done;
  assert.equal(h.latest().submittedFiles, 2);
  assert.equal(h.latest().submittedUnits, 2);
  assert.equal(h.latest().processedUnits, 2);
  assert.equal(h.latest().processedPages, 3);
  assert.equal(h.latest().jobs.length, 1);
});

test('a required blank back delays document completion but never increases content-page progress', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a', { pages: [1], appendBlank: true }), segment('b'))));
  const call = await h.nextCall();
  assert.equal(h.latest().totalPages, 2);
  progress(call, 0, 1, { documentComplete: false });
  assert.equal(h.snapshot().processedPages, 1);
  assert.equal(h.snapshot().processedFiles, 0);
  assert.equal(h.snapshot().processedUnits, 0);
  processing(call, 0, { processedPages: 1, blank: true });
  assert.equal(h.snapshot().currentFile.blank, true);
  assert.equal(h.snapshot().processedFiles, 0);
  progress(call, 0, 1, { blank: true, documentComplete: true });
  assert.equal(h.latest().processedFiles, 1);
  assert.equal(h.latest().processedPages, 1);
  assert.equal(h.latest().submittedFiles, 0);
  progress(call, 1, 1);
  assert.equal(h.latest().processedPages, 2);
  const receipt = job(call, [0, 1]);
  call.resolve({ jobs: [receipt] });
  await h.queue.done;
  assert.equal(h.latest().processedPages, 2);
});

test('all pages processed before EndDoc failure are still unconfirmed and require review', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('b'))));
  const call = await h.nextCall();
  progress(call, 0, 2);
  progress(call, 1, 1);
  assert.equal(h.latest().processedFiles, 2);
  assert.equal(h.latest().submittedFiles, 0);
  call.reject(uncertainFailure());
  await h.queue.done;
  assert.equal(h.latest().status, 'failed');
  assert.equal(h.latest().needsConfirmation, true);
  assert.equal(h.latest().processedFiles, 2);
  assert.equal(h.latest().submittedFiles, 0);
  assert.equal(h.latest().submittedUnits, 0);
  assert.equal(fileState(h.latest(), 'a').uncertainUnits, 1);
  assert.equal(fileState(h.latest(), 'b').uncertainUnits, 1);
});

test('a receipt received before a broken pipe preserves confirmed files and isolates uncertain ones', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('b'))));
  const call = await h.nextCall();
  progress(call, 0, 2);
  progress(call, 1, 1);
  job(call, [0]);
  assert.equal(h.latest().submittedFiles, 1);
  call.reject(uncertainFailure());
  await h.queue.done;
  assert.equal(h.latest().needsConfirmation, true);
  assert.equal(h.latest().submittedFiles, 1);
  assert.equal(h.latest().submittedUnits, 1);
  assert.deepEqual(h.latest().fileIds, ['a']);
  assert.equal(fileState(h.latest(), 'a').submittedUnits, 1);
  assert.equal(fileState(h.latest(), 'a').uncertainUnits, 0);
  assert.equal(fileState(h.latest(), 'b').submittedUnits, 0);
  assert.equal(fileState(h.latest(), 'b').uncertainUnits, 1);
});

test('invalid document identity or page counts cannot mutate file progress', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('b'))));
  const call = await h.nextCall();
  const baseline = h.snapshot();
  const validShape = {
    event: 'document-progress', groupIndex: 0, documentIndex: 0,
    fileId: 'a', contentPages: 2, processedPages: 1, blank: false, documentComplete: false,
  };
  for (const invalid of [
    { documentIndex: -1 }, { documentIndex: 99 }, { documentIndex: 0.5 },
    { fileId: 'b' }, { fileId: 'not-in-plan' }, { fileId: undefined },
    { processedPages: -1 }, { processedPages: 3 }, { processedPages: 0.5 },
    { processedPages: NaN }, { contentPages: 99 }, { contentPages: '2' },
    { blank: true },
  ]) {
    call.event({ ...validShape, ...invalid });
    assert.deepEqual(h.snapshot(), baseline, JSON.stringify(invalid));
  }
  progress(call, 0, 1);
  assert.equal(h.snapshot().processedPages, 1);
  progress(call, 0, 2);
  progress(call, 1, 1);
  call.resolve({ jobs: [] });
  await h.queue.done;
  assert.equal(h.latest().submittedFiles, 2);
});

test('older native mocks without progress events reconcile all files on normal final success', { timeout: 5000 }, async t => {
  const h = controlledQueue(t);
  await h.queue.submit(plan(task(segment('a'), segment('a'), segment('b'))));
  const call = await h.nextCall();
  assert.equal(h.latest().processedFiles, 0);
  assert.equal(h.latest().submittedFiles, 0);
  call.resolve({ jobs: [{ status: 'submitted', documentName: 'Legacy final response', jobId: 456 }] });
  await h.queue.done;
  assert.equal(h.latest().status, 'submitted');
  assert.equal(h.latest().processedFiles, 2);
  assert.equal(h.latest().submittedFiles, 2);
  assert.equal(h.latest().processedUnits, 3);
  assert.equal(h.latest().submittedUnits, 3);
  assert.equal(h.latest().processedPages, 5);
  assert.equal(h.latest().totalPages, 5);
  assert.equal(fileState(h.latest(), 'a').submittedUnits, 2);
  assert.equal(fileState(h.latest(), 'a').uncertainUnits, 0);
});
