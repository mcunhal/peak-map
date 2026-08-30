# GPX Files and Line Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group loaded GPX routes by their source file, give each file one pen and one line style, and let any section inside a file override them.

**Architecture:** `appState.tracks` (a flat list of segments) becomes `appState.trackFiles`, each holding a `style` and a list of `sections` that inherit from it. Line styles are drawn as real geometry by a new `dashAlong` generator, never as `stroke-dasharray`. `main.js` flattens files into the flat array the worker already takes, resolving each section's style on the way; `layers.js` then groups sections by resolved pen so the SVG has one layer per pen.

**Tech Stack:** Vue 2 SFC (`src/App.vue`), plain ES modules, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-gpx-files-and-line-styles-design.md`

## Global Constraints

- **Never emit `stroke-dasharray`, and never a fill.** Every path carries its own `stroke` and `stroke-width`. `svgWriter.test.js` asserts this; do not weaken it.
- **Sizes are millimetres at the boundary, samples inside.** Anything measured in millimetres is converted in `src/core/composite.js` against `mapper.scale`. Algorithms and `scene.js` only ever see samples.
- **Everything in `src/core/` is pure.** No DOM, no MapLibre, no canvas.
- **Use `./node_modules/.bin/vitest`, not `npx vitest`.** `npx` resolves a different major version that swallows `console.log`.
- Full suite: `npm test` — 579 tests, offline, ~3s. It must be green at every commit.
- Existing exported names that must keep working unchanged: `dotsAlong`, `splitByVisibility`, `buildLayers`, `parseGpx`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/dash.js` | The dash-pattern generator and the four style presets. Pure, no scene knowledge. | Create |
| `src/core/dash.test.js` | Tests for the above. | Create |
| `src/core/scene.js` | Chooses which generator a run uses, from the track's style. | Modify |
| `src/core/composite.js` | Converts style patterns from millimetres to samples. | Modify |
| `src/core/layers.js` | Groups track sections into one layer per resolved pen. | Modify |
| `src/gpx/trackFiles.js` | The `trackFiles` model: build from parsed files, resolve a section's style, override, reset. Pure, no Vue. | Create |
| `src/gpx/trackFiles.test.js` | Tests for the above. | Create |
| `src/main.js` | Ingest into `trackFiles`; flatten to the worker request. | Modify |
| `src/appState.js` | `trackFiles` replaces `tracks`; drop `dotPitch` / `dotLength`. | Modify |
| `src/App.vue` | The grouped, expandable panel. | Modify |

`dash.js` and `trackFiles.js` are new files rather than additions to `scene.js` and `main.js` because both are pure logic with a small interface and a lot of test surface, and both files they would otherwise land in are already long.

---

### Task 1: The dash generator and style presets

**Files:**
- Create: `src/core/dash.js`
- Test: `src/core/dash.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LINE_STYLES` — `{ solid: null, dashed: [1.8, 1.2], dotted: [0.3, 0.9], 'dash-dot': [1.8, 0.8, 0.3, 0.8] }`, millimetres, `null` meaning no dashing.
  - `LINE_STYLE_IDS` — `['solid', 'dashed', 'dotted', 'dash-dot']`.
  - `dashAlong(points, pattern)` — `points` is `[{x, y}, ...]` in samples, `pattern` is `[on, off, on, off, ...]` in samples. Returns `Array<Array<number>>`, flat `[x0,y0,x1,y1,...]` polylines. A `null` or empty pattern returns the whole run as one polyline.
  - `sparsePattern(pattern)` — doubles the gaps and leaves the marks alone. `null` in, `null` out.

- [ ] **Step 1: Write the failing tests**

```js
// src/core/dash.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/core/dash.test.js`
Expected: FAIL — `Failed to resolve import "./dash"`.

- [ ] **Step 3: Write the implementation**

```js
// src/core/dash.js
/**
 * Line styles, drawn as geometry.
 *
 * The SVG contract forbids `stroke-dasharray`: simple viewers ignore it, and a
 * plotter needs the pen path itself to be broken. So a dashed line is real
 * marks, cut from the run along its own arc length.
 *
 * This is deliberately not `dotsAlong` in `scene.js`. That one clips every mark
 * at the end of the polyline segment it starts in, which is invisible for a
 * 0.3mm dot and ruinous for a 1.8mm dash: a GPX track recorded every few metres
 * has segments shorter than the dash on paper, so every dash would come out
 * truncated to a segment. This walks the whole run instead, and a mark follows
 * the route around a corner.
 */

/** Patterns in millimetres: [on, off, on, off, ...]. Null means no dashing. */
export const LINE_STYLES = {
  solid: null,
  dashed: [1.8, 1.2],
  dotted: [0.3, 0.9],
  'dash-dot': [1.8, 0.8, 0.3, 0.8],
};

export const LINE_STYLE_IDS = Object.keys(LINE_STYLES);

/**
 * The same style, thinned out: gaps doubled, marks untouched.
 *
 * Used where a route passes behind a ridge. Scaling the whole pattern would
 * lengthen the marks too, which reads as a different style rather than the same
 * one at lower density.
 */
export function sparsePattern(pattern) {
  if (!pattern || pattern.length === 0) return null;
  return pattern.map((value, i) => (i % 2 === 1 ? value * 2 : value));
}

/**
 * Cut a run into marks along its arc length.
 *
 * @param {Array<{x: number, y: number}>} points - a run, in field samples
 * @param {Array<number>|null} pattern - [on, off, ...] in samples, cycling
 * @returns {Array<Array<number>>} flat [x0,y0,x1,y1,...] polylines
 */
export function dashAlong(points, pattern) {
  if (points.length < 2) return [];
  if (!pattern || pattern.length === 0) {
    return [points.flatMap((p) => [p.x, p.y])];
  }

  const out = [];
  let step = 0;              // which entry of the pattern we are inside
  let left = pattern[0];     // how much of that entry is still ahead
  let drawing = true;        // even entries are marks, odd ones are gaps
  let run = drawing ? [points[0].x, points[0].y] : [];

  for (let i = 1; i < points.length; ++i) {
    const a = points[i - 1];
    const b = points[i];
    let segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment === 0) continue;

    let travelled = 0;
    while (segment - travelled > left) {
      travelled += left;
      const t = travelled / Math.hypot(b.x - a.x, b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;

      if (drawing) {
        run.push(x, y);
        if (run.length >= 4) out.push(run);
        run = [];
      } else {
        run = [x, y];
      }

      drawing = !drawing;
      step = (step + 1) % pattern.length;
      left = pattern[step];
    }

    left -= segment - travelled;
    // The far end of this segment falls inside the current entry, so a mark in
    // progress simply carries on through the corner.
    if (drawing) run.push(b.x, b.y);
  }

  if (drawing && run.length >= 4) out.push(run);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/core/dash.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 590 passed (579 + 11), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/core/dash.js src/core/dash.test.js
git commit -m "Add a dash generator that survives a corner"
```

---

### Task 2: The trackFiles model

**Files:**
- Create: `src/gpx/trackFiles.js`
- Test: `src/gpx/trackFiles.test.js`

**Interfaces:**
- Consumes: `LINE_STYLE_IDS` from `src/core/dash.js`; `DEFAULT_TRACK_COLORS` from `src/core/layers.js`.
- Produces:
  - `makeTrackFile(fileName, parsedSections, index)` → `{ id, name, style: {color, width, lineStyle}, sections: [{ id, name, points, override: {} }] }`. Colour is `DEFAULT_TRACK_COLORS[index % length]`, width `0.5`, lineStyle `'solid'`.
  - `resolveStyle(file, section)` → `{ color, width, lineStyle }`.
  - `isOverridden(section, key)` → boolean.
  - `setOverride(section, key, value)` → mutates `section.override`.
  - `clearOverride(section, key)` → mutates `section.override`.
  - `flattenForRequest(trackFiles)` → `{ tracks: [{name, fileName, points, lineStyle}], pens: [{color, width}] }`, index-aligned.

- [ ] **Step 1: Write the failing tests**

```js
// src/gpx/trackFiles.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/gpx/trackFiles.test.js`
Expected: FAIL — `Failed to resolve import "./trackFiles"`.

- [ ] **Step 3: Write the implementation**

```js
// src/gpx/trackFiles.js
/**
 * Loaded GPX routes, grouped by the file they came from.
 *
 * A file is the unit a person thinks in: one ride, one colour, one pen. The
 * parser hands back one entry per track segment, and flattening those straight
 * into a list gave a six-segment ride six different colours with nothing to say
 * they belonged together.
 *
 * A section inherits its file's style until it overrides a key, and then holds
 * that key until it is cleared. A file-level change therefore never disturbs
 * something set by hand.
 *
 * Pure, and free of Vue: the panel drives these, and so do the tests.
 */
import { DEFAULT_TRACK_COLORS } from '../core/layers';

const STYLE_KEYS = ['color', 'width', 'lineStyle'];

let seed = 0;
const nextId = (prefix) => `${prefix}${++seed}`;

/**
 * @param {string} fileName - as dropped, e.g. "estrela.gpx"
 * @param {Array<{name, points}>} parsedSections - straight from `parseGpx`
 * @param {number} index - how many files were already loaded; picks the colour
 */
export function makeTrackFile(fileName, parsedSections, index) {
  const id = nextId('f');
  return {
    id,
    name: fileName,
    style: {
      color: DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length],
      width: 0.5,
      lineStyle: 'solid',
    },
    sections: parsedSections.map((section) => ({
      id: nextId(`${id}s`),
      name: section.name,
      points: section.points,
      override: {},
    })),
  };
}

/** The style a section actually draws with. */
export function resolveStyle(file, section) {
  const out = {};
  for (const key of STYLE_KEYS) {
    out[key] = key in section.override ? section.override[key] : file.style[key];
  }
  return out;
}

export function isOverridden(section, key) {
  return key in section.override;
}

export function setOverride(section, key, value) {
  section.override[key] = value;
}

export function clearOverride(section, key) {
  delete section.override[key];
}

/**
 * Flatten to the shape the worker already takes: a list of tracks and a list of
 * pens by the same index. Grouping into layers happens later, from the pens.
 */
export function flattenForRequest(trackFiles) {
  const tracks = [];
  const pens = [];

  for (const file of trackFiles) {
    for (const section of file.sections) {
      const style = resolveStyle(file, section);
      tracks.push({
        name: section.name,
        fileName: file.name,
        points: section.points,
        lineStyle: style.lineStyle,
      });
      pens.push({ color: style.color, width: style.width });
    }
  }

  return { tracks, pens };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/gpx/trackFiles.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 603 passed, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/gpx/trackFiles.js src/gpx/trackFiles.test.js
git commit -m "Group loaded routes by the file they came from"
```

---

### Task 3: Draw a track in its own style

**Files:**
- Modify: `src/core/scene.js` — `splitByVisibility`, and the `drapes`/`tracks` return block
- Test: `src/core/scene.test.js`

**Interfaces:**
- Consumes: `dashAlong`, `sparsePattern` from `src/core/dash.js`.
- Produces: `splitByVisibility(points, mode, dotPitch, dotLength, pattern = null)` — a fifth optional argument. When `pattern` is null the function behaves exactly as it does today. `renderRidgelineScene` reads `track.pattern` off each supplied track (already in samples) and passes it through.

**Note for the implementer:** the existing four-argument calls must keep working unchanged — that is what keeps a default sheet byte-identical. Add the parameter at the end with a null default; do not reorder.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/scene.test.js`:

```js
describe('drawing a track in its own style', () => {
  const visible = (n) =>
    Array.from({ length: n }, (_, i) => ({ x: i, y: 0, visible: true }));

  it('leaves a solid track whole', () => {
    expect(splitByVisibility(visible(5), 'dotted', 0.9, 0.3, null)).toEqual([
      [0, 0, 1, 0, 2, 0, 3, 0, 4, 0],
    ]);
  });

  it('cuts a visible run into the pattern it was given', () => {
    const out = splitByVisibility(visible(11), 'dotted', 0.9, 0.3, [2, 2]);
    expect(out.map((l) => [l[0], l[l.length - 2]])).toEqual([[0, 2], [4, 6], [8, 10]]);
  });

  it('draws a hidden run of a styled track sparser, not differently', () => {
    // 12 points, the second half hidden.
    const points = Array.from({ length: 13 }, (_, i) => ({
      x: i, y: 0, visible: i <= 6,
    }));
    const out = splitByVisibility(points, 'dotted', 0.9, 0.3, [2, 2]);

    // The hidden half is the same 2-long mark, with the gap doubled to 4.
    const hidden = out.map((l) => [l[0], l[l.length - 2]]).filter(([s]) => s >= 6);
    for (const [start, end] of hidden) expect(end - start).toBeCloseTo(2, 6);
  });

  it('still dots a hidden run when the track is solid, exactly as before', () => {
    // The default sheet must not change: no pattern means the old path.
    const points = Array.from({ length: 13 }, (_, i) => ({
      x: i, y: 0, visible: i <= 6,
    }));
    expect(splitByVisibility(points, 'dotted', 0.9, 0.3, null)).toEqual(
      splitByVisibility(points, 'dotted', 0.9, 0.3)
    );
  });

  it('applies the style to an always-visible track too', () => {
    // 'visible' mode used to return the run whole regardless of style.
    const out = splitByVisibility(visible(11), 'visible', 0.9, 0.3, [2, 2]);
    expect(out.length).toBeGreaterThan(1);
  });

  it('draws nothing hidden when the mode says hide, styled or not', () => {
    const points = Array.from({ length: 13 }, (_, i) => ({
      x: i, y: 0, visible: i <= 6,
    }));
    const out = splitByVisibility(points, 'hidden', 0.9, 0.3, [2, 2]);
    for (const line of out) expect(line[0]).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/core/scene.test.js`
Expected: FAIL — "cuts a visible run into the pattern it was given" returns one whole polyline; the fifth argument is ignored.

- [ ] **Step 3: Change `splitByVisibility`**

Replace the existing function in `src/core/scene.js` with:

```js
/**
 * Walk a track in route order and cut it into drawable polylines according to the
 * visibility already decided for each point.
 *
 * `pattern` is the track's line style, in samples, or null for a solid line.
 * A solid track keeps the original path exactly — including `dotsAlong` for its
 * hidden run — which is what makes a sheet drawn with the defaults unchanged.
 */
export function splitByVisibility(points, mode, dotPitch, dotLength, pattern = null) {
  const out = [];
  if (points.length < 2) return out;

  const styled = (run) =>
    pattern ? dashAlong(run, pattern) : [run.flatMap((p) => [p.x, p.y])];

  if (mode === 'visible') {
    out.push(...styled(points));
    return out;
  }

  let run = [];
  let runVisible = points[0].visible;

  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    if (runVisible) {
      out.push(...styled(run));
    } else if (mode === 'dotted') {
      // A solid line has no gaps to widen, so it falls back to plain dots.
      out.push(
        ...(pattern
          ? dashAlong(run, sparsePattern(pattern))
          : dotsAlong(run, dotPitch, dotLength))
      );
    }
    run = [];
  };

  for (const point of points) {
    if (point.visible !== runVisible) {
      // Share the boundary point with both runs so there is no gap between them.
      run.push(point);
      flush();
      runVisible = point.visible;
      run.push(point);
    }
    run.push(point);
  }
  flush();

  return out;
}
```

Add to the imports at the top of `src/core/scene.js`:

```js
import { dashAlong, sparsePattern } from './dash';
```

- [ ] **Step 4: Pass each track's pattern through**

In `renderRidgelineScene`, change the `tracks` entry of the returned object to read the pattern off the supplied track:

```js
    tracks: tracks.map((track, i) => ({
      name: track.name,
      polylines: splitByVisibility(
        projected[i], trackMode, dotPitch, dotLength, track.pattern || null
      ),
    })),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/core/scene.test.js`
Expected: PASS, all of them — including every pre-existing test, unchanged.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 609 passed, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/core/scene.js src/core/scene.test.js
git commit -m "Draw a track in the line style it was given"
```

---

### Task 4: Convert style patterns at the millimetre boundary

**Files:**
- Modify: `src/core/composite.js`
- Test: `src/core/composite.test.js`

**Interfaces:**
- Consumes: `LINE_STYLES` from `src/core/dash.js`; `tracks[].lineStyle` from the request.
- Produces: each track handed to `renderRidgelineScene` carries `pattern`, in samples.

**Note for the implementer:** this is the invariant that broke the relief once. A pattern in millimetres must be divided by `mapper.scale` here, or raising the detail will shrink every dash on the page.

- [ ] **Step 1: Write the failing test**

Append to `src/core/composite.test.js`:

```js
describe('line styles at the millimetre boundary', () => {
  const twoTracks = (lineStyle) => [
    { name: 'r', fileName: 'a.gpx', lineStyle, points: trackAlongRow(field, 30).points },
  ];

  it('draws the same dash length on paper however fine the sampling', () => {
    // The bug this guards: sizes are millimetres at the boundary and samples
    // inside. A pattern passed straight through would shrink with detail.
    const lengthsAt = (width) => {
      const f = hillWithBbox(width, Math.round(width * 0.75));
      const { mapper } = setup(f);
      const layers = buildTerrainLayers({
        field: f,
        mapper,
        algorithmIds: ['ridgeline'],
        algorithmOptions: { rowCount: 20, heightScale: 20, smoothSteps: 0 },
        tracks: [{
          name: 'r', fileName: 'a.gpx', lineStyle: 'dashed',
          points: trackAlongRow(f, Math.round(f.height * 0.5)).points,
        }],
        trackMode: 'visible',
        pens: { tracks: [{ color: '#c1272d', width: 0.5 }] },
      });
      const route = layers.find((l) => l.id.startsWith('route'));
      return route.polylines
        .slice(1, 6)
        .map((l) => Math.hypot(l[2] - l[0], l[3] - l[1]));
    };

    const coarse = lengthsAt(80);
    const fine = lengthsAt(160);
    for (let i = 0; i < coarse.length; ++i) {
      // 1.8mm on paper at both sampling rates.
      expect(fine[i]).toBeCloseTo(coarse[i], 1);
      expect(fine[i]).toBeCloseTo(1.8, 1);
    }
  });

  it('leaves a solid track as one polyline per visible run', () => {
    const { mapper } = setup(field);
    const layers = buildTerrainLayers({
      field,
      mapper,
      algorithmIds: ['ridgeline'],
      algorithmOptions: { rowCount: 20, heightScale: 20, smoothSteps: 0 },
      tracks: twoTracks('solid'),
      trackMode: 'visible',
      pens: { tracks: [{ color: '#c1272d', width: 0.5 }] },
    });
    expect(layers.find((l) => l.id.startsWith('route')).polylines).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/core/composite.test.js`
Expected: FAIL — the dashed track comes back as one polyline; `pattern` is never built.

- [ ] **Step 3: Convert the patterns**

In `src/core/composite.js`, add the import:

```js
import { LINE_STYLES } from './dash';
```

Then, next to the existing `trackDots` line, build the styled tracks and use them everywhere `tracks` is passed to `renderRidgelineScene`:

```js
  // Line styles are millimetres on paper, like every other size here, so they
  // convert against the same scale. Passing them through in millimetres would
  // make every dash shrink as the detail rose — the same silent failure the
  // table above exists to prevent.
  const styledTracks = tracks.map((track) => {
    const pattern = LINE_STYLES[track.lineStyle] || null;
    return pattern
      ? { ...track, pattern: pattern.map((mm) => mm * samplesPerMm) }
      : track;
  });
```

Replace every `tracks,` passed into `renderRidgelineScene` (there are three: in `flat()`, in `draped()`, and in `flatTracks()`) with `tracks: styledTracks,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/core/composite.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 611 passed, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/core/composite.js src/core/composite.test.js
git commit -m "Convert line styles to samples at the millimetre boundary"
```

---

### Task 5: One SVG layer per pen

**Files:**
- Modify: `src/core/layers.js`
- Test: `src/core/layers.test.js`

**Interfaces:**
- Consumes: `scene.tracks[].name`, and a new `scene.tracks[].fileName`; `options.trackPens` by index, as today.
- Produces: layers with id `route-<colour without #>-<width × 100, zero-padded to 3>` and label listing the distinct contributing file names.

**Note for the implementer:** a plotter does a pen change per layer, so twenty segments of one colour must not become twenty layers. Sections merge on colour and width only — line style is geometry by this point, not a pen.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/layers.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/core/layers.test.js`
Expected: FAIL — three layers come back instead of one; ids are `route-s1` and so on.

- [ ] **Step 3: Replace the track loop in `buildLayers`**

Replace the `(scene.tracks || []).forEach(...)` block in `src/core/layers.js` with:

```js
  // One layer per pen, not per section. A plotter does a pen change per layer,
  // so a twenty-segment ride in one colour must not ask for twenty of them.
  // Line style does not enter the key: by this point a dash is geometry, and a
  // dashed and a solid route of the same colour and width take the same pen.
  const byPen = new Map();

  (scene.tracks || []).forEach((track, index) => {
    if (!track.polylines || track.polylines.length === 0) return;

    const pen = trackPens[index] || {};
    const color = pen.color || DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length];
    const width = pen.width ?? 0.5;
    const key = `${color}|${width}`;

    if (!byPen.has(key)) {
      byPen.set(key, {
        id: penId(color, width),
        sources: [],
        penColor: color,
        penWidth: width,
        polylines: [],
      });
    }

    const layer = byPen.get(key);
    const source = track.fileName || track.name;
    if (source && !layer.sources.includes(source)) layer.sources.push(source);
    for (const line of track.polylines) layer.polylines.push(mapper.polylineToMm(line));
  });

  for (const layer of byPen.values()) {
    let id = layer.id;
    if (usedIds.has(id)) id = `${id}-${usedIds.size}`;
    usedIds.add(id);
    layers.push({
      id,
      label: layer.sources.join(', ') || id,
      penColor: layer.penColor,
      penWidth: layer.penWidth,
      polylines: layer.polylines,
    });
  }
```

Add the id helper next to `toId`:

```js
/**
 * A layer id from the pen itself, so the same pen always lands in the same
 * layer whatever it was called upstream.
 */
function penId(color, width) {
  const hex = String(color).replace('#', '').toLowerCase();
  const hundredths = String(Math.round(Number(width) * 100)).padStart(3, '0');
  return `route-${hex}-${hundredths}`;
}
```

`toId` is now unused by the track path but is still used for the terrain; leave it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/core/layers.test.js`
Expected: PASS. Pre-existing tests in that file which assert one layer per track by name will fail — **read each one and decide whether the test or the code is wrong before changing either.** Tests asserting per-track ids are now asserting the old design and should be rewritten to the new grouping; tests asserting pen colour, width, or that empty tracks are dropped must still pass unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: green. `pipeline.test.js` and `composite.test.js` reference route layer ids; update those references to the new ids rather than loosening the assertions.

- [ ] **Step 6: Commit**

```bash
git add src/core/layers.js src/core/layers.test.js src/core/pipeline.test.js src/core/composite.test.js
git commit -m "Give the SVG one layer per pen, not one per segment"
```

---

### Task 6: Ingest files, and send them

**Files:**
- Modify: `src/main.js:388-415` — `addGpxFiles`, `removeTrack`; `buildRequest`
- Modify: `src/appState.js:104` — `tracks` → `trackFiles`; remove `dotPitch`, `dotLength`

**Interfaces:**
- Consumes: `makeTrackFile`, `flattenForRequest` from `src/gpx/trackFiles.js`.
- Produces: `appState.trackFiles`; `removeTrackFile(fileId)`; the request's `tracks` and `pens.tracks`.

- [ ] **Step 1: Change the state**

In `src/appState.js`, replace `tracks: [],` with `trackFiles: [],`, and delete the `dotPitch: 0.9,` and `dotLength: 0.3,` lines.

- [ ] **Step 2: Change ingest**

Replace `addGpxFiles` and `removeTrack` in `src/main.js` with:

```js
/** Parse dropped or chosen GPX files and add them, one entry per file. */
async function addGpxFiles(files) {
  const errors = [];

  for (const file of files) {
    try {
      const parsed = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
      if (parsed.length === 0) {
        errors.push(`${file.name}: no track points`);
        continue;
      }
      appState.trackFiles.push(
        makeTrackFile(file.name, parsed, appState.trackFiles.length)
      );
    } catch (error) {
      // One bad file must not lose the others.
      errors.push(`${file.name}: ${error.message}`);
    }
  }

  appState.error = errors.length ? errors.join('; ') : null;
  if (appState.shouldDraw) updateMap();
}

function removeTrackFile(fileId) {
  const at = appState.trackFiles.findIndex((f) => f.id === fileId);
  if (at >= 0) appState.trackFiles.splice(at, 1);
  if (appState.shouldDraw) updateMap();
}
```

Add the import at the top of `src/main.js`:

```js
import { makeTrackFile, flattenForRequest } from './gpx/trackFiles';
```

Export `removeTrackFile` wherever `removeTrack` was exported, and delete `removeTrack`.

- [ ] **Step 3: Change the request**

In `buildRequest`, replace the `tracks:` line and the `pens.tracks` line. Build the flattened pair once, above the returned object:

```js
  const { tracks: trackList, pens: trackPens } = flattenForRequest(appState.trackFiles);
```

Then use `tracks: trackList,` in place of the old `tracks:` mapping, `tracks: trackPens,` inside `pens`, and delete the `dotPitch` and `dotLength` entries from the request.

- [ ] **Step 4: Update everything that read the old state**

Search and fix every remaining reference:

Run: `grep -rn "appState.tracks\|dotPitch\|dotLength\|removeTrack\b" src/ --include=*.js --include=*.vue`
Expected after the edits: matches only in `src/core/scene.js` (its own `dotPitch`/`dotLength` parameters, which stay) and `src/core/composite.js` (`trackDots`, which stays for solid tracks). Anything in `src/main.js`, `src/appState.js` or `src/App.vue` is a leftover — fix it.

`trackBounds` in `src/gpx/parse.js` takes a flat list of `{points}`; call it with `flattenForRequest(appState.trackFiles).tracks`.

- [ ] **Step 5: Verify the app builds and the suite is green**

Run: `npm run build && npm test`
Expected: build clean; tests green.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/appState.js
git commit -m "Load GPX as files, and send their resolved pens"
```

---

### Task 7: The grouped panel

**Files:**
- Modify: `src/App.vue` — the `GPX routes` block (currently around lines 254-283), `computed`, `methods`, `RENDER_INPUTS`

**Interfaces:**
- Consumes: `resolveStyle`, `isOverridden`, `setOverride`, `clearOverride` from `src/gpx/trackFiles.js`; `LINE_STYLE_IDS` from `src/core/dash.js`; `removeTrackFile` from `src/main.js`.
- Produces: the panel. No new app state — expansion is component-local.

**Note for the implementer:** there is no DOM test harness in this project (no jsdom, no `@vue/test-utils`). Verify this task by driving the running app, as Step 5 describes. Do not add a test dependency for it.

- [ ] **Step 1: Replace the GPX routes block**

```html
        <h3>GPX routes</h3>
        <div class='row'>
          <div class='col'>Add files</div>
          <div class='col c-2'><input type='file' accept='.gpx' multiple @change='onGpxChosen'></div>
        </div>

        <template v-for='file in trackFiles'>
          <div class='row' :key='file.id'>
            <div class='col track-name'>
              <a href='#' class='disclosure' @click.prevent='toggleFile(file.id)'>{{expanded[file.id] ? '▾' : '▸'}}</a>
              {{file.name}}
            </div>
            <div class='col c-2'>
              <input type='color' v-model='file.style.color'>
              <input type='number' step='0.05' v-model.number='file.style.width' min='0.05' max='2'>
              <select v-model='file.style.lineStyle'>
                <option v-for='s in lineStyles' :value='s' :key='s'>{{s}}</option>
              </select>
              <a href='#' @click.prevent='removeFile(file.id)'>remove</a>
            </div>
          </div>

          <div class='row section' v-for='section in (expanded[file.id] ? file.sections : [])' :key='section.id'>
            <div class='col track-name section-name'>{{section.name}}</div>
            <div class='col c-2'>
              <input type='color'
                     :value='styleOf(file, section).color'
                     @input='override(section, "color", $event.target.value)'>
              <input type='number' step='0.05' min='0.05' max='2'
                     :value='styleOf(file, section).width'
                     @input='override(section, "width", Number($event.target.value))'>
              <select :value='styleOf(file, section).lineStyle'
                      @change='override(section, "lineStyle", $event.target.value)'>
                <option v-for='s in lineStyles' :value='s' :key='s'>{{s}}</option>
              </select>
              <a href='#' v-if='hasOverride(section)' @click.prevent='resetSection(section)'>reset</a>
            </div>
          </div>
        </template>

        <div class='row' v-if='trackFiles.length'>
          <div class='col'>Behind a ridge</div>
          <div class='col c-2'>
            <select v-model='trackMode'>
              <option value='dotted'>draw as dots</option>
              <option value='hidden'>hide</option>
              <option value='visible'>always show</option>
            </select>
          </div>
        </div>
```

- [ ] **Step 2: Add the component code**

In `data`, add `expanded: {}`.

In `computed`, add:

```js
    lineStyles() {
      return LINE_STYLE_IDS;
    },
```

In `methods`, add:

```js
    toggleFile(id) {
      // Vue 2 cannot see a plain key added to an object.
      this.$set(this.expanded, id, !this.expanded[id]);
    },
    styleOf(file, section) {
      return resolveStyle(file, section);
    },
    hasOverride(section) {
      return Object.keys(section.override).length > 0;
    },
    override(section, key, value) {
      this.$set(section.override, key, value);
    },
    resetSection(section) {
      for (const key of Object.keys(section.override)) this.$delete(section.override, key);
    },
    removeFile(id) {
      removeTrackFile(id);
    },
```

Add the imports at the top of the `<script>` block:

```js
import { resolveStyle } from './gpx/trackFiles';
import { LINE_STYLE_IDS } from './core/dash';
```

and add `removeTrackFile` to whatever `main.js` import the file already has for `removeTrack`.

In `RENDER_INPUTS`, replace `'tracks'` with `'trackFiles'` and delete `'dotPitch'`, `'dotLength'`. The deep watcher on `tracks` becomes a deep watcher on `trackFiles`.

- [ ] **Step 3: Add the styles**

Append to the `<style>` block:

```css
.settings-form .row.section { opacity: 0.9; }
.settings-form .section-name { padding-left: 1.5em; font-size: 0.9em; }
.settings-form .disclosure { text-decoration: none; margin-right: 0.4em; }
```

- [ ] **Step 4: Verify the suite and the build**

Run: `npm test && npm run build`
Expected: both green.

- [ ] **Step 5: Verify the panel in the running app**

Start the dev server, then drive it with Playwright, which is installed at `D:\Dev` (import from a script placed there, or module resolution fails). `window.appState` is exposed in dev builds; set `shouldDraw` and `settingsOpen` to open the panel, since the map never finishes painting in a headless tab.

Check, and report what you saw:
1. Loading a 3-segment GPX gives **one** row, not three.
2. Its three sections appear only after clicking the disclosure.
3. Changing the file colour moves all three sections.
4. Overriding one section's width, then changing the file width, leaves that section at its own value and moves the other two.
5. **reset** appears only on the overridden section and returns it to the file's value.

- [ ] **Step 6: Commit**

```bash
git add src/App.vue
git commit -m "Show GPX routes grouped by file, with per-section overrides"
```

---

### Task 8: End-to-end, and the notes

**Files:**
- Modify: `scripts/renderUserRoutes.test.js`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the guarded route test**

`scripts/renderUserRoutes.test.js` builds a request by hand. Update it to the new shape: `tracks` entries gain `fileName` and `lineStyle`, `dotPitch`/`dotLength` go. Give one file `lineStyle: 'dashed'` so the guarded run exercises a style against real GPX.

Run: `GPX_DIR=/path/to/gpx SAMPLE_DIR=/tmp ./node_modules/.bin/vitest run scripts/renderUserRoutes.test.js`
Expected: PASS, if you have GPX to hand. If not, say so rather than skipping silently.

- [ ] **Step 2: Add a test that dashes survive the optimizer**

Append to `src/core/composite.test.js`:

```js
it('leaves the dashes in a styled route after optimization', () => {
  // merge rejoins endpoints within mergeTolerance. The smallest gap in the
  // presets is 0.8mm against a 0.15mm default, so the dashes must survive.
  const { mapper } = setup(field);
  const layers = buildTerrainLayers({
    field,
    mapper,
    algorithmIds: ['ridgeline'],
    algorithmOptions: { rowCount: 20, heightScale: 20, smoothSteps: 0 },
    tracks: [{
      name: 'r', fileName: 'a.gpx', lineStyle: 'dashed',
      points: trackAlongRow(field, 30).points,
    }],
    trackMode: 'visible',
    pens: { tracks: [{ color: '#c1272d', width: 0.5 }] },
  });

  const before = layers.find((l) => l.id.startsWith('route')).polylines.length;
  const after = optimizeLayers(layers, {
    dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08,
  }).find((l) => l.id.startsWith('route')).polylines.length;

  expect(before).toBeGreaterThan(5);
  expect(after).toBe(before);
});
```

Add `import { optimizeLayers } from './optimize';` to that file if it is not already there.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run build`
Expected: green, clean.

- [ ] **Step 4: Record the invariants**

Add to the Invariants section of `AGENTS.md`:

```markdown
**A line style is geometry, never `stroke-dasharray`.** `core/dash.js` holds the
four presets and `dashAlong`, which cuts a run into marks along its arc length.
`scene.js` keeps `dotsAlong` as well, and the two are not interchangeable:
`dotsAlong` clips every mark at the end of the polyline segment it starts in,
which is invisible at a 0.3mm dot and ruinous at a 1.8mm dash, because a GPX
track recorded every few metres has segments shorter than the dash on paper. A
solid track's hidden run still goes through `dotsAlong`, which is what keeps a
default sheet byte-identical.

Patterns are millimetres and convert in `composite.js` like every other size. A
pattern passed through in millimetres shrinks with the detail slider.

Gaps must stay well clear of `mergeTolerance` — 0.15mm by default against a
smallest gap of 0.8mm. Raise merge tolerance past the gap and the optimizer
joins every dash back into a solid line with nothing to say it did.

**A file is the unit, not a segment.** `parseGpx` returns one entry per track
segment; `gpx/trackFiles.js` groups them under the file they came from, which is
what a person actually names and colours. A section inherits its file's style
until it overrides a key, then holds it until reset, so a file-level change never
disturbs something set by hand. The palette advances per file.

**The SVG has one layer per pen, not one per section.** A plotter does a pen
change per layer, so a twenty-segment ride in one colour is one layer. Sections
merge on colour and width alone — a dash is geometry by then, not a pen — and the
label lists the files that contributed. The layer list therefore does not map
one-to-one onto files; the panel is where the file grouping shows.
```

Update the test count on the `npm test` line to whatever `npm test` now reports.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md scripts/renderUserRoutes.test.js src/core/composite.test.js
git commit -m "Record what line styles and file grouping cost"
```

---

## Self-Review

**Spec coverage.** Data model → Task 2. Line styles as geometry → Task 1, with the `dotsAlong` split the spec now records. Behind a ridge, including the solid special case → Task 3. Millimetre boundary → Task 4. SVG layers → Task 5. Panel → Task 7. Worker request → Task 6. `dotPitch`/`dotLength` removal → Tasks 6 and 7. Every testing row in the spec appears in a task; the optimizer risk is Task 8 Step 2.

**Type consistency.** `resolveStyle(file, section)`, `setOverride(section, key, value)`, `clearOverride(section, key)`, `isOverridden(section, key)`, `makeTrackFile(fileName, parsedSections, index)`, `flattenForRequest(trackFiles)` are used with those exact signatures in Tasks 2, 6 and 7. `dashAlong(points, pattern)` and `sparsePattern(pattern)` are used as defined in Tasks 1, 3 and 4. `splitByVisibility` keeps its four existing parameters and gains a fifth. `penId(color, width)` is defined and used only in Task 5.

**Known rough edge.** Task 5 changes route layer ids, which `pipeline.test.js` and `composite.test.js` assert on. Step 5 of that task calls this out and says to update the references rather than loosen them.
