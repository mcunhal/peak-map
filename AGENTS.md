# Notes for agents

Read this before changing anything. It records the shape of the code and the
traps that cost real time to find, most of which look like working code.

Human-facing docs are in `README.md`. The original design is in
`docs/superpowers/specs/2026-08-28-peak-map-plotter-design.md`, which is accurate
about intent but predates several decisions recorded here.

## What this is

A fork of `anvaka/peak-map` rebuilt to produce plot-ready SVG. Upstream computed
everything in browser pixels; this computes in millimetres on a sheet of paper.
Deployed as a static-assets-only Cloudflare Worker at `maps.ai-forged.uk`.

## The pipeline

```
DemSource ──tiles──▶ HeightField ──▶ algorithm ──▶ polylines (field samples)
                          │                              │
                     Region (4 corners)             PageMapper
                          │                              │
                     GPX tracks ─────────────────▶ LayerSet (millimetres)
                                                         │
                                              Optimizer ──▶ SvgWriter
```

Everything in `src/core/` is pure: no DOM, no MapLibre, no canvas. That is what
lets the algorithms be tested against synthetic terrain and run in a worker. Keep
it that way — if you need the DOM in `core/`, the design is wrong.

The whole pipeline runs in `src/worker/render.worker.js`, off the main thread,
because dense algorithms take seconds.

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | Pure pipeline. Height fields, page, occlusion, layers, optimizer, SVG writer, compass. |
| `src/core/algorithms/` | The eight terrain-to-line algorithms, behind one registry interface. |
| `src/dem/` | Tile math, elevation source registry, height-field construction. |
| `src/gpx/` | GPX parsing. |
| `src/worker/` | The render worker. The only place millimetres become samples. |
| `src/main.js` | Map wiring, request building, preview. |
| `src/App.vue` | The whole UI. Vue 2 SFC, one file. |
| `scripts/` | Guarded probes and benches, plus a Node PNG decoder. |

## Invariants

Break any of these and something will look right while being wrong.

**Sizes are millimetres at the boundary, samples inside.** The app sends every
size in millimetres; `render.worker.js` converts to field samples against
`mapper.scale`, via `MILLIMETRE_OPTIONS`. Algorithms only ever see samples. If you
add a size setting, add it to that table, or raising the detail will silently
change how the map looks. This is exactly the bug that made relief fall from 74mm
to 14mm as detail went 300 to 1600.

**The sheet is a projective region, not a bounding box.** `createRegion` in
`src/dem/tileMath.js` maps the unit square onto four corners. A box cannot express
a rotated view, and a parallelogram cannot express a tilted one: at 55 degrees of
pitch the far edge of the view covers nearly three times the ground the near edge
does. `main.js` gets the corners by unprojecting the sheet's screen rectangle,
which settles angle and aspect together. Both the terrain and the GPX tracks must
go through the same region or they will disagree.

**Occlusion is depth-ordered.** A track point is hidden only by terrain nearer
than it. `scene.js` decides visibility in depth order and emits geometry in route
order, because a route weaves back and forth in depth and cannot be walked with a
cursor. Testing tracks against the finished occlusion buffer erases foreground
routes entirely. There are tests for both.

**Tracks never mark the occlusion buffer.** A route is paint on the surface; it
does not hide terrain. Adding tracks must leave the terrain byte-identical.

**Multipass runs last.** Retracing a stroke looks exactly like a duplicate to
`deduplicate`, which will remove it. Order in `optimizePolylines` is
dedup → merge → sort → reloop → simplify → multipass.

**The SVG contract.** Millimetre root with a numerically identical viewBox; every
path carries its own `stroke` and `stroke-width` rather than inheriting from its
layer group (simple viewers do not implement inheritance and render blank); never
a fill; never `stroke-dasharray`. Tests assert all of it.

## Running things

```bash
npm test          # 379 tests, offline, ~3s
npm run dev
npm run deploy    # builds and pushes to Cloudflare
```

**Use `./node_modules/.bin/vitest`, not `npx vitest`.** `npx` resolves to a
different cached major version that swallows `console.log`, which will make you
think a probe produced no output.

Several tests are guarded by environment variables so `npm test` stays offline and
fast. They are the fastest way to check real behaviour:

```bash
REAL_DATA=1 SAMPLE_DIR=/tmp ./node_modules/.bin/vitest run scripts/renderRealMap.test.js
GPX_DIR=/path/to/gpx SAMPLE_DIR=/tmp ./node_modules/.bin/vitest run scripts/renderUserRoutes.test.js
BENCH=1 ./node_modules/.bin/vitest run scripts/bench.test.js
```

`scripts/pngDecode.js` decodes PNG on `node:zlib`, so the pipeline can be driven
against real tiles outside a browser. Node has no `createImageBitmap`.

To rasterise an SVG for inspection, headless Chrome works and needs no dependency:

```bash
"/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu --window-size=1400,1000 --default-background-color=FFFFFFFF \
  --screenshot=out.png wrapper.html
```

## Driving the app in a browser

`window.appState` is exposed in dev builds only. In production, find the Vue
instance by walking for an element whose `__vue__` has the property you want —
`.app-container.__vue__` is not reliably the App component.

**The automation tab is always `document.hidden`.** rAF is throttled, so MapLibre
never paints and its style never finishes loading: you will see `isStyleLoaded()`
false and conclude the basemap is broken when it is not. Taking a screenshot pumps
frames and it recovers. Verify placement and geometry numerically; leave "how it
looks" to a human. A long `await` loop over rAF will hang the CDP call.

## Traps already paid for

Each of these was a real bug that looked like working code.

**`bitmap.close()` before reading `bitmap.width`.** Closing an `ImageBitmap` sets
its dimensions to zero, so a tile came back claiming to be empty and every sample
became nodata while reporting that all tiles had loaded. Read dimensions first.
`buildHeightField` now also counts a zero-dimension tile as missing.

**Unbounded nearest-neighbour search.** The spatial index in `optimize.js` widens
until it finds *something*, however far, only for the caller to reject it as out of
tolerance. Merging must pass its tolerance as `maxDistance`. Symptom: sparse
geometry is slower than dense — 493 segments took 5.6s while 11920 took 0.9s.

**Name collisions in the options bag.** All algorithms share one options object.
`levels` meant an array of contour elevations to one and a tonal step count to
another. Hatching's is renamed `toneLevels` at the registry boundary, and
`contourLevels` accepts only an actual array.

**Marching squares on exact sample values.** A level landing precisely on grid
values (a cone at round numbers) produces zero-length segments and junctions shared
by six segments, chaining into fragments. The level is nudged below measurable
precision and degenerate crossings dropped.

**Allocation in the streamline hot loop.** `sampleGradient` returning a fresh
object twice per step, over millions of steps, was most of the running time. Use
`sampleGradientInto` with the module-level scratch objects.

**Fixed slope ranges for hachures.** Normalising steepness across a fixed span of
angles gives uniform static on real terrain, which occupies a narrow band of it.
`slopePercentiles` takes the range from the data. This turned 124740 strokes into
22712 and made the map legible.

**Streamlines give uniform density by design.** That is the Jobard & Lefer
guarantee. They convey direction, not height. Hachures are the density-varying
member of that family; do not "fix" streamlines by making them vary.

**An opaque CSS background under the preview canvas.** Upstream painted a
checkerboard behind `.height-map` to show the overlay area. It sits between the
sheet and the map, so paper transparency revealed checkers rather than terrain.
Removed — but the lesson is to check the stylesheet before believing a screenshot.

## Test-writing traps

Three test expectations in this repo were wrong while the code was right. All three
had the same shape: a fixture that could not show the effect being asserted.

- **Radially symmetric terrain hides directional effects.** A gaussian hill's
  contours are circles, so rotating the light provably changes nothing. Use
  asymmetric terrain for anything involving direction.
- **Near and far are easy to invert.** The top of a sheet is the *far* ground, so
  rows there cover *more* ground, and a camera compresses them. Got this backwards
  twice, once in a region test and once in a compass test.
- **Physical intuitions need checking against the algorithm.** Flooding a cone
  *reduces* line count, because a horizontal cut through a cone is one interval,
  not two. Occlusion is correctly a no-op until displacement outruns row spacing.

When a test fails, work out which of the code and the test is wrong before
changing either. Several of these bugs were found because a *test* was wrong in an
informative way.

## Deployment notes

- Adding a `route` to `wrangler.jsonc` **silently disables the workers.dev URL**
  unless `workers_dev: true` is set. It is set; leave it.
- `index.html` already serves `Cache-Control: max-age=0, must-revalidate`. There is
  no stale-bundle problem; a normal reload is enough. Do not advise hard refreshes.
- The local network resolves `ai-forged.uk` to `192.168.0.1`, so `curl` from this
  machine cannot reach the deployed site. Use `--resolve` with a Cloudflare IP.
- Cloudflare injects a bot-detection script, so the served page is about 900 bytes
  larger than the built one. That is not a bug.

## Things deliberately not done

- G-code, HPGL and machine-specific backends. Output is generic layered SVG.
- OpenTopography and Copernicus GLO-30. Needs a key, GeoTIFF decoding, and probably
  a CORS proxy. This is the one substantial feature from the design still missing.
- 2-opt path refinement. The sort interface is open for it.
- National high-resolution DEM services.
