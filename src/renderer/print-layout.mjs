// Match PrintEngine.Fit and QueryPageSettings. Every length is in hundredths of
// an inch, the unit returned by native inspect/printers/page-layout commands.
export const PRINT_LAYOUT_UNIT = 'hundredths-inch';
export const POINTS_PER_PRINT_UNIT = 72 / 100;

// Used only when driver geometry is unavailable. Prefer the printer's own paper
// sizes (including its rounding/custom dimensions) over this reference catalog.
const STANDARD_PAPERS = Object.freeze({
  a0: [3311, 4681], a1: [2339, 3311], a2: [1654, 2339],
  a3: [1169, 1654], a4: [827, 1169], a5: [583, 827], a6: [413, 583],
  letter: [850, 1100], legal: [850, 1400], tabloid: [1100, 1700], ledger: [1700, 1100],
});
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const normalized = value => String(value ?? '').trim().toLowerCase();
const copySize = value => ({ width: Number(value.width), height: Number(value.height) });

function requireSize(value, label) {
  if (!value || !positive(value.width) || !positive(value.height)) throw new RangeError(`${label} dimensions must be positive finite lengths.`);
  return copySize(value);
}

/** Resolve each source page separately, just like native QueryPageSettings. */
export function resolvePreviewLandscape({ source, settings = {} } = {}) {
  const size = requireSize(source, 'Source');
  if (typeof settings.landscape === 'boolean') return settings.landscape;
  const orientation = settings.orientation || 'auto';
  if (orientation === 'auto') return size.width > size.height;
  if (orientation === 'portrait') return false;
  if (orientation === 'landscape') return true;
  throw new RangeError('Unknown print orientation.');
}

function fallbackPaper(settings, paperSizes, landscape) {
  const name = String(settings.paper || settings.paperSize || 'A4');
  const key = normalized(name);
  const match = paperSizes.find(paper => paper && [paper.name, paper.kind, paper.rawKind].some(value => normalized(value) === key));
  let size;
  if (match && positive(match.width) && positive(match.height)) size = copySize(match);
  else if (STANDARD_PAPERS[key]) {
    const [width, height] = STANDARD_PAPERS[key];
    size = { width, height };
  } else throw new RangeError(`Unknown paper dimensions: ${name}`);
  // Driver PaperSize dimensions are unrotated. Landscape swaps them, even for
  // custom papers whose unrotated width is larger than their height.
  return { name, ...(landscape ? { width: size.height, height: size.width } : size) };
}

function driverPage(geometry) {
  if (!geometry || geometry.dimensionUnit && geometry.dimensionUnit !== PRINT_LAYOUT_UNIT) return null;
  const { paper, printableArea: area } = geometry;
  if (!paper || !positive(paper.width) || !positive(paper.height) || !area || !finite(area.x) || !finite(area.y) || !positive(area.width) || !positive(area.height)) return null;
  return { paper: copySize(paper), printableArea: { x: Number(area.x), y: Number(area.y), ...copySize(area) } };
}

function intersection(rect, paper) {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(paper.width, rect.x + rect.width), bottom = Math.min(paper.height, rect.y + rect.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Position the source on the physical sheet without changing print settings.
 * Driver geometry must already be queried for the resolved page orientation.
 * Without it, the whole sheet is used and geometrySource tells the UI that the
 * printer's non-printable margins are not yet represented.
 *
 * PDF source dimensions: current page viewport at scale 1, multiplied by 100/72.
 * Image source dimensions: native inspect width/height, which already honor the
 * file DPI (96 when invalid) and EXIF orientation; do not use CSS/image pixels.
 */
export function calculatePrintLayout({ source, settings = {}, paperSizes = [], driverGeometry = null } = {}) {
  const sourceSize = requireSize(source, 'Source');
  const landscape = resolvePreviewLandscape({ source: sourceSize, settings });
  const scaleMode = settings.scale || 'fit';
  if (!['fit', 'shrink', 'actual'].includes(scaleMode)) throw new RangeError('Unknown print scale mode.');
  const driver = driverPage(driverGeometry);
  const fallback = driver ? null : fallbackPaper(settings, paperSizes, landscape);
  const paper = { x: 0, y: 0, ...(driver?.paper || { width: fallback.width, height: fallback.height }) };
  const printableArea = driver?.printableArea || { ...paper };
  const fitScale = Math.min(printableArea.width / sourceSize.width, printableArea.height / sourceSize.height);
  const scale = scaleMode === 'actual' ? 1 : scaleMode === 'shrink' ? Math.min(1, fitScale) : fitScale;
  const width = sourceSize.width * scale, height = sourceSize.height * scale;
  const destination = { x: printableArea.x + (printableArea.width - width) / 2, y: printableArea.y + (printableArea.height - height) / 2, width, height };
  const clip = intersection(printableArea, paper);
  const epsilon = 1e-6;
  const clipped = destination.x < clip.x - epsilon || destination.y < clip.y - epsilon || destination.x + width > clip.x + clip.width + epsilon || destination.y + height > clip.y + clip.height + epsilon;
  return {
    dimensionUnit: PRINT_LAYOUT_UNIT,
    paperName: String(settings.paper || settings.paperSize || 'A4'),
    source: sourceSize, paper, printableArea, destination, clip,
    scale, landscape, clipped,
    geometrySource: driver ? 'driver' : 'paper-size',
  };
}
