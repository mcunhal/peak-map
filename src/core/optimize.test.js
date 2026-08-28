import { describe, it, expect } from 'vitest';
import {
  simplifyPolyline, deduplicateSegments, mergePolylines, sortPolylines,
  reloopPolylines, optimizePolylines, optimizeLayers, measurePlot,
  compareMetrics, vpypeRecipe, polylineLength, isClosed,
} from './optimize';

const totalLength = (lines) => lines.reduce((n, l) => n + polylineLength(l), 0);
const totalPoints = (lines) => lines.reduce((n, l) => n + l.length / 2, 0);

describe('simplifyPolyline', () => {
  it('collapses collinear points', () => {
    expect(simplifyPolyline([0, 0, 1, 0, 2, 0, 3, 0], 0.01)).toEqual([0, 0, 3, 0]);
  });

  it('keeps a point that deviates by more than the tolerance', () => {
    expect(simplifyPolyline([0, 0, 1, 5, 2, 0], 0.01)).toEqual([0, 0, 1, 5, 2, 0]);
  });

  it('stays within the tolerance of the original', () => {
    const line = [];
    for (let i = 0; i <= 200; ++i) line.push(i * 0.5, Math.sin(i / 12) * 10);
    const simplified = simplifyPolyline(line, 0.05);
    expect(totalPoints([simplified])).toBeLessThan(totalPoints([line]));
    // Endpoints are always preserved.
    expect(simplified.slice(0, 2)).toEqual(line.slice(0, 2));
    expect(simplified.slice(-2)).toEqual(line.slice(-2));
  });

  it('never adds points', () => {
    const line = [0, 0, 1, 1, 2, 0, 3, 1];
    expect(totalPoints([simplifyPolyline(line, 0.5)])).toBeLessThanOrEqual(4);
  });

  it('leaves a two-point line alone', () => {
    expect(simplifyPolyline([0, 0, 5, 5], 1)).toEqual([0, 0, 5, 5]);
  });
});

describe('deduplicateSegments', () => {
  it('removes a stroke drawn twice', () => {
    const out = deduplicateSegments([[0, 0, 10, 0], [0, 0, 10, 0]], 0.05);
    expect(totalLength(out)).toBeCloseTo(10, 6);
  });

  it('recognises a stroke retraced in the opposite direction', () => {
    const out = deduplicateSegments([[0, 0, 10, 0], [10, 0, 0, 0]], 0.05);
    expect(totalLength(out)).toBeCloseTo(10, 6);
  });

  it('keeps genuinely different geometry', () => {
    const out = deduplicateSegments([[0, 0, 10, 0], [0, 5, 10, 5]], 0.05);
    expect(totalLength(out)).toBeCloseTo(20, 6);
  });

  it('never increases total length', () => {
    const input = [[0, 0, 5, 0, 10, 0], [5, 0, 10, 0, 15, 0], [0, 0, 5, 0]];
    expect(totalLength(deduplicateSegments(input, 0.05))).toBeLessThanOrEqual(
      totalLength(input) + 1e-9
    );
  });

  it('drops segments shorter than the tolerance', () => {
    expect(deduplicateSegments([[0, 0, 0.001, 0]], 0.05)).toEqual([]);
  });
});

describe('mergePolylines', () => {
  it('joins two strokes that meet', () => {
    const out = mergePolylines([[0, 0, 5, 0], [5, 0, 10, 0]], 0.1);
    expect(out).toHaveLength(1);
    expect(totalLength(out)).toBeCloseTo(10, 6);
  });

  it('reverses a stroke when that is what makes the ends meet', () => {
    const out = mergePolylines([[0, 0, 5, 0], [10, 0, 5, 0]], 0.1);
    expect(out).toHaveLength(1);
  });

  it('leaves strokes apart when they do not meet', () => {
    expect(mergePolylines([[0, 0, 5, 0], [9, 0, 14, 0]], 0.1)).toHaveLength(2);
  });

  it('preserves drawn length', () => {
    const input = [[0, 0, 5, 0], [5, 0, 10, 0], [10, 0, 10, 5]];
    const out = mergePolylines(input, 0.1);
    expect(totalLength(out)).toBeCloseTo(totalLength(input), 6);
  });

  it('does not duplicate the joint point', () => {
    const out = mergePolylines([[0, 0, 5, 0], [5, 0, 10, 0]], 0.1);
    expect(totalPoints(out)).toBe(3);
  });

  it('reduces pen lifts on a chain of many small strokes', () => {
    const input = [];
    for (let i = 0; i < 50; ++i) input.push([i, 0, i + 1, 0]);
    expect(mergePolylines(input, 0.1).length).toBe(1);
  });
});

describe('sortPolylines', () => {
  const scattered = [
    [100, 100, 101, 100],
    [0, 0, 1, 0],
    [50, 50, 51, 50],
    [2, 0, 3, 0],
  ];

  it('reduces pen-up travel', () => {
    const travel = (lines) => {
      let d = 0, px = 0, py = 0;
      for (const l of lines) {
        d += Math.hypot(l[0] - px, l[1] - py);
        px = l[l.length - 2];
        py = l[l.length - 1];
      }
      return d;
    };
    expect(travel(sortPolylines(scattered))).toBeLessThan(travel(scattered));
  });

  it('keeps every stroke', () => {
    expect(sortPolylines(scattered)).toHaveLength(scattered.length);
  });

  it('preserves total drawn length', () => {
    expect(totalLength(sortPolylines(scattered))).toBeCloseTo(totalLength(scattered), 6);
  });

  it('starts from the stroke nearest the origin', () => {
    expect(sortPolylines(scattered)[0].slice(0, 2)).toEqual([0, 0]);
  });

  it('reverses a stroke when its far end is nearer', () => {
    const out = sortPolylines([[10, 0, 1, 0]], { origin: [0, 0] });
    expect(out[0].slice(0, 2)).toEqual([1, 0]);
  });

  it('respects allowReverse false', () => {
    const out = sortPolylines([[10, 0, 1, 0]], { origin: [0, 0], allowReverse: false });
    expect(out[0].slice(0, 2)).toEqual([10, 0]);
  });

  it('handles many strokes without quadratic blow-up', () => {
    const many = [];
    for (let i = 0; i < 4000; ++i) {
      const x = (i % 80) * 3;
      const y = Math.floor(i / 80) * 3;
      many.push([x, y, x + 1, y + 1]);
    }
    const started = Date.now();
    const out = sortPolylines(many);
    expect(out).toHaveLength(4000);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('reloopPolylines', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];

  it('recognises a closed loop', () => {
    expect(isClosed(square, 0.1)).toBe(true);
    expect(isClosed([0, 0, 10, 0], 0.1)).toBe(false);
  });

  it('moves the seam of a closed loop', () => {
    const out = reloopPolylines([square], 0.1)[0];
    expect(out.slice(0, 2)).not.toEqual(square.slice(0, 2));
  });

  it('keeps the loop closed and the same length', () => {
    const out = reloopPolylines([square], 0.1)[0];
    expect(isClosed(out, 0.1)).toBe(true);
    expect(polylineLength(out)).toBeCloseTo(polylineLength(square), 6);
  });

  it('leaves open strokes untouched', () => {
    const open = [0, 0, 5, 0, 10, 3];
    expect(reloopPolylines([open], 0.1)[0]).toEqual(open);
  });

  it('is deterministic', () => {
    expect(reloopPolylines([square], 0.1)).toEqual(reloopPolylines([square], 0.1));
  });
});

describe('optimizePolylines', () => {
  it('cuts pen lifts on fragmented geometry', () => {
    const fragments = [];
    for (let i = 0; i < 60; ++i) fragments.push([i, 0, i + 1, 0]);
    const out = optimizePolylines(fragments);
    expect(out.length).toBeLessThan(fragments.length);
  });

  it('never lengthens the drawing', () => {
    const input = [];
    for (let i = 0; i < 40; ++i) {
      input.push([i, 0, i + 1, 0], [i, 0, i + 1, 0]); // every stroke drawn twice
    }
    const out = optimizePolylines(input);
    expect(totalLength(out)).toBeLessThan(totalLength(input));
  });

  it('halves the drawn length when everything is drawn twice', () => {
    const once = [];
    for (let i = 0; i < 30; ++i) once.push([i * 2, 0, i * 2 + 1, 3]);
    const twice = [...once, ...once.map((l) => l.slice())];
    expect(totalLength(optimizePolylines(twice))).toBeCloseTo(
      totalLength(optimizePolylines(once)),
      3
    );
  });

  it('is deterministic', () => {
    const input = [[0, 0, 5, 0], [5, 0, 10, 4], [20, 20, 25, 25]];
    expect(optimizePolylines(input)).toEqual(optimizePolylines(input));
  });

  it('can be turned off pass by pass', () => {
    const input = [[0, 0, 1, 0], [1, 0, 2, 0]];
    const untouched = optimizePolylines(input, {
      dedupTolerance: 0, mergeTolerance: 0, simplifyTolerance: 0, sort: false, reloop: false,
    });
    expect(untouched).toEqual(input);
  });

  it('drops strokes left with fewer than two points', () => {
    expect(optimizePolylines([[0, 0]])).toEqual([]);
  });
});

describe('optimizeLayers', () => {
  it('optimizes each layer but leaves pens alone', () => {
    const layers = [
      { id: 'terrain', penColor: '#000', penWidth: 0.3, polylines: [[0, 0, 1, 0], [1, 0, 2, 0]] },
      { id: 'route', penColor: '#f00', penWidth: 0.5, polylines: [[5, 5, 6, 6]] },
    ];
    const out = optimizeLayers(layers);
    expect(out[0].penColor).toBe('#000');
    expect(out[1].id).toBe('route');
    expect(out[0].polylines).toHaveLength(1);
  });
});

describe('measurePlot', () => {
  const layers = [{ id: 'a', polylines: [[0, 0, 10, 0], [20, 0, 30, 0]] }];

  it('measures pen-down length', () => {
    expect(measurePlot(layers).penDownMm).toBeCloseTo(20, 6);
  });

  it('measures pen-up travel including the move from the origin', () => {
    // 0->0 is free, then 10 across the gap.
    expect(measurePlot(layers).penUpMm).toBeCloseTo(10, 6);
  });

  it('counts one lift per stroke', () => {
    expect(measurePlot(layers).penLifts).toBe(2);
  });

  it('estimates time from the machine profile', () => {
    const m = measurePlot(layers, { drawSpeed: 10, travelSpeed: 10, penLiftTime: 1 });
    expect(m.seconds).toBeCloseTo(20 / 10 + 10 / 10 + 2, 6);
  });

  it('shows optimization paying off', () => {
    const scattered = [];
    for (let i = 0; i < 40; ++i) scattered.push([i, 0, i + 1, 0]);
    const before = measurePlot([{ id: 'a', polylines: scattered }]);
    const after = measurePlot([{ id: 'a', polylines: optimizePolylines(scattered) }]);
    expect(after.penLifts).toBeLessThan(before.penLifts);
    expect(after.seconds).toBeLessThan(before.seconds);
  });
});

describe('compareMetrics', () => {
  it('reports the change as percentages and seconds saved', () => {
    const before = { penDownMm: 100, penUpMm: 100, penLifts: 10, points: 100, seconds: 10 };
    const after = { penDownMm: 100, penUpMm: 50, penLifts: 5, points: 80, seconds: 6 };
    const c = compareMetrics(before, after);
    expect(c.penUpChangePercent).toBeCloseTo(-50, 6);
    expect(c.penLiftChangePercent).toBeCloseTo(-50, 6);
    expect(c.secondsSaved).toBeCloseTo(4, 6);
  });
});

describe('vpypeRecipe', () => {
  it('emits the passes in vpype order', () => {
    const recipe = vpypeRecipe();
    const order = ['read', 'deduplicate', 'linemerge', 'linesort', 'reloop', 'linesimplify', 'write'];
    let last = -1;
    for (const command of order) {
      const at = recipe.indexOf(command);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('states tolerances in millimetres', () => {
    expect(vpypeRecipe({ mergeTolerance: 0.25 })).toContain('--tolerance 0.25mm');
  });

  it('omits passes that are switched off', () => {
    const recipe = vpypeRecipe({ sort: false, reloop: false, dedupTolerance: 0 });
    expect(recipe).not.toContain('linesort');
    expect(recipe).not.toContain('reloop');
    expect(recipe).not.toContain('deduplicate');
  });

  it('carries the no-flip flag when reversing is disallowed', () => {
    expect(vpypeRecipe({ allowReverse: false })).toContain('--no-flip');
  });

  it('uses the given file names', () => {
    const recipe = vpypeRecipe({}, { input: 'a.svg', output: 'b.svg' });
    expect(recipe).toContain('read "a.svg"');
    expect(recipe).toContain('write "b.svg"');
  });
});
