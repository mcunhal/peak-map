import { describe, it, expect } from 'vitest';
import { buildLayers, DEFAULT_TRACK_COLORS } from './layers';
import { createPage, createPageMapper } from './page';
import { writeSvg } from './svgWriter';

const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 10 });
const mapper = createPageMapper(page, { width: 100, height: 100 });

const scene = (over = {}) => ({
  terrain: [[0, 0, 10, 10]],
  tracks: [],
  ...over,
});

describe('buildLayers', () => {
  it('puts terrain in its own layer', () => {
    const layers = buildLayers(scene(), mapper);
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe('terrain');
  });

  it('gives every track its own layer', () => {
    const layers = buildLayers(
      scene({
        tracks: [
          { name: 'Serra da Estrela', polylines: [[0, 0, 5, 5]] },
          { name: 'Gerês', polylines: [[1, 1, 6, 6]] },
        ],
      }),
      mapper
    );
    expect(layers.map((l) => l.id)).toEqual([
      'terrain',
      'route-serra-da-estrela',
      'route-ger-s',
    ]);
  });

  it('assigns distinct default colours', () => {
    const layers = buildLayers(
      scene({
        tracks: [
          { name: 'a', polylines: [[0, 0, 1, 1]] },
          { name: 'b', polylines: [[0, 0, 1, 1]] },
        ],
      }),
      mapper
    );
    expect(layers[1].penColor).toBe(DEFAULT_TRACK_COLORS[0]);
    expect(layers[2].penColor).toBe(DEFAULT_TRACK_COLORS[1]);
    expect(layers[1].penColor).not.toBe(layers[2].penColor);
  });

  it('honours configured pen colour and width per track', () => {
    const layers = buildLayers(
      scene({ tracks: [{ name: 'a', polylines: [[0, 0, 1, 1]] }] }),
      mapper,
      { trackPens: [{ color: '#ff00ff', width: 0.8 }] }
    );
    expect(layers[1].penColor).toBe('#ff00ff');
    expect(layers[1].penWidth).toBe(0.8);
  });

  it('honours the terrain pen', () => {
    const layers = buildLayers(scene(), mapper, {
      terrainPen: { color: '#334455', width: 0.15 },
    });
    expect(layers[0].penColor).toBe('#334455');
    expect(layers[0].penWidth).toBe(0.15);
  });

  it('keeps ids unique when two tracks share a name', () => {
    const layers = buildLayers(
      scene({
        tracks: [
          { name: 'ride', polylines: [[0, 0, 1, 1]] },
          { name: 'ride', polylines: [[0, 0, 1, 1]] },
        ],
      }),
      mapper
    );
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  it('falls back to an index when a name yields no usable id', () => {
    const layers = buildLayers(
      scene({ tracks: [{ name: '***', polylines: [[0, 0, 1, 1]] }] }),
      mapper
    );
    expect(layers[1].id).toBe('route-1');
  });

  it('skips a track with nothing drawn', () => {
    const layers = buildLayers(
      scene({ tracks: [{ name: 'empty', polylines: [] }] }),
      mapper
    );
    expect(layers).toHaveLength(1);
  });

  it('converts field coordinates to millimetres', () => {
    const layers = buildLayers(scene({ terrain: [[0, 0]] }), mapper);
    expect(layers[0].polylines[0]).toEqual(mapper.polylineToMm([0, 0]));
  });
});

describe('layers through to SVG', () => {
  it('writes terrain and each route as separate labelled layers', () => {
    const layers = buildLayers(
      scene({
        tracks: [
          { name: 'Serra', polylines: [[0, 0, 5, 5]] },
          { name: 'Gerês', polylines: [[1, 1, 6, 6]] },
        ],
      }),
      mapper,
      { trackPens: [{ color: '#c1272d' }, { color: '#0b6e99' }] }
    );
    const svg = writeSvg({ page, layers });

    expect(svg.match(/inkscape:groupmode="layer"/g)).toHaveLength(3);
    expect(svg).toContain('inkscape:label="terrain"');
    expect(svg).toContain('inkscape:label="Serra"');
    expect(svg).toContain('stroke="#c1272d"');
    expect(svg).toContain('stroke="#0b6e99"');
    // Terrain first, so routes are plotted over it.
    expect(svg.indexOf('id="terrain"')).toBeLessThan(svg.indexOf('id="route-serra"'));
  });

  it('escapes a track name that would break the label attribute', () => {
    const layers = buildLayers(
      scene({ tracks: [{ name: 'a"b & <c>', polylines: [[0, 0, 1, 1]] }] }),
      mapper
    );
    const svg = writeSvg({ page, layers });
    expect(svg).toContain('inkscape:label="a&quot;b &amp; &lt;c&gt;"');
  });
});
