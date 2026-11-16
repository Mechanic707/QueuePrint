import { buildTree, orderedFiles, moveItem, resolveSettings, buildPrintPlan } from '../core/index.mjs';

const root = document.getElementById('queueprint-design');
const $ = selector => root.querySelector(selector);
const $$ = selector => [...root.querySelectorAll(selector)];
const api = window.queueprint;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const icons = () => window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const INTERNAL_DRAG_TYPE = 'application/x-queueprint-item';
const defaults = { paper: 'A4', orientation: 'auto', color: 'mono', duplex: 'simplex', scale: 'fit', copies: 1, pageRanges: '' };
let tree = buildTree([]);
let printers = [];
let state = { selected: null, focusedFolder: null, focusType: 'all', scope: 'batch', view: 'list', sort: 'natural', checked: new Set(), collapsed: new Set(), quantity: 1, quantityMode: 'sets', boundary: true, printerName: '', globalSettings: { ...defaults }, folderOverrides: {}, fileOverrides: {}, driverSettings: {}, presets: [] };
let dialog = null, busy = false, currentBatch = null, currentPlan = null, dragged = null, returnFocus = null;
let toastTimer = null, saveTimer = null, previewToken = 0, pdfModule = null, pdfDocument = null, pdfFileId = null, pdfRenderTask = null, imageUrl = null, previewPage = 1;
let externalDragDepth = 0;

const files = () => orderedFiles(tree);
const file = id => tree.files[id];
const folder = id => tree.folders[id];
const isValidFile = f => Boolean(f && !f.error && Number.isInteger(f.pages) && f.pages > 0);
const activePrinter = () => printers.find(p => p.name === state.printerName);
function supportedPapers(printer = activePrinter()) {
  const input = printer?.paperSizes?.length ? printer.paperSizes : printer?.papers;
  if (!Array.isArray(input) || !input.length) return [{ value: 'A4', label: 'A4' }, { value: 'A5', label: 'A5' }, { value: 'A3', label: 'A3' }, { value: 'Letter', label: 'Letter' }, { value: 'Legal', label: 'Legal' }];
  const result = new Map();
  input.forEach(paper => { const value = typeof paper === 'string' ? paper : paper.kind && paper.kind !== 'Custom' ? String(paper.kind) : paper.name; if (value) result.set(value, { value, label: typeof paper === 'string' ? paper : paper.name || value }); });
  return [...result.values()];
}
const activeBatch = () => Boolean(currentBatch && ['starting', 'running', 'paused', 'stopping'].includes(currentBatch.status));
function ancestors(id) { const list = []; let current = folder(id); while (current) { list.unshift(current); current = folder(current.parentId); } return list; }
function descendantFiles(id) { const current = folder(id); if (!current) return []; return [...current.fileIds.map(file), ...current.folderIds.flatMap(descendantFiles)]; }
function settingsConfig() { return { globalSettings: state.globalSettings, folderOverrides: state.folderOverrides, fileOverrides: state.fileOverrides }; }
function effective(f) { return resolveSettings(tree, f.id, settingsConfig()); }
function effectiveFolder(id) { return Object.assign({}, state.globalSettings, ...ancestors(id).map(g => state.folderOverrides[g.id] || {})); }
function activeSettings() { return state.scope === 'file' && file(state.selected) ? effective(file(state.selected)) : state.scope === 'folder' && folder(state.focusedFolder) ? effectiveFolder(state.focusedFolder) : state.globalSettings; }
function plan() {
  try { return buildPrintPlan(tree, { ...settingsConfig(), selectedIds: [...state.checked], quantityMode: state.quantityMode, quantity: state.quantity, boundary: state.boundary }); }
  catch (error) { return { ready: false, units: [], tasks: [], summary: { fileCount: state.checked.size, pageCount: 0, sheetCount: 0, blankSides: 0, unknownFiles: [] }, errors: [{ message: error.message }] }; }
}
function runtime(message, error = false) { $('#qp-runtime-status').textContent = message; $('#qp-runtime-status').classList.toggle('is-error', error); $('#qp-runtime-status').hidden = !message; }
function announce(message, duration = 3800) { clearTimeout(toastTimer); $('#qp-announcement').textContent = message; $('#qp-announcement').hidden = false; toastTimer = setTimeout(() => { $('#qp-announcement').hidden = true; }, duration); }
function showError(error) { announce(error?.message || String(error), 6500); }
function savePreferences() {
  if (!api) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.savePreferences({ version: 1, printerName: state.printerName, globalSettings: state.globalSettings, boundary: state.boundary, quantityMode: state.quantityMode, driverSettings: state.driverSettings, presets: state.presets }).catch(showError), 250);
}
function invalidatePlan() { currentPlan = null; }
function renderTree() {
  const walk = (id, depth) => folder(id).folderIds.map(gid => {
    const g = folder(gid);
    return `<button class="qp-tree-item qp-depth-${depth}${state.focusType === 'folder' && state.focusedFolder === gid ? ' is-focused' : ''}" data-folder="${esc(gid)}" title="${esc(g.relativePath)}" style="--qp-tree-depth:${depth}">${icon(depth ? 'corner-down-right' : 'folder')}<span>${esc(g.name)}</span><small>${descendantFiles(gid).length}</small></button>${walk(gid, depth + 1)}`;
  }).join('');
  $('#qp-tree-items').innerHTML = walk(tree.rootId, 0);
  $('#qp-root-count').textContent = folder(tree.rootId).folderIds.length + ' 组';
  $('#qp-file-count').textContent = files().length;
}
function renderRows() {
  const all = files();
  let html = '';
  function fileRows(id) {
    return folder(id).fileIds.map(fid => {
      const f = file(fid), invalid = !isValidFile(f);
      const custom = Object.keys(state.fileOverrides[fid] || {}).length > 0;
      const inherited = ancestors(f.parentId).some(g => Object.keys(state.folderOverrides[g.id] || {}).length > 0);
      const copies = Number(effective(f).copies) || 1;
      return `<tr class="qp-file-row${state.selected === fid && state.focusType === 'file' ? ' is-selected' : ''}${invalid ? ' has-error' : ''}" draggable="${!activeBatch()}" data-drag-file="${esc(fid)}"><td class="qp-check-cell"><input type="checkbox" data-check-file="${esc(fid)}" ${state.checked.has(fid) ? 'checked' : ''} ${invalid || activeBatch() ? 'disabled' : ''} aria-label="打印 ${esc(f.name)}"></td><td class="qp-number-cell">${String(all.findIndex(item => item.id === fid) + 1).padStart(2, '0')}</td><td><button class="qp-file-open" data-file="${esc(fid)}" title="${esc(f.path || f.relativePath)}">${icon(f.kind === 'image' ? 'image' : 'file-text')}<span><span class="qp-file-name">${esc(f.name)}</span>${invalid ? `<small class="qp-file-error-message">${esc(f.error || '文件页数尚不可用')}</small>` : ''}</span></button></td><td class="qp-copies-cell"><input class="qp-row-copies" data-file-copies="${esc(fid)}" type="number" min="1" max="100" step="1" value="${copies}" ${invalid || busy || activeBatch() ? 'disabled' : ''} aria-label="${esc(f.name)} 的基础份数" title="本行 ${copies} 份 × 全局 ${state.quantity} ${state.quantityMode === 'sets' ? '套' : '份'} = 共 ${copies * state.quantity} 份"></td><td class="qp-pages-cell">${f.pages || '—'}</td><td class="qp-state-cell ${invalid ? 'qp-file-error' : custom || inherited ? 'qp-overridden' : 'qp-inherited'}">${invalid ? '不可打印' : custom ? '自定义' : inherited ? '文件夹' : '默认'}</td></tr>`;
    }).join('');
  }
  function walk(id, depth) {
    folder(id).folderIds.forEach(gid => {
      const g = folder(gid), eligible = descendantFiles(gid).filter(isValidFile), checked = eligible.filter(f => state.checked.has(f.id)).length, collapsed = state.collapsed.has(gid);
      html += `<tr class="qp-folder-row${depth ? ' qp-subfolder' : ''}" draggable="${!activeBatch()}" data-drag-folder="${esc(gid)}"><td colspan="6"><div class="qp-folder-heading" style="padding-left:${Math.min(depth, 5) * 17 + 2}px"><input type="checkbox" data-check-folder="${esc(gid)}" ${eligible.length && checked === eligible.length ? 'checked' : ''} ${!eligible.length || activeBatch() ? 'disabled' : ''} aria-label="选择 ${esc(g.name)} 的全部文件"><span class="qp-drag-handle">${icon('grip-vertical')}</span><button data-collapse="${esc(gid)}" aria-label="${collapsed ? '展开' : '折叠'} ${esc(g.name)}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}</button><button data-folder="${esc(gid)}" title="${esc(g.relativePath)}">${icon('folder')}<span>${esc(g.name)}</span></button><small>${descendantFiles(gid).length} 个文件</small></div></td></tr>`;
      if (!collapsed) { html += fileRows(gid); walk(gid, depth + 1); }
    });
  }
  html += fileRows(tree.rootId);
  walk(tree.rootId, 0);
  $('#qp-file-rows').innerHTML = html;
  $$('[data-check-folder]').forEach(el => { const fs = descendantFiles(el.dataset.checkFolder).filter(isValidFile), n = fs.filter(f => state.checked.has(f.id)).length; el.indeterminate = n > 0 && n < fs.length; });
  const eligible = all.filter(isValidFile), selected = eligible.filter(f => state.checked.has(f.id));
  $('#qp-check-all').checked = eligible.length > 0 && selected.length === eligible.length;
  $('#qp-check-all').indeterminate = selected.length > 0 && selected.length < eligible.length;
  $('#qp-check-all').disabled = !eligible.length || activeBatch();
  $('#qp-empty-state').hidden = all.length > 0;
  $('#qp-remove-button').disabled = !all.length || activeBatch();
  $('#qp-list-caption').textContent = all.length ? `${all.length} 个文件 · ${selected.length} 个已勾选 · 按清单顺序打印` : '导入文件夹或添加文件开始';
}
function renderSettings() {
  const s = activeSettings(), f = file(state.selected), g = folder(state.focusedFolder), printer = activePrinter();
  $('[data-setting="paper"]').innerHTML = supportedPapers(printer).map(paper => `<option value="${esc(paper.value)}">${esc(paper.label)}</option>`).join('');
  $$('[data-scope]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.scope === state.scope)); b.disabled = (b.dataset.scope === 'file' && !f) || (b.dataset.scope === 'folder' && !g) || activeBatch(); });
  const overrides = state.scope === 'file' ? state.fileOverrides[state.selected] : state.scope === 'folder' ? state.folderOverrides[state.focusedFolder] : null;
  const overrideCount = Object.keys(overrides || {}).length;
  $('#qp-scope-title').textContent = state.scope === 'batch' ? '整批默认设置' : state.scope === 'file' ? f?.name || '请选择文件' : g?.name || '请选择文件夹';
  $('#qp-scope-caption').textContent = state.scope === 'batch' ? '应用于所有未单独设置的文件' : overrideCount ? `已单独设置 ${overrideCount} 项，其余属性继续继承` : state.scope === 'folder' ? '继承上级设置，包含下级文件夹' : '继承文件夹与整批设置';
  $('#qp-inherit').hidden = !overrideCount || state.scope === 'batch';
  $$('[data-setting]').forEach(el => { el.value = s[el.dataset.setting] ?? defaults[el.dataset.setting]; el.disabled = activeBatch() || (el.dataset.setting === 'color' && printer?.color === false) || (el.dataset.setting === 'duplex' && printer?.duplex === false); });
  $('#qp-file-settings').hidden = state.scope !== 'file';
  const fileCopies = Number(s.copies) || 1;
  $('#qp-file-copies').value = fileCopies;
  $('#qp-file-copies-label').textContent = state.quantityMode === 'sets' ? '每套内，此文件打印几份' : '此文件的基础份数';
  $('#qp-file-copies-hint').textContent = `${state.checked.has(state.selected) ? '' : '当前文件未勾选。'}${state.quantityMode === 'sets' ? `每套 ${fileCopies} 份 × ${state.quantity} 套` : `基础 ${fileCopies} 份 × 全局 ${state.quantity} 份`} = 共 ${fileCopies * state.quantity} 份`;
  $('#qp-copies-heading').textContent = state.quantityMode === 'sets' ? '份/套' : '基础份数';
  $('#qp-copies-heading').title = state.quantityMode === 'sets' ? '每套内此文件打印几份；总份数还会乘以右侧套数' : '此文件基础份数；实际份数 = 基础份数 × 右侧全局份数';
  $('#qp-page-ranges').value = s.pageRanges || '';
  $('#qp-boundary').checked = state.boundary;
  $('#qp-quantity').value = state.quantity;
  $('#qp-quantity-unit').textContent = state.quantityMode === 'sets' ? '套' : '份';
  $$('[name=qp-quantity-mode]').forEach(el => { el.checked = el.value === state.quantityMode; el.disabled = activeBatch(); });
  $('#qp-sequence-hint').textContent = state.quantityMode === 'sets' ? `A → B → C，整批重复 ${state.quantity} 套` : `A × ${state.quantity} → B × ${state.quantity} → C × ${state.quantity}`;
  $('#qp-sort').value = state.sort;
  $('#qp-order-label').textContent = '目录分组 · ' + ({ natural: '自然排序', reverse: '名称倒序', manual: '手动顺序' }[state.sort]);
  $('#qp-printer').value = state.printerName;
  $('#qp-printer').disabled = !printers.length || activeBatch();
  $('#qp-printer-info').textContent = printer ? [printer.color === false ? '黑白打印机' : printer.color === true ? '支持彩色' : '', printer.duplex ? '自动双面' : '', printer.isDefault ? '系统默认' : '', printer.status && printer.status !== 'ready' && printer.status !== 0 ? String(printer.status) : ''].filter(Boolean).join(' · ') || '已连接 Windows 打印队列' : '未找到可用打印机';
  $$('[data-action="driver-settings"]').forEach(el => { el.disabled = !printer || activeBatch() || busy; });
  ['#qp-boundary', '#qp-quantity', '#qp-file-copies', '#qp-page-ranges', '#qp-preset', '#qp-sort'].forEach(selector => { $(selector).disabled = activeBatch(); });
  $$('[data-file-copies]').forEach(el => { el.disabled = busy || activeBatch() || !isValidFile(file(el.dataset.fileCopies)); });
  $$('[data-action="import-folder"],[data-action="import-files"],[data-action="move-up"],[data-action="move-down"],[data-action="restore"],[data-action="refresh-printers"],[data-action="quantity-up"],[data-action="quantity-down"]').forEach(el => { el.disabled = busy || activeBatch() || !api; });
}
function renderTotals() {
  const p = plan(), t = p.summary;
  $('#qp-total-files').textContent = t.fileCount ?? t.files ?? state.checked.size;
  $('#qp-total-pages').textContent = t.pageCount ?? t.pages ?? '—';
  $('#qp-total-sheets').textContent = t.sheetCount ?? t.sheets ?? '—';
  $('#qp-print-count').textContent = state.checked.size;
  $('#qp-print-button').disabled = !api || !activePrinter() || !p.ready || !state.checked.size || busy || activeBatch();
  const errors = p.errors || [], blankSides = t.blankSides ?? t.blanks ?? 0;
  $('#qp-boundary-note').textContent = blankSides ? `当前设置预留 ${blankSides} 面空白背面` : '双面时，自动留出空白背面';
  $('#qp-footer-detail').textContent = errors.length ? errors[0].message : !state.checked.size ? '勾选要打印的文件，打印前核对顺序与属性' : [state.globalSettings.paper, state.globalSettings.color === 'color' ? '彩色' : '黑白', state.globalSettings.duplex === 'simplex' ? '单面' : '双面', state.quantityMode === 'sets' ? `整批 ${state.quantity} 套` : `每文件 ${state.quantity} 份`, Object.keys(state.folderOverrides).length || Object.keys(state.fileOverrides).length ? '含独立设置' : '', blankSides ? `预留 ${blankSides} 面空白` : ''].filter(Boolean).join(' · ');
  $('#qp-footer-detail').classList.toggle('qp-file-error', errors.length > 0);
  $('#qp-page-ranges').classList.toggle('is-invalid', errors.some(error => error.fileId === state.selected && /range|page/i.test(error.code || '')));
  $('#qp-list-view').hidden = state.view !== 'list';
  $('#qp-preview-view').hidden = state.view !== 'preview';
  $$('[data-action^="view-"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.action === 'view-' + state.view)));
  const batchLabel = { starting: '正在准备打印…', running: '正在有序提交', paused: '后续任务已暂停', stopping: '正在停止后续任务…', stopped: '已停止后续任务', submitted: '任务已提交至 Windows 队列', failed: '提交失败，请核对队列' };
  $('#qp-batch-status').textContent = currentBatch ? batchLabel[currentBatch.status] || currentBatch.status : '尚未提交打印任务';
}
function render() { renderTree(); renderRows(); renderSettings(); renderTotals(); icons(); }
function update() { invalidatePlan(); render(); savePreferences(); }
function setSetting(key, value) {
  if (activeBatch()) return;
  if (state.scope === 'file' && file(state.selected)) state.fileOverrides[state.selected] = { ...state.fileOverrides[state.selected], [key]: value };
  else if (state.scope === 'folder' && folder(state.focusedFolder)) state.folderOverrides[state.focusedFolder] = { ...state.folderOverrides[state.focusedFolder], [key]: value };
  else state.globalSettings[key] = value;
  update();
}
function setFileCopies(id, value) {
  if (busy || activeBatch() || !isValidFile(file(id))) return;
  const copies = Math.min(100, Math.max(1, Math.round(Number(value) || 1)));
  const wasSelected = state.selected === id;
  state.selected = id; state.focusedFolder = file(id).parentId; state.focusType = 'file'; state.scope = 'file';
  state.fileOverrides[id] = { ...state.fileOverrides[id], copies };
  if (!wasSelected) previewPage = 1;
  update();
  if (state.view === 'preview' && !wasSelected) renderPreview();
}
function focusFile(id) {
  if (!file(id)) return;
  state.selected = id; state.focusedFolder = file(id).parentId; state.focusType = 'file'; state.scope = 'file'; previewPage = 1;
  render(); if (state.view === 'preview') renderPreview();
}
function focusFolder(id) {
  state.focusedFolder = id; state.focusType = 'folder'; state.scope = 'folder';
  render();
  $$('[data-drag-folder]').find(el => el.dataset.dragFolder === id)?.scrollIntoView({ block: 'nearest' });
}
function sortTree(mode) {
  state.sort = mode;
  if (mode !== 'manual') {
    tree = structuredClone(tree);
    const compare = (a, b) => (mode === 'reverse' ? -1 : 1) * collator.compare(a.name, b.name);
    Object.values(tree.folders).forEach(g => { g.folderIds.sort((a, b) => compare(folder(a), folder(b))); g.fileIds.sort((a, b) => compare(file(a), file(b))); });
  }
  update();
}
function moveFocused(delta) {
  if (activeBatch()) return;
  const id = state.focusType === 'folder' ? state.focusedFolder : state.selected;
  if (!id) return;
  try { tree = moveItem(tree, { type: state.focusType === 'folder' ? 'folder' : 'file', id, delta }); state.sort = 'manual'; update(); } catch (error) { showError(error); }
}
function enforceCapabilities() {
  const printer = activePrinter();
  const targets = [state.globalSettings, ...Object.values(state.folderOverrides), ...Object.values(state.fileOverrides)];
  if (printer?.color === false) targets.forEach(s => { if ('color' in s) s.color = 'mono'; });
  if (printer?.duplex === false) targets.forEach(s => { if ('duplex' in s) s.duplex = 'simplex'; });
  const papers = supportedPapers(printer), defaultPaper = printer?.defaultSettings?.paperSize;
  const fallback = papers.find(p => p.value === 'A4') || papers.find(p => p.value === defaultPaper || p.label === defaultPaper?.name || p.label === defaultPaper) || papers[0];
  let changedPaper = false;
  if (fallback) targets.forEach(s => { if (s.paper && !papers.some(p => p.value === s.paper)) { s.paper = fallback.value; changedPaper = true; } });
  if (changedPaper) announce(`当前打印机不支持原纸张，已调整为 ${fallback.label}`);
}
async function refreshPrinters(silent = false) {
  if (!api) return;
  try {
    const result = await api.getPrinters();
    printers = Array.isArray(result) ? result : result.printers || [];
    if (!printers.some(p => p.name === state.printerName)) state.printerName = printers.find(p => p.isDefault)?.name || printers[0]?.name || '';
    $('#qp-printer').innerHTML = printers.length ? printers.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.isDefault ? '（默认）' : ''}</option>`).join('') : '<option value="">未找到打印机</option>';
    enforceCapabilities(); render();
    if (!silent) announce(printers.length ? `已读取 ${printers.length} 台打印机` : '请先在 Windows 设置中安装打印机');
  } catch (error) { $('#qp-printer').innerHTML = '<option value="">读取打印机失败</option>'; runtime('读取打印机失败：' + error.message, true); }
}
async function importItems(kind, droppedFiles = []) {
  if (!api || busy || activeBatch()) return;
  busy = true; renderSettings(); runtime('正在读取文件并统计页数…');
  let importWarningText = '';
  try {
    const result = await (kind === 'dropped' ? api.importDroppedFiles(droppedFiles) : kind === 'folder' ? api.pickFolder() : api.pickFiles());
    if (result.cancelled) return;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) importWarningText = `导入提示 ${warnings.length} 条：` + warnings.slice(0, 3).map(warning => typeof warning === 'string' ? warning : warning.message || String(warning)).join('；') + (warnings.length > 3 ? '；其余提示未展开' : '');
    const incoming = result.files || [], previous = tree;
    if (!incoming.length) { announce('未发现支持的 PDF、JPG 或 PNG 文件' + (warnings.length ? `，有 ${warnings.length} 条导入提示` : '')); return; }
    const existingFiles = new Map(files().map(f => [f.id, f]));
    const deduplicated = new Map(existingFiles);
    incoming.forEach(f => deduplicated.set(f.id, f));
    tree = buildTree([...deduplicated.values()]);
    if (state.sort === 'manual') Object.values(tree.folders).forEach(g => {
      const old = previous.folders[g.id]; if (!old) return;
      g.folderIds.sort((a, b) => { const ai = old.folderIds.indexOf(a), bi = old.folderIds.indexOf(b); return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi); });
      g.fileIds.sort((a, b) => { const ai = old.fileIds.indexOf(a), bi = old.fileIds.indexOf(b); return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi); });
    });
    incoming.forEach(f => {
      if (!isValidFile(f)) state.checked.delete(f.id);
      else if (!existingFiles.has(f.id) || !isValidFile(existingFiles.get(f.id))) state.checked.add(f.id);
    });
    if (!state.selected || !file(state.selected)) { state.selected = files()[0]?.id || null; state.focusedFolder = file(state.selected)?.parentId || null; state.focusType = 'file'; }
    if (state.sort !== 'manual') sortTree(state.sort);
    const invalid = incoming.filter(f => !isValidFile(f));
    announce(`已读取 ${incoming.length} 个文件${invalid.length ? `，其中 ${invalid.length} 个不可打印，已取消勾选` : ''}${result.skipped ? `，跳过 ${result.skipped} 个不支持的文件` : ''}${warnings.length ? `，有 ${warnings.length} 条导入提示` : ''}`);
    if (state.view === 'preview') renderPreview();
  } catch (error) { showError(error); }
  finally { busy = false; runtime(importWarningText); render(); }
}
function removeFocused() {
  if (activeBatch()) return;
  const removeIds = state.focusType === 'folder' ? descendantFiles(state.focusedFolder).map(f => f.id) : state.selected ? [state.selected] : [];
  if (!removeIds.length) { announce('先选中要移出的文件或文件夹'); return; }
  const preserved = files().filter(f => !removeIds.includes(f.id));
  removeIds.forEach(id => { state.checked.delete(id); delete state.fileOverrides[id]; });
  const old = tree;
  tree = buildTree(preserved);
  Object.values(tree.folders).forEach(g => { const previous = old.folders[g.id]; if (previous) { g.folderIds.sort((a, b) => previous.folderIds.indexOf(a) - previous.folderIds.indexOf(b)); g.fileIds.sort((a, b) => previous.fileIds.indexOf(a) - previous.fileIds.indexOf(b)); } });
  state.selected = files()[0]?.id || null; state.focusedFolder = file(state.selected)?.parentId || null; state.focusType = 'file'; state.scope = 'batch'; previewPage = 1;
  update(); if (state.view === 'preview') renderPreview(); announce(`已从清单移出 ${removeIds.length} 个文件，原文件保留`);
}

function byteArray(value) { return value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value?.data || value || []); }
async function loadPdfModule() {
  if (!pdfModule) {
    pdfModule = await import('../../node_modules/pdfjs-dist/build/pdf.mjs');
    pdfModule.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  }
  return pdfModule;
}
function previewMessage(message) { $('#qp-preview-message').textContent = message; $('#qp-preview-message').hidden = false; $('#qp-pdf-canvas').hidden = true; $('#qp-image-preview').hidden = true; }
async function renderPreview() {
  const f = file(state.selected), token = ++previewToken;
  pdfRenderTask?.cancel(); pdfRenderTask = null;
  if (state.view !== 'preview') return;
  if (!f) { previewMessage('从清单中选择文件'); return; }
  $('#qp-preview-title').textContent = f.name;
  $('#qp-preview-page-count').textContent = f.pages || '—';
  $('#qp-preview-page-number').value = previewPage;
  $('#qp-preview-page-number').max = f.pages || 1;
  $$('[data-action="previous-page"]').forEach(b => { b.disabled = previewPage <= 1 || f.kind === 'image'; });
  $$('[data-action="next-page"]').forEach(b => { b.disabled = previewPage >= (f.pages || 1) || f.kind === 'image'; });
  previewMessage('正在读取预览…');
  try {
    const data = f.kind === 'image' || pdfFileId !== f.id || !pdfDocument ? await api.getFileBytes(f.id) : null;
    if (token !== previewToken) return;
    if (f.kind === 'image' && data.kind !== 'pdf') {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(new Blob([byteArray(data.bytes)], { type: data.mimeType || (/\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg') }));
      const image = $('#qp-image-preview'); image.src = imageUrl; image.alt = f.name;
      await image.decode();
      if (token !== previewToken) return;
      const zoom = $('#qp-zoom').value;
      image.style.width = zoom === 'fit' ? '100%' : `${image.naturalWidth * Number(zoom)}px`;
      image.style.maxWidth = zoom === 'fit' ? '100%' : 'none';
      $('#qp-preview-message').hidden = true; image.hidden = false; return;
    }
    if (pdfFileId !== f.id || !pdfDocument) {
      if (pdfDocument) await pdfDocument.destroy();
      const pdfjs = await loadPdfModule();
      const loadingTask = pdfjs.getDocument({ data: byteArray(data.bytes), cMapUrl: new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href, wasmUrl: new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url).href, isEvalSupported: false });
      loadingTask.onPassword = (_updatePassword, reason) => { loadingTask.destroy(); if (token === previewToken) previewMessage(reason === 2 ? 'PDF 密码不正确，请使用已解密的文件。' : '此 PDF 需要密码，请先解密后重新导入。'); };
      const loaded = await loadingTask.promise;
      if (token !== previewToken) { await loaded.destroy(); return; }
      pdfDocument = loaded; pdfFileId = f.id;
    }
    previewPage = Math.max(1, Math.min(previewPage, pdfDocument.numPages));
    const page = await pdfDocument.getPage(previewPage);
    if (token !== previewToken) return;
    const base = page.getViewport({ scale: 1 }), zoom = $('#qp-zoom').value;
    const availableWidth = Math.max(180, $('#qp-paper-stage').clientWidth - 44);
    const scale = zoom === 'fit' ? availableWidth / base.width : Number(zoom);
    const viewport = page.getViewport({ scale }), ratio = window.devicePixelRatio || 1, canvas = $('#qp-pdf-canvas');
    canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = Math.floor(viewport.width) + 'px'; canvas.style.height = Math.floor(viewport.height) + 'px';
    const context = canvas.getContext('2d', { alpha: false });
    pdfRenderTask = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
    await pdfRenderTask.promise;
    if (token !== previewToken) return;
    $('#qp-preview-message').hidden = true; canvas.hidden = false;
    $('#qp-preview-page-count').textContent = pdfDocument.numPages; $('#qp-preview-page-number').value = previewPage;
  } catch (error) { if (error?.name !== 'RenderingCancelledException' && token === previewToken) previewMessage('无法预览：' + error.message); }
}
function setPreviewPage(value) { const f = file(state.selected); previewPage = Math.max(1, Math.min(Number(f?.pages) || 1, Math.round(Number(value) || 1))); renderPreview(); }

function openDialog(type, title, content, actions) {
  returnFocus = document.activeElement; dialog = type;
  $('#qp-dialog-title').textContent = title; $('#qp-dialog-eyebrow').textContent = type === 'queue' ? 'PRINT QUEUE' : 'QUEUEPRINT';
  $('#qp-dialog-body').innerHTML = content; $('#qp-dialog-actions').innerHTML = actions; $('#qp-overlay').hidden = false; icons();
  setTimeout(() => { $('#qp-dialog-actions button')?.focus(); }, 0);
}
function closeDialog() { dialog = null; $('#qp-overlay').hidden = true; if (returnFocus?.isConnected) returnFocus.focus(); }
function summaryOf(p) { return { files: p.summary.fileCount ?? p.summary.files ?? 0, pages: p.summary.pageCount ?? p.summary.pages ?? 0, sheets: p.summary.sheetCount ?? p.summary.sheets ?? 0, blanks: p.summary.blankSides ?? p.summary.blanks ?? 0 }; }
function unitFile(unit) { return file(unit.fileId ?? unit.id) || { name: unit.name || unit.path || '文件', relativePath: '', pages: unit.pageCount ?? unit.pages?.length ?? 0 }; }
function orderList(p) {
  return `<ol class="qp-order-list">${p.units.slice(0, 100).map((unit, index) => {
    const f = unitFile(unit), count = Array.isArray(unit.pages) ? unit.pages.length : unit.pageCount ?? f.pages;
    const copies = Number(unit.settings?.copies) || 1;
    const copyLabel = state.quantityMode === 'sets' ? `第 ${unit.setIndex || 1} 套 · 本文件第 ${unit.copyIndex || 1}/${copies} 份` : `本文件第 ${unit.copyIndex || 1}/${copies * state.quantity} 份`;
    return `<li><span>${index + 1}</span><span class="qp-order-filename" title="${esc(f.relativePath)}">${esc(f.name)}<small class="qp-unit-copy-label">${esc(copyLabel)}</small><small>${esc(f.relativePath || f.name)}</small></span><span class="qp-order-status">${count || '—'} 页${unit.appendBlank ? ' + 空白' : ''}</span></li>`;
  }).join('')}</ol>${p.units.length > 100 ? `<div class="qp-order-extra">仅展示前 100 项，共 ${p.units.length} 项，其他项依次提交。</div>` : ''}`;
}
function showOrder() {
  const p = plan(), s = summaryOf(p);
  openDialog('order', '核对出纸顺序', `<div class="qp-dialog-subtitle">${state.quantityMode === 'sets' ? '整批成套' : '逐文件多份'} · ${state.quantity} ${state.quantityMode === 'sets' ? '套' : '份'} · ${state.boundary ? '每文件从新纸开始' : '同属性文件连续排页'}</div>${p.errors.length ? `<div class="qp-dialog-errors">${p.errors.map(e => esc(e.message)).join('<br>')}</div>` : ''}${orderList(p)}<div class="qp-dialog-summary"><span>${s.files} 个文件 · ${s.pages} 页 · 预计 ${s.sheets} 张</span><span>${s.blanks ? `含 ${s.blanks} 面空白背面` : '每套独立起纸'}</span></div>`, '<button class="qp-button" data-action="close-dialog">返回调整</button>');
}
function confirmPrint() {
  if (busy || activeBatch()) return;
  const p = plan();
  if (!state.printerName) { announce('请先选择打印机'); return; }
  if (!p.ready || !state.checked.size) { announce(p.errors[0]?.message || '请勾选可以打印的文件'); return; }
  const s = summaryOf(p);
  currentPlan = p;
  openDialog('confirm', '确认批量打印', `<div class="qp-confirm-printer">${icon('printer')}<strong>${esc(state.printerName)}</strong></div><div class="qp-confirm-stats"><div><strong>${s.files}</strong>个文件</div><div><strong>${s.pages}</strong>页内容</div><div><strong>${s.sheets}</strong>张纸（预计）</div></div><div class="qp-dialog-subtitle">${state.quantityMode === 'sets' ? `整批打印 ${state.quantity} 套` : `每个文件打印 ${state.quantity} 份`} · ${state.boundary ? '每文件从新纸开始' : '同属性文件连续排页'}${s.blanks ? ` · 预留 ${s.blanks} 面空白背面` : ''}</div>${orderList(p)}<p class="qp-dialog-note">确认后将任务发送到上面的真实打印机。请核对打印机、顺序、套数及右侧设置。</p>`, '<button class="qp-button" data-action="close-dialog">返回调整</button><button class="qp-button qp-primary" data-action="submit-print">确认并打印</button>');
}
async function submitPrint() {
  if (dialog !== 'confirm' || !currentPlan || activeBatch()) return;
  const p = currentPlan;
  currentBatch = { status: 'starting', taskIndex: 0, totalTasks: p.tasks.length, submittedFiles: 0, totalFiles: p.units.length, jobs: [] };
  render(); showQueue();
  try {
    const result = await api.submitPrint({ ...p, printerName: state.printerName, devModeBase64: state.driverSettings[state.printerName]?.devModeBase64 || null, jobName: '序印 · 批量打印' });
    currentBatch.batchId ||= result.batchId; if (currentBatch.status === 'starting') currentBatch.status = 'running';
    render(); renderQueue();
  } catch (error) { currentBatch.status = 'failed'; currentBatch.error = error.message; currentBatch.message = error.message; render(); renderQueue(); }
}
function renderQueue() {
  if (dialog !== 'queue' || !currentBatch) return;
  const batch = currentBatch, total = batch.totalTasks ?? batch.taskCount ?? 0, completed = Math.max(0, Number(batch.taskIndex) || 0);
  const label = { starting: '正在准备打印任务…', running: '正在按清单顺序提交', paused: '后续任务已暂停', stopping: '正在停止后续提交…', stopped: '已停止后续任务', submitted: '全部任务已提交至 Windows 队列', failed: '任务提交失败' }[batch.status] || batch.status;
  const active = activeBatch();
  $('#qp-dialog-body').innerHTML = `<div class="qp-progress-heading"><span aria-live="polite">${esc(label)}</span><span>${Math.min(completed, total)} / ${total}</span></div><div class="qp-progress-track" role="progressbar" aria-label="任务提交进度" aria-valuemin="0" aria-valuemax="${Math.max(1, total)}" aria-valuenow="${Math.min(completed, total)}"><div class="qp-progress-fill" style="width:${total ? Math.min(100, completed / total * 100) : 0}%"></div></div>${batch.message || batch.error ? `<div class="${batch.status === 'failed' ? 'qp-dialog-errors' : 'qp-dialog-subtitle'}">${esc(batch.message || batch.error)}</div>` : ''}${(batch.jobs || []).map((job, index) => `<div class="qp-batch-job"><span>任务 ${index + 1}${job.jobId ? ` · Windows #${esc(job.jobId)}` : ''}<small>${job.documentName ? ' · ' + esc(job.documentName) : ''}</small></span><span>${esc(job.status || '已入队')}</span></div>`).join('')}<p class="qp-dialog-note">“已提交”表示 Windows 打印队列已接收任务，实际出纸情况以打印机为准。${batch.needsConfirmation || batch.status === 'failed' ? '<br>提交状态不明的任务不会自动重试，请先核对 Windows 队列和已输出材料。' : active ? '<br>暂停会阻止后续任务提交；当前已入队任务可能继续输出。' : ''}</p>`;
  $('#qp-dialog-actions').innerHTML = active ? `<button class="qp-button" data-action="stop-print" ${batch.status === 'stopping' ? 'disabled' : ''}>停止后续</button><button class="qp-button" data-action="close-dialog">返回清单</button><button class="qp-button qp-primary" data-action="${batch.status === 'paused' ? 'resume-print' : 'pause-print'}" ${batch.status === 'stopping' || batch.status === 'starting' ? 'disabled' : ''}>${batch.status === 'paused' ? '继续提交' : '暂停后续'}</button>` : '<button class="qp-button qp-primary" data-action="close-dialog">返回清单</button>';
}
function showQueue() { if (!currentBatch) { announce('尚未提交打印任务'); return; } openDialog('queue', '打印队列', '', ''); renderQueue(); }
async function queueAction(action) {
  try {
    if (action === 'pause-print') await api.pausePrint();
    else if (action === 'resume-print') await api.resumePrint();
    else if (action === 'stop-print') await api.stopPrint();
  } catch (error) { showError(error); }
}
async function showDriver() {
  if (!api || !state.printerName || activeBatch()) return;
  busy = true; renderSettings();
  try {
    const result = await api.showPrinterProperties({ printerName: state.printerName, devModeBase64: state.driverSettings[state.printerName]?.devModeBase64 });
    if (result.cancelled) return;
    state.driverSettings[state.printerName] = { devModeBase64: result.devModeBase64 || result.devmode };
    if (result.settings) { const allowed = Object.fromEntries(Object.entries(result.settings).filter(([key, value]) => key in defaults && value != null)); Object.assign(state.globalSettings, allowed); }
    state.scope = 'batch'; update(); announce('已应用本批次打印机属性');
  } catch (error) { showError(error); }
  finally { busy = false; renderSettings(); }
}
function savePresetDialog() { openDialog('preset', '保存打印方案', '<label class="qp-field"><span>方案名称</span><input id="qp-preset-name" type="text" maxlength="40" value="我的打印方案"></label><p class="qp-dialog-note">保存整批纸张、单双面、缩放与文件边界规则。文件夹和单文件的独立设置继续保留在当前清单。</p>', '<button class="qp-button" data-action="close-dialog">取消</button><button class="qp-button qp-primary" data-action="commit-preset">保存方案</button>'); }
function renderPresetOptions() { $('#qp-preset').innerHTML = '<option value="standard">常规文档</option><option value="receipt">报销票据 · 单面</option><option value="duplex">归档材料 · 双面</option>' + state.presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); }
function applyPreset(value) { const preset = state.presets.find(p => p.id === value); state.globalSettings = preset ? { ...defaults, ...preset.settings } : { ...defaults, duplex: value === 'duplex' ? 'long' : 'simplex', scale: value === 'receipt' ? 'actual' : 'fit' }; state.boundary = preset ? preset.boundary : true; enforceCapabilities(); state.scope = 'batch'; update(); announce('已应用整批方案，独立设置继续保留'); }
function setQuantity(value) { state.quantity = Math.min(100, Math.max(1, Math.round(Number(value) || 1))); update(); }

root.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.dataset.file) { focusFile(button.dataset.file); return; }
    if (button.dataset.folder) { focusFolder(button.dataset.folder); return; }
    if (button.dataset.collapse) { const id = button.dataset.collapse; state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id); renderRows(); icons(); return; }
    if (button.dataset.scope) { state.scope = button.dataset.scope; renderSettings(); return; }
    const action = button.dataset.action;
    if (action === 'import-folder' || action === 'import-files') await importItems(action === 'import-folder' ? 'folder' : 'files');
    else if (action === 'focus-all') { state.focusType = 'all'; state.scope = 'batch'; state.collapsed.clear(); render(); }
    else if (action === 'view-list' || action === 'view-preview') { state.view = action === 'view-list' ? 'list' : 'preview'; renderTotals(); if (state.view === 'preview') renderPreview(); }
    else if (action === 'move-up' || action === 'move-down') moveFocused(action === 'move-up' ? -1 : 1);
    else if (action === 'remove-selected') removeFocused();
    else if (action === 'restore') { if (state.scope === 'file') delete state.fileOverrides[state.selected]; else if (state.scope === 'folder') delete state.folderOverrides[state.focusedFolder]; update(); announce('已恢复继承上级设置'); }
    else if (action === 'quantity-up' || action === 'quantity-down') setQuantity(state.quantity + (action === 'quantity-up' ? 1 : -1));
    else if (action === 'show-order') showOrder();
    else if (action === 'confirm-print') confirmPrint();
    else if (action === 'submit-print') await submitPrint();
    else if (action === 'close-dialog') closeDialog();
    else if (action === 'show-queue') showQueue();
    else if (['pause-print', 'resume-print', 'stop-print'].includes(action)) await queueAction(action);
    else if (action === 'refresh-printers') await refreshPrinters();
    else if (action === 'driver-settings') await showDriver();
    else if (action === 'previous-page' || action === 'next-page') setPreviewPage(previewPage + (action === 'previous-page' ? -1 : 1));
    else if (action === 'save-preset') savePresetDialog();
    else if (action === 'commit-preset') { const name = $('#qp-preset-name').value.trim(); if (!name) { $('#qp-preset-name').focus(); return; } const id = 'preset-' + Date.now(); state.presets.push({ id, name, settings: { ...state.globalSettings }, boundary: state.boundary }); renderPresetOptions(); $('#qp-preset').value = id; closeDialog(); savePreferences(); announce('打印方案已保存'); }
  } catch (error) { showError(error); }
});
root.addEventListener('change', event => {
  const el = event.target;
  if (el.dataset.fileCopies) setFileCopies(el.dataset.fileCopies, el.value);
  else if (el.dataset.setting) setSetting(el.dataset.setting, el.value);
  else if (el.dataset.checkFile) { el.checked ? state.checked.add(el.dataset.checkFile) : state.checked.delete(el.dataset.checkFile); renderRows(); renderTotals(); icons(); }
  else if (el.dataset.checkFolder) { descendantFiles(el.dataset.checkFolder).filter(isValidFile).forEach(f => el.checked ? state.checked.add(f.id) : state.checked.delete(f.id)); renderRows(); renderTotals(); icons(); }
  else if (el.id === 'qp-check-all') { state.checked = new Set(el.checked ? files().filter(isValidFile).map(f => f.id) : []); renderRows(); renderTotals(); icons(); }
  else if (el.id === 'qp-sort') sortTree(el.value);
  else if (el.id === 'qp-quantity') setQuantity(el.value);
  else if (el.name === 'qp-quantity-mode') { state.quantityMode = el.value; update(); }
  else if (el.id === 'qp-boundary') { state.boundary = el.checked; update(); }
  else if (el.id === 'qp-file-copies') setSetting('copies', Math.min(100, Math.max(1, Math.round(Number(el.value) || 1))));
  else if (el.id === 'qp-page-ranges') setSetting('pageRanges', el.value.trim());
  else if (el.id === 'qp-printer') { state.printerName = el.value; enforceCapabilities(); update(); }
  else if (el.id === 'qp-preset') applyPreset(el.value);
  else if (el.id === 'qp-zoom') renderPreview();
  else if (el.id === 'qp-preview-page-number') setPreviewPage(el.value);
});
root.addEventListener('dragstart', event => {
  if (busy || activeBatch() || event.target.closest('input,select')) { event.preventDefault(); return; }
  const row = event.target.closest('[data-drag-file],[data-drag-folder]'); if (!row) return;
  dragged = row.dataset.dragFile ? { type: 'file', id: row.dataset.dragFile } : { type: 'folder', id: row.dataset.dragFolder };
  event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(dragged)); event.dataTransfer.effectAllowed = 'move';
});
root.addEventListener('dragover', event => { const row = event.target.closest('[data-drag-file],[data-drag-folder]'); if (!row || !dragged || !Array.from(event.dataTransfer?.types || []).includes(INTERNAL_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; $$('.qp-is-dragover').forEach(el => el.classList.remove('qp-is-dragover')); row.classList.add('qp-is-dragover'); });
root.addEventListener('dragend', () => { dragged = null; $$('.qp-is-dragover').forEach(el => el.classList.remove('qp-is-dragover')); clearExternalDrop(); });
root.addEventListener('drop', event => {
  const row = event.target.closest('[data-drag-file],[data-drag-folder]'); if (!row || !dragged || !Array.from(event.dataTransfer?.types || []).includes(INTERNAL_DRAG_TYPE)) return; event.preventDefault(); event.stopPropagation();
  const targetType = row.dataset.dragFile ? 'file' : 'folder', targetId = row.dataset.dragFile || row.dataset.dragFolder;
  try { if (targetType !== dragged.type) throw new Error('文件只能在组内移动，文件夹只能在同级移动'); tree = moveItem(tree, { ...dragged, beforeId: targetId }); state.focusType = dragged.type; if (dragged.type === 'file') { state.selected = dragged.id; state.focusedFolder = file(dragged.id).parentId; } else state.focusedFolder = dragged.id; state.sort = 'manual'; update(); } catch (error) { showError(error); render(); }
  dragged = null;
});
function isExternalFileDrag(event) { const types = Array.from(event.dataTransfer?.types || []); return types.includes('Files') && !types.includes(INTERNAL_DRAG_TYPE); }
function clearExternalDrop() { externalDragDepth = 0; $('#qp-drop-overlay').hidden = true; root.classList.remove('qp-external-drag'); }
function showExternalDrop() {
  const blocked = busy || activeBatch() || !api?.importDroppedFiles;
  $('#qp-drop-overlay').hidden = false; $('#qp-drop-overlay').classList.toggle('is-blocked', blocked); root.classList.add('qp-external-drag');
  $('#qp-drop-title').textContent = busy ? '正在读取文件，请稍后再拖入' : activeBatch() ? '打印任务进行中，暂不能导入' : !api?.importDroppedFiles ? '请通过新版序印桌面程序导入' : '松开鼠标，导入文件夹或文件';
  $('#qp-drop-caption').textContent = blocked ? '当前清单保持不变' : '支持 PDF、JPG、PNG，自动保留子文件夹分组';
}
document.addEventListener('dragenter', event => { if (!isExternalFileDrag(event)) return; event.preventDefault(); externalDragDepth += 1; showExternalDrop(); });
document.addEventListener('dragover', event => {
  if (Array.from(event.dataTransfer?.types || []).includes(INTERNAL_DRAG_TYPE)) return;
  event.preventDefault();
  if (!isExternalFileDrag(event)) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
  event.dataTransfer.dropEffect = busy || activeBatch() || !api?.importDroppedFiles ? 'none' : 'copy'; showExternalDrop();
});
document.addEventListener('dragleave', event => { if (!isExternalFileDrag(event)) return; event.preventDefault(); externalDragDepth = Math.max(0, externalDragDepth - 1); if (!externalDragDepth || !event.relatedTarget) clearExternalDrop(); });
document.addEventListener('drop', event => {
  event.preventDefault(); clearExternalDrop();
  if (!isExternalFileDrag(event)) return;
  const droppedFiles = Array.from(event.dataTransfer?.files || []);
  if (!droppedFiles.length) return;
  if (busy || activeBatch()) { announce(busy ? '正在读取文件，请稍后再导入' : '请先完成或停止当前打印批次，再导入新文件'); return; }
  if (!api?.importDroppedFiles) { announce('本地拖入组件未连接，请通过新版序印桌面程序启动'); return; }
  importItems('dropped', droppedFiles);
});
window.addEventListener('blur', clearExternalDrop);
root.addEventListener('keydown', event => {
  if (event.target.dataset.fileCopies && event.key === 'Enter') { event.preventDefault(); event.target.blur(); return; }
  if (!dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
  if (event.key === 'Tab') { const elements = [...$('#qp-overlay').querySelectorAll('button:not([disabled]),input,select')].filter(el => !el.hidden), first = elements[0], last = elements.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === 'preview' && $('#qp-zoom').value === 'fit') renderPreview(); }, 160); });
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); if (imageUrl) URL.revokeObjectURL(imageUrl); pdfDocument?.destroy(); });

async function initialize() {
  render();
  if (!api) { runtime('本地打印组件未连接。请通过“序印”桌面程序启动。', true); $('#qp-printer').innerHTML = '<option value="">本地组件未连接</option>'; renderSettings(); return; }
  api.onPrintProgress(progress => {
    if (currentBatch?.batchId && progress.batchId && currentBatch.batchId !== progress.batchId) return;
    currentBatch = { ...currentBatch, ...progress };
    renderSettings(); renderTotals(); renderQueue();
    if (progress.status === 'submitted') announce('所有任务已提交至 Windows 打印队列');
    if (progress.status === 'failed' && dialog !== 'queue') { showQueue(); }
  });
  try {
    const prefs = await api.loadPreferences();
    if (prefs) { state.globalSettings = { ...defaults, ...prefs.globalSettings }; state.printerName = prefs.printerName || ''; state.boundary = prefs.boundary !== false; state.quantityMode = prefs.quantityMode === 'copies' ? 'copies' : 'sets'; state.presets = Array.isArray(prefs.presets) ? prefs.presets : []; state.driverSettings = prefs.driverSettings || {}; }
    renderPresetOptions();
  } catch (error) { showError(error); }
  await refreshPrinters(true);
  render();
}
initialize().catch(error => runtime('启动失败：' + error.message, true));
