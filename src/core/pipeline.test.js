import { describe, it, expect } from 'vitest';
import { createPage, createPageMapper } from './page';
import { ridgeline } from './algorithms/ridgeline';
import { writeSvg } from './svgWriter';
import { gaussianHill } from './testFields';

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
