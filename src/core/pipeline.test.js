import { describe, it, expect } from 'vitest';
import { createPage, createPageMapper } from './page';
import { ridgeline } from './algorithms/ridgeline';
import { writeSvg } from './svgWriter';
import { gaussianHill } from './testFields';
import { compassForPage, compassCutout } from './compass';
import { subtractPolygon, pointInPolygon } from './clip';

/**
 * End-to-end through the pure core: a height field becomes polylines, the polylines
 * are placed on a physical page, and the page is written as plot-ready SVG.
 */
function plot(field, { paper = 'A3', orientation = 'landscape', margin = 15 } = {}) {
  const page = createPage({ paper, orientation, margin });
  const mapper = createPageMapper(page, field);
  const lines = ridgeline(field, {
    rowCount: 40,
    heightScale: 60,
    smoothSteps: 2,
    occlude: true,
  });
  const svg = writeSvg({
    page,
    layers: [
      {
        id: 'terrain',
        label: 'terrain',
        penColor: '#161616',
        penWidth: 0.3,
        polylines: lines.map((l) => mapper.polylineToMm(l)),
      },
    ],
  });
  return { page, mapper, lines, svg };
}

describe('height field to plot-ready SVG', () => {
  const field = gaussianHill(300, 200, 900);

  it('produces an A3 landscape sheet in millimetres', () => {
    const { svg } = plot(field);
    expect(svg).toContain('width="420mm"');
    expect(svg).toContain('height="297mm"');
    expect(svg).toContain('viewBox="0 0 420 297"');
  });

  it('draws something', () => {
    const { svg, lines } = plot(field);
    expect(lines.length).toBeGreaterThan(0);
    expect(svg.match(/<path /g).length).toBeGreaterThan(0);
  });

  it('keeps every coordinate inside the page margins', () => {
    const { page, svg } = plot(field);
    const { drawable } = page;
    const coords = [...svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
    expect(coords.length).toBeGreaterThan(100);
    for (const [, xs, ys] of coords) {
      const x = Number(xs);
      const y = Number(ys);
      expect(x).toBeGreaterThanOrEqual(drawable.x - 0.001);
      expect(x).toBeLessThanOrEqual(drawable.x + drawable.width + 0.001);
      expect(y).toBeGreaterThanOrEqual(drawable.y - 0.001);
      expect(y).toBeLessThanOrEqual(drawable.y + drawable.height + 0.001);
    }
  });

  it('does not distort the terrain', () => {
    // One scale for both axes, so the map keeps its shape on paper.
    const { mapper } = plot(field);
    const [x0, y0] = mapper.toMm(0, 0);
    const [x1, y1] = mapper.toMm(10, 10);
    expect(x1 - x0).toBeCloseTo(y1 - y0, 9);
  });

  it('changes physical size with the paper, not the geometry count', () => {
    const a3 = plot(field, { paper: 'A3' });
    const a4 = plot(field, { paper: 'A4' });
    expect(a3.lines.length).toBe(a4.lines.length);
    expect(a3.mapper.scale).toBeGreaterThan(a4.mapper.scale);
    expect(a4.svg).toContain('width="297mm"');
  });

  it('emits nothing a plotter cannot draw', () => {
    const { svg } = plot(field);
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).not.toMatch(/<path[^>]*fill="(?!none)/);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });
});

describe('detail changes resolution, not appearance', () => {
  // The sizes the app sends are millimetres on the paper, converted to field
  // samples against the page mapper. This is the guarantee that conversion buys:
  // raising the detail resolves more terrain without redrawing the map larger or
  // smaller. Before it, relief fell from 74mm to 14mm as detail went 300 to 1600.
  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });
  const aspect = page.drawable.width / page.drawable.height;

  const reliefMm = (detail) => {
    const width = detail;
    const height = Math.round(detail / aspect);
    const field = gaussianHill(width, height, 1200);
    const mapper = createPageMapper(page, field);

    // 26mm of relief, expressed the way the worker expresses it.
    const heightScale = 26 / mapper.scale;
    const lines = ridgeline(field, {
      rowCount: 60,
      heightScale,
      smoothSteps: 0,
      occlude: false,
    });

    let peak = 0;
    for (const line of lines) {
      const ys = [];
      for (let i = 1; i < line.length; i += 2) ys.push(line[i]);
      peak = Math.max(peak, Math.max(...ys) - Math.min(...ys));
    }
    return peak * mapper.scale;
  };

  it('keeps the relief the same physical height at any detail', () => {
    const coarse = reliefMm(300);
    const middling = reliefMm(900);
    const fine = reliefMm(1600);

    for (const value of [coarse, middling, fine]) {
      expect(value).toBeGreaterThan(0);
    }
    // Within a couple of percent; the sampling grid shifts slightly.
    expect(middling).toBeCloseTo(coarse, 0);
    expect(fine).toBeCloseTo(coarse, 0);
    expect(Math.abs(fine - coarse) / coarse).toBeLessThan(0.05);
  });
});

describe('the compass cut-out through the pipeline', () => {
  const field = gaussianHill(300, 200, 900);
  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });
  const mapper = createPageMapper(page, field);
  const placement = { radius: 12, corner: 'bottom-right' };

  const terrain = ridgeline(field, { rowCount: 40, heightScale: 60, occlude: true }).map(
    (line) => mapper.polylineToMm(line)
  );

  it('leaves clean paper under the rose', () => {
    const cutout = compassCutout(page, { ...placement, margin: 1.5 });
    const cut = subtractPolygon(terrain, cutout);

    // Something was actually removed, or the assertion below proves nothing.
    const total = (lines) => lines.reduce((n, l) => n + l.length / 2, 0);
    expect(total(cut)).toBeLessThan(total(terrain));

    // Sampled along each stroke rather than at its vertices. A cut lands a
    // vertex exactly on the boundary, where a crossing count is undefined and
    // reports either answer; what matters is that no ink crosses the interior.
    for (const line of cut) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        for (const t of [0.25, 0.5, 0.75]) {
          const x = line[i] + (line[i + 2] - line[i]) * t;
          const y = line[i + 1] + (line[i + 3] - line[i + 1]) * t;
          expect(pointInPolygon(cutout, x, y)).toBe(false);
        }
      }
    }
  });

  it('does not cut the rose itself', () => {
    // The worker subtracts from the map layers and then appends the compass, so
    // the rose is never its own victim.
    const rose = compassForPage(page, placement);
    const cutout = compassCutout(page, { ...placement, margin: 1.5 });
    for (const line of rose) {
      for (let i = 0; i < line.length; i += 2) {
        expect(pointInPolygon(cutout, line[i], line[i + 1])).toBe(true);
      }
    }
  });

  it('cuts nothing anywhere else on the sheet', () => {
    const cutout = compassCutout(page, { ...placement, margin: 1.5 });
    const cut = subtractPolygon(terrain, cutout);

    let xs = [];
    for (let i = 0; i < cutout.length; i += 2) xs.push(cutout[i]);
    const leftOfRose = Math.min(...xs);

    const inkLeftOf = (lines) =>
      lines.reduce((n, line) => {
        for (let i = 0; i < line.length; i += 2) if (line[i] < leftOfRose - 1) n += 1;
        return n;
      }, 0);

    expect(inkLeftOf(cut)).toBe(inkLeftOf(terrain));
  });
});
