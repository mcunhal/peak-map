import { describe, it, expect } from 'vitest';
import { compassRose, compassForPage } from './compass';
import { createPage } from './page';
import { polylineLength } from './optimize';

const bounds = (lines) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 2) {
      if (line[i] < minX) minX = line[i];
      if (line[i] > maxX) maxX = line[i];
      if (line[i + 1] < minY) minY = line[i + 1];
      if (line[i + 1] > maxY) maxY = line[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
};

/** The needle tip: the point furthest from the centre on the needle stroke. */
const needleTip = (lines, cx, cy) => {
  // The needle is the closed kite, the second stroke when the ring is on.
  const needle = lines[1];
  let best = null;
  let far = -1;
  for (let i = 0; i < needle.length; i += 2) {
    const d = Math.hypot(needle[i] - cx, needle[i + 1] - cy);
    if (d > far) {
      far = d;
      best = [needle[i], needle[i + 1]];
    }
  }
  return best;
};

describe('compassRose', () => {
  it('is made of strokes, not text', () => {
    const lines = compassRose({ cx: 0, cy: 0, radius: 10 });
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) {
      expect(Array.isArray(line)).toBe(true);
      expect(line.length).toBeGreaterThanOrEqual(4);
      expect(line.every(Number.isFinite)).toBe(true);
    }
  });

  it('points north up the page when north is up the page', () => {
    const lines = compassRose({ cx: 0, cy: 0, radius: 10, northAngle: 0 });
    const [tx, ty] = needleTip(lines, 0, 0);
    expect(Math.abs(tx)).toBeLessThan(0.001);
    // Up the page is a smaller y.
    expect(ty).toBeLessThan(-5);
  });

  it('points where it is told', () => {
    // North lying 90 degrees clockwise from up the page means north is to the right.
    const lines = compassRose({ cx: 0, cy: 0, radius: 10, northAngle: 90 });
    const [tx, ty] = needleTip(lines, 0, 0);
    expect(tx).toBeGreaterThan(5);
    expect(Math.abs(ty)).toBeLessThan(0.001);
  });

  it('follows the angle all the way round', () => {
    for (const northAngle of [0, 45, 90, 180, 270, 315]) {
      const lines = compassRose({ cx: 0, cy: 0, radius: 10, northAngle });
      const [tx, ty] = needleTip(lines, 0, 0);
      const angle = (Math.atan2(tx, -ty) * 180) / Math.PI;
      const expected = ((northAngle % 360) + 360) % 360;
      const got = ((angle % 360) + 360) % 360;
      expect(Math.min(Math.abs(got - expected), 360 - Math.abs(got - expected))).toBeLessThan(0.001);
    }
  });

  it('stays within its own radius, apart from the label', () => {
    const b = bounds(compassRose({ cx: 100, cy: 100, radius: 10 }));
    expect(b.minX).toBeGreaterThan(100 - 11);
    expect(b.maxX).toBeLessThan(100 + 11);
    // The N sits above the ring.
    expect(b.minY).toBeGreaterThan(100 - 16);
    expect(b.maxY).toBeLessThan(100 + 11);
  });

  it('scales with the radius', () => {
    const small = compassRose({ cx: 0, cy: 0, radius: 5 });
    const large = compassRose({ cx: 0, cy: 0, radius: 20 });
    const total = (l) => l.reduce((n, x) => n + polylineLength(x), 0);
    expect(total(large)).toBeGreaterThan(total(small) * 3);
  });

  it('can drop the ring and the minor points', () => {
    const full = compassRose({ cx: 0, cy: 0, radius: 10 });
    const bare = compassRose({ cx: 0, cy: 0, radius: 10, ring: false, ticks: false });
    expect(bare.length).toBeLessThan(full.length);
  });

  it('is deterministic', () => {
    expect(compassRose({ cx: 1, cy: 2, radius: 8, northAngle: 33 })).toEqual(
      compassRose({ cx: 1, cy: 2, radius: 8, northAngle: 33 })
    );
  });

  it('rejects a radius that is not a size', () => {
    expect(() => compassRose({ cx: 0, cy: 0, radius: 0 })).toThrow(/radius/i);
  });
});

describe('compassForPage', () => {
  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });

  it('sits inside the drawable area, bottom right by default', () => {
    const b = bounds(compassForPage(page, { radius: 12 }));
    const { drawable } = page;
    expect(b.minX).toBeGreaterThanOrEqual(drawable.x);
    expect(b.maxX).toBeLessThanOrEqual(drawable.x + drawable.width);
    expect(b.minY).toBeGreaterThanOrEqual(drawable.y);
    expect(b.maxY).toBeLessThanOrEqual(drawable.y + drawable.height);

    // Bottom right, so past the middle on both axes.
    expect(b.minX).toBeGreaterThan(drawable.x + drawable.width / 2);
    expect(b.minY).toBeGreaterThan(drawable.y + drawable.height / 2);
  });

  it('honours the other corners', () => {
    const { drawable } = page;
    const left = bounds(compassForPage(page, { corner: 'bottom-left' }));
    expect(left.maxX).toBeLessThan(drawable.x + drawable.width / 2);

    const top = bounds(compassForPage(page, { corner: 'top-right' }));
    expect(top.maxY).toBeLessThan(drawable.y + drawable.height / 2);
  });

  it('stays inside the page on the smallest sheet with the largest rose', () => {
    const small = createPage({ paper: 'A5', orientation: 'portrait', margin: 5 });
    const b = bounds(compassForPage(small, { radius: 14 }));
    expect(b.minX).toBeGreaterThanOrEqual(small.drawable.x - 0.001);
    expect(b.maxY).toBeLessThanOrEqual(small.drawable.y + small.drawable.height + 0.001);
  });

  it('asks where north is, when north depends on where the rose sits', () => {
    let asked = null;
    compassForPage(page, {
      radius: 10,
      northAngle: (cx, cy) => {
        asked = [cx, cy];
        return 20;
      },
    });
    // It has to be given the rose's own position, not the page's centre.
    expect(asked[0]).toBeGreaterThan(page.drawable.x + page.drawable.width / 2);
    expect(asked[1]).toBeGreaterThan(page.drawable.y + page.drawable.height / 2);
  });

  it('rejects a corner it does not know', () => {
    expect(() => compassForPage(page, { corner: 'middle' })).toThrow(/corner/i);
  });
});
