import { describe, it, expect } from 'vitest';
import { dashAlong, sparsePattern, LINE_STYLES, LINE_STYLE_IDS } from './dash';

/** A straight run along x, one point per unit, so arc length is easy to read. */
const straight = (length) =>
  Array.from({ length: length + 1 }, (_, i) => ({ x: i, y: 0 }));

/** The [start, end] x of each emitted mark on a straight run. */
const spans = (lines) => lines.map((l) => [l[0], l[l.length - 2]]);

describe('dashAlong', () => {
  it('returns the whole run when there is no pattern', () => {
    expect(dashAlong(straight(4), null)).toEqual([[0, 0, 1, 0, 2, 0, 3, 0, 4, 0]]);
    expect(dashAlong(straight(4), [])).toEqual([[0, 0, 1, 0, 2, 0, 3, 0, 4, 0]]);
  });

  it('emits marks of the on length, spaced by the off length', () => {
    // 2 on, 2 off, over a run of 10: marks at 0-2, 4-6, 8-10.
    expect(spans(dashAlong(straight(10), [2, 2]))).toEqual([[0, 2], [4, 6], [8, 10]]);
  });

  it('carries a mark across a polyline corner instead of truncating it', () => {
    // Right angle at (1,0). A 2-long mark starting at 0 must reach (1,1).
    const bent = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    const [first] = dashAlong(bent, [2, 2]);
    // The mark follows the corner, so it holds the corner point too.
    expect(first).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('keeps the pattern phase running across segments', () => {
    // Segment boundaries every 1 unit must not restart the pattern.
    expect(spans(dashAlong(straight(8), [1, 3]))).toEqual([[0, 1], [4, 5]]);
  });

  it('cycles a four-part pattern', () => {
    // 2 on, 1 off, 1 on, 1 off = a 5-long cycle.
    expect(spans(dashAlong(straight(10), [2, 1, 1, 1]))).toEqual([
      [0, 2], [3, 4], [5, 7], [8, 9],
    ]);
  });

  it('stops at the end of the run rather than overrunning it', () => {
    const last = dashAlong(straight(5), [2, 2]).at(-1);
    expect(last[last.length - 2]).toBeLessThanOrEqual(5);
  });

  it('ignores a run with fewer than two points', () => {
    expect(dashAlong([{ x: 0, y: 0 }], [1, 1])).toEqual([]);
    expect(dashAlong([], [1, 1])).toEqual([]);
  });
});

describe('sparsePattern', () => {
  it('doubles the gaps and leaves the marks alone', () => {
    expect(sparsePattern([1.8, 1.2])).toEqual([1.8, 2.4]);
    expect(sparsePattern([1.8, 0.8, 0.3, 0.8])).toEqual([1.8, 1.6, 0.3, 1.6]);
  });

  it('has nothing to widen on a solid line', () => {
    expect(sparsePattern(null)).toBe(null);
  });
});

describe('LINE_STYLES', () => {
  it('offers exactly the four styles the panel does, solid first', () => {
    expect(LINE_STYLE_IDS).toEqual(['solid', 'dashed', 'dotted', 'dash-dot']);
    expect(Object.keys(LINE_STYLES)).toEqual(LINE_STYLE_IDS);
  });

  it('gives every style except solid an even-length on/off pattern', () => {
    expect(LINE_STYLES.solid).toBe(null);
    for (const id of LINE_STYLE_IDS.filter((i) => i !== 'solid')) {
      expect(LINE_STYLES[id].length % 2).toBe(0);
      for (const v of LINE_STYLES[id]) expect(v).toBeGreaterThan(0);
    }
  });

  it('leaves every gap well clear of the default merge tolerance', () => {
    // optimizeLayers merges endpoints within 0.15mm by default. A gap at or
    // below that would let the optimizer join the dashes back into a solid
    // line, silently undoing the style.
    for (const id of LINE_STYLE_IDS.filter((i) => i !== 'solid')) {
      const gaps = LINE_STYLES[id].filter((_, i) => i % 2 === 1);
      for (const gap of gaps) expect(gap).toBeGreaterThan(0.5);
    }
  });
});
