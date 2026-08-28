# Peak Map → plot-ready topographic line maps

**Date:** 2026-08-28
**Status:** Approved, staged implementation
**Upstream:** [anvaka/peak-map](https://github.com/anvaka/peak-map) (MIT)

## Goal

Fork peak-map and turn it into a tool that produces **plot-ready, layered, mm-accurate
SVG** of topographic line art, with GPX routes as separate pen layers, several
terrain-to-line algorithms, multiple elevation sources, and plot-path optimization.

The end goal is plotting the maps on a pen plotter. No specific machine is targeted;
output is generic layered SVG in millimetres that any plotter toolchain can consume.
No G-code or machine-specific backend is in scope.

## What upstream is

| | |
|---|---|
| Stack | Vue 2.5, webpack 3, Babel 6, `mapbox-gl` 1.6 |
| DEM | Mapbox terrain-RGB, via a personal token hardcoded in `src/config.js` |
| Algorithm | Horizontal scanlines with a `columnHeights` occlusion buffer (hidden-line ridgeline) |
| SVG export | Exists: `src/lib/createSVGContext.js`, a canvas-2D shim emitting one `<g id='paths'>` |
| Build | Verified to install (1374 packages) and build cleanly on Node 24 |

Two properties of upstream drive the whole design:

1. **Everything is computed in screen pixels.** Heights are sampled into a
   `Float32Array` of `window.innerWidth × window.innerHeight`, and the exported SVG's
   viewBox is the browser window size. There are no real-world units.
2. **There is exactly one layer and one algorithm**, both hardwired into the renderer.

Neither survives the requirements. The fork's spine is therefore a headless core.

## Architecture

```
DemSource ──tiles/bbox──▶ HeightField          (grid, bbox, min/max, nodata mask)
                              │
            ┌─────────────────┼──────────────────┐
            ▼                 ▼                  ▼
      Algorithm         OcclusionBuffer      GpxTrack[]
    (5 families)                │                │
            └────────▶ LayerSet ◀───────────────┘
                          │   {name, penColor, penWidth, polylines[]}
                          ▼
                     Optimizer          (per layer, tolerances in mm)
                          ▼
                     PageMapper         (field coords → mm inside margins)
                          ▼
                     SvgWriter          (layered SVG, mm root + identical viewBox)
```

### Core principles

- **Algorithms consume a `HeightField` and emit polylines in field coordinates.**
  No DOM, no MapLibre, no canvas anywhere in `src/core/`. This is what makes five
  algorithm families, the optimizer and the GPX projector independently testable.
- **Render resolution is an explicit setting**, decoupled from window size.
- **The core runs in a Web Worker.** Evenly-spaced streamlines over a large grid will
  not fit in a rAF budget; upstream's rAF time-slicing is replaced.
- The Vue app shrinks to: choose bounds on the map → build a `RenderJob` → run the
  core in a worker → rasterize the returned `LayerSet` to canvas for preview →
  write SVG.

### Page model

Paper (A4/A3/A2/custom), orientation, and margins, all in millimetres. The SVG root is
declared in mm with a numerically identical viewBox, so one user unit equals 1mm and
optimizer tolerances are naturally physical. This matches the convention already used
in the sibling `vectorizer` project.

## GPX layers

Parsing reuses **`moto-studio/gpx`**, the existing TypeScript GPX parser, rather than
adding a dependency.

Each track projects into field coordinates and is displaced by the same elevation
mapping the terrain uses, so a route climbs the peaks it actually crosses.
Displacement is always applied. Occlusion treatment is a three-way choice:

- **hidden** — occluded portions are dropped
- **always visible** — drawn over everything
- **dotted** — occluded portions become dots

Dots are emitted as **real short subpaths at a configurable mm pitch**, never
`stroke-dasharray`, because dash attributes are unreliable across plotter toolchains.

### Depth ordering (important)

Occlusion is depth-ordered, so **the GPX pass cannot run after the terrain pass**. A
track in the foreground must be tested against the occlusion buffer as it stood at
that scanline, not against the finished buffer, or near ridges get wrongly hidden by
far ones. The ridgeline renderer emits rows bottom-to-top and track segments are
interleaved at their own depth. This is why `OcclusionBuffer` is a shared first-class
object rather than a local inside the renderer.

### Planar algorithms

Occlusion is only meaningful for the ridgeline algorithm. Contours, hachures,
streamlines and hatching are top-down planar — there is no "behind". For those the
equivalent is the inverse: a **knockout corridor**, where terrain lines break for a
configurable mm width around the track so the route reads on top.

**GPX interaction mode is therefore chosen per algorithm family, not globally.**

Each track becomes its own SVG layer with its own pen colour and width, written as
Inkscape-compatible groups that also carry plain `id` and `stroke` for toolchains
that ignore the Inkscape namespace.

## Algorithms

| Algorithm | Basis | Shared machinery |
|---|---|---|
| **Ridgeline** (ported from upstream) | scanlines + hidden-line removal; extended with scanline direction (horizontal / vertical / radial) | `OcclusionBuffer` |
| **Contours** | marching squares at fixed intervals, `d3-contour` | — |
| **Tanaka illuminated contours** | contour weight and multipass modulated by sun azimuth | contours + hillshade |
| **Streamline hatching** | Jobard & Lefer, *Creating Evenly-Spaced Streamlines of Arbitrary Density* | gradient field |
| **Hachures** | Samsonov, *Morphometric Mapping of Topography by Flowline Hachures*; stroke length and density by steepness | gradient field |
| **Hillshade hatching** | parallel lines, spacing driven by computed hillshade | hillshade |

Three derived products — **gradient field**, **hillshade**, **contour set** — are
computed once per `HeightField` and cached. This sharing is what keeps the last four
from being four separate builds, and it drives the staging.

Prior art to study: [volzo, *Hatching, Hachures, and Contour Lines*](https://volzo.de/posts/hatching-hachures-contours/)
and [volzotan/flowlines](https://github.com/volzotan/flowlines).

## Elevation sources

A registry with two kinds, because the difference is structural rather than cosmetic.

**`rgb-tiles`** — a URL template plus a decode function; drops into the existing tile
fetcher.

| Source | Key | Decode |
|---|---|---|
| `terrarium` (AWS Open Data) — **default** | none | `(R*256 + G + B/256) - 32768` |
| `mapbox-terrain-rgb` | user token | `-10000 + (R*65536 + G*256 + B) * 0.1` |

**`bbox-api`** — a separate fetch-and-reproject path.

| Source | Key | Path |
|---|---|---|
| `opentopography` (COP30 / SRTMGL1 / NASADEM) | free key | GeoTIFF for a bbox → `geotiff.js` → reproject onto the render grid |

Terrarium is SRTM-derived: roughly 30m, with voids in steep terrain and above 60°N.
COP30 is meaningfully better data, which is why it is worth the heavier path and also
why it is staged last.

The upstream Mapbox token belongs to anvaka and **must not be shipped**. Removing it is
part of Stage 0.

## Optimizer

Per layer, following vpype's documented order with deduplication inserted first:

**deduplicate → merge → sort → reloop → simplify**

- `deduplicate` — drop segments overlapping already-kept geometry within tolerance.
  The large win for contours and hatching, where coincident geometry is everywhere.
- `merge` — join endpoints within tolerance, allowing reversal.
- `sort` — greedy nearest-neighbour with path reversal. The interface stays open for
  2-opt/Or-opt later without restructuring.
- `reloop` — rotate closed-loop seams so they scatter.
- `simplify` — Ramer–Douglas–Peucker at a tolerance below plotter resolution.

Metrics reported before and after: pen-down length, pen-up travel, pen-lift count, and
estimated time from a configurable draw speed and lift penalty.

An equivalent **vpype command line** is emitted alongside the SVG, giving a route into
that ecosystem without the app pretending to be it.

## Testing

- **Core** — Vitest over synthetic height fields (plane, cone, gaussian, saddle) with
  golden polyline assertions. Deterministic because the core is pure.
- **Optimizer** — property tests rather than goldens: pen-down length preserved within
  tolerance across sort and merge; dedup never increases total length; simplify stays
  inside its Hausdorff band.
- **SVG writer** — asserts the mm/viewBox numeric identity, the layer structure, and
  that dotted tracks contain no `stroke-dasharray`.
- **Visual** — golden SVGs compared structurally (path count, total length), not by
  pixel diff.

## Error handling

- **Missing tiles** — upstream fills blanks with a zero-height colour. Replaced by an
  explicit nodata mask on `HeightField`; algorithms skip nodata rather than drawing a
  false sea-level plateau.
- **Nodata voids** (Terrarium in steep terrain) — masked, with optional fill by
  neighbourhood interpolation; surfaced in the UI as a coverage warning.
- **Tile fetch failure** — retry with backoff, then a hard error naming the source,
  rather than silently degrading.
- **Oversized requests** — upstream throws past 50 tiles. Replaced by a budget derived
  from page size and detail, reported to the user before fetching.
- **Missing/invalid API key** (Mapbox, OpenTopography) — source disabled in the picker
  with the reason shown, never a failed render.
- **Malformed GPX** — per-file error, other tracks still render.

## Staging

Too large for one plan. Six sub-projects, each with its own spec → plan → implement
cycle.

| Stage | Work | Rationale |
|---|---|---|
| **0** | Fork, Vite migration, MapLibre swap, Terrarium DEM, remove upstream token, parity check vs upstream | Boring and risky; must land before anything builds on it |
| **1** | Headless core, page/units, ridgeline ported, Web Worker, mm SVG with layers | Unblocks everything else |
| **2** | GPX layers — multi-file, per-track pens, three occlusion modes | Headline feature, ahead of the algorithm tail |
| **3** | Optimizer, metrics, vpype recipe export | Early, so later algorithms are measurable |
| **4** | Contours + Tanaka | Cheapest new algorithm; dependency of Tanaka |
| **5** | Gradient field: streamlines, hachures, hillshade hatching | Heavy visual work on shared machinery |
| **6** | OpenTopography / COP30 source | Isolated, heaviest infra, nothing depends on it |

GPX precedes the optimizer because it is the priority feature and nothing depends on
the optimizer.

## Risks

1. **Internal MapLibre APIs.** Upstream leans on `map.transform.coveringTiles` and
   `map.transform.pointLocation`, which are private. MapLibre forked from mapbox-gl v1
   so they should carry over; verified in Stage 0. Stage 1 then computes tile coverage
   from the geographic bbox directly and **drops the internal-API dependency entirely**.
2. **OpenTopography CORS.** May not permit browser requests. Mitigation is a Cloudflare
   Worker proxy, a pattern already in use in sibling projects.
3. **Streamline runtime** on large grids. Mitigated by the Web Worker and progressive
   emission.
4. **Terrarium vs Mapbox data differences** mean the Stage 0 parity check compares
   structure and behaviour, not pixel-identical output.
5. **`gh` is not installed**, so the fork must be created by the account owner. The
   local repo carries `upstream` only until a fork origin exists.

## Out of scope

- G-code, HPGL, and machine-specific export backends
- National high-resolution DEM services (IGN, swisstopo, 3DEP)
- 2-opt / Or-opt path refinement (interface left open)
- Preserving upstream's Zazzle mug-printing integration
