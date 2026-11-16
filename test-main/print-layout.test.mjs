import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrintLayout, resolvePreviewLandscape, PRINT_LAYOUT_UNIT, POINTS_PER_PRINT_UNIT } from '../src/renderer/print-layout.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-7, `${actual} differs from ${expected}`);
const nearRect = (actual, expected) => { for (const key of ['x', 'y', 'width', 'height']) near(actual[key], expected[key]); };
const driverA4 = {
  dimensionUnit: 'hundredths-inch', landscape: false,
  paper: { width: 827, height: 1169 },
  printableArea: { x: 17, y: 19, width: 793, height: 1129 },
};

test('A4 preview exposes physical sheet size, independently of the source size', () => {
  const result = calculatePrintLayout({ source: { width: 400, height: 600 } });
  assert.equal(result.dimensionUnit, PRINT_LAYOUT_UNIT);
  assert.equal(POINTS_PER_PRINT_UNIT, .72);
  assert.deepEqual(result.paper, { x: 0, y: 0, width: 827, height: 1169 });
  assert.equal(result.paperName, 'A4');
  assert.equal(result.geometrySource, 'paper-size');
  near(result.destination.height, 1169);
  near(result.destination.width, 779.3333333333333);
  near(result.destination.x, 23.83333333333337);
  assert.equal(result.clipped, false);
});

test('driver printable margins set the physical placement of a fitted square', () => {
  const result = calculatePrintLayout({ source: { width: 600, height: 600 }, driverGeometry: driverA4 });
  assert.equal(result.geometrySource, 'driver');
  assert.deepEqual(result.paper, { x: 0, y: 0, width: 827, height: 1169 });
  nearRect(result.destination, { x: 17, y: 187, width: 793, height: 793 });
  assert.deepEqual(result.clip, driverA4.printableArea);
  assert.equal(result.clipped, false);
});

test('actual size retains physical dimensions and shows the printable-area crop', () => {
  const result = calculatePrintLayout({ source: { width: 900, height: 1200 }, settings: { scale: 'actual' }, driverGeometry: driverA4 });
  assert.equal(result.scale, 1);
  assert.deepEqual(result.destination, { x: -36.5, y: -16.5, width: 900, height: 1200 });
  assert.deepEqual(result.clip, { x: 17, y: 19, width: 793, height: 1129 });
  assert.equal(result.clipped, true);
});

test('shrink preserves a small 300-DPI image at its actual inch dimensions', () => {
  // Native inspect converts a 600 x 300 pixel, 300-DPI image to 200 x 100 units.
  const options = { source: { width: 200, height: 100 }, settings: { orientation: 'portrait', scale: 'shrink' }, driverGeometry: driverA4 };
  const result = calculatePrintLayout(options);
  assert.equal(result.scale, 1);
  assert.deepEqual(result.destination, { x: 313.5, y: 533.5, width: 200, height: 100 });
  const fitted = calculatePrintLayout({ ...options, settings: { ...options.settings, scale: 'fit' } });
  near(fitted.scale, 3.965);
  near(fitted.destination.width, 793);
  assert.equal(fitted.clipped, false);
});

test('shrink reduces an oversized source without exceeding driver printable bounds', () => {
  const result = calculatePrintLayout({ source: { width: 1586, height: 2258 }, settings: { scale: 'shrink' }, driverGeometry: driverA4 });
  assert.equal(result.scale, .5);
  assert.deepEqual(result.destination, driverA4.printableArea);
  assert.equal(result.clipped, false);
});

test('automatic orientation is resolved for each page and square pages stay portrait', () => {
  assert.equal(resolvePreviewLandscape({ source: { width: 1200, height: 600 } }), true);
  assert.equal(resolvePreviewLandscape({ source: { width: 600, height: 1200 } }), false);
  assert.equal(resolvePreviewLandscape({ source: { width: 600, height: 600 } }), false);
  const landscape = calculatePrintLayout({ source: { width: 1200, height: 600 }, settings: { paper: 'A4' } });
  const portrait = calculatePrintLayout({ source: { width: 600, height: 1200 }, settings: { paper: 'A4' } });
  assert.deepEqual(landscape.paper, { x: 0, y: 0, width: 1169, height: 827 });
  assert.deepEqual(portrait.paper, { x: 0, y: 0, width: 827, height: 1169 });
  assert.equal(landscape.landscape, true);
  assert.equal(portrait.landscape, false);
});

test('explicit orientation and native landscape overrides have native precedence', () => {
  const source = { width: 1200, height: 600 };
  assert.equal(resolvePreviewLandscape({ source, settings: { orientation: 'portrait' } }), false);
  assert.equal(resolvePreviewLandscape({ source, settings: { orientation: 'portrait', landscape: true } }), true);
  assert.equal(resolvePreviewLandscape({ source, settings: { orientation: 'landscape', landscape: false } }), false);
});

test('resolved landscape driver geometry is used once without a second rotation', () => {
  const result = calculatePrintLayout({
    source: { width: 1000, height: 600 },
    driverGeometry: { dimensionUnit: PRINT_LAYOUT_UNIT, landscape: true, paper: { width: 1169, height: 827 }, printableArea: { x: 19, y: 17, width: 1129, height: 793 } },
  });
  assert.equal(result.landscape, true);
  assert.deepEqual(result.paper, { x: 0, y: 0, width: 1169, height: 827 });
  near(result.destination.width, 1129);
  near(result.destination.y, 74.8);
  assert.equal(result.clipped, false);
});

test('printer paper sizes and custom landscape dimensions take precedence over catalog rounding', () => {
  const paperSizes = [{ name: 'Local A4', kind: 'A4', rawKind: 9, width: 826, height: 1170 }, { name: 'Custom card', kind: 'Custom', rawKind: 512, width: 700, height: 400 }];
  const source = { width: 300, height: 500 };
  const a4 = calculatePrintLayout({ source, settings: { paper: 'A4' }, paperSizes });
  const byName = calculatePrintLayout({ source, settings: { paperSize: 'Local A4' }, paperSizes });
  const custom = calculatePrintLayout({ source, settings: { paper: '512', orientation: 'landscape' }, paperSizes });
  assert.deepEqual(a4.paper, { x: 0, y: 0, width: 826, height: 1170 });
  assert.deepEqual(byName.paper, a4.paper);
  assert.deepEqual(custom.paper, { x: 0, y: 0, width: 400, height: 700 });
});

test('asymmetric margins center content within the printable area, not the sheet', () => {
  const result = calculatePrintLayout({ source: { width: 500, height: 500 }, settings: { scale: 'actual' }, driverGeometry: { paper: { width: 850, height: 1100 }, printableArea: { x: 50, y: 10, width: 780, height: 1000 } } });
  assert.deepEqual(result.destination, { x: 190, y: 260, width: 500, height: 500 });
  assert.equal(result.clipped, false);
});

test('borderless overspray can extend beyond the physical sheet and is clipped at paper edges', () => {
  const result = calculatePrintLayout({ source: { width: 800, height: 1200 }, driverGeometry: { paper: { width: 800, height: 1200 }, printableArea: { x: -10, y: -10, width: 820, height: 1220 } } });
  assert.deepEqual(result.clip, { x: 0, y: 0, width: 800, height: 1200 });
  assert.equal(result.clipped, true);
});

test('invalid driver geometry falls back explicitly and invalid source/settings never fabricate a preview', () => {
  for (const driverGeometry of [
    { ...driverA4, dimensionUnit: 'millimeters' },
    { ...driverA4, printableArea: { ...driverA4.printableArea, width: 0 } },
    { ...driverA4, paper: { width: Infinity, height: 100 } },
  ]) assert.equal(calculatePrintLayout({ source: { width: 400, height: 600 }, driverGeometry }).geometrySource, 'paper-size');
  for (const source of [undefined, { width: 0, height: 10 }, { width: -1, height: 10 }, { width: NaN, height: 10 }, { width: 10, height: Infinity }]) assert.throws(() => calculatePrintLayout({ source }), RangeError);
  assert.throws(() => calculatePrintLayout({ source: { width: 10, height: 20 }, settings: { paper: 'Unknown custom paper' } }), /Unknown paper dimensions/);
  assert.throws(() => calculatePrintLayout({ source: { width: 10, height: 20 }, settings: { scale: 'stretch' } }), /Unknown print scale/);
  assert.throws(() => calculatePrintLayout({ source: { width: 10, height: 20 }, settings: { orientation: 'diagonal' } }), /Unknown print orientation/);
});

test('layout calculations do not mutate source, settings, paper sizes or driver metadata', () => {
  const input = { source: { width: 400, height: 500 }, settings: { scale: 'actual', orientation: 'portrait' }, paperSizes: [{ name: 'A4', width: 827, height: 1169 }], driverGeometry: structuredClone(driverA4) };
  const before = structuredClone(input);
  const result = calculatePrintLayout(input);
  assert.deepEqual(input, before);
  result.source.width = 1; result.paper.height = 1; result.printableArea.width = 1; result.clip.width = 1;
  assert.deepEqual(input, before);
});
