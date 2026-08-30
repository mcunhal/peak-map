# GPX routes grouped by file, with line styles

**Date:** 2026-08-31
**Status:** Approved, ready for implementation planning
**Touches:** `src/gpx/`, `src/core/scene.js`, `src/core/layers.js`, `src/core/composite.js`, `src/main.js`, `src/App.vue`, `src/appState.js`

## Goal

Organise loaded GPX routes by the file they came from, give each file one pen and
one line style, and let any section inside a file override them.

## Why

Loading one GPX file today produces one entry per track segment, each taking the
next colour from the palette. A six-segment ride arrives as six differently
coloured routes with no indication they belong together, and re-colouring them
means editing six controls to the same value.

The file is the unit a person thinks in. It should be the unit the panel shows.

## What exists now

| | |
|---|---|
| `parseGpx(xml, fallbackName)` | returns `[{name, points}]`, one per track segment, route, or waypoint run |
| `addGpxFiles` in `main.js` | flattens every file's segments into a flat `appState.tracks`, colour by global index |
| `appState.tracks` | `[{name, points, color, width}]`, not persisted |
| Panel | flat list; colour, width, remove per entry |
| `trackMode` | global: `hidden` / `dotted` / `visible` — what happens where a route passes behind a ridge |
| `dotPitch`, `dotLength` | global, millimetres, used only for the `dotted` hidden run |
| `dotsAlong(points, pitch, dotLength)` | in `scene.js`; emits real two-point marks along a polyline |
| `buildLayers` | one SVG layer per track, by index |

Two existing constraints shape the design:

- **The SVG contract forbids `stroke-dasharray`.** A dashed line has to be real
  geometry. `dotsAlong` already does exactly this, so the primitive exists.
- **Sizes are millimetres at the boundary, samples inside.** Anything measured in
  millimetres must be converted in `composite.js` against `mapper.scale`, or
  raising the detail silently changes how the sheet looks.

## Design

### 1. Data model

`appState.tracks` becomes `appState.trackFiles`:

```js
{
  id: 'f1',
  name: 'estrela.gpx',
  style: { color: '#c1272d', width: 0.5, lineStyle: 'solid' },
  sections: [
    { id: 'f1s0', name: 'Ascent (1)', points: [...], override: {} },
    { id: 'f1s1', name: 'Ascent (2)', points: [...], override: { width: 0.8 } },
  ],
}
```

A section's effective style is `{ ...file.style, ...section.override }`, taking
only keys actually present in `override`.

- Editing a section control writes that one key into `override`.
- **Reset** deletes the key, returning the section to the file's value.
- Editing a file control changes `file.style` and therefore every section that
  has not overridden that key. Overridden sections are left alone.

The palette advances **per file**, not per section. This is the change that fixes
the original complaint.

Tracks are not persisted — only `lidarCacheUrl` is — so there is no migration and
no stored shape to keep compatible.

### 2. Line styles as geometry

Generalise the dot generator:

```js
dashAlong(points, pattern)   // pattern is [on, off, on, off, ...] in samples, cycling
```

`dotsAlong(points, pitch, dotLength)` becomes a wrapper for
`dashAlong(points, [dotLength, pitch - dotLength])`, so its existing callers and
tests are untouched.

Presets, in millimetres:

| style | pattern |
|---|---|
| `solid` | — (no dashing) |
| `dashed` | 1.8 on, 1.2 off |
| `dotted` | 0.3 on, 0.9 off |
| `dash-dot` | 1.8 on, 0.8 off, 0.3 on, 0.8 off |

`dash-dot` alternates, which is why a single pitch/length pair is not enough and
the pattern is a list.

The patterns are millimetres and must be converted at the `composite.js`
boundary, where `trackDots` is converted today. Converting the resolved pattern
per section replaces `trackDots` entirely.

`dotPitch` and `dotLength` are removed: from the panel, from the worker request,
and from `appState`. Nothing needs them once every style carries its own pattern,
and leaving two dead millimetre fields in the request is exactly the kind of
second convention this design exists to remove.

### 3. Where a route passes behind a ridge

`trackMode` stays global. Within it:

- **`dotted`** — the hidden run draws the section's own style, sparser. Precisely:
  **the gaps double and the marks keep their length**, so `dashed`'s
  `[1.8, 1.2]` becomes `[1.8, 2.4]`. Scaling the whole pattern would lengthen the
  dashes too and read as a different style rather than the same one thinned out.
  The one special case is `solid`, which has no gaps to widen: its hidden run uses
  the `dotted` preset, which is exactly today's behaviour. **A default sheet must
  come out byte-identical to today**, and there is a test for that.
- **`hidden`** — hidden runs are not drawn.
- **`visible`** — hidden runs draw in the section's ordinary style.

### 4. SVG layers

Sections merge by resolved pen — colour and width — across all files. Line style
does not enter the key, because dashes are geometry rather than a stroke
attribute, so a dashed and a solid route of the same colour and width can share
one pen and one layer.

- id: `route-<colour without #>-<width × 100>`, e.g. `route-c1272d-050`
- label: the distinct file names contributing, e.g. `estrela, pico`

This minimises pen changes, which is the point of layering on a plotter. The
accepted cost is that the SVG layer list no longer maps one-to-one onto files;
the panel still groups by file.

### 5. Panel

```
GPX routes
  [Add files]
  ▸ estrela.gpx    ● [0.5] [solid  ▾]   remove
  ▾ pico.gpx       ● [0.5] [dashed ▾]   remove
      Ascent (1)   ● [0.5] [dashed ▾]   ·
      Ascent (2)   ● [0.8] [dotted ▾]   reset
```

- The chevron expands a file to its sections; always available, since a
  single-section file may still want an override.
- Section controls display the inherited value until overridden.
- An overridden control is marked and offers **reset**; a section using
  inherited values everywhere shows no reset.
- Expansion state is component-local data keyed by file id. It is not app state
  and must not trigger a re-render.

### 6. Worker request

The worker keeps taking a flat array, so `scene.js` needs no structural change:

```js
tracks: [{ name, fileName, points, lineStyle }]
pens:  { tracks: [{ color, width }] }   // resolved, by index
```

`main.js` flattens `trackFiles` into that shape, resolving each section's style as
it goes. Grouping into layers happens in `layers.js`, from the resolved pens.

## Testing

| Area | What is asserted |
|---|---|
| Ingest | one file → one entry with N sections; several files → separate entries; colour advances per file, not per section |
| Style resolution | section inherits; override sticks when the file changes; reset restores; a file change reaches non-overridden sections |
| `dashAlong` | pattern cycles across segment joins; phase carries between segments; sparse doubles gaps and leaves marks alone; solid returns the run whole |
| Behind a ridge | a solid section under `dotted` mode is byte-identical to today's output |
| Layers | sections sharing a pen merge into one layer; an overridden section splits into its own; label lists contributing files |
| Optimizer | dashes survive `optimizeLayers` at default tolerances |
| Millimetre boundary | dash size on paper is unchanged when detail goes 300 → 1600 |
| SVG contract | no `stroke-dasharray` (existing test already covers this) |

## Risks

**The optimizer can undo dashes.** `merge` rejoins polyline endpoints within
`mergeTolerance`, default 0.15 mm. The smallest gap in the presets is 0.8 mm, so
there is roughly 5× clearance at the defaults — but a user who raises merge
tolerance past the gap turns every dashed route back into a solid line, silently.
A test pins the default case. If that is not enough, the fallback is to clamp
merge tolerance below the smallest gap present on the sheet, which makes it
impossible rather than merely tested. Not doing that now.

**A default sheet must not change.** The hidden-run rule is built so that
`solid` + `dotted` reproduces today's geometry exactly. This is the assertion most
likely to catch a mistake in the dash refactor.

## Not in scope

- Per-section `trackMode`. It reads as a sheet-wide decision and was not asked
  for.
- Reordering files or sections.
- Persisting loaded routes across reloads.
- Per-section pitch and mark length. Four presets were chosen over exposing the
  numbers.
