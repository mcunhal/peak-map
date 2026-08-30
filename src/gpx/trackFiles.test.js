import { describe, it, expect } from 'vitest';
import {
  makeTrackFile, resolveStyle, isOverridden, setOverride, clearOverride,
  flattenForRequest,
} from './trackFiles';
import { DEFAULT_TRACK_COLORS } from '../core/layers';

const parsed = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `seg ${i + 1}`,
    points: [{ lat: 40 + i, lon: -8, ele: null }, { lat: 40.1 + i, lon: -8, ele: null }],
  }));

describe('makeTrackFile', () => {
  it('keeps every parsed segment as a section of one file', () => {
    const file = makeTrackFile('estrela.gpx', parsed(3), 0);
    expect(file.name).toBe('estrela.gpx');
    expect(file.sections).toHaveLength(3);
    expect(file.sections.map((s) => s.name)).toEqual(['seg 1', 'seg 2', 'seg 3']);
  });

  it('gives the file one colour, not one per segment', () => {
    // The whole point: a six-segment ride used to arrive in six colours.
    const file = makeTrackFile('estrela.gpx', parsed(6), 0);
    expect(file.style.color).toBe(DEFAULT_TRACK_COLORS[0]);
    expect(file.style.width).toBe(0.5);
    expect(file.style.lineStyle).toBe('solid');
  });

  it('advances the palette per file', () => {
    const a = makeTrackFile('a.gpx', parsed(4), 0);
    const b = makeTrackFile('b.gpx', parsed(2), 1);
    expect(b.style.color).toBe(DEFAULT_TRACK_COLORS[1]);
    expect(b.style.color).not.toBe(a.style.color);
  });

  it('gives every file and section an id of its own', () => {
    const a = makeTrackFile('a.gpx', parsed(2), 0);
    const b = makeTrackFile('b.gpx', parsed(2), 1);
    const ids = [a.id, b.id, ...a.sections.map((s) => s.id), ...b.sections.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts every section with no overrides', () => {
    const file = makeTrackFile('a.gpx', parsed(2), 0);
    for (const s of file.sections) expect(s.override).toEqual({});
  });
});

describe('resolveStyle', () => {
  it('takes the file style when the section overrides nothing', () => {
    const file = makeTrackFile('a.gpx', parsed(1), 0);
    expect(resolveStyle(file, file.sections[0])).toEqual({
      color: DEFAULT_TRACK_COLORS[0], width: 0.5, lineStyle: 'solid',
    });
  });

  it('takes the overridden key and inherits the rest', () => {
    const file = makeTrackFile('a.gpx', parsed(1), 0);
    setOverride(file.sections[0], 'width', 0.8);
    expect(resolveStyle(file, file.sections[0])).toEqual({
      color: DEFAULT_TRACK_COLORS[0], width: 0.8, lineStyle: 'solid',
    });
  });

  it('leaves an overridden section alone when the file changes', () => {
    const file = makeTrackFile('a.gpx', parsed(2), 0);
    setOverride(file.sections[0], 'color', '#000000');
    file.style.color = '#ffffff';

    expect(resolveStyle(file, file.sections[0]).color).toBe('#000000');
    expect(resolveStyle(file, file.sections[1]).color).toBe('#ffffff');
  });
});

describe('overrides', () => {
  it('reports which keys are held by the section', () => {
    const file = makeTrackFile('a.gpx', parsed(1), 0);
    const s = file.sections[0];
    expect(isOverridden(s, 'width')).toBe(false);
    setOverride(s, 'width', 0.8);
    expect(isOverridden(s, 'width')).toBe(true);
    expect(isOverridden(s, 'color')).toBe(false);
  });

  it('returns the section to the file value when cleared', () => {
    const file = makeTrackFile('a.gpx', parsed(1), 0);
    const s = file.sections[0];
    setOverride(s, 'lineStyle', 'dotted');
    clearOverride(s, 'lineStyle');
    expect(isOverridden(s, 'lineStyle')).toBe(false);
    expect(resolveStyle(file, s).lineStyle).toBe('solid');
  });
});

describe('flattenForRequest', () => {
  it('emits one entry per section, with its resolved pen alongside', () => {
    const a = makeTrackFile('a.gpx', parsed(2), 0);
    const b = makeTrackFile('b.gpx', parsed(1), 1);
    setOverride(a.sections[1], 'width', 0.9);
    b.style.lineStyle = 'dashed';

    const { tracks, pens } = flattenForRequest([a, b]);

    expect(tracks).toHaveLength(3);
    expect(pens).toHaveLength(3);
    expect(tracks.map((t) => t.fileName)).toEqual(['a.gpx', 'a.gpx', 'b.gpx']);
    expect(tracks.map((t) => t.lineStyle)).toEqual(['solid', 'solid', 'dashed']);
    expect(pens.map((p) => p.width)).toEqual([0.5, 0.9, 0.5]);
    expect(pens.map((p) => p.color)).toEqual([
      DEFAULT_TRACK_COLORS[0], DEFAULT_TRACK_COLORS[0], DEFAULT_TRACK_COLORS[1],
    ]);
  });

  it('carries the points through untouched', () => {
    const a = makeTrackFile('a.gpx', parsed(1), 0);
    expect(flattenForRequest([a]).tracks[0].points).toBe(a.sections[0].points);
  });

  it('has nothing to send when no files are loaded', () => {
    expect(flattenForRequest([])).toEqual({ tracks: [], pens: [] });
  });
});
