# QueuePrint core

Pure Node/browser-compatible ESM modules. This directory performs no filesystem,
printer, network, or UI operations. Import the public API from `index.mjs`.

## Documents and directory order

```js
const tree = buildTree([
  {
    id: 'document-1',
    path: 'C:\\Materials\\Travel\\01.pdf',
    relativePath: 'Materials/Travel/01.pdf',
    name: '01.pdf',
    kind: 'pdf', // 'pdf' or 'image'
    pages: 3, // null until parsed; images default to 1
  },
]);
```

`relativePath` includes the desired visible import-root name. Multiple roots can
coexist. If two import roots have the same name, the scanner should give their
first path component distinct visible labels before calling `buildTree`.

The tree contains `rootId`, `folders`, and `files`. The latter two are ID-keyed
objects. Folders contain `id`, `parentId`, `name`, `relativePath`, `folderIds`, and
`fileIds`. Files retain the scanner fields and add `parentId`.

The virtual root ID is `folder:`. A visible folder at `Materials/Travel` has ID
`folder:Materials/Travel`. There is no synthetic “local files” folder.

- `orderedFiles(tree, folderId?)`: local files first, then child folders in order.
- `folderFileIds(tree, folderId?)`: recursive file IDs in that same order.
- `ancestorFolders(tree, folderId)`: root through the requested folder, inclusive.
- `sortTree(tree, 'natural' | 'reverse' | 'manual')`: independently sort sibling
  lists; manual mode preserves the current order.
- `moveItem(tree, {type, id, delta})`: move a file/folder by a sibling offset.
- `moveItem(tree, {type, id, beforeId})`: insert before a sibling for drag/drop.

Operations return a new tree when order changes. A move beyond a sibling boundary
is a no-op. Moving across parents throws `QueuePrintError` with code
`CROSS_PARENT_MOVE`; it never silently breaks directory groups.

## Settings inheritance

```js
const config = {
  globalSettings: { paper: 'A4', duplex: 'long' },
  folderOverrides: { 'folder:Materials/Travel': { color: 'color' } },
  fileOverrides: { 'document-1': { copies: 2, pageRanges: '1,3' } },
};
const effective = resolveSettings(tree, 'document-1', config);
```

Defaults are paper `A4`, orientation `auto`, color `mono`, duplex `simplex`, scale
`fit`, copies `1`, and pageRanges `''` (all pages). Orientation also accepts
`portrait`/`landscape`, duplex `long`/`short`, color `color`, and scale
`actual`/`shrink`. Driver fields such as `devModeBase64` are preserved and inherited.

Each property merges independently in this order: defaults → global → every
ancestor folder → file. `undefined` inherits; other explicit values override.
`resolveFolderSettings` performs the same merge without the final file override.
`clearOverride(map, id, key?)` immutably removes a field or an entire override.

`parsePageRanges(input, pageCount)` returns unique 1-based pages in source order.
It accepts comma-separated pages/ranges, Chinese commas, or a page array. Empty,
`all`, `全部`, or `*` selects all pages. Invalid/out-of-bounds ranges throw rather
than silently truncating. PDF ranges do not restrict image pages.

## Print plans

```js
const plan = buildPrintPlan(tree, {
  ...config,
  selectedIds: ['document-1'], // omitted = all; [] = none
  quantityMode: 'sets', // 'sets' or 'copies'
  quantity: 2,
  boundary: true,
});
```

`plan` contains `ready`, `units`, `tasks`, `summary`, and `errors`.

- A unit is one physical document copy. It includes `id`, `fileId`, `path`,
  `relativePath`, `name`, `kind`, `pages`, `pageCount`, effective `settings`,
  1-based `setIndex`/`copyIndex`, `appendBlank`, and `startOnFront`.
- Sets mode repeats the entire selected sequence. Copies mode repeats each file
  before advancing. Effective file `copies` multiplies the selected quantity.
- Each set starts a new native task and a fresh sheet. Explicit repeated document
  copies also start on fresh sheets, even with continuous-file layout enabled.
- Adjacent units with equal native settings may share one task. A settings change
  isolates the next task. Non-adjacent matching settings are never regrouped.
- A task contains `id`, `setIndex`, `settings`, `segments`, `pageCount`,
  `sheetCount`, `blankSides`, `insertedBlankPages`, and `ready`.
- Task settings omit `copies` and `pageRanges`: the plan already expands both.
  Native copies must remain 1. Segments include the unit's path and **1-based
  integer page array**, plus `appendBlank`/`startOnFront` and identity fields.

The native layer executes `appendBlank` exactly, once. It must not automatically
pad `startOnFront`: that flag is an assertion describing the planned starting
side. A task starts on the front naturally. Its last unused back is counted in
`blankSides`, but does not require an appended blank page. The core only appends
blank pages inside a task when a following document must start on the front.

Summary fields: `fileCount`, `unitCount`, `pageCount`, `sheetCount`, `blankSides`,
`insertedBlankPages`, `taskCount`, `unknownFiles`, `quantity`, `quantityMode`,
`boundary`, and `complete`. Short aliases `files`, `pages`, `sheets`, and `blanks`
are also provided. Page count excludes blank pages. Unknown counts produce
partial totals and `complete: false`; the UI should display “待解析”.

Always check `plan.ready` before submission. Errors are objects with `code`,
`message`, and optional `fileId`. Unknown PDF page counts, invalid ranges/settings,
and an empty selection block submission.

Resource limits are exported as `PLAN_LIMITS`: 10,000 expanded document units and
100,000 emitted pages including inserted blanks. Quantity multiplication and
selected page counts are checked before expanding repeated units. Page-range
parsing also has a bounded allocation path, so an enormous PDF page count cannot
freeze the renderer. An excessive plan returns `PLAN_TOO_LARGE`, `ready: false`,
`summary.limited: true`, and empty `units`/`tasks`; no partial task is printable.

## Submission and retries

`canAutoRetry(record)` only permits a failed task with explicit proof of no
submission (`submitted: false`, no spooler ID/timestamp, and no uncertain state).
Plain `'failed'`, unknown status, or a submitted task is insufficient evidence.

`transitionJob(record, nextStatus, details?)` preserves submission uncertainty.
Entering `submitting` makes an unacknowledged failure uncertain. A caller may
report a proven pre-submit failure with `{submitted: false,
submissionState: 'not-submitted'}`. Starting another attempt after uncertain or
successful submission requires `{userConfirmed: true}`. Confirmation starts a
new attempt; it does not claim the old one was never printed.

Run the meaningful boundary and integration-contract tests with:

```text
node --test test/core.test.mjs
```
