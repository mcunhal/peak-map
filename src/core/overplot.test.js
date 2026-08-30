import { describe, it, expect } from 'vitest';
import { createHeightField } from './heightField';
import { createPage, createPageMapper } from './page';
import { buildTerrainLayers } from './composite';
import { clipToBounds } from './clip';

/**
 * A ridge running across the sheet, cresting exactly on its near edge.
 *
 * This is the terrain that shows the problem. The relief lifts the crest up the
 * page, and there is no nearer ground to draw in the space it leaves, so the
 * bottom of the sheet comes out blank. A hill in the middle of the sheet cannot
 * show it — the rows in front of it fill the gap themselves.
 *
 * Elevation depends only on the row, so the crest is at the same height across
 * the width and the measurements below are not about where the peak is in x.
 */
function ridgeOnNearEdge({ width, height, crestRow, sheetHeight = null }) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    const value = 100 * Math.exp(-((y - crestRow) ** 2) / (2 * 8 * 8));
    for (let x = 0; x < width; ++x) data[y * width + x] = value;
  }
  return createHeightField({ width, height, data, sheetHeight });
}

/** One millimetre per sample, so page positions read directly as field rows. */
const page = createPage({ paper: { width: 100, height: 100 }, margin: 0 });
const SHEET_ROWS = 100;
const CREST = SHEET_ROWS - 1;
const OPTIONS = { rowCount: 60, heightScale: 20, smoothSteps: 0, occlude: true };

function render({ overplot }) {
  const extra = Math.round(SHEET_ROWS * overplot);
  const field = ridgeOnNearEdge({
    width: 100,
    height: SHEET_ROWS + extra,
    crestRow: CREST,
    sheetHeight: overplot > 0 ? SHEET_ROWS : null,
  });

  const mapper = createPageMapper(page, field);
  const layers = buildTerrainLayers({
    field,
    mapper,
    algorithmIds: ['ridgeline'],
    algorithmOptions: OPTIONS,
  });

  const bottom = page.drawable.y + page.drawable.height;
  const polylines = layers.flatMap((layer) =>
    clipToBounds(layer.polylines, { maxY: bottom })
  );

  const ys = polylines.flatMap((line) => line.filter((_, i) => i % 2 === 1));
  return { polylines, lowest: Math.max(...ys), highest: Math.min(...ys) };
}

describe('over-plotting the bottom of the sheet', () => {
  it('leaves the paper under a near-edge crest blank without it', () => {
    const { lowest } = render({ overplot: 0 });
    // The crest is lifted by the full relief height, and nothing is drawn below
    // it: twenty millimetres of empty paper along the bottom of the sheet.
    expect(100 - lowest).toBeGreaterThan(19);
  });

  it('draws the terrain there instead', () => {
    const { lowest } = render({ overplot: 0.2 });
    expect(100 - lowest).toBeLessThan(1);
  });

  it('cuts the over-plot off at the page edge', () => {
    const { polylines } = render({ overplot: 0.2 });
    for (const line of polylines) {
      for (let i = 1; i < line.length; i += 2) {
        expect(line[i]).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });

  it('does not move the drawing that was already on the sheet', () => {
    // The far edge is unlifted, so it pins the top of the drawing, and the crest
    // pins the bottom of it. Both must land where they always did: over-plotting
    // extends the sheet downwards, it does not rescale it.
    const plain = render({ overplot: 0 });
    const over = render({ overplot: 0.2 });
    expect(over.highest).toBeCloseTo(plain.highest, 6);
  });

  it('keeps the line pitch the sheet was promised', () => {
    // Spreading the requested line count over a taller field would thin the
    // lines out on the paper. Measured at the top of the sheet, where the ground
    // is flat and consecutive lines sit exactly one row-spacing apart.
    const pitch = ({ overplot }) => {
      const { polylines } = render({ overplot });
      const tops = polylines
        .map((line) => line[1])
        .filter((y) => y < 20)
        .sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < tops.length; ++i) gaps.push(tops[i] - tops[i - 1]);
      return gaps.reduce((a, b) => a + b, 0) / gaps.length;
    };

    const plain = pitch({ overplot: 0 });
    const over = pitch({ overplot: 0.2 });
    expect(over).toBeCloseTo(plain, 1);
  });
});
