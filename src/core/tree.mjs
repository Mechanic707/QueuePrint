/** Pure document-tree operations. No filesystem access occurs in this module. */
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export class QueuePrintError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueuePrintError';
    this.code = code;
    Object.assign(this, details);
  }
}

function relativeParts(value) {
  const text = String(value ?? '').replaceAll('\\', '/');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new QueuePrintError('INVALID_RELATIVE_PATH', 'relativePath 必须是相对路径');
  }
  const parts = text.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..' || part.includes('\0'))) {
    throw new QueuePrintError('INVALID_RELATIVE_PATH', 'relativePath 不能包含上级目录或空字符');
  }
  return parts;
}

function kindOf(item, name) {
  if (item.kind === 'pdf') return 'pdf';
  if (['image', 'png', 'jpg', 'jpeg'].includes(item.kind)) return 'image';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(png|jpe?g)$/i.test(name)) return 'image';
  return item.kind || 'unsupported';
}

/**
 * relativePath includes every desired visible directory, e.g. 报销材料/差旅/01.pdf.
 * The virtual folder: root holds loose files, and is not an imported folder.
 */
export function buildTree(items = [], { rootName = '全部文件' } = {}) {
  const tree = {
    rootId: 'folder:',
    folders: {
      'folder:': { id: 'folder:', parentId: null, name: rootName, relativePath: '', folderIds: [], fileIds: [] },
    },
    files: Object.create(null),
  };
  for (const item of items) {
    const fallback = item.name || String(item.path || '').replaceAll('\\', '/').split('/').at(-1);
    const parts = relativeParts(item.relativePath || fallback);
    if (!parts.length) throw new QueuePrintError('MISSING_FILENAME', '文件缺少名称');
    let parentId = tree.rootId;
    for (let n = 1; n < parts.length; n += 1) {
      const folderPath = parts.slice(0, n).join('/');
      const folderId = `folder:${folderPath}`;
      if (!tree.folders[folderId]) {
        tree.folders[folderId] = {
          id: folderId, parentId, name: parts[n - 1], relativePath: folderPath, folderIds: [], fileIds: [],
        };
        tree.folders[parentId].folderIds.push(folderId);
      }
      parentId = folderId;
    }
    const relativePath = parts.join('/');
    const name = item.name || parts.at(-1);
    const id = String(item.id ?? `file:${relativePath}`);
    if (Object.hasOwn(tree.files, id)) throw new QueuePrintError('DUPLICATE_FILE_ID', `文件 ID 重复：${id}`, { fileId: id });
    const kind = kindOf(item, name);
    const pages = item.pages ?? (kind === 'image' ? 1 : null);
    tree.files[id] = { ...item, id, name, relativePath, kind, pages, parentId };
    tree.folders[parentId].fileIds.push(id);
  }
  return sortTree(tree);
}

/** Return files in the exact print order: current folder files, then child folders. */
export function orderedFiles(tree, folderId = tree.rootId) {
  if (!tree.folders[folderId]) return [];
  const result = [];
  const walk = id => {
    const folder = tree.folders[id];
    result.push(...folder.fileIds.map(fileId => tree.files[fileId]));
    folder.folderIds.forEach(walk);
  };
  walk(folderId);
  return result;
}

export function folderFileIds(tree, folderId = tree.rootId) {
  return orderedFiles(tree, folderId).map(file => file.id);
}

/** Ancestors include the virtual root and the folder itself, outermost first. */
export function ancestorFolders(tree, folderId) {
  const result = [];
  let folder = tree.folders[folderId];
  while (folder) {
    result.unshift(folder);
    folder = folder.parentId === null ? null : tree.folders[folder.parentId];
  }
  return result;
}

/** Sort each sibling list independently; never sort the flattened file list. */
export function sortTree(tree, mode = 'natural') {
  if (mode === 'manual') return tree;
  if (!['natural', 'reverse'].includes(mode)) throw new QueuePrintError('INVALID_SORT_MODE', '未知排序方式');
  const sign = mode === 'reverse' ? -1 : 1;
  const compare = (collection, a, b) => sign * (collator.compare(collection[a].name, collection[b].name) || collator.compare(a, b));
  const folders = {};
  for (const [id, folder] of Object.entries(tree.folders)) {
    folders[id] = {
      ...folder,
      fileIds: [...folder.fileIds].sort((a, b) => compare(tree.files, a, b)),
      folderIds: [...folder.folderIds].sort((a, b) => compare(tree.folders, a, b)),
    };
  }
  return { ...tree, folders };
}

/**
 * Immutable move. Specify delta (e.g. -1/+1), or beforeId for drag-and-drop.
 * Reaching a sibling boundary is a no-op; a cross-parent move is an error.
 */
export function moveItem(tree, { type, id, delta, beforeId } = {}) {
  if (!['file', 'folder'].includes(type)) throw new QueuePrintError('INVALID_ITEM_TYPE', '只能移动文件或文件夹');
  const collection = type === 'file' ? tree.files : tree.folders;
  const item = collection[id];
  if (!item) throw new QueuePrintError('ITEM_NOT_FOUND', '待移动项不存在');
  if (item.parentId === null) return tree;
  const parent = tree.folders[item.parentId];
  const key = type === 'file' ? 'fileIds' : 'folderIds';
  const siblings = [...parent[key]];
  const oldIndex = siblings.indexOf(id);
  if (beforeId !== undefined) {
    const target = collection[beforeId];
    if (!target) throw new QueuePrintError('ITEM_NOT_FOUND', '目标项不存在');
    if (target.parentId !== item.parentId) throw new QueuePrintError('CROSS_PARENT_MOVE', '文件可在组内移动，文件夹可在同级移动');
    if (beforeId === id) return tree;
    siblings.splice(oldIndex, 1);
    siblings.splice(siblings.indexOf(beforeId), 0, id);
  } else {
    if (!Number.isInteger(delta)) throw new QueuePrintError('INVALID_MOVE', '移动方向必须是整数');
    const targetIndex = Math.max(0, Math.min(siblings.length - 1, oldIndex + delta));
    if (targetIndex === oldIndex) return tree;
    siblings.splice(oldIndex, 1);
    siblings.splice(targetIndex, 0, id);
  }
  return { ...tree, folders: { ...tree.folders, [parent.id]: { ...parent, [key]: siblings } } };
}
