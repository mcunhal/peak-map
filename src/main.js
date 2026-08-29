/**
 * Application startup, and the bridge between the map and the rendering core.
 *
 * The map's only job now is choosing a region. Everything from there — elevation,
 * line generation, page layout, optimization and SVG — happens in the worker,
 * against a bounding box rather than against the browser window.
 */
import appState from './appState';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildRasterStyle } from './config';
import { requestRender, isCancellation, cancelPending } from './renderService';
import { drawPreview, formatMetrics } from './preview';
import { parseGpx } from './gpx/parse';
import { createPage } from './core/page';


window.addEventListener('error', logError);

// Dev-only handle so the app state can be driven from the console (and from
// automated checks, where the tab is hidden and the rAF render loop is throttled).
if (import.meta.env.DEV) window.appState = appState;

// Load vue asyncronously
import('@/vueApp.js');

// Hold a reference to the maplibregl instance.
let map;
let isListening = false;

appState.init = init;
appState.redraw = redraw;
appState.updateMap = updateMap;
appState.exportToSVG = exportToSVG;
appState.setBounds = setBounds;
appState.listenToEvents = listenToEvents;
appState.addGpxFiles = addGpxFiles;
appState.removeTrack = removeTrack;
appState.redrawPreview = redrawPreview;

function init() {
  updateSizes();

  window.map = map = new maplibregl.Map({
    trackResize: false,
    container: 'map',
    minZoom: 0,
    style: buildRasterStyle(),
    center: [-7.6, 40.33], // Serra da Estrela
    zoom: 10.2,
    hash: true,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  listenToEvents(true);

  map.on('load', () => {
    appState.angle = map.getBearing();
  });

  // Upstream disabled this. Rotation now changes what is drawn, so a phone needs
  // a way to reach it: two fingers to turn, two fingers dragged up or down to
  // tilt.
  map.touchZoomRotate.enableRotation();
  if (map.touchPitch && map.touchPitch.enable) map.touchPitch.enable();
}

function listenToEvents(newIsListening) {
  if (newIsListening) {
    if (!isListening) {
      map.on('moveend', updateMapWhenIdle);
      map.on('movestart', markStale);
    }
    isListening = true;
  } else {
    map.off('moveend', updateMapWhenIdle);
    map.off('movestart', markStale);
    isListening = false;
  }
}

function updateMapWhenIdle() {
  map.once('idle', updateMap);
}

function markStale() {
  const canvas = getPreviewCanvas();
  if (canvas) canvas.style.opacity = 0.25;
}

function redraw() {
  updateMap();
}

function pageSettings() {
  return {
    paper: appState.paper,
    orientation: appState.orientation,
    margin: Number(appState.margin),
  };
}

/**
 * The sheet, described by where it sits on screen and what that covers.
 *
 * Working from the screen rectangle rather than from map bounds settles two
 * things at once. The sheet is the right shape, because the rectangle is given
 * the paper's proportions. And it is at the right angle, because unprojecting
 * its corners follows whatever bearing the map is at: a bounding box cannot
 * express a rotated view, and asking for one turns a rotated sheet back to
 * north-up while quietly enlarging it.
 */
function currentSheet() {
  const { drawable } = createPage(pageSettings());
  const aspect = drawable.width / drawable.height;

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;

  // Largest rectangle of the paper's shape that fits the window.
  let width = viewWidth;
  let height = width / aspect;
  if (height > viewHeight) {
    height = viewHeight;
    width = height * aspect;
  }
  const x = (viewWidth - width) / 2;
  const y = (viewHeight - height) / 2;

  const at = (px, py) => {
    const p = map.unproject([px, py]);
    return { lng: p.lng, lat: p.lat };
  };

  // All four corners, because a tilted camera sees a trapezoid: the far edge
  // covers far more ground than the near one, and three corners can only
  // describe a parallelogram.
  const cornersAt = (top) => ({
    nw: at(x, top),
    ne: at(x + width, top),
    sw: at(x, y + height),
    se: at(x + width, y + height),
  });

  // Near the horizon the far edge runs away to nothing useful, and past it
  // unprojecting is meaningless. Pull the top of the sheet down until the
  // perspective is severe but still finite, rather than letting it blow up.
  const nearWidth = () => {
    const c = cornersAt(y);
    return Math.abs(c.se.lng - c.sw.lng);
  };
  const spread = (top) => {
    const c = cornersAt(top);
    const far = Math.abs(c.ne.lng - c.nw.lng);
    const near = Math.abs(c.se.lng - c.sw.lng);
    if (!Number.isFinite(far) || !Number.isFinite(near) || near === 0) return Infinity;
    return far / near;
  };

  let top = y;
  if (map.getPitch() > 0) {
    const limit = 6;
    let low = y;
    let high = y + height * 0.9;
    if (spread(low) > limit) {
      // Binary search the highest top edge whose perspective stays inside the
      // limit. Twenty steps is well under a pixel.
      for (let i = 0; i < 20; ++i) {
        const mid = (low + high) / 2;
        if (spread(mid) > limit) low = mid;
        else high = mid;
      }
      top = high;
    }
  }

  const usedHeight = y + height - top;

  return {
    screenRect: { x, y: top, width, height: usedHeight },
    corners: cornersAt(top),
    pitch: map.getPitch(),
    clamped: top > y + 0.5,
  };
}

function buildRequest(corners) {
  return {
    regionCorners: corners,
    sourceId: appState.demSource,
    detail: Number(appState.detail),
    algorithm: appState.algorithm,
    algorithmOptions: {
      rowCount: Number(appState.lineDensity),
      heightScale: Number(appState.heightScale),
      smoothSteps: Number(appState.smoothSteps),
      oceanLevel: Number(appState.oceanLevel),
      occlude: appState.occlude,
      separation: Number(appState.separation),
      minStroke: Number(appState.hachureMinStroke),
      maxStroke: Number(appState.hachureMaxStroke),
      gap: Number(appState.hachureGap),
      interval: appState.contourInterval ? Number(appState.contourInterval) : null,
      count: Number(appState.contourCount),
      azimuth: Number(appState.sunAzimuth),
      classes: Number(appState.tanakaClasses),
      angle: Number(appState.hatchAngle),
      spacing: Number(appState.hatchSpacing),
      toneLevels: Number(appState.hatchLevels),
    },
    tracks: appState.tracks.map((t) => ({ name: t.name, points: t.points })),
    trackMode: appState.trackMode,
    dotPitch: Number(appState.dotPitch),
    dotLength: Number(appState.dotLength),
    page: pageSettings(),
    pens: {
      terrain: { color: appState.terrainPenColor, width: Number(appState.terrainPenWidth) },
      tracks: appState.tracks.map((t) => ({ color: t.color, width: Number(t.width) })),
    },
    optimize: {
      dedupTolerance: appState.optimizeDedup ? Number(appState.dedupTolerance) : 0,
      mergeTolerance: appState.optimizeMerge ? Number(appState.mergeTolerance) : 0,
      simplifyTolerance: appState.optimizeSimplify ? Number(appState.simplifyTolerance) : 0,
      sort: appState.optimizeSort,
      reloop: appState.optimizeReloop,
      allowReverse: true,
    },
    machine: {
      drawSpeed: Number(appState.drawSpeed),
      travelSpeed: Number(appState.travelSpeed),
      penLiftTime: Number(appState.penLiftTime),
    },
    background: appState.includeBackground ? appState.paperColor : null,
    weightMode: appState.weightMode,
    weightPasses: Number(appState.weightPasses),
    compass: {
      show: appState.showCompass,
      radius: Number(appState.compassRadius),
      corner: appState.compassCorner,
      color: appState.compassColor,
      width: Number(appState.compassPenWidth),
      // Read from the map rather than from state, so it is whatever the sheet
      // was actually framed at.
      bearing: map.getBearing(),
    },
    title: appState.mapName || 'peak map',
  };
}

let lastResult = null;
let lastTarget = null;

function updateMap() {
  if (!map) return;

  const canvas = getPreviewCanvas();
  if (!canvas) return;

  if (!appState.shouldDraw) {
    cancelPending();
    canvas.style.display = 'none';
    appState.renderProgress = null;
    return;
  }

  canvas.style.display = '';
  ensureSizeIsUpdated();

  appState.error = null;
  appState.renderProgress = { message: 'Starting', fraction: 0 };

  // Captured now, so the preview lands where the sheet was when it was framed
  // even if the map has moved on by the time the render finishes.
  const sheet = currentSheet();
  const target = sheet.screenRect;
  appState.sheetPitch = Math.round(sheet.pitch);
  appState.sheetClamped = sheet.clamped;

  requestRender(buildRequest(sheet.corners), (progress) => {
    appState.renderProgress = progress;
  })
    .then((result) => {
      if (!result) return;
      lastResult = result;
      appState.renderProgress = null;
      appState.metrics = formatMetrics(result.metrics);
      appState.vpypeRecipe = result.vpype;
      appState.renderInfo = {
        zoom: result.zoom,
        tiles: result.tileCount,
        missing: result.missingTiles,
        field: result.fieldSize.join(' x '),
        minElevation: Math.round(result.elevation.min),
        maxElevation: Math.round(result.elevation.max),
      };
      canvas.style.opacity = 1;
      lastTarget = target;
      redrawPreview();
    })
    .catch((error) => {
      if (isCancellation(error)) return;
      appState.renderProgress = null;
      appState.error = error.message;
    });
}

function exportToSVG() {
  return lastResult ? lastResult.svg : null;
}

/**
 * Repaint the preview from the last render.
 *
 * Paper opacity only changes how the sheet is displayed, so it must not cost a
 * new render: the terrain has not changed, only whether you can see through the
 * paper to the map beneath it.
 */
function redrawPreview() {
  const canvas = getPreviewCanvas();
  if (!canvas || !lastResult) return;
  drawPreview(canvas, lastResult.page, lastResult.layers, {
    background: appState.paperColor,
    backgroundAlpha: Number(appState.paperOpacity) / 100,
    target: lastTarget,
  });
}

/** Parse dropped or chosen GPX files and add them as tracks. */
async function addGpxFiles(files) {
  const palette = ['#c1272d', '#0b6e99', '#1a7f37', '#b8860b', '#6b3fa0', '#c2560f'];
  const errors = [];

  for (const file of files) {
    try {
      const parsed = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
      for (const track of parsed) {
        appState.tracks.push({
          name: track.name,
          points: track.points,
          color: palette[appState.tracks.length % palette.length],
          width: 0.5,
        });
      }
    } catch (error) {
      // One bad file must not lose the others.
      errors.push(`${file.name}: ${error.message}`);
    }
  }

  appState.error = errors.length ? errors.join('; ') : null;
  if (appState.shouldDraw) updateMap();
}

function removeTrack(index) {
  appState.tracks.splice(index, 1);
  if (appState.shouldDraw) updateMap();
}

function setBounds(bounds) {
  appState.bounds = bounds;
  if (bounds) {
    appState.selectedBoundShortName = bounds.display_name;
    appState.mapName = (bounds.display_name || '').split(',')[0];
    const bbox = bounds.boundingbox;
    map.fitBounds([[bbox[2], bbox[1]], [bbox[3], bbox[0]]], {
      animate: false,
      padding: { top: 42, bottom: 0, left: 0, right: 0 },
    });
  } else {
    appState.selectedBoundShortName = null;
    appState.mapName = '';
  }
  updateMap();
}

function ensureSizeIsUpdated() {
  if (!appState.sizeDirty) return;
  appState.sizeDirty = false;
  updateSizes();
}

function updateSizes() {
  const dimensions = getCanvasDimensions();
  const mapContainer = document.querySelector('#map');
  if (mapContainer) {
    mapContainer.style.left = px(dimensions.left);
    mapContainer.style.top = px(dimensions.top);
    mapContainer.style.width = px(dimensions.width);
    mapContainer.style.height = px(dimensions.height);
  }
  if (map) map.resize();

  const canvas = getPreviewCanvas();
  if (canvas) {
    canvas.style.left = px(dimensions.left);
    canvas.style.top = px(dimensions.top);
    canvas.style.width = px(dimensions.width);
    canvas.style.height = px(dimensions.height);
  }

  appState.sizeDirty = false;
}

function getPreviewCanvas() {
  return document.querySelector('.height-map');
}

function getCanvasDimensions() {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function logError(e) {
  const description = e ? `${e.message} in ${e.filename}:${e.lineno}` : 'Unknown exception';
  console.error('[peak-map]', description);
}

function px(x) {
  return x + 'px';
}
