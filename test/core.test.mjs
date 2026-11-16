import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, orderedFiles, sortTree, moveItem, folderFileIds, ancestorFolders,
  DEFAULT_SETTINGS, resolveSettings, resolveFolderSettings, clearOverride,
  parsePageRanges, buildPrintPlan, canAutoRetry, transitionJob,
} from '../src/core/index.mjs';

const file = (id, relativePath, pages = 1, extra = {}) => ({
  id, path: `C:/demo/${relativePath}`, relativePath,
  name: relativePath.replaceAll('\\', '/').split('/').at(-1), kind: 'pdf', pages, ...extra,
});
const ids = tree => orderedFiles(tree).map(item => item.id);
const planIds = plan => plan.units.map(unit => unit.fileId);
const duplex = { ...DEFAULT_SETTINGS, duplex: 'long' };

test('tree preserves directories and visits local files before children with natural sibling ordering', () => {
  const tree = buildTree([
    file('b10', '材料/02 目录/10.pdf'), file('root10', '10.pdf'),
    file('sub', '材料/01 目录/子目录/1.pdf'), file('b2', '材料/02 目录/2.pdf'),
    file('root2', '2.pdf'), file('local', '材料/99.pdf'), file('a', '材料/01 目录/100.pdf'),
  ]);
  assert.deepEqual(ids(tree), ['root2', 'root10', 'local', 'a', 'sub', 'b2', 'b10']);
  assert.deepEqual(folderFileIds(tree, 'folder:材料/01 目录'), ['a', 'sub']);
  assert.deepEqual(ancestorFolders(tree, 'folder:材料/01 目录/子目录').map(folder => folder.name), ['全部文件', '材料', '01 目录', '子目录']);
});

test('natural and reverse sorting work when nested folders separate siblings in input', () => {
  const tree = buildTree([file('z', 'Z/1.pdf'), file('zc', 'Z/child/1.pdf'), file('a', 'A/1.pdf')]);
  assert.deepEqual(ids(tree), ['a', 'z', 'zc']);
  assert.deepEqual(ids(sortTree(tree, 'reverse')), ['z', 'zc', 'a']);
  assert.deepEqual(ids(tree), ['a', 'z', 'zc']);
});

test('Windows relative paths normalize and a real 本级文件 folder remains distinct from local files', () => {
  const tree = buildTree([file('child', '材料\\本级文件\\1.pdf'), file('local', '材料\\1.pdf')]);
  assert.deepEqual(ids(tree), ['local', 'child']);
  assert.deepEqual(tree.folders['folder:材料'].fileIds, ['local']);
  assert.equal(tree.files.child.relativePath, '材料/本级文件/1.pdf');
});

test('multiple import roots retain their names, including identical leaf-folder names', () => {
  const tree = buildTree([file('a', 'A/01/1.pdf'), file('b', 'B/01/1.pdf')]);
  assert.deepEqual(tree.folders[tree.rootId].folderIds, ['folder:A', 'folder:B']);
  assert.notEqual(tree.files.a.parentId, tree.files.b.parentId);
});

test('file moves are immutable and cannot cross folder boundaries', () => {
  const tree = buildTree([file('a', 'A/1.pdf'), file('b', 'A/2.pdf'), file('c', 'B/1.pdf')]);
  const moved = moveItem(tree, { type: 'file', id: 'b', delta: -1 });
  assert.deepEqual(ids(moved), ['b', 'a', 'c']);
  assert.deepEqual(ids(tree), ['a', 'b', 'c']);
  assert.equal(moveItem(moved, { type: 'file', id: 'b', delta: -1 }), moved);
  assert.throws(() => moveItem(tree, { type: 'file', id: 'a', beforeId: 'c' }), { code: 'CROSS_PARENT_MOVE' });
});

test('folder moves carry descendants and beforeId uses the post-removal target index', () => {
  const tree = buildTree([file('a', 'A/1.pdf'), file('sub', 'A/sub/1.pdf'), file('b', 'B/1.pdf'), file('c', 'C/1.pdf')]);
  const moved = moveItem(tree, { type: 'folder', id: 'folder:A', delta: 1 });
  assert.deepEqual(ids(moved), ['b', 'a', 'sub', 'c']);
  const dropped = moveItem(moved, { type: 'folder', id: 'folder:C', beforeId: 'folder:A' });
  assert.deepEqual(ids(dropped), ['b', 'c', 'a', 'sub']);
  assert.throws(() => moveItem(tree, { type: 'folder', id: 'folder:A/sub', beforeId: 'folder:B' }), { code: 'CROSS_PARENT_MOVE' });
});

test('invalid relative paths and duplicate IDs are rejected without filesystem access', () => {
  assert.throws(() => buildTree([file('x', '../secret.pdf')]), { code: 'INVALID_RELATIVE_PATH' });
  assert.throws(() => buildTree([file('x', 'A/1.pdf'), file('x', 'A/2.pdf')]), { code: 'DUPLICATE_FILE_ID' });
  const tree = buildTree([file('__proto__', '1.pdf')]);
  assert.equal(tree.files.__proto__.id, '__proto__');
});

test('settings inherit individual fields from global through all ancestor folders to file', () => {
  const tree = buildTree([file('a', 'A/B/1.pdf')]);
  const config = {
    globalSettings: { color: 'color', orientation: 'landscape', devModeBase64: 'driver-data' },
    folderOverrides: { 'folder:A': { paper: 'A5' }, 'folder:A/B': { scale: 'actual', color: undefined } },
    fileOverrides: { a: { duplex: 'short', copies: 2 } },
  };
  const settings = resolveSettings(tree, 'a', config);
  assert.deepEqual(settings, { ...DEFAULT_SETTINGS, color: 'color', orientation: 'landscape', paper: 'A5', scale: 'actual', duplex: 'short', copies: 2, devModeBase64: 'driver-data' });
  assert.equal(resolveFolderSettings(tree, 'folder:A/B', config).duplex, 'simplex');
  settings.paper = 'A3';
  assert.equal(config.folderOverrides['folder:A'].paper, 'A5');
});

test('restoring one field or a whole override preserves ancestor overrides', () => {
  const original = { a: { paper: 'A5', duplex: 'long' }, b: { color: 'color' } };
  assert.deepEqual(clearOverride(original, 'a', 'paper'), { a: { duplex: 'long' }, b: { color: 'color' } });
  assert.deepEqual(clearOverride(original, 'a'), { b: { color: 'color' } });
  assert.equal(original.a.paper, 'A5');
});

test('page ranges select unique pages in source order and accept full-document selection', () => {
  assert.deepEqual(parsePageRanges('5，1-3,3', 6), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRanges([3, 1, 3], 3), [1, 3]);
  assert.deepEqual(parsePageRanges('', 3), [1, 2, 3]);
  assert.deepEqual(parsePageRanges('all', 2), [1, 2]);
});

test('invalid, descending, empty and out-of-range page ranges are blocked', () => {
  for (const value of ['0', '4', '3-1', '1,,2', 'abc', []]) assert.throws(() => parsePageRanges(value, 3));
  assert.throws(() => parsePageRanges('1', null), { code: 'PAGE_COUNT_UNKNOWN' });
});

test('sets and per-file quantities produce distinct output orders', () => {
  const tree = buildTree([file('a', '1.pdf'), file('b', '2.pdf')]);
  const sets = buildPrintPlan(tree, { quantity: 2, quantityMode: 'sets' });
  const copies = buildPrintPlan(tree, { quantity: 2, quantityMode: 'copies' });
  assert.deepEqual(planIds(sets), ['a', 'b', 'a', 'b']);
  assert.deepEqual(planIds(copies), ['a', 'a', 'b', 'b']);
  assert.equal(sets.summary.pageCount, 4);
  assert.equal(sets.summary.fileCount, 2);
  assert.equal(sets.summary.unitCount, 4);
});

test('per-set file copies combine with batch sets without multiplying native copies again', () => {
  const tree = buildTree([file('a', '1.pdf', 1), file('b', '2.pdf', 2)]);
  const plan = buildPrintPlan(tree, { globalSettings: duplex, fileOverrides: { a: { copies: 2 } }, quantity: 2 });
  assert.deepEqual(planIds(plan), ['a', 'a', 'b', 'a', 'a', 'b']);
  assert.equal(plan.summary.pageCount, 8);
  assert.equal(plan.summary.sheetCount, 6);
  assert.equal(plan.summary.blankSides, 4);
  assert.equal(plan.tasks.length, 2);
  assert.equal('copies' in plan.tasks[0].settings, false);
  assert.equal('pageRanges' in plan.tasks[0].settings, false);
});

test('one file at three copies and other files at one retain set order and correct duplex boundaries', () => {
  const tree = buildTree([
    file('a', '材料/1.pdf', 3), file('b', '材料/2.pdf', 1), file('c', '材料/10.pdf', 1),
  ]);
  const options = { globalSettings: duplex, fileOverrides: { a: { copies: 3 } }, quantity: 2, quantityMode: 'sets' };
  const bounded = buildPrintPlan(tree, { ...options, boundary: true });
  const continuous = buildPrintPlan(tree, { ...options, boundary: false });
  for (const plan of [bounded, continuous]) {
    assert.equal(plan.ready, true);
    assert.deepEqual(planIds(plan), ['a', 'a', 'a', 'b', 'c', 'a', 'a', 'a', 'b', 'c']);
    assert.equal(plan.summary.fileCount, 3);
    assert.equal(plan.summary.unitCount, 10);
    assert.equal(plan.summary.pageCount, 22);
    assert.deepEqual(plan.tasks.map(task => task.setIndex), [1, 2]);
    assert.deepEqual(plan.tasks[0].segments.map(segment => segment.copyIndex), [1, 2, 3, 1, 1]);
  }
  assert.equal(bounded.summary.sheetCount, 16);
  assert.equal(bounded.summary.blankSides, 10);
  assert.equal(bounded.summary.insertedBlankPages, 8);
  assert.deepEqual(bounded.tasks[0].segments.map(segment => segment.appendBlank), [true, true, true, true, false]);
  // Explicit A copies remain independent; ordinary B/C can share a sheet when enabled.
  assert.equal(continuous.summary.sheetCount, 14);
  assert.equal(continuous.summary.blankSides, 6);
  assert.equal(continuous.summary.insertedBlankPages, 6);
  assert.deepEqual(continuous.tasks[0].segments.map(segment => segment.startOnFront), [true, true, true, true, false]);
  assert.deepEqual(continuous.tasks[0].segments.map(segment => segment.appendBlank), [true, true, true, false, false]);
  const perFile = buildPrintPlan(tree, { ...options, quantityMode: 'copies', boundary: true });
  assert.deepEqual(planIds(perFile), ['a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'c', 'c']);
  assert.equal(perFile.summary.pageCount, 22);
});

test('every batch set starts on a fresh sheet even with continuous files enabled', () => {
  const tree = buildTree([file('a', '1.pdf', 1), file('b', '2.pdf', 2)]);
  const plan = buildPrintPlan(tree, { globalSettings: duplex, boundary: false, quantity: 2 });
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.summary.pageCount, 6);
  assert.equal(plan.summary.sheetCount, 4);
  assert.equal(plan.summary.blankSides, 2);
  assert.equal(plan.summary.insertedBlankPages, 0);
  assert.ok(plan.tasks.every(task => task.segments[0].startOnFront));
});

test('single-page separate sets and explicit document copies never share a sheet', () => {
  const tree = buildTree([file('a', '1.pdf')]);
  const sets = buildPrintPlan(tree, { globalSettings: duplex, quantity: 2, boundary: false });
  const copies = buildPrintPlan(tree, { globalSettings: duplex, quantity: 2, quantityMode: 'copies', boundary: false });
  assert.equal(sets.summary.sheetCount, 2);
  assert.equal(copies.summary.sheetCount, 2);
  assert.equal(copies.summary.insertedBlankPages, 1);
});

test('continuous distinct documents share a sheet; file boundaries insert exactly one blank', () => {
  const tree = buildTree([file('a', '1.pdf'), file('b', '2.pdf')]);
  const continuous = buildPrintPlan(tree, { globalSettings: duplex, boundary: false });
  assert.equal(continuous.summary.sheetCount, 1);
  assert.deepEqual(continuous.units.map(unit => unit.startOnFront), [true, false]);
  const bounded = buildPrintPlan(tree, { globalSettings: duplex, boundary: true });
  assert.equal(bounded.summary.sheetCount, 2);
  assert.equal(bounded.summary.blankSides, 2);
  assert.equal(bounded.summary.insertedBlankPages, 1);
  assert.deepEqual(bounded.tasks[0].segments.map(segment => segment.appendBlank), [true, false]);
  assert.deepEqual(bounded.units.map(unit => unit.appendBlank), [true, false]);
});

test('only adjacent units of the same settings and same set merge into a task', () => {
  const tree = buildTree([file('a', '1.pdf'), file('b', '2.pdf'), file('c', '3.pdf')]);
  const plan = buildPrintPlan(tree, { globalSettings: duplex, fileOverrides: { b: { color: 'color' } }, boundary: false });
  assert.deepEqual(plan.tasks.map(task => task.segments.map(segment => segment.fileId)), [['a'], ['b'], ['c']]);
  assert.equal(plan.summary.sheetCount, 3);
  assert.ok(plan.tasks.every(task => task.segments[0].startOnFront));
  assert.ok(plan.tasks.every(task => !task.segments.at(-1).appendBlank));
});

test('driver configuration participates in task isolation and remains in native settings', () => {
  const tree = buildTree([file('a', '1.pdf'), file('b', '2.pdf')]);
  const plan = buildPrintPlan(tree, { globalSettings: { devModeBase64: 'A' }, fileOverrides: { b: { devModeBase64: 'B' } } });
  assert.deepEqual(plan.tasks.map(task => task.settings.devModeBase64), ['A', 'B']);
});

test('PDF range arrays are 1-based and photo pages are unaffected by PDF-only range selection', () => {
  const tree = buildTree([file('pdf', '1.pdf', 10), file('image', '2.jpg', 1, { kind: 'image' })]);
  const plan = buildPrintPlan(tree, { globalSettings: { ...duplex, pageRanges: '2-3,7' } });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.tasks[0].segments[0].pages, [2, 3, 7]);
  assert.deepEqual(plan.tasks[0].segments[1].pages, [1]);
  assert.equal(plan.summary.pageCount, 4);
  assert.equal(plan.summary.sheetCount, 3);
});

test('unknown page counts, invalid range and no selection block submission honestly', () => {
  const tree = buildTree([file('unknown', '1.pdf', null), file('known', '2.pdf', 2)]);
  const plan = buildPrintPlan(tree);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.summary.unknownFiles, ['unknown']);
  assert.ok(plan.errors.some(error => error.code === 'PAGE_COUNT_UNKNOWN' && error.fileId === 'unknown'));
  assert.equal(plan.tasks[0].ready, false);
  const invalidRange = buildPrintPlan(tree, { selectedIds: ['known'], fileOverrides: { known: { pageRanges: '9' } } });
  assert.equal(invalidRange.ready, false);
  assert.equal(invalidRange.errors[0].code, 'PAGE_RANGE_OUT_OF_BOUNDS');
  const empty = buildPrintPlan(tree, { selectedIds: [] });
  assert.equal(empty.ready, false);
  assert.equal(empty.tasks.length, 0);
});

test('selection preserves tree order and does not mutate caller settings or documents', () => {
  const tree = buildTree([file('a', '1.pdf'), file('b', '2.pdf'), file('c', '3.pdf')]);
  const original = JSON.stringify(tree);
  const settings = { ...duplex };
  const plan = buildPrintPlan(tree, { selectedIds: ['c', 'a'], globalSettings: settings });
  assert.deepEqual(planIds(plan), ['a', 'c']);
  assert.equal(JSON.stringify(tree), original);
  assert.deepEqual(settings, duplex);
});

test('plan blank insertion agrees with native per-task page cursor and sheet counts', () => {
  const tree = buildTree([file('a', 'A/1.pdf', 3), file('b', 'A/2.pdf', 2), file('c', 'B/1.pdf', 1)]);
  for (const boundary of [false, true]) {
    const plan = buildPrintPlan(tree, { globalSettings: duplex, quantity: 3, boundary, fileOverrides: { b: { copies: 2 } } });
    for (const task of plan.tasks) {
      let cursor = 0;
      for (const segment of task.segments) {
        if (segment.startOnFront) assert.equal(cursor % 2, 0);
        cursor += segment.pages.length;
        if (segment.appendBlank) cursor += 1;
      }
      assert.equal(task.sheetCount, Math.ceil(cursor / 2));
    }
  }
});

test('retry requires explicit evidence of non-submission, not merely a failed status', () => {
  assert.equal(canAutoRetry('failed'), false);
  assert.equal(canAutoRetry({ status: 'failed' }), false);
  assert.equal(canAutoRetry({ status: 'failed', submitted: false }), true);
  assert.equal(canAutoRetry({ status: 'failed', submitted: false, jobId: 7 }), false);
  assert.equal(canAutoRetry({ status: 'failed', submitted: false, submissionState: 'unknown' }), false);
});

test('submission and unknown states cannot be downgraded into automatic retries', () => {
  const submitted = transitionJob({ status: 'submitting', submitted: false }, 'submitted', { jobId: 42 });
  const failed = transitionJob(submitted, 'failed', { submitted: false, jobId: null });
  assert.equal(failed.submitted, true);
  assert.equal(failed.jobId, 42);
  assert.equal(canAutoRetry(failed), false);
  assert.throws(() => transitionJob(failed, 'pending'), { code: 'RETRY_REQUIRES_CONFIRMATION' });
  const unknown = transitionJob({ status: 'submitting', submitted: false }, 'unknown');
  const stillUnknown = transitionJob(unknown, 'failed', { submissionState: 'not-submitted' });
  assert.equal(stillUnknown.submissionState, 'unknown');
  assert.equal(canAutoRetry(stillUnknown), false);
  const confirmed = transitionJob(unknown, 'pending', { userConfirmed: true });
  assert.equal(confirmed.submitted, false);
  assert.equal(confirmed.submissionState, 'not-submitted');
  assert.equal(confirmed.attempt, 2);
});

test('a timeout during native submission is uncertain; a proven pre-submit failure is retryable', () => {
  const preparing = transitionJob(undefined, 'preparing');
  assert.equal(canAutoRetry(transitionJob(preparing, 'failed')), true);
  const submitting = transitionJob(preparing, 'submitting');
  assert.equal(canAutoRetry(transitionJob(submitting, 'failed')), false);
  const notSent = transitionJob(submitting, 'failed', { submitted: false, submissionState: 'not-submitted' });
  assert.equal(canAutoRetry(notSent), true);
});

test('oversized quantities and page ranges are blocked before expansion with no partial tasks', () => {
  const single = buildTree([file('a', '1.pdf')]);
  const excessiveCopies = buildPrintPlan(single, { quantity: 999, fileOverrides: { a: { copies: 999 } } });
  assert.equal(excessiveCopies.summary.unitCount, 998_001);
  const excessivePages = buildPrintPlan(buildTree([file('a', '1.pdf', 101)]), { quantity: 999 });
  // A huge source count must not first allocate a 100-million-element array.
  const hugeSource = buildTree([file('a', '1.pdf', 100_000_000)]);
  const excessiveRange = buildPrintPlan(hugeSource);
  const explicitRange = buildPrintPlan(hugeSource, { globalSettings: { pageRanges: '1-100000000' } });
  const extraBlank = buildPrintPlan(buildTree([file('a', '1.pdf', 1), file('b', '2.pdf', 99_999)]), { globalSettings: duplex });
  for (const plan of [excessiveCopies, excessivePages, excessiveRange, explicitRange, extraBlank]) {
    assert.equal(plan.ready, false);
    assert.equal(plan.summary.limited, true);
    assert.ok(plan.errors.some(error => error.code === 'PLAN_TOO_LARGE'));
    assert.deepEqual(plan.units, []);
    assert.deepEqual(plan.tasks, []);
  }
  const narrowRange = buildPrintPlan(hugeSource, { globalSettings: { pageRanges: '1,100000000' } });
  assert.equal(narrowRange.ready, true);
  assert.deepEqual(narrowRange.units[0].pages, [1, 100_000_000]);
});
