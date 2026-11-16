import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPreviewZoom,
  fitPreviewScale,
  calculateRasterSize,
  zoomScrollPosition,
} from '../src/renderer/preview-math.mjs';

const PIXEL_BUDGET = 24_000_000;
const MAX_EDGE = 8192;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);

function safeRaster(raster, budget = PIXEL_BUDGET) {
  for (const key of ['width', 'height']) {
    assert.ok(Number.isInteger(raster[key]) && raster[key] >= 1, `${key} must be a positive device-pixel integer`);
    assert.ok(raster[key] <= MAX_EDGE, `${key} must respect the canvas edge limit`);
  }
  assert.ok(raster.width * raster.height <= budget, 'device-pixel area exceeds the rendering budget');
  assert.ok(Number.isFinite(raster.renderRatio) && raster.renderRatio > 0, 'renderRatio must be usable by the renderer');
  assert.ok(Number.isFinite(raster.cssWidth) && raster.cssWidth > 0);
  assert.ok(Number.isFinite(raster.cssHeight) && raster.cssHeight > 0);
  assert.equal(typeof raster.limited, 'boolean');
}

test('manual preview zoom accepts 10%-400%, preserves decimals and safely handles invalid input', () => {
  for (const [input, expected] of [
    [10, 10], [400, 400], [125.5, 125.5], ['200', 200],
    [0, 10], [-50, 10], [1000, 400],
    [NaN, 100], [Infinity, 100], [-Infinity, 100], ['invalid zoom', 100], [undefined, 100],
  ]) {
    assert.equal(clampPreviewZoom(input), expected, String(input));
  }
});

test('a small image fits width or whole page, while 100% keeps its natural CSS dimensions', () => {
  const dimensions = Object.freeze({ contentWidth: 100, contentHeight: 50, containerWidth: 300, containerHeight: 120 });
  const widthScale = fitPreviewScale({ ...dimensions, mode: 'width' });
  near(widthScale, 3, 'fit-width scale');
  near(dimensions.contentWidth * widthScale, 300, 'fit-width displayed width');
  const pageScale = fitPreviewScale({ ...dimensions, mode: 'page' });
  near(pageScale, 2.4, 'fit-page scale');
  near(dimensions.contentHeight * pageScale, 120, 'fit-page displayed height');
  assert.ok(dimensions.contentWidth * pageScale <= dimensions.containerWidth);
  const actualScale = fitPreviewScale({ ...dimensions, containerWidth: 20, containerHeight: 20, mode: 'actual' });
  assert.equal(actualScale, 1);
  assert.equal(dimensions.contentWidth * actualScale, 100);
  assert.equal(dimensions.contentHeight * actualScale, 50);
});

test('automatic fit shrinks large pages below 10%, caps enlargement and rejects unusable sizes', () => {
  assert.equal(fitPreviewScale({ contentWidth: 10_000, contentHeight: 10_000, containerWidth: 100, containerHeight: 100, mode: 'page' }), 0.01);
  assert.equal(fitPreviewScale({ contentWidth: 1, contentHeight: 1, containerWidth: 10_000, containerHeight: 10_000, mode: 'width' }), 4);
  for (const dimensions of [
    { contentWidth: 2384, contentHeight: 3370, containerWidth: 650, containerHeight: 280 }, // A0 PDF.
    { contentWidth: 8000, contentHeight: 6000, containerWidth: 320, containerHeight: 180 }, // Large photo.
  ]) {
    const scale = fitPreviewScale({ ...dimensions, mode: 'page' });
    const displayedWidth = dimensions.contentWidth * scale;
    const displayedHeight = dimensions.contentHeight * scale;
    assert.ok(scale > 0 && scale < 0.1, 'automatic fit must be able to shrink below the manual 10% minimum');
    assert.ok(displayedWidth <= dimensions.containerWidth + 1e-8, 'whole-page fit overflows the container horizontally');
    assert.ok(displayedHeight <= dimensions.containerHeight + 1e-8, 'whole-page fit overflows the container vertically');
    assert.ok(Math.abs(displayedWidth - dimensions.containerWidth) < 1e-8
      || Math.abs(displayedHeight - dimensions.containerHeight) < 1e-8, 'whole-page fit should fill at least one available dimension');
  }
  const valid = { contentWidth: 600, contentHeight: 900, containerWidth: 300, containerHeight: 400, mode: 'page' };
  for (const key of ['contentWidth', 'contentHeight', 'containerWidth', 'containerHeight']) {
    for (const value of [0, -1, NaN, Infinity, undefined]) {
      assert.equal(fitPreviewScale({ ...valid, [key]: value }), 1, `${key}=${String(value)}`);
    }
  }
});

test('ordinary high-DPI preview keeps CSS size and uses the requested device-pixel density', () => {
  const input = Object.freeze({ cssWidth: 800, cssHeight: 1200, devicePixelRatio: 2, maxPixels: PIXEL_BUDGET });
  const raster = calculateRasterSize(input);
  safeRaster(raster);
  assert.equal(raster.cssWidth, 800);
  assert.equal(raster.cssHeight, 1200);
  assert.equal(raster.width, 1600);
  assert.equal(raster.height, 2400);
  assert.equal(raster.renderRatio, 2);
  assert.equal(raster.limited, false);
  assert.deepEqual(input, { cssWidth: 800, cssHeight: 1200, devicePixelRatio: 2, maxPixels: PIXEL_BUDGET });
});

test('large zoom and high DPI reduce raster resolution within 24M pixels without changing displayed size', () => {
  for (const dimensions of [
    { cssWidth: 4000, cssHeight: 6000, devicePixelRatio: 3 },
    { cssWidth: 16_000, cssHeight: 24_000, devicePixelRatio: 4 },
    { cssWidth: 24_000, cssHeight: 16_000, devicePixelRatio: 4 },
  ]) {
    const input = Object.freeze({ ...dimensions, maxPixels: PIXEL_BUDGET });
    const raster = calculateRasterSize(input);
    safeRaster(raster);
    assert.equal(raster.cssWidth, dimensions.cssWidth);
    assert.equal(raster.cssHeight, dimensions.cssHeight);
    assert.equal(raster.limited, true);
    assert.ok(raster.renderRatio < dimensions.devicePixelRatio);
    assert.ok(Math.abs(raster.width - raster.cssWidth * raster.renderRatio) <= 1);
    assert.ok(Math.abs(raster.height - raster.cssHeight * raster.renderRatio) <= 1);
  }
});

test('extreme aspect ratios and invalid raster inputs cannot request giant or nonfinite canvases', () => {
  for (const input of [
    { cssWidth: 1e12, cssHeight: 1, devicePixelRatio: 4, maxPixels: PIXEL_BUDGET },
    { cssWidth: 1, cssHeight: 1e12, devicePixelRatio: 4, maxPixels: PIXEL_BUDGET },
    { cssWidth: 1000, cssHeight: 2000, devicePixelRatio: 100_000, maxPixels: PIXEL_BUDGET },
    { cssWidth: 0, cssHeight: -10, devicePixelRatio: NaN, maxPixels: 0 },
    { cssWidth: NaN, cssHeight: Infinity, devicePixelRatio: Infinity, maxPixels: NaN },
    { cssWidth: 500, cssHeight: 900, devicePixelRatio: -1, maxPixels: -1 },
    {},
  ]) {
    safeRaster(calculateRasterSize(input));
  }
  const onePixel = calculateRasterSize({ cssWidth: 1000, cssHeight: 1000, devicePixelRatio: 4, maxPixels: 1 });
  safeRaster(onePixel, 1);
  assert.equal(onePixel.width, 1);
  assert.equal(onePixel.height, 1);
});

test('zoom preserves the document point beneath the pointer, including previously centered content', () => {
  const scenarios = [
    {
      input: { scrollLeft: 400, scrollTop: 300, anchorX: 150, anchorY: 80, fromScale: 1, toScale: 2 },
      expected: { scrollLeft: 950, scrollTop: 680 }, sourcePoint: { x: 550, y: 380 },
    },
    {
      // A 400x600 page centered in a 1000x800 viewport expands beyond it at 300%.
      input: { scrollLeft: 0, scrollTop: 0, anchorX: 500, anchorY: 400, fromScale: 1, toScale: 3,
        oldOffsetX: 300, oldOffsetY: 100, newOffsetX: 0, newOffsetY: 0 },
      expected: { scrollLeft: 100, scrollTop: 500 }, sourcePoint: { x: 200, y: 300 },
    },
  ];
  for (const { input, expected, sourcePoint } of scenarios) {
    const result = zoomScrollPosition(input);
    near(result.scrollLeft, expected.scrollLeft, 'new horizontal scroll');
    near(result.scrollTop, expected.scrollTop, 'new vertical scroll');
    near(sourcePoint.x * input.toScale + (input.newOffsetX || 0) - result.scrollLeft, input.anchorX, 'anchored document x');
    near(sourcePoint.y * input.toScale + (input.newOffsetY || 0) - result.scrollTop, input.anchorY, 'anchored document y');
    const restored = zoomScrollPosition({
      ...input, ...result, fromScale: input.toScale, toScale: input.fromScale,
      oldOffsetX: input.newOffsetX || 0, oldOffsetY: input.newOffsetY || 0,
      newOffsetX: input.oldOffsetX || 0, newOffsetY: input.oldOffsetY || 0,
    });
    near(restored.scrollLeft, input.scrollLeft, 'zoom round-trip horizontal scroll');
    near(restored.scrollTop, input.scrollTop, 'zoom round-trip vertical scroll');
  }
});

test('zooming out at a boundary clamps negative scroll and invalid input stays finite', () => {
  assert.deepEqual(zoomScrollPosition({
    scrollLeft: 0, scrollTop: 0, anchorX: 300, anchorY: 200, fromScale: 2, toScale: 1,
  }), { scrollLeft: 0, scrollTop: 0 });
  for (const invalidScale of [0, -1, NaN, Infinity]) {
    assert.deepEqual(zoomScrollPosition({
      scrollLeft: 25, scrollTop: 50, anchorX: 100, anchorY: 100,
      fromScale: invalidScale, toScale: invalidScale,
    }), { scrollLeft: 25, scrollTop: 50 });
  }
  const invalid = zoomScrollPosition({ scrollLeft: Infinity, scrollTop: NaN, anchorX: NaN, anchorY: Infinity, oldOffsetX: NaN, newOffsetY: Infinity });
  assert.ok(Number.isFinite(invalid.scrollLeft) && invalid.scrollLeft >= 0);
  assert.ok(Number.isFinite(invalid.scrollTop) && invalid.scrollTop >= 0);
});
