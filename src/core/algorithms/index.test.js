import { describe, it, expect } from 'vitest';
import { ALGORITHMS, listAlgorithms, getAlgorithm, renderTerrain, DEFAULT_ALGORITHM } from './index';
import { gaussianHill, planeField } from '../testFields';
import { polylineLength } from '../optimize';

const hill = gaussianHill(80, 80, 900);
const totalLength = (lines) => lines.reduce((n, l) => n + polylineLength(l), 0);
const groupLength = (groups) => groups.reduce((n, g) => n + totalLength(g.polylines), 0);

describe('the registry', () => {
  it('offers every algorithm with a name and a description', () => {
    const listed = listAlgorithms();
    expect(listed.length).toBeGreaterThanOrEqual(4);
    for (const entry of listed) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(typeof entry.planar).toBe('boolean');
    }
  });

  it('marks only the ridgeline family as non-planar', () => {
    expect(ALGORITHMS.ridgeline.planar).toBe(false);
    expect(ALGORITHMS.contours.planar).toBe(true);
    expect(ALGORITHMS.tanaka.planar).toBe(true);
  });

  it('has a default that exists', () => {
    expect(getAlgorithm(DEFAULT_ALGORITHM)).toBeTruthy();
  });

  it('names the alternatives when asked for one that does not exist', () => {
    expect(() => getAlgorithm('spirograph')).toThrow(/ridgeline/);
  });
});

describe('every algorithm', () => {
  for (const id of Object.keys(ALGORITHMS)) {
    describe(id, () => {
      it('returns groups of polylines', () => {
        const groups = renderTerrain(hill, id);
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
          expect(typeof group.name).toBe('string');
          expect(Array.isArray(group.polylines)).toBe(true);
          expect(group.weight).toBeGreaterThan(0);
          expect(group.weight).toBeLessThanOrEqual(1);
        }
      });

      it('draws something on real terrain', () => {
        expect(groupLength(renderTerrain(hill, id))).toBeGreaterThan(0);
      });

      it('emits only finite coordinates', () => {
        for (const group of renderTerrain(hill, id)) {
          for (const line of group.polylines) {
            for (const v of line) expect(Number.isFinite(v)).toBe(true);
          }
        }
      });

      it('emits no stroke with fewer than two points', () => {
        for (const group of renderTerrain(hill, id)) {
          for (const line of group.polylines) expect(line.length).toBeGreaterThanOrEqual(4);
        }
      });

      it('stays inside the field', () => {
        for (const group of renderTerrain(hill, id)) {
          for (const line of group.polylines) {
            for (let i = 0; i < line.length; i += 2) {
              expect(line[i]).toBeGreaterThanOrEqual(-1);
              expect(line[i]).toBeLessThanOrEqual(hill.width + 1);
            }
          }
        }
      });

      it('is deterministic', () => {
        expect(renderTerrain(hill, id)).toEqual(renderTerrain(hill, id));
      });

      it('survives flat ground without throwing', () => {
        expect(() => renderTerrain(planeField(30, 30, 200), id)).not.toThrow();
      });
    });
  }
});

describe('algorithms differ from one another', () => {
  it('produces genuinely different geometry per algorithm', () => {
    const lengths = Object.keys(ALGORITHMS).map((id) => groupLength(renderTerrain(hill, id)));
    // Contours and ridgelines should not coincidentally draw the same amount.
    expect(new Set(lengths.map((l) => l.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('splits into several pens only where weight varies', () => {
    expect(renderTerrain(hill, 'ridgeline')).toHaveLength(1);
    expect(renderTerrain(hill, 'contours')).toHaveLength(1);
    expect(renderTerrain(hill, 'tanaka', { classes: 3 }).length).toBe(3);
  });

  it('gives index contours a heavier weight', () => {
    const groups = renderTerrain(hill, 'contours-by-level', { interval: 100, indexEvery: 5 });
    expect(groups[0].weight).toBe(1);
    expect(groups[1].weight).toBe(0.5);
  });

  it('honours options passed over the defaults', () => {
    const coarse = renderTerrain(hill, 'contours', { interval: 300 });
    const fine = renderTerrain(hill, 'contours', { interval: 50 });
    expect(groupLength(fine)).toBeGreaterThan(groupLength(coarse));
  });
});

describe('the two algorithms lit by a hillshade', () => {
  // Tanaka and the hatching both render the same hillshade, and the app sends
  // them one sun. They must exaggerate it by the same amount too, or the same
  // light produces two different reliefs on one sheet.
  const lit = ['tanaka', 'hillshade-hatching'];

  it('declare the same vertical exaggeration', () => {
    const [a, b] = lit.map((id) => ALGORITHMS[id].defaults.zFactor);
    expect(a).toBe(b);
  });

  it.each(lit)('declares %s exaggeration in its defaults, not inline', (id) => {
    // A fallback buried in `run` cannot be seen, overridden by the defaults
    // table, or reported to the UI. Tanaka hid a `?? 4` there.
    expect(ALGORITHMS[id].defaults.zFactor).toBeGreaterThan(0);
  });
});
