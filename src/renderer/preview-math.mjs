export const DEFAULT_PIXEL_BUDGET = 16_000_000;
export const MAX_CANVAS_EDGE = 8192;

const positive = (value, fallback = 1) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Percentage, not a CSS scale. Invalid values return the actual-size default. */
export function clampPreviewZoom(percent) {
  return Math.min(400, Math.max(10, finite(percent, 100)));
}

export function fitPreviewScale({ contentWidth, contentHeight, containerWidth, containerHeight, mode = 'width' } = {}) {
  if (mode === 'actual') return 1;
  const dimensions = [contentWidth, contentHeight, containerWidth, containerHeight].map(Number);
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) return 1;
  const [width, height, availableWidth, availableHeight] = dimensions;
  const scale = mode === 'page' ? Math.min(availableWidth / width, availableHeight / height) : availableWidth / width;
  // Automatic fitting can be below the manual 10% minimum for large pages.
  return Math.max(Number.MIN_VALUE, Math.min(4, scale));
}

/** Keep requested CSS size; reduce backing resolution under pixel/edge budgets. */
export function calculateRasterSize({ cssWidth, cssHeight, devicePixelRatio = 1, maxPixels = DEFAULT_PIXEL_BUDGET } = {}) {
  const w = positive(cssWidth), h = positive(cssHeight), dpr = positive(devicePixelRatio);
  const budget = Math.max(1, Math.floor(positive(maxPixels, DEFAULT_PIXEL_BUDGET)));
  let ratio = Math.min(dpr, MAX_CANVAS_EDGE / w, MAX_CANVAS_EDGE / h, Math.sqrt(budget / w / h));
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = Number.MIN_VALUE;
  let width = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.floor(w * ratio)));
  let height = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.floor(h * ratio)));
  // A one-pixel floor on an extreme aspect ratio can otherwise exceed budget.
  if (width * height > budget) {
    if (width >= height) width = Math.max(1, Math.floor(budget / height));
    else height = Math.max(1, Math.floor(budget / width));
  }
  return { width, height, cssWidth: w, cssHeight: h, renderRatio: Math.min(width / w, height / h), limited: ratio < dpr * (1 - 1e-9) };
}

/** Anchor is in viewport client coordinates; offsets are content-space offsets. */
export function zoomScrollPosition({ scrollLeft, scrollTop, anchorX, anchorY, fromScale, toScale, oldOffsetX, oldOffsetY, newOffsetX, newOffsetY } = {}) {
  const from = positive(fromScale), to = positive(toScale);
  const left = ((finite(scrollLeft) + finite(anchorX) - finite(oldOffsetX)) / from) * to + finite(newOffsetX) - finite(anchorX);
  const top = ((finite(scrollTop) + finite(anchorY) - finite(oldOffsetY)) / from) * to + finite(newOffsetY) - finite(anchorY);
  return { scrollLeft: Math.max(0, finite(left)), scrollTop: Math.max(0, finite(top)) };
}
