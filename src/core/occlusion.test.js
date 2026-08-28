import { describe, it, expect } from 'vitest';
import { createOcclusionBuffer } from './occlusion';

describe('createOcclusionBuffer', () => {
  it('starts with everything visible', () => {
    const buf = createOcclusionBuffer(4, 100);
    expect(buf.isVisible(0, 99)).toBe(true);
    expect(buf.isVisible(3, 0)).toBe(true);
  });

  it('hides points at or below an already drawn point', () => {
    const buf = createOcclusionBuffer(4, 100);
    buf.mark(2, 40);
    expect(buf.isVisible(2, 41)).toBe(false);
    expect(buf.isVisible(2, 39)).toBe(true);
  });

  it('treats a point at exactly the drawn height as visible', () => {
    const buf = createOcclusionBuffer(4, 100);
    buf.mark(2, 40);
    expect(buf.isVisible(2, 40)).toBe(true);
  });

  it('keeps columns independent', () => {
    const buf = createOcclusionBuffer(4, 100);
    buf.mark(1, 10);
    expect(buf.isVisible(2, 90)).toBe(true);
  });

  it('only ever raises the horizon', () => {
    const buf = createOcclusionBuffer(4, 100);
    buf.mark(0, 30);
    buf.mark(0, 70); // lower on screen, behind the first
    expect(buf.horizonAt(0)).toBe(30);
  });

  it('reports points above the page as not visible', () => {
    const buf = createOcclusionBuffer(4, 100);
    expect(buf.isVisible(0, -5)).toBe(false);
  });

  it('rejects out-of-range columns', () => {
    const buf = createOcclusionBuffer(4, 100);
    expect(() => buf.mark(4, 10)).toThrow(/column/i);
  });

  it('resets to fully visible', () => {
    const buf = createOcclusionBuffer(4, 100);
    buf.mark(0, 10);
    buf.reset();
    expect(buf.isVisible(0, 99)).toBe(true);
  });
});
