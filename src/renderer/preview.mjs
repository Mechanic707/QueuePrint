import { clampPreviewZoom, fitPreviewScale, calculateRasterSize, zoomScrollPosition } from './preview-math.mjs';

let pdfModulePromise;
const asBytes = value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value?.data || value || []);
const cancelled = () => Object.assign(new Error('Preview cancelled'), { name: 'PreviewCancelled' });
const versionKey = file => file ? [file.id, file.size ?? '', file.modified ?? file.lastModified ?? '', file.pages ?? '', file.kind].join('|') : '';
async function pdfModule() {
  if (!pdfModulePromise) pdfModulePromise = import('../../node_modules/pdfjs-dist/build/pdf.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
    return module;
  }).catch(error => { pdfModulePromise = null; throw error; });
  return pdfModulePromise;
}

export function createPreviewController({ root, api, onSelectFile }) {
  const $ = selector => root.querySelector(selector);
  const view = $('#qp-preview-view'), stage = $('#qp-paper-stage'), content = $('#qp-preview-content');
  const canvas = $('#qp-pdf-canvas'), image = $('#qp-image-preview'), message = $('#qp-preview-message');
  const picker = $('#qp-preview-file-select'), percentInput = $('#qp-zoom-percent');
  let allFiles = [], selected = null, visible = false, resource = null, serial = 0, renderTask = null;
  let renderQueue = Promise.resolve(), pageNumber = 1, zoomMode = 'width', zoomPercent = 100, layoutScale = 1, fileListKey = '';
  let pan = null, resizeTimer, lastSize = '', disposed = false;

  function isCurrent(token, context) { return visible && token === serial && resource === context && !context.disposed; }
  function loading(value) { view.dataset.loading = String(value); stage.setAttribute('aria-busy', String(value)); }
  function controls() {
    const index = allFiles.findIndex(file => file.id === selected?.id);
    picker.value = selected?.id || ''; picker.disabled = !allFiles.length;
    picker.title = selected?.relativePath || selected?.name || '选择预览文件';
    $('#qp-previous-file').disabled = index <= 0; $('#qp-next-file').disabled = index < 0 || index >= allFiles.length - 1;
    $('#qp-preview-file-position').textContent = `${index < 0 ? 0 : index + 1} / ${allFiles.length}`;
    $('#qp-preview-title').textContent = selected?.relativePath || selected?.name || '选择一个文件查看内容';
    const count = resource?.pdf?.numPages || (selected?.kind === 'image' ? 1 : selected?.pages || 0);
    $('#qp-preview-page-number').value = pageNumber; $('#qp-preview-page-number').max = Math.max(1, count); $('#qp-preview-page-number').disabled = !count;
    $('#qp-preview-page-count').textContent = count || '—';
    $('[data-action="previous-page"]').disabled = pageNumber <= 1 || !count;
    $('[data-action="next-page"]').disabled = !count || pageNumber >= count;
    if (document.activeElement !== percentInput) percentInput.value = Math.round(zoomPercent * 10) / 10;
    for (const id of ['#qp-zoom-out', '#qp-zoom-in', '#qp-zoom-percent', '#qp-preview-fit-width', '#qp-preview-fit-page', '#qp-preview-actual-size']) $(id).disabled = !selected;
    $('#qp-zoom-out').disabled = !selected || zoomPercent <= 10;
    $('#qp-zoom-in').disabled = !selected || zoomPercent >= 400;
    $('#qp-preview-fit-width').setAttribute('aria-pressed', String(zoomMode === 'width'));
    $('#qp-preview-fit-page').setAttribute('aria-pressed', String(zoomMode === 'page'));
    $('#qp-preview-actual-size').setAttribute('aria-pressed', String(zoomMode === 'custom' && Math.abs(zoomPercent - 100) < .001));
    view.dataset.fileId = selected?.id || ''; view.dataset.page = String(pageNumber); view.dataset.zoomMode = zoomMode; view.dataset.zoomPercent = String(Math.round(zoomPercent * 100) / 100); view.dataset.kind = selected?.kind || '';
  }
  function setMessage(text, hideContent = true) {
    message.textContent = text; message.hidden = false;
    if (hideContent) { content.hidden = true; canvas.hidden = true; image.hidden = true; }
  }
  function clearRenderTask() { try { renderTask?.cancel(); } catch {} }
  function release(context) {
    if (!context || context.disposed) return;
    context.disposed = true;
    const hadPdf = !!context.pdf; context.pdf = null;
    if (!hadPdf) void context.loadTask?.destroy().catch(() => {});
    void Promise.resolve(context.lastUse).catch(() => {}).then(async () => {
      // PDF.js 6 owns document/worker disposal on its loading task, not proxy.
      try { await context.loadTask?.destroy(); } catch {}
      if (context.url) {
        if (image.getAttribute('src') === context.url) image.removeAttribute('src');
        URL.revokeObjectURL(context.url); context.url = null;
      }
    });
  }
  function detach() {
    const old = resource; resource = null; // Clear identity before any awaited destroy.
    release(old);
  }
  function createResource(file) {
    const context = { key: versionKey(file), file, pdf: null, loadTask: null, url: null, image: null, disposed: false, lastUse: Promise.resolve() };
    const work = (async () => {
      const data = await api.getFileBytes(file.id);
      if (context.disposed) throw cancelled();
      if (file.kind === 'image' && data.kind !== 'pdf') {
        context.url = URL.createObjectURL(new Blob([asBytes(data.bytes)], { type: data.mimeType || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg') }));
        const decoded = new Image(); decoded.src = context.url; await decoded.decode();
        if (context.disposed) throw cancelled();
        context.image = decoded;
      } else {
        const module = await pdfModule();
        if (context.disposed) throw cancelled();
        const task = module.getDocument({ data: asBytes(data.bytes), cMapUrl: new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href, wasmUrl: new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url).href, isEvalSupported: false });
        context.loadTask = task;
        task.onPassword = () => { context.error = '此 PDF 需要密码，请先解密后重新导入。'; void task.destroy().catch(() => {}); };
        const loaded = await task.promise;
        if (context.disposed) { await task.destroy(); throw cancelled(); }
        context.pdf = loaded;
      }
      return context;
    })();
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { context.error = '读取预览超时，请检查文件后重试。'; void context.loadTask?.destroy().catch(() => {}); reject(new Error(context.error)); }, 45000); });
    context.promise = Promise.race([work, deadline]).finally(() => clearTimeout(timeout));
    context.promise.catch(() => {});
    return context;
  }
  function contentOffset() {
    const outer = stage.getBoundingClientRect(), inner = content.getBoundingClientRect();
    return { x: inner.left - outer.left - stage.clientLeft + stage.scrollLeft, y: inner.top - outer.top - stage.clientTop + stage.scrollTop };
  }
  function anchorAt(event) {
    if (content.hidden) return null;
    const rect = stage.getBoundingClientRect(), offset = contentOffset();
    const inside = event && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    return { scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop, anchorX: inside ? event.clientX - rect.left - stage.clientLeft : stage.clientWidth / 2, anchorY: inside ? event.clientY - rect.top - stage.clientTop : stage.clientHeight / 2, fromScale: layoutScale, oldOffsetX: offset.x, oldOffsetY: offset.y };
  }
  function geometry(width, height, scale, anchor, reset) {
    content.hidden = false; content.style.width = width + 'px'; content.style.height = height + 'px'; layoutScale = scale;
    if (reset) { stage.scrollLeft = 0; stage.scrollTop = 0; }
    else if (anchor) {
      const next = contentOffset(), scroll = zoomScrollPosition({ ...anchor, toScale: scale, newOffsetX: next.x, newOffsetY: next.y });
      stage.scrollLeft = scroll.scrollLeft; stage.scrollTop = scroll.scrollTop;
    }
    stage.classList.toggle('can-pan', stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1);
  }
  function scaleFor(width, height) {
    if (zoomMode === 'custom') return clampPreviewZoom(zoomPercent) / 100;
    const css = getComputedStyle(stage);
    return fitPreviewScale({ contentWidth: width, contentHeight: height, containerWidth: stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), containerHeight: stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), mode: zoomMode });
  }
  async function refresh({ anchor = null, reset = false } = {}) {
    if (!visible || !selected || disposed) return;
    const token = ++serial, file = selected, key = versionKey(file);
    clearRenderTask();
    if (resource && resource.key !== key) detach();
    if (!resource) resource = createResource(file);
    const context = resource;
    loading(true); view.dataset.error = ''; setMessage(context.pdf || context.image ? '正在渲染…' : '正在载入预览…', reset || content.hidden);
    controls();
    try {
      await context.promise;
      if (!isCurrent(token, context)) return;
      const operation = renderQueue.catch(() => {}).then(async () => {
        if (!isCurrent(token, context)) return;
        if (context.image) {
          const scale = scaleFor(context.image.naturalWidth, context.image.naturalHeight);
          zoomPercent = scale * 100;
          canvas.hidden = true; image.src = context.url; image.alt = file.name;
          await image.decode();
          if (!isCurrent(token, context)) return;
          image.hidden = false;
          geometry(context.image.naturalWidth * scale, context.image.naturalHeight * scale, scale, anchor, reset);
          image.dataset.fileId = file.id; view.dataset.renderLimited = 'false'; $('#qp-preview-resolution-note').hidden = true;
        } else {
          const document = context.pdf;
          pageNumber = Math.max(1, Math.min(pageNumber, document.numPages));
          const page = await document.getPage(pageNumber);
          if (!isCurrent(token, context)) return;
          const base = page.getViewport({ scale: 1 }), scale = scaleFor(base.width, base.height), viewport = page.getViewport({ scale });
          const raster = calculateRasterSize({ cssWidth: viewport.width, cssHeight: viewport.height, devicePixelRatio: window.devicePixelRatio || 1 });
          zoomPercent = scale * 100;
          image.hidden = true; canvas.hidden = false;
          // This queue only reaches here after the old RenderTask has settled.
          canvas.width = raster.width; canvas.height = raster.height; canvas.style.width = raster.cssWidth + 'px'; canvas.style.height = raster.cssHeight + 'px';
          geometry(raster.cssWidth, raster.cssHeight, scale, anchor, reset);
          const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: [raster.width / viewport.width, 0, 0, raster.height / viewport.height, 0, 0] });
          renderTask = task;
          try { await task.promise; } finally { if (renderTask === task) renderTask = null; }
          if (!isCurrent(token, context)) return;
          canvas.dataset.fileId = file.id; canvas.dataset.page = String(pageNumber);
          view.dataset.renderLimited = String(raster.limited); $('#qp-preview-resolution-note').hidden = !raster.limited;
        }
        if (!isCurrent(token, context)) return;
        message.hidden = true; controls();
      });
      context.lastUse = operation; renderQueue = operation.catch(() => {});
      await operation;
    } catch (error) {
      if (!visible || token !== serial || resource !== context) return;
      detach(); setMessage(context.error || '无法预览：' + error.message); view.dataset.error = error.name || 'PreviewError';
    } finally { if (visible && token === serial) { loading(false); controls(); } }
  }
  function releaseView() {
    ++serial; clearRenderTask(); detach(); loading(false); pan = null; stage.classList.remove('is-panning', 'can-pan');
    content.hidden = true; canvas.hidden = true; image.hidden = true;
    void renderQueue.catch(() => {}).then(() => { if (!visible && !resource) { canvas.width = 1; canvas.height = 1; } });
  }
  function sync({ files, selectedId, visible: nextVisible }) {
    if (disposed) return;
    allFiles = files;
    const signature = JSON.stringify(files.map(file => [file.id, file.relativePath, file.name]));
    if (signature !== fileListKey) {
      fileListKey = signature; picker.replaceChildren();
      let lastGroup = '', group;
      for (const file of files) {
        const label = (file.relativePath || file.name).replaceAll('\\', '/').split('/').slice(0, -1).join(' / ') || '单独添加的文件';
        if (!group || label !== lastGroup) { group = document.createElement('optgroup'); group.label = label; picker.append(group); lastGroup = label; }
        const option = document.createElement('option'); option.value = file.id; option.textContent = file.name; group.append(option);
      }
      if (!files.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '选择一个文件查看内容'; picker.append(option); }
    }
    const oldKey = versionKey(selected), next = files.find(file => file.id === selectedId) || null;
    const changed = oldKey !== versionKey(next), entering = !visible && nextVisible;
    selected = next; visible = !!nextVisible;
    if (!visible || !selected) {
      releaseView();
      if (!selected) { pageNumber = 1; setMessage(files.length ? '从文件选择器中选择文件' : '导入文件后可在这里预览'); }
      controls(); return;
    }
    if (changed || entering) { pageNumber = 1; releaseView(); visible = true; void refresh({ reset: true }); }
    controls();
  }
  function setPage(value) {
    const count = resource?.pdf?.numPages || (selected?.kind === 'image' ? 1 : selected?.pages || 1);
    pageNumber = Math.max(1, Math.min(count, Math.round(Number(value) || 1)));
    controls(); void refresh({ reset: true });
  }
  function setZoom(value, anchor = anchorAt()) {
    zoomMode = 'custom'; zoomPercent = clampPreviewZoom(value); percentInput.value = Math.round(zoomPercent * 10) / 10;
    controls(); void refresh({ anchor });
  }
  picker.addEventListener('change', () => { if (allFiles.some(file => file.id === picker.value)) onSelectFile(picker.value); });
  $('#qp-previous-file').addEventListener('click', () => { const index = allFiles.findIndex(file => file.id === selected?.id); if (index > 0) onSelectFile(allFiles[index - 1].id); });
  $('#qp-next-file').addEventListener('click', () => { const index = allFiles.findIndex(file => file.id === selected?.id); if (index >= 0 && index < allFiles.length - 1) onSelectFile(allFiles[index + 1].id); });
  $('#qp-zoom-out').addEventListener('click', () => setZoom(zoomPercent / 1.2));
  $('#qp-zoom-in').addEventListener('click', () => setZoom(zoomPercent * 1.2));
  percentInput.addEventListener('change', () => setZoom(percentInput.value));
  percentInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); setZoom(percentInput.value); percentInput.blur(); } });
  for (const [id, mode] of [['#qp-preview-fit-width', 'width'], ['#qp-preview-fit-page', 'page'], ['#qp-preview-actual-size', 'custom']]) $(id).addEventListener('click', () => {
    const anchor = anchorAt(); zoomMode = mode; if (mode === 'custom') zoomPercent = 100; controls(); void refresh({ anchor });
  });
  view.addEventListener('wheel', event => {
    if (!visible || !event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    const factor = Math.exp(-event.deltaY * units * .002);
    if ((zoomPercent <= 10 && factor <= 1) || (zoomPercent >= 400 && factor >= 1)) return;
    setZoom(zoomPercent * factor, anchorAt(event));
  }, { passive: false, capture: true });
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || content.hidden || event.target.closest('button,input,select,a') || !stage.classList.contains('can-pan')) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId); stage.classList.add('is-panning'); event.preventDefault();
  });
  stage.addEventListener('pointermove', event => { if (pan?.id !== event.pointerId) return; stage.scrollLeft = pan.left - event.clientX + pan.x; stage.scrollTop = pan.top - event.clientY + pan.y; event.preventDefault(); });
  const endPan = event => { if (pan?.id !== event.pointerId) return; pan = null; stage.classList.remove('is-panning'); if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); };
  stage.addEventListener('pointerup', endPan); stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('dragstart', event => event.preventDefault());
  const observer = new ResizeObserver(() => {
    const size = `${stage.clientWidth}:${stage.clientHeight}:${window.devicePixelRatio}`;
    if (size === lastSize) return; lastSize = size;
    if (visible && !content.hidden) stage.classList.toggle('can-pan', stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1);
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (visible && selected && zoomMode !== 'custom') void refresh({ anchor: anchorAt() }); }, 90);
  });
  observer.observe(stage);
  return { sync, refresh, setPage, dispose() { disposed = true; visible = false; observer.disconnect(); clearTimeout(resizeTimer); releaseView(); } };
}
