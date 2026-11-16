import { ancestorFolders, QueuePrintError } from './tree.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  paper: 'A4',
  orientation: 'auto',
  color: 'mono',
  duplex: 'simplex',
  scale: 'fit',
  copies: 1,
  pageRanges: '',
});

function applyPatch(target, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const [key, value] of Object.entries(patch)) {
    // An absent field inherits; null/empty strings remain explicit values.
    if (value !== undefined) target[key] = value;
  }
}

export function resolveFolderSettings(tree, folderId, {
  globalSettings = {}, folderOverrides = {},
} = {}) {
  if (!tree.folders[folderId]) throw new QueuePrintError('FOLDER_NOT_FOUND', '文件夹不存在');
  const settings = { ...DEFAULT_SETTINGS };
  applyPatch(settings, globalSettings);
  for (const folder of ancestorFolders(tree, folderId)) applyPatch(settings, folderOverrides[folder.id]);
  return settings;
}

/** Merge individual properties, rather than replacing a whole inherited preset. */
export function resolveSettings(tree, fileId, config = {}) {
  const file = tree.files[fileId];
  if (!file) throw new QueuePrintError('FILE_NOT_FOUND', '文件不存在', { fileId });
  const settings = resolveFolderSettings(tree, file.parentId, config);
  applyPatch(settings, config.fileOverrides?.[fileId]);
  return settings;
}

/** Clear an entire scope override, or a single field, without mutating the map. */
export function clearOverride(overrides, id, key) {
  const next = { ...overrides };
  if (key === undefined) {
    delete next[id];
  } else if (next[id]) {
    next[id] = { ...next[id] };
    delete next[id][key];
    if (!Object.keys(next[id]).length) delete next[id];
  }
  return next;
}

/**
 * Parse 1-based page selection. Duplicate pages are printed once, in source order.
 * Empty/all/* selects the entire document. Invalid/out-of-range input is rejected.
 */
export function parsePageRanges(input, pageCount, { maxPages = Infinity } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new QueuePrintError('PAGE_COUNT_UNKNOWN', '文件页数尚未解析');
  }
  let ranges;
  if (Array.isArray(input)) {
    ranges = input.map(page => [Number(page), Number(page)]);
  } else {
    const text = String(input ?? '').trim();
    if (!text || /^(all|全部|\*)$/i.test(text)) {
      if (pageCount > maxPages) throw new QueuePrintError('PLAN_TOO_LARGE', '选中的页面过多，请缩小页码范围后分批打印');
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }
    const parts = text.replaceAll('，', ',').replace(/[–—]/g, '-').split(',');
    if (parts.some(part => !part.trim())) throw new QueuePrintError('INVALID_PAGE_RANGE', '页码范围格式不正确，例如 1-3,5');
    ranges = parts.map(part => {
      const match = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!match) throw new QueuePrintError('INVALID_PAGE_RANGE', '页码范围格式不正确，例如 1-3,5');
      return [Number(match[1]), Number(match[2] ?? match[1])];
    });
  }
  const selected = new Set();
  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new QueuePrintError('PAGE_RANGE_OUT_OF_BOUNDS', `页码范围必须在 1-${pageCount} 页之内，且起始页不大于结束页`);
    }
    if (end - start + 1 > maxPages) throw new QueuePrintError('PLAN_TOO_LARGE', '选中的页面过多，请缩小页码范围后分批打印');
    for (let page = start; page <= end; page += 1) {
      selected.add(page);
      if (selected.size > maxPages) throw new QueuePrintError('PLAN_TOO_LARGE', '选中的页面过多，请缩小页码范围后分批打印');
    }
  }
  if (!selected.size) throw new QueuePrintError('EMPTY_PAGE_RANGE', '至少选择一页');
  return [...selected].sort((a, b) => a - b);
}
