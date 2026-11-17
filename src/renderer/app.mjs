import { buildTree, orderedFiles, moveItem, resolveSettings, buildPrintPlan } from '../core/index.mjs';
import { createPreviewController } from './preview.mjs';

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
let toastTimer = null, saveTimer = null;
let externalDragDepth = 0;
let queueFileNodes = new Map(), queueJobNodes = new Map(), queueRenderFrame = 0;
const preview = createPreviewController({ root, api, onSelectFile: focusFile });

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
      return `<tr class="qp-file-row${state.selected === fid && state.focusType === 'file' ? ' is-selected' : ''}${invalid ? ' has-error' : ''}" draggable="${!activeBatch()}" data-drag-file="${esc(fid)}"><td class="qp-check-cell"><input type="checkbox" data-check-file="${esc(fid)}" ${state.checked.has(fid) ? 'checked' : ''} ${invalid || activeBatch() ? 'disabled' : ''} aria-label="打印 ${esc(f.name)}"></td><td class="qp-number-cell">${String(all.findIndex(item => item.id === fid) + 1).padStart(2, '0')}</td><td><button class="qp-file-open" data-file="${esc(fid)}" title="${esc(f.path || f.relativePath)}">${icon(f.kind === 'image' ? 'image' : 'file-text')}<span><span class="qp-file-name">${esc(f.name)}</span>${invalid ? `<small class="qp-file-error-message">${esc(f.error || '文件页数尚不可用')}</small>` : ''}</span></button></td><td class="qp-copies-cell"><input class="qp-row-copies" data-file-copies="${esc(fid)}" type="number" min="1" max="100" step="1" value="${copies}" ${invalid || busy || activeBatch() ? 'disabled' : ''} aria-label="${esc(f.name)} 的基础份数" title="本行 ${copies} 份 × 全局 ${state.quantity} ${state.quantityMode === 'sets' ? '套' : '份'} = 共 ${copies * state.quantity} 份"></td><td class="qp-pages-cell">${f.pages || '—'}</td><td class="qp-state-cell ${invalid ? 'qp-file-error' : custom || inherited ? 'qp-overridden' : 'qp-inherited'}">${invalid ? '不可打印' : custom ? '自定义' : inherited ? '文件夹' : '默认'}</td><td class="qp-remove-cell"><button class="qp-remove-item" type="button" data-remove-file="${esc(fid)}" ${busy || activeBatch() ? 'disabled' : ''} aria-label="移出文件 ${esc(f.name)}" title="从清单移出 ${esc(f.name)}，原文件保留">${icon('minus')}</button></td></tr>`;
    }).join('');
  }
  function walk(id, depth) {
    folder(id).folderIds.forEach(gid => {
      const g = folder(gid), eligible = descendantFiles(gid).filter(isValidFile), checked = eligible.filter(f => state.checked.has(f.id)).length, collapsed = state.collapsed.has(gid);
      html += `<tr class="qp-folder-row${depth ? ' qp-subfolder' : ''}" draggable="${!activeBatch()}" data-drag-folder="${esc(gid)}"><td colspan="7"><div class="qp-folder-heading" style="padding-left:${Math.min(depth, 5) * 17 + 2}px"><input type="checkbox" data-check-folder="${esc(gid)}" ${eligible.length && checked === eligible.length ? 'checked' : ''} ${!eligible.length || activeBatch() ? 'disabled' : ''} aria-label="选择 ${esc(g.name)} 的全部文件"><span class="qp-drag-handle">${icon('grip-vertical')}</span><button data-collapse="${esc(gid)}" aria-label="${collapsed ? '展开' : '折叠'} ${esc(g.name)}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}</button><button data-folder="${esc(gid)}" title="${esc(g.relativePath)}">${icon('folder')}<span>${esc(g.name)}</span></button><small>${descendantFiles(gid).length} 个文件</small><button class="qp-remove-item" type="button" data-remove-folder="${esc(gid)}" ${busy || activeBatch() ? 'disabled' : ''} aria-label="移出文件夹 ${esc(g.name)} 及全部内容" title="从清单移出 ${esc(g.name)} 及其子文件夹中的全部文件，原文件保留">${icon('minus')}</button></div></td></tr>`;
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
  renderRemoveControls();
  $('#qp-list-caption').textContent = all.length ? `${all.length} 个文件 · ${selected.length} 个已勾选 · 按清单顺序打印` : '导入文件夹或添加文件开始';
}
function renderRemoveControls() {
  const locked = busy || activeBatch();
  const target = state.focusType === 'folder' ? folder(state.focusedFolder) : file(state.selected);
  $('#qp-remove-button').disabled = locked || !target;
  $('#qp-remove-button').title = target ? `从清单移出 ${target.name}${state.focusType === 'folder' ? ' 及全部内容' : ''}，原文件保留` : '先选择要移出的文件或文件夹';
  $$('[data-remove-file],[data-remove-folder]').forEach(button => { button.disabled = locked; });
  $('#qp-preview-remove-file').disabled = locked || !file(state.selected);
}
function renderSettings() {
  renderRemoveControls();
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
  renderPreview();
  $$('[data-action^="view-"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.action === 'view-' + state.view)));
  renderBatchStatus();
}
function renderBatchStatus() {
  const batchLabel = { starting: '正在准备打印…', running: '正在有序提交', paused: '后续任务已暂停', stopping: '正在停止后续任务…', stopped: '已停止后续任务', submitted: '任务已提交至 Windows 队列', failed: '提交失败，请核对队列' };
  setText($('#qp-batch-status'), currentBatch ? batchLabel[currentBatch.status] || currentBatch.status : '尚未提交打印任务');
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
  update();
  if (state.view === 'preview' && !wasSelected) renderPreview();
}
function focusFile(id) {
  if (!file(id)) return;
  state.selected = id; state.focusedFolder = file(id).parentId; state.focusType = 'file'; state.scope = 'file';
  render(); if (state.view === 'preview') renderPreview();
}
function focusFolder(id) {
  state.focusedFolder = id; state.focusType = 'folder'; state.scope = 'folder';
  if (state.view === 'preview') {
    const descendants = descendantFiles(id);
    if (!descendants.some(item => item.id === state.selected)) state.selected = descendants[0]?.id || null;
  }
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
  const type = state.focusType === 'folder' ? 'folder' : 'file';
  const id = type === 'folder' ? state.focusedFolder : state.selected;
  if (!id) { announce('先选中要移出的文件或文件夹'); return; }
  removeItem(type, id);
}
function removeItem(type, id) {
  if (busy || activeBatch()) return;
  const target = type === 'folder' ? folder(id) : file(id);
  if (!target) return;
  const removed = new Set(type === 'folder' ? descendantFiles(id).map(f => f.id) : [id]);
  if (!removed.size) return;
  const before = files(), index = Math.max(0, before.findIndex(f => f.id === state.selected));
  const preserved = before.filter(f => !removed.has(f.id));
  const next = before.slice(index).find(f => !removed.has(f.id)) || before.slice(0, index).reverse().find(f => !removed.has(f.id));
  removed.forEach(fid => { state.checked.delete(fid); delete state.fileOverrides[fid]; });
  const old = tree;
  tree = buildTree(preserved);
  Object.values(tree.folders).forEach(g => { const previous = old.folders[g.id]; if (previous) { g.folderIds.sort((a, b) => previous.folderIds.indexOf(a) - previous.folderIds.indexOf(b)); g.fileIds.sort((a, b) => previous.fileIds.indexOf(a) - previous.fileIds.indexOf(b)); } });
  for (const gid of Object.keys(state.folderOverrides)) if (!folder(gid)) delete state.folderOverrides[gid];
  state.collapsed = new Set([...state.collapsed].filter(gid => folder(gid)));
  const keepFolderContext = (state.focusType === 'folder' || state.scope === 'folder') && folder(state.focusedFolder);
  if (!file(state.selected)) {
    state.selected = (keepFolderContext ? descendantFiles(state.focusedFolder)[0]?.id : null) || next?.id || null;
  }
  if (!keepFolderContext) {
    const lostFolderScope = state.scope === 'folder' && !folder(state.focusedFolder);
    state.focusedFolder = file(state.selected)?.parentId || null;
    if (state.focusType !== 'all') state.focusType = state.selected ? 'file' : 'all';
    if (lostFolderScope) state.scope = state.selected ? 'file' : 'batch';
  }
  if (!state.selected) { state.focusType = 'all'; state.scope = 'batch'; state.focusedFolder = null; }
  update();
  announce(type === 'folder' ? `已移出文件夹「${target.name}」及其中 ${removed.size} 个文件，原文件保留` : `已从清单移出「${target.name}」，原文件保留`);
}

function renderPreview() {
  const selected = file(state.selected);
  preview.sync({ files: files(), selectedId: state.selected, visible: state.view === 'preview',
    settings: selected ? effective(selected) : state.globalSettings, printer: activePrinter(),
    devModeBase64: state.driverSettings[state.printerName]?.devModeBase64 });
}
function setPreviewPage(value) { preview.setPage(value); }

function openDialog(type, title, content, actions) {
  returnFocus = document.activeElement; dialog = type;
  $('.qp-dialog').classList.toggle('is-progress-dialog', type === 'queue');
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
  const fileProgress = new Map();
  for (const unit of p.units) {
    const f = unitFile(unit), id = unit.fileId ?? unit.id;
    if (!fileProgress.has(id)) fileProgress.set(id, { fileId: id, name: f.name, relativePath: f.relativePath, totalUnits: 0, processedUnits: 0, submittedUnits: 0, uncertainUnits: 0 });
    fileProgress.get(id).totalUnits++;
  }
  currentBatch = { status: 'starting', taskIndex: 0, totalTasks: p.tasks.length, submittedFiles: 0, totalFiles: fileProgress.size, processedFiles: 0, totalUnits: p.units.length, processedUnits: 0, submittedUnits: 0, processedPages: 0, totalPages: p.summary.pageCount ?? p.summary.pages ?? 0, currentFile: null, fileProgress: [...fileProgress.values()], jobs: [] };
  render(); showQueue();
  try {
    const result = await api.submitPrint({ ...p, printerName: state.printerName, devModeBase64: state.driverSettings[state.printerName]?.devModeBase64 || null, jobName: '序印 · 批量打印' });
    currentBatch.batchId ||= result.batchId; if (currentBatch.status === 'starting') currentBatch.status = 'running';
    render(); renderQueue();
  } catch (error) { currentBatch.status = 'failed'; currentBatch.error = error.message; currentBatch.message = error.message; render(); renderQueue(); }
}
function progressNumber(value, fallback = 0) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback; }
function setText(element, value) { const text = String(value ?? ''); if (element.textContent !== text) element.textContent = text; }
function ensureQueueLayout() {
  if ($('#qp-progress-shell')) return;
  queueFileNodes = new Map(); queueJobNodes = new Map();
  $('#qp-dialog-body').innerHTML = `<div id="qp-progress-shell"><div class="qp-file-progress-heading"><div><span>文件处理进度</span><strong id="qp-processed-files">0 / 0</strong><small>个文件</small></div><span id="qp-file-progress-percent">0%</span></div><div id="qp-file-progress-bar" class="qp-progress-track" role="progressbar" aria-label="文件处理进度" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><div class="qp-progress-fill"></div></div><div class="qp-file-progress-stats"><div><span>已确认提交</span><strong id="qp-submitted-files">0 / 0</strong><small>个文件</small></div><div id="qp-unit-progress-wrap"><span>已处理份次</span><strong id="qp-processed-units">0 / 0</strong><small>份次</small></div><div><span>处理页数</span><strong id="qp-processed-pages">0 / 0</strong><small>页</small></div></div><div id="qp-current-file" class="qp-current-file" hidden><div><span id="qp-current-file-label">正在处理</span><strong id="qp-current-file-name"></strong></div><p id="qp-current-file-path"></p><span id="qp-current-file-pages"></span></div><div id="qp-progress-feedback" class="qp-progress-feedback" role="status" aria-live="polite"></div><div class="qp-progress-list-title"><strong>文件清单</strong><span id="qp-progress-list-count"></span></div><ol id="qp-progress-list" class="qp-file-progress-list" aria-label="逐文件处理进度"></ol><p id="qp-progress-list-more" class="qp-progress-list-more" hidden></p><details id="qp-windows-details" class="qp-windows-details"><summary>Windows 队列详情 <span id="qp-windows-job-count"></span></summary><p id="qp-windows-task-count"></p><div id="qp-windows-jobs"></div><p class="qp-dialog-note">Windows 作业可以合并多个文件，因此作业数与文件数不同。</p></details><p id="qp-progress-notice" class="qp-dialog-note">文件处理表示已生成打印内容；已确认提交表示 Windows 已接收任务。实际出纸情况以打印机为准。</p></div>`;
  $('#qp-dialog-actions').innerHTML = '<button id="qp-stop-progress-button" class="qp-button" data-action="stop-print">停止后续作业</button><button id="qp-close-progress-button" class="qp-button" data-action="close-dialog">返回清单</button><button id="qp-pause-progress-button" class="qp-button qp-primary" data-action="pause-print" title="当前 Windows 作业继续处理，只暂停后续作业">暂停后续作业</button>';
}
function renderQueue() {
  if (dialog !== 'queue' || !currentBatch) return;
  ensureQueueLayout();
  const batch = currentBatch, active = activeBatch();
  const entries = (Array.isArray(batch.fileProgress) ? batch.fileProgress : []).map(entry => {
    const totalUnits = Math.max(1, progressNumber(entry.totalUnits, 1));
    const submittedUnits = Math.min(totalUnits, progressNumber(entry.submittedUnits));
    return { ...entry, totalUnits, submittedUnits, processedUnits: Math.min(totalUnits, Math.max(submittedUnits, progressNumber(entry.processedUnits))), uncertainUnits: Math.min(totalUnits, progressNumber(entry.uncertainUnits)) };
  });
  const totalFiles = Math.max(entries.length, progressNumber(batch.totalFiles));
  const processedFiles = Math.min(totalFiles, progressNumber(batch.processedFiles, entries.filter(entry => entry.processedUnits >= entry.totalUnits).length));
  const submittedFiles = Math.min(totalFiles, progressNumber(batch.submittedFiles, entries.filter(entry => entry.submittedUnits >= entry.totalUnits).length));
  const totalUnits = progressNumber(batch.totalUnits, entries.reduce((sum, entry) => sum + entry.totalUnits, 0));
  const processedUnits = Math.min(totalUnits, progressNumber(batch.processedUnits, entries.reduce((sum, entry) => sum + entry.processedUnits, 0)));
  const percent = totalFiles ? Math.floor(processedFiles / totalFiles * 100) : 0;
  setText($('#qp-processed-files'), `${processedFiles} / ${totalFiles}`);
  setText($('#qp-submitted-files'), `${submittedFiles} / ${totalFiles}`);
  setText($('#qp-processed-units'), `${processedUnits} / ${totalUnits}`);
  setText($('#qp-processed-pages'), `${progressNumber(batch.processedPages)} / ${progressNumber(batch.totalPages)}`);
  setText($('#qp-file-progress-percent'), percent + '%');
  $('#qp-unit-progress-wrap').hidden = totalUnits <= totalFiles;
  const bar = $('#qp-file-progress-bar'); bar.setAttribute('aria-valuemax', String(Math.max(1, totalFiles))); bar.setAttribute('aria-valuenow', String(processedFiles)); bar.querySelector('.qp-progress-fill').style.width = percent + '%';
  const current = batch.currentFile;
  // A completed document has no currentFile until the next document starts.
  // Keep this status slot in the layout so each file boundary cannot move the
  // centered dialog or the list the user is reading.
  $('#qp-current-file').hidden = false;
  $('#qp-current-file').dataset.idle = String(!current);
  if (current) {
    setText($('#qp-current-file-label'), active && batch.status !== 'paused' ? '正在处理' : '最近处理');
    setText($('#qp-current-file-name'), current.name || file(current.fileId)?.name || '文件');
    setText($('#qp-current-file-path'), current.relativePath || file(current.fileId)?.relativePath || '');
    const copy = `第 ${Math.max(1, progressNumber(current.copyIndex, 1))} / ${Math.max(1, progressNumber(current.totalUnits, 1))} 份`;
    const pages = current.blank ? '补入空白背面' : `内容页 ${progressNumber(current.processedPages)} / ${progressNumber(current.contentPages)} 页`;
    setText($('#qp-current-file-pages'), [current.setIndex ? `第 ${current.setIndex} 套` : '', copy, pages].filter(Boolean).join(' · '));
  } else {
    const idle = { starting: '正在准备文件', paused: '已暂停后续作业', stopping: '正在停止后续作业', stopped: '已停止文件处理', submitted: '本批次文件已处理完毕', failed: '本批次已停止处理' }[batch.status] || (processedFiles === totalFiles ? '文件已处理，等待确认提交' : '等待处理下一个文件');
    setText($('#qp-current-file-label'), active ? '处理状态' : '本批次');
    setText($('#qp-current-file-name'), idle);
    setText($('#qp-current-file-path'), '当前没有正在处理的文件');
    setText($('#qp-current-file-pages'), `已处理 ${progressNumber(batch.processedPages)} / ${progressNumber(batch.totalPages)} 页`);
  }
  const label = { starting: '正在准备文件与打印设置…', running: totalFiles > 0 && processedFiles === totalFiles && submittedFiles < totalFiles ? '文件已处理，等待 Windows 确认提交。' : '正在处理文件，按清单顺序提交。', paused: '后续 Windows 作业已暂停；当前已入队内容可能继续输出。', stopping: '正在停止后续作业，当前作业仍可能继续处理。', stopped: '已停止后续作业，请核对已确认提交的文件。', submitted: submittedFiles === totalFiles ? '全部文件已确认提交至 Windows 队列。' : '批次已结束，仍有文件未确认提交，请核对队列。', failed: batch.message || batch.error || '提交失败，请核对 Windows 队列与已输出材料。' }[batch.status] || batch.message || '';
  setText($('#qp-progress-feedback'), label);
  $('#qp-progress-feedback').classList.toggle('is-error', batch.status === 'failed' || !!batch.needsConfirmation);
  const displayed = entries.slice(0, 100), visibleIds = new Set(displayed.map(entry => String(entry.fileId)));
  for (const [id, node] of queueFileNodes) if (!visibleIds.has(id)) { node.remove(); queueFileNodes.delete(id); }
  const list = $('#qp-progress-list');
  displayed.forEach((entry, index) => {
    const id = String(entry.fileId);
    let node = queueFileNodes.get(id);
    if (!node) {
      node = document.createElement('li'); node.dataset.progressFile = id;
      node.innerHTML = '<span class="qp-progress-file-number"></span><div class="qp-progress-file-content"><strong></strong><span class="qp-progress-file-path"></span><small></small></div><span class="qp-progress-file-state"></span>';
      queueFileNodes.set(id, node);
    }
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    const pending = entry.submittedUnits < entry.totalUnits;
    const stateName = entry.uncertainUnits > 0 ? 'uncertain' : !pending ? 'submitted' : entry.processedUnits >= entry.totalUnits ? 'processed' : current?.fileId === entry.fileId && ['running', 'stopping'].includes(batch.status) ? 'running' : entry.submittedUnits > 0 ? 'partial-submitted' : entry.processedUnits > 0 ? 'partial-processed' : 'waiting';
    node.dataset.state = stateName;
    setText(node.querySelector('.qp-progress-file-number'), index + 1);
    setText(node.querySelector('strong'), entry.name || file(entry.fileId)?.name || '文件');
    setText(node.querySelector('.qp-progress-file-path'), entry.relativePath || file(entry.fileId)?.relativePath || '');
    setText(node.querySelector('small'), `已处理 ${entry.processedUnits}/${entry.totalUnits} 份 · 已确认提交 ${entry.submittedUnits}/${entry.totalUnits} 份${entry.uncertainUnits ? ` · ${entry.uncertainUnits} 份待核对` : ''}`);
    setText(node.querySelector('.qp-progress-file-state'), { uncertain: '待核对', submitted: '已提交', processed: '已处理待提交', running: '处理中', 'partial-submitted': '部分已提交', 'partial-processed': '部分已处理', waiting: '待处理' }[stateName]);
  });
  setText($('#qp-progress-list-count'), `${totalFiles} 个源文件`);
  $('#qp-progress-list-more').hidden = totalFiles <= displayed.length;
  setText($('#qp-progress-list-more'), `仅显示前 ${displayed.length} 个文件，另 ${Math.max(0, totalFiles - displayed.length)} 个文件计入总体进度。`);
  const jobs = Array.isArray(batch.jobs) ? batch.jobs : [], tasks = progressNumber(batch.totalTasks ?? batch.taskCount), completedTasks = Math.min(tasks, progressNumber(batch.taskIndex));
  const confirmedTasks = Math.min(tasks, Math.max(completedTasks, jobs.filter(job => job.status === 'submitted').length));
  setText($('#qp-windows-job-count'), `${jobs.length} 个作业`);
  setText($('#qp-windows-task-count'), `Windows 作业：${confirmedTasks} / ${tasks} 已确认提交`);
  const jobIds = new Set();
  jobs.forEach((job, index) => {
    const id = `${index}:${job.jobId || ''}`; jobIds.add(id);
    let node = queueJobNodes.get(id);
    if (!node) { node = document.createElement('div'); node.className = 'qp-batch-job'; node.innerHTML = '<span><strong></strong><small></small></span><span class="qp-windows-job-state"></span>'; queueJobNodes.set(id, node); $('#qp-windows-jobs').append(node); }
    setText(node.querySelector('strong'), `作业 ${index + 1}${job.jobId ? ` · Windows #${job.jobId}` : ''}`);
    setText(node.querySelector('small'), job.documentName || '');
    setText(node.querySelector('.qp-windows-job-state'), { submitted: '已提交', queued: '已入队', spooling: '入队中', failed: '失败', unknown: '待核对' }[job.status] || job.status || '已提交');
  });
  for (const [id, node] of queueJobNodes) if (!jobIds.has(id)) { node.remove(); queueJobNodes.delete(id); }
  setText($('#qp-progress-notice'), '文件处理表示已生成打印内容；已确认提交表示 Windows 已接收任务。实际出纸情况以打印机为准。' + (batch.needsConfirmation || batch.status === 'failed' ? ' 提交状态不明的任务不会自动重试，请先核对队列与已输出材料。' : active ? ' 暂停仅阻止后续 Windows 作业，当前作业可能继续处理和输出。' : ''));
  $('#qp-stop-progress-button').hidden = !active; $('#qp-pause-progress-button').hidden = !active;
  $('#qp-stop-progress-button').disabled = batch.status === 'stopping';
  $('#qp-pause-progress-button').disabled = ['starting', 'stopping'].includes(batch.status);
  $('#qp-pause-progress-button').dataset.action = batch.status === 'paused' ? 'resume-print' : 'pause-print';
  setText($('#qp-pause-progress-button'), batch.status === 'paused' ? '继续提交' : '暂停后续作业');
  $('#qp-close-progress-button').classList.toggle('qp-primary', !active);
}
function showQueue() { if (!currentBatch) { announce('尚未提交打印任务'); return; } openDialog('queue', '打印队列', '', ''); renderQueue(); }
function scheduleQueueRender() {
  if (queueRenderFrame || dialog !== 'queue') return;
  queueRenderFrame = requestAnimationFrame(() => { queueRenderFrame = 0; renderQueue(); });
}
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
    if (button.dataset.removeFile) { removeItem('file', button.dataset.removeFile); return; }
    if (button.dataset.removeFolder) { removeItem('folder', button.dataset.removeFolder); return; }
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
    else if (action === 'remove-preview-file') removeItem('file', state.selected);
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
    else if (action === 'previous-page' || action === 'next-page') setPreviewPage(Number($('#qp-preview-page-number').value) + (action === 'previous-page' ? -1 : 1));
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
  else if (el.id === 'qp-preview-page-number') setPreviewPage(el.value);
});
root.addEventListener('dragstart', event => {
  if (busy || activeBatch() || event.target.closest('input,select,[data-remove-file],[data-remove-folder]')) { event.preventDefault(); return; }
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
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); cancelAnimationFrame(queueRenderFrame); preview.dispose(); });

async function initialize() {
  render();
  if (!api) { runtime('本地打印组件未连接。请通过“序印”桌面程序启动。', true); $('#qp-printer').innerHTML = '<option value="">本地组件未连接</option>'; renderSettings(); return; }
  api.onPrintProgress(progress => {
    if (currentBatch?.batchId && progress.batchId && currentBatch.batchId !== progress.batchId) return;
    const wasActive = activeBatch(), previousStatus = currentBatch?.status;
    currentBatch = { ...currentBatch, ...progress };
    // Page events only change the queue. Rebuilding printer settings and
    // recalculating the complete print plan for every page repaints the blurred
    // workbench behind the dialog and needlessly competes with progress frames.
    if (wasActive !== activeBatch()) { renderSettings(); renderTotals(); }
    else if (previousStatus !== currentBatch.status) renderBatchStatus();
    scheduleQueueRender();
    if (progress.status === 'submitted' && previousStatus !== 'submitted') announce('所有任务已提交至 Windows 打印队列');
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
