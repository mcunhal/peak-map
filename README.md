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
- **GPX routes** as separate pen layers, riding the terrain surface and going
  dotted where they pass behind a ridge.
- **A plot-path optimizer** that typically cuts pen-up travel by over 90%, with
  before-and-after numbers and an estimated plot time.
- **Rotate and tilt** the map; the drawing follows, including a true perspective
  view when tilted.
- **A compass rose** drawn as strokes, which foreshortens with the sheet.

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
npm test               # 379 tests, offline
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

MIT, as upstream.
