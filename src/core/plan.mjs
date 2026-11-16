import { orderedFiles } from './tree.mjs';
import { resolveSettings, parsePageRanges } from './settings.mjs';

export const PLAN_LIMITS = Object.freeze({ maxUnits: 10_000, maxPages: 100_000 });

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function nativeSettings(settings) {
  // Copies and page selection have already been expanded into the plan.
  const { copies, pageRanges, ...result } = settings;
  return result;
}

function addError(errors, code, message, fileId) {
  if (!errors.some(error => error.code === code && error.fileId === fileId)) {
    errors.push({ code, message, ...(fileId ? { fileId } : {}) });
  }
}

/**
 * Build a fully ordered plan. All page arrays are 1-based.
 * A new set or changed effective settings starts a new native print job.
 * Native must execute appendBlank exactly; startOnFront is an assertion only.
 * The final unprinted back of a task is counted in blankSides, not appendBlank.
 */
export function buildPrintPlan(tree, options = {}) {
  const {
    selectedIds, globalSettings = {}, folderOverrides = {}, fileOverrides = {},
    quantityMode = 'sets', quantity = 1, boundary = true,
  } = options;
  const errors = [];
  const wanted = selectedIds === undefined ? null : new Set(selectedIds);
  const selected = orderedFiles(tree).filter(file => wanted === null || wanted.has(file.id));
  const validQuantity = Number.isInteger(Number(quantity)) && Number(quantity) >= 1 && Number(quantity) <= 999;
  const count = validQuantity ? Number(quantity) : 1;
  if (!validQuantity) addError(errors, 'INVALID_QUANTITY', '打印数量须为 1-999 的整数');
  if (!['sets', 'copies'].includes(quantityMode)) addError(errors, 'INVALID_QUANTITY_MODE', '未知打印数量模式');
  if (!selected.length) addError(errors, 'EMPTY_SELECTION', '请选择要打印的文件');
  const unknownFiles = [];
  function tooLarge(unitCount, pageCount = 0) {
    if (!errors.some(error => error.code === 'PLAN_TOO_LARGE')) {
      addError(errors, 'PLAN_TOO_LARGE', '当前批次过大：最多 10,000 份文件、100,000 页（含补白），请减少套数或分批打印');
    }
    const summary = {
      fileCount: selected.length, unitCount, pageCount, sheetCount: 0,
      blankSides: 0, insertedBlankPages: 0, taskCount: 0,
      unknownFiles: [...unknownFiles], quantity: count, quantityMode,
      boundary: Boolean(boundary), complete: false, limited: true,
      files: selected.length, pages: pageCount, sheets: 0, blanks: 0,
    };
    // No partially expanded task can escape into the submission layer.
    return { ready: false, units: [], tasks: [], summary, errors };
  }
  if (selected.length > PLAN_LIMITS.maxUnits) return tooLarge(selected.length * count);
  const prepared = selected.map(file => {
    const settings = resolveSettings(tree, file.id, { globalSettings, folderOverrides, fileOverrides });
    const validCopies = Number.isInteger(Number(settings.copies)) && Number(settings.copies) >= 1 && Number(settings.copies) <= 999;
    if (!validCopies) addError(errors, 'INVALID_COPIES', `${file.name} 的每套份数须为 1-999 的整数`, file.id);
    return { file, settings, copies: validCopies ? Number(settings.copies) : 1 };
  });
  const requestedUnits = prepared.reduce((total, item) => total + item.copies * count, 0);
  // Check multiplication before allocating repeated units or any page arrays.
  if (requestedUnits > PLAN_LIMITS.maxUnits) return tooLarge(requestedUnits);
  const source = [];
  let requestedPages = 0;
  for (const item of prepared) {
    const { file, settings } = item;
    let pages = null;
    if (!['pdf', 'image'].includes(file.kind)) addError(errors, 'UNSUPPORTED_FILE', `暂不支持文件格式：${file.name}`, file.id);
    if (!Number.isInteger(file.pages) || file.pages < 1) {
      unknownFiles.push(file.id);
      addError(errors, 'PAGE_COUNT_UNKNOWN', `${file.name} 的页数尚未解析`, file.id);
    } else {
      try {
        pages = parsePageRanges(file.kind === 'image' ? '' : settings.pageRanges, file.pages, { maxPages: PLAN_LIMITS.maxPages });
      } catch (error) {
        addError(errors, error.code || 'INVALID_PAGE_RANGE', `${file.name}：${error.message}`, file.id);
        if (error.code === 'PLAN_TOO_LARGE') return tooLarge(requestedUnits, requestedPages);
      }
    }
    requestedPages += (pages?.length ?? 0) * item.copies * count;
    if (requestedPages > PLAN_LIMITS.maxPages) return tooLarge(requestedUnits, requestedPages);
    if (!['simplex', 'long', 'short'].includes(settings.duplex)) addError(errors, 'INVALID_DUPLEX', `${file.name} 的单双面设置无效`, file.id);
    if (!['auto', 'portrait', 'landscape'].includes(settings.orientation)) addError(errors, 'INVALID_ORIENTATION', `${file.name} 的方向设置无效`, file.id);
    if (!['mono', 'color'].includes(settings.color)) addError(errors, 'INVALID_COLOR', `${file.name} 的色彩设置无效`, file.id);
    if (!['fit', 'actual', 'shrink'].includes(settings.scale)) addError(errors, 'INVALID_SCALE', `${file.name} 的缩放设置无效`, file.id);
    source.push({ ...item, pages });
  }

  const units = [];
  function append(sourceItem, setIndex, copyIndex, independentCopy) {
    const { file, settings, pages } = sourceItem;
    units.push({
      id: `unit:${units.length + 1}`, fileId: file.id, path: file.path,
      relativePath: file.relativePath, name: file.name, kind: file.kind,
      pages: pages ? [...pages] : null, pageCount: pages?.length ?? null,
      settings: { ...settings }, setIndex, copyIndex, independentCopy,
      appendBlank: false, startOnFront: true,
    });
  }
  if (quantityMode === 'copies') {
    for (const item of source) {
      const copies = item.copies * count;
      for (let copy = 1; copy <= copies; copy += 1) append(item, 1, copy, copies > 1);
    }
  } else {
    for (let set = 1; set <= count; set += 1) {
      for (const item of source) {
        for (let copy = 1; copy <= item.copies; copy += 1) append(item, set, copy, item.copies > 1);
      }
    }
  }

  const unitById = new Map(units.map(unit => [unit.id, unit]));
  const tasks = [];
  let current = null;
  function finishTask() {
    if (!current) return;
    const duplex = current.settings.duplex !== 'simplex';
    current.ready = current.segments.every(segment => Array.isArray(segment.pages));
    current.pageCount = current.segments.reduce((total, segment) => total + (segment.pages?.length ?? 0), 0);
    current.insertedBlankPages = current.segments.filter(segment => segment.appendBlank).length;
    const emittedPages = current.pageCount + current.insertedBlankPages;
    current.sheetCount = duplex ? Math.ceil(emittedPages / 2) : emittedPages;
    current.blankSides = duplex ? current.sheetCount * 2 - current.pageCount : 0;
    delete current.signature;
    delete current.cursor;
    tasks.push(current);
    current = null;
  }
  for (const unit of units) {
    const settings = nativeSettings(unit.settings);
    const signature = JSON.stringify(stableValue(settings));
    if (current && (current.setIndex !== unit.setIndex || current.signature !== signature)) finishTask();
    if (!current) {
      current = { id: `task:${tasks.length + 1}`, setIndex: unit.setIndex, settings, signature, cursor: 0, segments: [] };
    }
    const duplex = settings.duplex !== 'simplex';
    const previous = current.segments.at(-1);
    // Explicit duplicate copies remain independent physical copies, even when
    // continuous layout between ordinary single-copy files is requested.
    const forceFront = boundary || unit.independentCopy || previous?.independentCopy;
    if (duplex && forceFront && current.cursor % 2 === 1 && previous) {
      previous.appendBlank = true;
      const previousUnit = unitById.get(previous.id);
      if (previousUnit) previousUnit.appendBlank = true;
      current.cursor += 1;
    }
    unit.startOnFront = !duplex || current.cursor % 2 === 0;
    const segment = {
      id: unit.id, fileId: unit.fileId, path: unit.path, relativePath: unit.relativePath,
      name: unit.name, kind: unit.kind, pages: unit.pages ? [...unit.pages] : null,
      appendBlank: false, startOnFront: unit.startOnFront, independentCopy: unit.independentCopy,
      setIndex: unit.setIndex, copyIndex: unit.copyIndex,
    };
    current.segments.push(segment);
    current.cursor += unit.pageCount ?? 0;
  }
  finishTask();
  const pageCount = units.reduce((total, unit) => total + (unit.pageCount ?? 0), 0);
  const sheetCount = tasks.reduce((total, task) => total + task.sheetCount, 0);
  const blankSides = tasks.reduce((total, task) => total + task.blankSides, 0);
  const insertedBlankPages = tasks.reduce((total, task) => total + task.insertedBlankPages, 0);
  if (pageCount + insertedBlankPages > PLAN_LIMITS.maxPages) return tooLarge(requestedUnits, pageCount);
  const summary = {
    fileCount: selected.length, unitCount: units.length, pageCount, sheetCount,
    blankSides, insertedBlankPages, taskCount: tasks.length, unknownFiles,
    quantity: count, quantityMode, boundary: Boolean(boundary),
    complete: errors.length === 0,
    // Short aliases ease integration with the original design's counters.
    files: selected.length, pages: pageCount, sheets: sheetCount, blanks: blankSides,
  };
  return { ready: errors.length === 0 && units.length > 0, units, tasks, summary, errors };
}
