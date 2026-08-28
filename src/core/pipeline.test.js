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
