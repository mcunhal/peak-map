import { describe, it, expect } from 'vitest';
import { createPage } from './page';
import { writeSvg } from './svgWriter';

const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 10 });

const layer = (over = {}) => ({
  id: 'terrain',
  label: 'terrain',
  penColor: '#161616',
  penWidth: 0.3,
  polylines: [[10, 10, 20, 20, 30, 15]],
  ...over,
});

describe('writeSvg', () => {
  it('declares the page in millimetres', () => {
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toContain('width="297mm"');
    expect(svg).toContain('height="210mm"');
  });

  it('gives the viewBox the same numbers as the physical size', () => {
    // This identity is what makes one user unit equal one millimetre.
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toContain('viewBox="0 0 297 210"');
  });

  it('writes each layer as an Inkscape layer group', () => {
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toContain('inkscape:groupmode="layer"');
    expect(svg).toContain('inkscape:label="terrain"');
    expect(svg).toContain('id="terrain"');
  });

  it('declares the Inkscape namespace when it uses it', () => {
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toContain('xmlns:inkscape=');
  });

  it('carries stroke on the group for tools that ignore Inkscape attributes', () => {
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toMatch(/stroke="#161616"/);
    expect(svg).toMatch(/stroke-width="0.3"/);
  });

  it('never fills a path', () => {
    const svg = writeSvg({ page, layers: [layer()] });
    expect(svg).toContain('fill="none"');
    expect(svg).not.toMatch(/<path[^>]*fill="(?!none)/);
  });

  it('never emits a dash array, which plotter toolchains handle inconsistently', () => {
    const svg = writeSvg({
      page,
      layers: [layer({ polylines: [[0, 0, 1, 1], [2, 2, 3, 3]] })],
    });
    expect(svg).not.toContain('stroke-dasharray');
  });

  it('writes one path per polyline', () => {
    const svg = writeSvg({
      page,
      layers: [layer({ polylines: [[0, 0, 1, 1], [2, 2, 3, 3], [4, 4, 5, 5]] })],
    });
    expect(svg.match(/<path /g)).toHaveLength(3);
  });

  it('keeps layers separate and in order', () => {
    const svg = writeSvg({
      page,
      layers: [layer(), layer({ id: 'route-1', label: 'route-1', penColor: '#c02020' })],
    });
    expect(svg.indexOf('id="terrain"')).toBeLessThan(svg.indexOf('id="route-1"'));
    expect(svg).toContain('#c02020');
  });

  it('drops polylines with fewer than two points', () => {
    const svg = writeSvg({ page, layers: [layer({ polylines: [[5, 5], []] })] });
    expect(svg).not.toContain('<path ');
  });

  it('rounds coordinates rather than writing full float noise', () => {
    const svg = writeSvg({
      page,
      layers: [layer({ polylines: [[1.23456789, 2.3456789, 3, 4]] })],
    });
    expect(svg).toContain('M1.235 2.346');
    expect(svg).not.toContain('1.23456789');
  });

  it('escapes a label so it cannot break out of the attribute', () => {
    const svg = writeSvg({
      page,
      layers: [layer({ label: 'a "b" & <c>' })],
    });
    expect(svg).toContain('inkscape:label="a &quot;b&quot; &amp; &lt;c&gt;"');
  });

  it('omits a background rect unless asked for one', () => {
    expect(writeSvg({ page, layers: [layer()] })).not.toContain('id="background"');
    const withBg = writeSvg({ page, layers: [layer()], background: '#F7F2E8' });
    expect(withBg).toContain('id="background"');
    expect(withBg).toContain('#F7F2E8');
  });
});
