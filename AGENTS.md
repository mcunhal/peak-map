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
| `src/core/` | Pure pipeline. Height fields, page, occlusion, layers, optimizer, SVG writer, compass. `composite.js` chooses and combines the algorithms, flat or draped. `clip.js` cuts polylines against the page edge and against keep-out shapes. |
| `src/core/algorithms/` | The eight terrain-to-line algorithms, behind one registry interface. |
| `src/dem/` | Tile math, elevation source registry, height-field construction. Plus the Portugal LiDAR path: `ptLidarGrid` (grid formula + TM06), `ptLidarCatalog` (public STAC search), `ptLidarRaster` / `rasterMosaic` (GeoTIFF to height field), `lidarCache` (bucket + dropped files), `resolution` (pen-vs-data). |
| `src/gpx/` | GPX parsing. |
| `src/worker/` | The render worker: tiles in, SVG out. It owns no drawing logic. |
| `src/main.js` | Map wiring, request building, preview. |
| `src/App.vue` | The whole UI. Vue 2 SFC, one file. |
| `src/components/` | `LidarPanel.vue` and the smaller UI pieces. |
| `scripts/` | Guarded probes and benches, a Node PNG decoder, and the LiDAR fetcher (`fetchLidar.mjs` + `dgtAuth.mjs` + `lidarRegions.mjs`). |

## Invariants

Break any of these and something will look right while being wrong.

**Sizes are millimetres at the boundary, samples inside.** The app sends every
size in millimetres; `core/composite.js` converts to field samples against
`mapper.scale`, via `MILLIMETRE_OPTIONS`. Algorithms only ever see samples. If you
add a size setting, add it to that table, or raising the detail will silently
change how the map looks. This is exactly the bug that made relief fall from 74mm
to 14mm as detail went 300 to 1600.

**The sheet is drawn past its bottom edge, and cut off there.** The relief lifts
a line up the page, so a peak on the near edge is raised clear of it and leaves
blank paper beneath — 21mm of an A3 at Serra da Estrela, measured. `main.js`
unprojects a screen rectangle that reaches below the sheet, and the extra rows
are drawn and then clipped at `drawable` bottom in the worker.

This is safe only because screen-to-ground is a homography and `createRegion`
fits one through four corners: lengthening the rectangle re-parametrises the same
map, so the sheet's own rows land on exactly the ground they did before.
`tileMath.test.js` asserts it row by row. Two things must then follow the sheet
rather than the field, and both are silent when wrong:

- `createPageMapper` fits `field.sheetHeight`, not `field.height`, or the map
  shrinks to make room for the over-plot instead of extending past it.
- `regionRowScales` normalises at mid-*sheet*, and `composite.js` scales
  `rowCount` by the same ratio. Otherwise extending the field rescales the whole
  relief and thins the lines out, which is the millimetre bug below arriving from
  the other direction.

Everything asks `sheetRows(field)`, which falls back to `field.height`, so a
field with no over-plot behaves exactly as it always did. The fraction is zero
unless something actually lifts: a plan-view contour map would only sample ground
it then throws away. **Note the over-plot band may fall outside the fetched LiDAR
tiles**, since `LidarPanel` picks them from `appState.bounds` rather than the
sheet; `rasterMosaic` tolerates the gap, so the bottom band simply will not fill.

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
does not hide terrain. Adding tracks must leave the terrain byte-identical. The
same holds for drapes.

**A drape is cut by the ground, not by the strokes.** `scene.js` keeps two
horizons: the terrain buffer, marked only by the rows actually drawn, which is
what makes ridge lines hide each other; and a second one marked from *every*
field row, which is what drapes are tested against. Sharing one buffer looks
right and is not — see the trap below.

**The compass sits on cleared paper.** A rose drawn over ridge lines is
unreadable, and a plotter cannot fill a disc behind it, so `compassCutout` builds
a keep-out shape and every other layer is cut against it before the optimizer
runs. Cutting afterwards would invalidate a plot path already sorted.

The shape is the convex hull of the rose's own geometry, not a circle: the ring
has radius 1 but the N stands clear above it and reaches 1.49, so a disc that
covered the letter would blank a needless amount of paper on the other three
sides. It goes through the *same* transform the rose does — `placeRose` is shared
— so on a tilted sheet the cut-out is the same projected ellipse the rose is.

**Multipass runs last.** Retracing a stroke looks exactly like a duplicate to
`deduplicate`, which will remove it. Order in `optimizePolylines` is
dedup → merge → sort → reloop → simplify → multipass.

**The SVG contract.** Millimetre root with a numerically identical viewBox; every
path carries its own `stroke` and `stroke-width` rather than inheriting from its
layer group (simple viewers do not implement inheritance and render blank); never
a fill; never `stroke-dasharray`. Tests assert all of it.

## Running things

```bash
npm test          # 558 tests, offline, ~3s
npm run dev
npm run deploy    # builds and pushes to Cloudflare
```

Portugal LiDAR, which needs a free DGT account in `.env` (see `.env.example`):

```bash
npm run lidar:list                                   # tile counts and storage budget
node scripts/fetchLidar.mjs --region "Sintra" --dry-run
node scripts/fetchLidar.mjs --region "Sintra" --out /path/to/cache
node scripts/fetchLidar.mjs --bbox -9.5,38.75,-9.32,38.85 --resolution 2m
```

Nothing in `src/` ever reads those credentials, and nothing may: the site is
public, so a credential in the bundle is a credential given to every visitor.

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

**One occlusion buffer for both the strokes and the drapes.** A contour draped
on the relief lies on the ground *between* the ridge-line strokes, so testing it
against the buffer those strokes mark lets every nearer one that crests above it
take a bite: the contour comes out as dashes. It looks like a rendering artifact
with no cause, and the giveaway is that it follows the line-count slider rather
than the terrain — 105 pieces at 10 rows, 837 at 120, and back to 80 once every
row was drawn. Drapes get a horizon marked from every field row, which also means
changing the line count no longer changes which contours are visible. Note that a
smooth hill cannot show this: its contours run parallel to the rows and never
graze one. It takes terrain the contours wander across.

**A plain-http tile cache on an https page.** The browser refuses the request
without sending it, and `loadFromCache` files a rejected fetch as a *miss* —
deliberately, because a miss is ordinary. So a cache that is up and serving
reports every tile absent, and nothing says the page never asked.
`describeCacheBase` decides this before any fetch and the panel shows the reason.
Localhost is exempt, which is what makes a local tile server work under
`npm run dev` but not against the deployed site.

**The seabed setting the baseline for the land.** Terrarium carries real
bathymetry, so a coastal sheet's lowest sample is the ocean floor: off Iberia
-5246m against a 3436m summit. `oceanLevel` stops those lines being *drawn*, but
`computeRange` still counted them, so water positioned and scaled a drawing it
was not part of. Two symptoms at once, and only the first is obvious. Every line
on the sheet was lifted by one constant — 34.5mm of an A3, measured at Lisbon,
Porto, Cadiz and Gijon alike — so the whole drawing sat north of the map beneath
it in every perspective, which is what makes it read as a projection bug rather
than an elevation one. And the relief silently shrank: only 3436 of 8682 metres
of range was land, so a 57mm setting gave the land 22mm. `computeRange` now takes
a `floor`, and both places that derive displacement (`scene.js`,
`algorithms/ridgeline.js`) pass `oceanLevel` — measure the range over the ground
that will actually be drawn.

**An opaque CSS background under the preview canvas.** Upstream painted a
checkerboard behind `.height-map` to show the overlay area. It sits between the
sheet and the map, so paper transparency revealed checkers rather than terrain.
Removed — but the lesson is to check the stylesheet before believing a screenshot.

## Test-writing traps

Five test expectations in this repo were wrong while the code was right. Three
had the same shape: a fixture that could not show the effect being asserted.

- **Radially symmetric terrain hides directional effects.** A gaussian hill's
  contours are circles, so rotating the light provably changes nothing. Use
  asymmetric terrain for anything involving direction.
- **Near and far are easy to invert.** The top of a sheet is the *far* ground, so
  rows there cover *more* ground, and a camera compresses them. Got this backwards
  twice, once in a region test and once in a compass test. A third time while
  testing the ocean baseline: a fixture whose land rose *towards* the viewer let
  the nearest row occlude every row behind it, so the drawing was one line and
  the assertion measured nothing. Put the coast down the sheet rather than
  across it, and every row carries both the shore and the summit.
- **A point on a polygon's boundary is not inside or outside it.** Ray casting is
  undefined there and will answer either way. Two assertions were written against
  it and both were wrong while the code was right: a convex hull's own vertices
  lie on its boundary, and a clip lands its cut vertices exactly on it. Assert
  what actually matters instead — for a convex ring, that the point is on the
  inner side of every edge; for clipped geometry, that points sampled *along* each
  stroke are outside, since ink is segments and a vertex touching the edge is
  fine.
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
- **OpenTopography and Copernicus GLO-30. Measured, and not worth building.**
  COP30 is more accurate than SRTM, by roughly one to five metres. On an A3 sheet
  of Serra da Estrela the relief maps 1742m of elevation onto 26mm of paper, which
  is 15 microns per metre of height, so that whole accuracy gain is 0.015 to
  0.075mm: under a third of a 0.25mm pen. Measured high-frequency detail in the
  current data averages 2.1m, which is 0.031mm on paper. None of it is drawable.

  It would not help where data *is* the limit either. Below about 3km across, a
  30m sample covers more than a third of a millimetre of paper and stair-steps,
  but COP30 is also 30m.

  Terrarium is not plain SRTM, and is already better than COP30 in places: 3DEP at
  10m over the United States, ArcticDEM at 5m above 60 degrees north, EUDEM plus
  national data across Europe, UK at 2m.

  What would actually improve close-up maps is national LiDAR: Spain publishes
  MDT02 at 2m (PNOA, free for non-commercial use via CNIG) and Portugal publishes
  0.5m and 2m DTM under CC BY 4.0 via DGT. That is 15 to 60 times finer, and it is
  the only thing that changes what a pen can draw at small scales.

- **Portuguese LiDAR is built and in use.** It is the one thing that changes what
  a pen can draw at small scales, and it took a while to find the right route, so
  the dead ends are recorded below to stop anyone walking back down them.

  **The route that works.** DGT publishes rasters through a STAC catalogue at
  `https://cdd.dgterritorio.gov.pt/dgt-be/v1`, which is public and needs no
  account to read:

      MDT-50cm, MDT-2m    terrain, bare earth
      MDS-50cm, MDS-2m    surface, including trees and buildings
      LAZ                 the point cloud
      ORTOS-1995..2025    orthophotos
      ACORES-*            the Azores

  `POST /search` with a bbox and a collection returns STAC items whose ids embed
  the tile name (`MDT-50cm-197501-07-2025`). Each carries one asset: a Float32
  GeoTIFF in EPSG:3763, one square kilometre, nodata -999. 50cm tiles are
  2000x2000 and 21.35MB; 2m tiles are 500x500 and about 1.33MB.

  **The tile index is a formula**, in `ptLidarGrid.js`. Tile names look opaque and
  are not: they encode the tile's position on a one-kilometre grid in EPSG:3763.

      col = floor(x / 1000)
      row = floor(y / 1000)
      name = (col + 200) * 1000 + (row + 301)

  Checked against all 91196 tiles in DGT's published index
  (`LiDAR2024_2025_Secciona.gpkg`, plain SQLite) with no mismatches, every tile
  exactly 1000m square. That module also carries the ETRS89 / Portugal TM06
  projection both ways with no dependency: Torre at 40.3217N 7.6136W projects to
  (44154, 72684), naming tile LO-244373, which the service confirms belongs to
  Covilha, Manteigas and Seia — the three municipalities meeting at the summit.
  A real file closed the loop: `MDT-50cm-238372-04-2024_v01.tif` is 2000x2000 at
  exactly 0.500m, extent x 38000..39000 y 71000..72000, precisely what
  `tileBounds` predicts from the name.

  **The minting endpoint is `/dgt-be/v1/download/<sha256>`, and the public search
  hands it to you.** Each asset `href` is that URL, not a bucket path, and no
  account is needed to read it — which is why adding to the cart works logged
  out. Logged out, a GET answers `302 -> /auth/login`; logged in, the same GET
  answers `302 -> <presigned URL>`. *The redirect is the mint.* A HAR of a real
  download appears to contain no minting call because DevTools does not log the
  `<a download>` navigation, only the presigned request it redirects to. That
  absence is misleading and cost an afternoon.

  Presigned URLs last an hour (`X-Amz-Expires: 3600`), sign only `host`, and
  carry no `X-Amz-Security-Token` — so a static MinIO key signs them
  server-side, not temporary credentials held by the browser. Nothing signs
  anything client-side: all nine scripts in that HAR were checked and none
  contains `aws4_request`, `hmac`, or a key.

  **Why a page cannot do this, and a script can.** CORS is a rule browsers impose
  on themselves; the server blocks nothing. `/dgt-be/v1` sends no
  `Access-Control-Allow-Origin` for any origin, so a page cannot call it — its
  preflight answers 204 with allow-credentials and allow-methods but no
  allow-origin, which a browser rejects. `curl`, the QGIS plugin and
  `scripts/fetchLidar.mjs` send no `Origin` and never ask. The object store
  itself does reflect any origin, so a presigned URL *is* fetchable from a page;
  only obtaining one is closed.

  **Per-visitor login does not work, and it was worth checking.** Each person
  using their own account would leak nothing and is how any OAuth app behaves.
  Keycloak refuses it: the client is `aai-oidc-dgt` and its only registered
  redirect is `https://cdd.dgterritorio.gov.pt/auth/callback`. An authorization
  request naming any other origin answers 400. A direct grant answers
  `unauthorized_client`, which is about the client rather than the credentials.
  Only DGT can change this. The QGIS plugin sidesteps it by using DGT's own
  callback and following the redirect itself — legal for a script, impossible for
  a page, which would need to land somewhere it controls.

  **Licence trap: STAC says `proprietary`, and it is wrong.** All five LiDAR
  collections report `license: "proprietary"` and `summaries.access: ["private"]`.
  That is STAC 1.0's placeholder for "not an SPDX id", left unfilled, and
  `access` describes the download gate rather than the terms. Every collection's
  `metadataLink` points at one INSPIRE record
  (`077a8c94-8b46-4a8a-8796-0d7fc4662f0c`), which states *Acesso publico sem
  restricoes* and CC-BY-4.0. **The INSPIRE record governs.** Redistribution is
  permitted with attribution, which is what makes mirroring tiles legal at all.
  Keep `ATTRIBUTION` from `ptLidarCatalog.js` with anything served from a cache.
  Do not trust the STAC field; this repo talked itself out of the correct licence
  once already on the strength of it.

  **The point cloud is the wrong route**, though it works. `portugal3d.dgterritorio.gov.pt`
  is CORS-open, accepts `Range`, and exposes `/info/{id}`, `/laz/meta/{file}`,
  `/laz/{file}`, `/search/position/{lat},{lon}` and `/search/place/{name}`.
  `/continente/LO-235379` gives `LO-235379-04-2024_v01.laz`, 323MB for one tile.
  Against that, the raster for the same ground is twenty times smaller and
  already gridded, so laz-perf, octree traversal and ground classification all
  fall away. The other DGT channels are dead ends outright: WCS is switched off,
  the WMS serves a coloured picture, and the INSPIRE ATOM download is 50m
  hypsometry, coarser than Terrarium.

### Portugal LiDAR: what is built

- `ptLidarCatalog.js` names the tiles a sheet needs from the public search and
  chooses the collection: 50cm only below about 600m across, 2m up to 2.3km,
  nothing finer above that, because past three samples per millimetre the pen is
  the limit. A 2m tile is sixteen times smaller, so this choice is most of the
  storage budget.
- `rasterMosaic.js` samples a set of projected rasters as one surface, tolerating
  gaps, since a sheet routinely spans tiles that were never flown.
  `ptLidarRaster.js` reads a GeoTIFF and samples it onto a sheet through the same
  region the tiled path uses, so rotation and tilt carry over untouched, and
  reports what fraction of the sheet the tiles actually cover.
- `lidarCache.js` fetches tiles from a configured base URL and matches dropped
  files to the sheet, tolerating the `_v01` suffix filenames carry and ids do
  not. **Cache keys are the full item id, never the grid number**: tiles get
  reflown, and `236380` alone would silently serve superseded data.
- **The cache needs no S3 API.** The client does `GET <base>/<item-id>.tif`,
  anonymous, with CORS. No listing, no auth, no signing, no multipart. MinIO,
  Garage and SeaweedFS are all machinery for an interface this never calls; a
  static file server is the whole requirement. The base is a runtime setting
  (`appState.lidarCacheUrl`, remembered in `localStorage`), with
  `VITE_LIDAR_CACHE_URL` only supplying its default, so one deployed page can be
  pointed at a bucket or at a machine on the LAN without a rebuild.
- `LidarPanel.vue` lists the tiles a sheet needs, links each to DGT for the user
  to fetch signed in, and takes dropped files.
- `scripts/fetchLidar.mjs` fills a local cache, with `scripts/dgtAuth.mjs` doing
  the Keycloak flow. `npm run lidar:list` prints the budget. Credentials come
  from `.env`, gitignored, and never from anything bundled.
- The worker takes `lidarTiles` and decodes with a dynamic `import('geotiff')`.
  That is why `vite.config.js` sets `worker.format = 'es'`: the default IIFE
  cannot code-split, and the 221KB of decoder should not load for everyone.

  Politeness, measured from the QGIS plugin rather than guessed: 0.2s between
  downloads, session revalidation every 10 files, 5s between *retries*. An
  earlier note in this file said 5s between downloads; that was wrong.

### Portugal LiDAR: next

- **Draw trees and buildings alongside the terrain.** `nDSM = MDS - MDT` gives
  height above ground; the two products share a grid, a tiling and a projection,
  so it is a per-pixel subtraction with no resampling. Threshold around 2m, run
  the existing marching squares on the mask, and emit building footprints and
  canopy outlines into their own SVG layer with their own pen, exactly as the GPX
  layer works. Buildings and vegetation separate on local planarity: roofs are
  flat, canopy is rough. Costs double the tiles for that ground.
- **Mirroring to R2 is designed but deliberately not switched on.** Egress is
  free and storage is $0.015/GB-month past 10GB (10GB-month free), so all 61GB
  of the local mirror would be $0.77 a month. Reads are Class B with 10 million
  free per month, and a sheet pulls tens of tiles, so they never bill. Fill it
  lazily from real use rather than bulk-scraping the country: the licence permits
  the latter, courtesy does not.

- **Serving the tiles from home through a Cloudflare Tunnel is against the CDN
  terms.** The content restriction moved out of the Self-Serve Subscription
  Agreement into the Application Services service-specific terms, and it lets
  Cloudflare limit the CDN where it is used "to serve video or a disproportionate
  percentage of pictures, audio files, or other large files" — on Free, Pro and
  Business alike. The stated exception is content served through the Developer
  Platform, Images or Stream, which is what makes **R2 the sanctioned route** for
  exactly this. There is no way around it with a tunnel: `cloudflared` always
  egresses through Cloudflare's edge, so a tunnelled hostname is proxied by
  definition — there is no grey-cloud tunnel. Serving from a LAN-only hostname
  that Cloudflare never fronts is fine, because the CDN is not in the path.

- 2-opt path refinement. The sort interface is open for it.
