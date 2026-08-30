import { describe, it, expect } from 'vitest';
import { PAPER_SIZES, createPage, createPageMapper } from './page';

describe('paper sizes', () => {
  it('knows A4 in millimetres', () => {
    expect(PAPER_SIZES.A4).toEqual({ width: 210, height: 297 });
  });

  it('keeps the ISO ratio between A-series sizes', () => {
    // Each A(n) is A(n+1) rotated and doubled.
    expect(PAPER_SIZES.A3.height).toBe(PAPER_SIZES.A2.width);
    expect(PAPER_SIZES.A4.height).toBe(PAPER_SIZES.A3.width);
  });
});

describe('createPage', () => {
  it('lays out portrait A4 with margins', () => {
    const page = createPage({ paper: 'A4', orientation: 'portrait', margin: 10 });
    expect(page.widthMm).toBe(210);
    expect(page.heightMm).toBe(297);
    expect(page.drawable).toEqual({ x: 10, y: 10, width: 190, height: 277 });
  });

  it('swaps the axes for landscape', () => {
    const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 0 });
    expect(page.widthMm).toBe(297);
    expect(page.heightMm).toBe(210);
  });

  it('accepts per-side margins', () => {
    const page = createPage({
      paper: 'A4',
      orientation: 'portrait',
      margin: { top: 5, right: 10, bottom: 15, left: 20 },
    });
    expect(page.drawable).toEqual({ x: 20, y: 5, width: 180, height: 277 });
  });

  it('accepts a custom size', () => {
    const page = createPage({ paper: { width: 100, height: 50 }, margin: 0 });
    expect(page.widthMm).toBe(100);
    expect(page.heightMm).toBe(50);
  });

  it('rejects margins that leave no drawable area', () => {
    expect(() => createPage({ paper: 'A4', margin: 200 })).toThrow(/margin/i);
  });
});

describe('createPageMapper', () => {
  const field = { width: 100, height: 50 };

  it('fits the field inside the drawable area preserving aspect ratio', () => {
    const page = createPage({ paper: { width: 200, height: 200 }, margin: 0 });
    const map = createPageMapper(page, field);
    // Field is 2:1, drawable is 1:1, so width binds: 200/100 = 2mm per sample.
    expect(map.scale).toBeCloseTo(2, 9);
  });

  it('maps the field corners to the drawable area', () => {
    const page = createPage({ paper: { width: 200, height: 200 }, margin: 0 });
    const map = createPageMapper(page, field);
    // 100x50 at 2mm/sample is 200x100mm, centred vertically in 200mm.
    expect(map.toMm(0, 0)).toEqual([0, 50]);
    expect(map.toMm(100, 50)).toEqual([200, 150]);
  });

  it('honours margins', () => {
    const page = createPage({ paper: { width: 220, height: 220 }, margin: 10 });
    const map = createPageMapper(page, field);
    expect(map.scale).toBeCloseTo(2, 9);
    expect(map.toMm(0, 0)).toEqual([10, 60]);
  });

  it('never maps outside the drawable area', () => {
    const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 12 });
    const map = createPageMapper(page, { width: 37, height: 91 });
    for (const [fx, fy] of [[0, 0], [37, 0], [0, 91], [37, 91], [18, 45]]) {
      const [mx, my] = map.toMm(fx, fy);
      expect(mx).toBeGreaterThanOrEqual(page.drawable.x - 1e-9);
      expect(mx).toBeLessThanOrEqual(page.drawable.x + page.drawable.width + 1e-9);
      expect(my).toBeGreaterThanOrEqual(page.drawable.y - 1e-9);
      expect(my).toBeLessThanOrEqual(page.drawable.y + page.drawable.height + 1e-9);
    }
  });
});

describe('createPageMapper with an over-plotted field', () => {
  const page = createPage({ paper: { width: 200, height: 200 }, margin: 0 });

  it('fits the sheet rows, not the whole field', () => {
    const plain = createPageMapper(page, { width: 100, height: 100 });
    const over = createPageMapper(page, { width: 100, height: 110, sheetHeight: 100 });
    // The extra rows hang off the bottom, so the map keeps its size.
    expect(over.scale).toBeCloseTo(plain.scale, 12);
    expect(over.offsetY).toBeCloseTo(plain.offsetY, 12);
  });

  it('puts the sheet edge exactly on the drawable edge', () => {
    const map = createPageMapper(page, { width: 100, height: 110, sheetHeight: 100 });
    expect(map.toMm(0, 100)[1]).toBeCloseTo(200, 9);
  });

  it('maps the over-plotted rows below the page', () => {
    const map = createPageMapper(page, { width: 100, height: 110, sheetHeight: 100 });
    expect(map.toMm(0, 110)[1]).toBeCloseTo(220, 9);
  });

  it('ignores a sheet height that is not a usable number', () => {
    const plain = createPageMapper(page, { width: 100, height: 100 });
    for (const bad of [0, -5, NaN, undefined, null]) {
      const map = createPageMapper(page, { width: 100, height: 100, sheetHeight: bad });
      expect(map.scale).toBeCloseTo(plain.scale, 12);
    }
  });
});
