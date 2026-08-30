# Peak Map — plotter edition

Turn any region of the world into topographic line art, sized for a sheet of
paper and ready for a pen plotter.

**Live: [maps.ai-forged.uk](https://maps.ai-forged.uk)**
· mirror: [peak-map.cunhalmiguel.workers.dev](https://peak-map.cunhalmiguel.workers.dev)

A fork of [anvaka/peak-map](https://github.com/anvaka/peak-map), whose hidden-line
ridgeline renderer is still at the heart of it. Everything else has been rebuilt
around plotting: real millimetres, eight algorithms, GPX routes on their own pens,
and a plot-path optimizer.

No API key is needed. Elevation comes from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), which are open
data, and the whole pipeline runs in your browser.

---

## What it does

Frame a region on the map, choose an algorithm, pick a paper size, and export
**layered SVG in millimetres** — one layer per pen, ready for Inkscape, AxiDraw,
vpype, or anything else that reads SVG.

- **Eight ways to draw terrain**, from Joy Division ridge lines to contours,
  streamlines and nineteenth-century hachures.
- **Combine them on one sheet**, each in its own pen and its own SVG layer, and
  optionally draped over the relief with hidden-line removal.
- **GPX routes** as separate pen layers, riding the terrain surface and going
  dotted where they pass behind a ridge.
- **A plot-path optimizer** that typically cuts pen-up travel by over 90%, with
  before-and-after numbers and an estimated plot time.
- **Rotate and tilt** the map; the drawing follows, including a true perspective
  view when tilted.
- **A compass rose** drawn as strokes, which foreshortens with the sheet.
- **Portuguese LiDAR** at 50 cm and 2 m for close-ups, sixteen to sixty times
  finer than the global elevation data.

---

## Using it

Open the site, pan and zoom to the region you want, and press **Draw this
region**. The white rectangle is your sheet: what it covers is exactly what gets
drawn. **Customize…** opens everything else.

On a phone, two fingers turn the map and two fingers dragged up or down tilt it.

### Terrain

| | |
|---|---|
| **Algorithm** | How terrain becomes lines. See the table below. |
| **Elevation data** | AWS Terrarium by default. Mapbox Terrain-RGB if you supply a token. |
| **Detail** | How finely the terrain is sampled, 200–1600. Higher resolves finer ridges and costs more time. Every size below is in millimetres, so this changes how much resolves, not how the map looks. |

### The algorithms

| Algorithm | What it draws |
|---|---|
| **Ridge lines** | Horizontal scanlines lifted by elevation, with hidden-line removal. The Joy Division look. |
| **Contour lines** | Isolines at fixed elevation intervals. The classic topographic map. |
| **Contours, one pen per level** | The same, split by elevation, so index contours can be heavier. |
| **Illuminated contours (Tanaka)** | Contours weighted by the light, so flat isolines read as relief. |
| **Streamlines** | Evenly spaced strokes running downhill. Reads as drainage and spurs. |
| **Streamlines along the hillside** | The same spacing, following the contour direction instead. |
| **Hachures** | Short downslope strokes, longer and denser where steeper, blank where level. |
| **Hillshade hatching** | Parallel rules whose density follows a computed hillshade. Renders tone. |

Ridge lines are the fastest and the most forgiving. Contours are the most
plotter-native: closed loops, no overdraw. Hachures and hillshade hatching are the
two that render *tone*; streamlines deliberately keep an even density, so they show
direction rather than height.

### Paper

Size, orientation and margins, all in millimetres. **Paper opacity** is
preview-only — turn it down to see your lines against the live map, which is the
quickest way to check they landed where you meant. The exported file is governed
by the separate **Sheet background** setting.

### GPX routes

Add one or more `.gpx` files. Each gets its own pen colour, width and SVG layer.

Where a route passes behind a ridge you can **hide** it, leave it **always
visible**, or draw it **as dots** — the cartographic convention for an occluded
line. Dots are real geometry at a pitch you set, never `stroke-dasharray`, which
plotter toolchains handle inconsistently.

### Plot optimization

Five passes, in the order vpype recommends:

| Pass | What it does |
|---|---|
| **dedup** | Removes strokes drawn twice. The big win for contours and hatching. |
| **merge** | Joins strokes whose ends meet, removing a pen lift. |
| **sort** | Reorders the draw so the pen travels less between strokes. |
| **reloop** | Moves the seams of closed loops so they do not line up. |
| **simplify** | Drops points finer than the plotter can resolve. |

Tolerances are in millimetres. The panel shows pen-down length, pen-up travel,
pen lifts and estimated time, and how much the optimizer saved. On a typical
sheet that is **over 90% less pen-up travel and around 70% fewer points, with the
drawing itself unchanged**.

An equivalent `vpype` command line is printed alongside, if you want to go
further than this app does.

### Heavier lines

Algorithms that vary line weight (Tanaka, contours by level) can express it two
ways, and they are not equivalent:

- **Drawing them again** — one pen, heavier lines get extra passes. Costs plotting
  time. This is the default, because a sheet that plots unattended with one pen is
  the case that has to work.
- **A wider pen** — each layer gets its own width, which means physically swapping
  pens between layers. Free, if you are willing to stand over it.

On one A3 sheet of Tanaka contours: passes gave 77.5 m drawn in 64 minutes,
pen widths gave 31.8 m in 51 minutes, with identical pen lifts.

---

## Combining algorithms

Tick as many as you like. Each draws into its own SVG layer with its own pen
colour and width, so a sheet can be contours in one pen over ridge lines in
another, plotted as two passes.

By default they are stacked flat, each in plan view. **Drape onto the relief**
changes that: the flat drawings are lifted onto the same displaced surface the
ridge lines are drawn on, and cut where the ground hides them, so a contour wraps
over the near face of a ridge and stops at its edge instead of running across it.

Draping works without ridge lines too. The relief is still built and still hides
what is behind it — it just is not drawn, which gives contours alone with true
hidden-line removal.

Which contours survive depends on the terrain, not on the line-count slider:
changing the density of the ridge lines does not change the drape.

---

## High-resolution elevation (Portugal)

The global elevation data is about 30 m per sample, which is plenty for a sheet
covering tens of kilometres and visibly stair-steps below about 3 km across. For
close-ups, DGT publishes LiDAR terrain models for mainland Portugal at 50 cm and
2 m under CC BY 4.0.

**When it is worth it.** On A3, roughly:

| Sheet covers | Use |
|---|---|
| under ~600 m | 50 cm — a single hillside |
| ~600 m – 2.3 km | 2 m — the usual close-up |
| over ~2.3 km | ordinary elevation; finer data cannot reach the paper |

Past about three samples per millimetre the pen is the limit rather than the
data, so a 50 cm tile on a wide sheet is twenty megabytes buying nothing. The
panel picks for you on **auto**.

**Getting the tiles.** Tick *use high-resolution elevation*, press **Find tiles
for this sheet**, and the panel lists exactly which squares it needs. Anything
already cached loads by itself. For the rest, each tile links to DGT, which asks
you to sign in — the download cannot happen from this page, because DGT's
download endpoint sends no CORS headers and needs a session. Files land in your
Downloads folder; drop them onto the panel.

A free account at [cdd.dgterritorio.gov.pt](https://cdd.dgterritorio.gov.pt) is
all that is needed. If you want many tiles at once, `scripts/fetchLidar.mjs`
fetches them locally — see [AGENTS.md](AGENTS.md). Your credentials stay in
`.env` and never reach the browser.

**Note the products.** `MDT` is bare earth, which is what you want for terrain.
`MDS` is the surface model — treetops and rooftops.

**Serving your own tiles.** The **Tile cache** field takes any base URL and is
remembered in your browser, so you can point the same page at a bucket, at a
machine on your own network, or at nothing. Tiles are fetched as
`<base>/<item-id>.tif` — a plain anonymous GET — so any static file server with
CORS will do, and there is no S3 API to stand up:

```
tiles.example.com {
    root * /srv/lidar
    file_server
    header Access-Control-Allow-Origin "*"
}
```

One catch: a page served over https cannot fetch an `http://` cache, because the
browser blocks it outright. Serve the tiles over https, or use `npm run dev`.
The panel tells you when the address it has been given cannot work, rather than
letting it look like an empty cache.

---

## Exporting and plotting

**Plot-ready SVG** gives you a sheet declared in millimetres with a numerically
identical viewBox, so one user unit is one millimetre and the paper comes out the
size it says. Each pen is an Inkscape layer group that also carries plain `id` and
`stroke`, so tools that ignore the Inkscape namespace still see it. Nothing is
ever filled and no dash arrays are emitted.

Open it in Inkscape and plot layer by layer, or hand it to vpype.

**Preview image (.png)** saves what is on screen, which is useful for sharing but
is not the plot.

---

## Running it yourself

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # 480 tests, offline
npm run build
```

Optional, for the Mapbox elevation source only — the app is fully usable without it:

```bash
cp .env.example .env   # then set VITE_MAPBOX_TOKEN
```

### Deploying

It is a static site with no server-side code, hosted as a Cloudflare Worker with
static assets. Requests to static assets are free and unlimited, and with no
Worker script there is nothing that can bill a request.

```bash
npm run deploy
```

Edit `wrangler.jsonc` to change the domain.

---

## Attribution and fair use

Elevation is AWS Terrain Tiles (SRTM, NED and others) via the AWS Open Data
programme, which has no usage restriction worth worrying about.

The **basemap** is OpenTopoMap and the **place search** is Nominatim. Both are
free and both have usage policies that discourage heavy or commercial traffic.
That is fine for personal use; if this ever gets real visitors, swap them for a
keyed provider. Only the basemap and search are affected — the elevation side
scales freely.

**Portuguese LiDAR** (`MDT`/`MDS`) is published by Direção-Geral do Território
under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution
travels with the data: it appears in the panel and is written into exported SVG.
If you cache or redistribute tiles, keep it.

MIT, as upstream.
