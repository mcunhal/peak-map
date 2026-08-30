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

  it('gives tracks on different pens a layer each, named for the pen', () => {
    // Two tracks with no pens supplied take successive default colours, so they
    // are two pens and two layers. The id comes from the pen rather than the
    // track name: the same pen must always land in the same layer.
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
      'route-c1272d-050',
      'route-0b6e99-050',
    ]);
    expect(layers.map((l) => l.label)).toEqual(['terrain', 'Serra da Estrela', 'Gerês']);
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

  it('takes the id from the pen, so an unusable name cannot spoil it', () => {
    // A name that slugs to nothing used to need an index fallback. The id is now
    // the pen, which no name can make unusable; the name is only the label.
    const layers = buildLayers(
      scene({ tracks: [{ name: '***', polylines: [[0, 0, 1, 1]] }] }),
      mapper
    );
    expect(layers[1].id).toBe('route-c1272d-050');
    expect(layers[1].label).toBe('***');
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
    expect(svg.indexOf('id="terrain"')).toBeLessThan(svg.indexOf('id="route-c1272d-050"'));
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

describe('grouping tracks into pens', () => {
  const track = (name, fileName) => ({
    name, fileName, polylines: [[0, 0, 1, 1]],
  });
  const mapper = { polylineToMm: (l) => l, scale: 1, offsetX: 0, offsetY: 0 };

  it('merges every section sharing a pen into one layer', () => {
    const scene = {
      terrain: [],
      tracks: [track('s1', 'a.gpx'), track('s2', 'a.gpx'), track('s3', 'a.gpx')],
    };
    const pens = Array(3).fill({ color: '#c1272d', width: 0.5 });

    const layers = buildLayers(scene, mapper, { trackPens: pens });

    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe('route-c1272d-050');
    expect(layers[0].polylines).toHaveLength(3);
  });

  it('splits an overridden section into its own layer', () => {
    const scene = { terrain: [], tracks: [track('s1', 'a.gpx'), track('s2', 'a.gpx')] };
    const pens = [{ color: '#c1272d', width: 0.5 }, { color: '#c1272d', width: 0.8 }];

    const layers = buildLayers(scene, mapper, { trackPens: pens });

    expect(layers.map((l) => l.id)).toEqual(['route-c1272d-050', 'route-c1272d-080']);
  });

  it('merges across files that share a pen, and says which they were', () => {
    const scene = { terrain: [], tracks: [track('s1', 'a.gpx'), track('s2', 'b.gpx')] };
    const pens = Array(2).fill({ color: '#0b6e99', width: 0.5 });

    const [layer] = buildLayers(scene, mapper, { trackPens: pens });

    expect(layer.label).toBe('a.gpx, b.gpx');
  });

  it('names a file only once however many sections it contributes', () => {
    const scene = {
      terrain: [],
      tracks: [track('s1', 'a.gpx'), track('s2', 'a.gpx'), track('s3', 'b.gpx')],
    };
    const pens = Array(3).fill({ color: '#0b6e99', width: 0.5 });

    expect(buildLayers(scene, mapper, { trackPens: pens })[0].label).toBe('a.gpx, b.gpx');
  });

  it('falls back to the track name when there is no file', () => {
    // The worker can still be driven with bare tracks.
    const scene = { terrain: [], tracks: [{ name: 'route', polylines: [[0, 0, 1, 1]] }] };
    const [layer] = buildLayers(scene, mapper, { trackPens: [{ color: '#1a7f37', width: 0.4 }] });
    expect(layer.label).toBe('route');
  });

  it('keeps the terrain layer first and separate', () => {
    const scene = { terrain: [[0, 0, 1, 1]], tracks: [track('s1', 'a.gpx')] };
    const layers = buildLayers(scene, mapper, {
      trackPens: [{ color: '#c1272d', width: 0.5 }],
      terrainId: 'ridgeline',
    });
    expect(layers[0].id).toBe('ridgeline');
    expect(layers).toHaveLength(2);
  });

  it('drops a section that drew nothing', () => {
    const scene = {
      terrain: [],
      tracks: [track('s1', 'a.gpx'), { name: 's2', fileName: 'a.gpx', polylines: [] }],
    };
    const pens = Array(2).fill({ color: '#c1272d', width: 0.5 });
    expect(buildLayers(scene, mapper, { trackPens: pens })[0].polylines).toHaveLength(1);
  });
});
