import tinycolor from 'tinycolor2';
import { DEFAULT_DEM_SOURCE, listSources } from './dem/sources';
import { listAlgorithms, DEFAULT_ALGORITHM } from './core/algorithms/index';
import { PAPER_SIZES } from './core/page';

/**
 * The tile cache URL, remembered per browser.
 *
 * Kept out of the URL hash deliberately: it is a property of the machine you are
 * sitting at, not of the map you are looking at, and sharing a link should not
 * hand someone an address they cannot reach.
 */
const CACHE_URL_KEY = 'peak-map.lidarCacheUrl';

function loadCacheUrl() {
  const fallback = import.meta.env.VITE_LIDAR_CACHE_URL || '';
  try {
    const stored = window.localStorage.getItem(CACHE_URL_KEY);
    return stored === null ? fallback : stored;
  } catch {
    // Private windows and blocked site data both throw rather than return null.
    return fallback;
  }
}

export function rememberCacheUrl(value) {
  try {
    window.localStorage.setItem(CACHE_URL_KEY, String(value || ''));
  } catch {
    // Not remembering it is a small loss; failing the render is not worth it.
  }
}

const appState = {
  angle: 0,
  currentState: 'intro',

  // --- region and data ---------------------------------------------------
  demSource: DEFAULT_DEM_SOURCE,
  demSources: listSources(),
  detail: 900,
  bounds: null,
  mapName: null,
  selectedBoundShortName: null,
  boundarySearchQuery: '',
  boundarySearchResults: [],
  showBoundaryDetails: false,

  // --- algorithm ---------------------------------------------------------
  selectedAlgorithms: [DEFAULT_ALGORITHM],
  algorithms: listAlgorithms(),
  algorithmPens: listAlgorithms().reduce((acc, algo) => {
    acc[algo.id] = { color: '#161616', width: 0.25 };
    return acc;
  }, {}),
  // Planar algorithms drawn on the relief rather than flat, and hidden where it
  // hides them. Off keeps the plan-view stacking, which is a different picture
  // rather than a worse one.
  drape: false,
  lineDensity: 60,
  // Sizes are in millimetres on the paper, so changing detail does not change
  // how the map looks.
  heightScale: 26,
  smoothSteps: 0.9,
  oceanLevel: 0,
  occlude: true,
  separation: 4,
  contourInterval: '',
  contourCount: 25,
  sunAzimuth: 315,
  weightMode: 'passes',
  weightPasses: 3,
  tanakaClasses: 3,
  hachureMinStroke: 0.8,
  hachureMaxStroke: 3.5,
  hachureGap: 1.2,
  hatchAngle: 45,
  hatchSpacing: 0.9,
  hatchLevels: 4,

  // --- page --------------------------------------------------------------
  paper: 'A3',
  papers: Object.keys(PAPER_SIZES),
  orientation: 'landscape',
  margin: 15,
  paperColor: '#ffffff',
  includeBackground: true,
  // Preview only; the exported file is unaffected.
  paperOpacity: 100,
  terrainPenColor: '#161616',
  terrainPenWidth: 0.25,

  // --- compass -----------------------------------------------------------
  showCompass: true,
  compassRadius: 12,
  compassCorner: 'bottom-right',
  compassCorners: ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
  compassColor: '#161616',
  compassPenWidth: 0.35,

  // --- gpx ---------------------------------------------------------------
  trackFiles: [],
  // Which GPX files are expanded to their sections. Panel state, like
  // `settingsOpen`: it is deliberately absent from RENDER_INPUTS and from the
  // worker request, so opening a file redraws nothing.
  expanded: {},
  trackMode: 'dotted',
  trackModes: ['dotted', 'hidden', 'visible'],

  // --- lidar (Portugal, close-ups only) -----------------------------------
  lidarEnabled: false,
  lidarKind: 'terrain',
  lidarResolution: 'auto',
  lidarResolutions: ['auto', '50cm', '2m'],
  // Where cached tiles are fetched from. The build supplies a default, but it
  // is a runtime setting so the same deployed page can be pointed at a bucket,
  // at a server on the LAN, or at nothing at all.
  lidarCacheUrl: loadCacheUrl(),
  lidarTiles: [],
  lidarLoaded: [],
  lidarStatus: null,
  lidarBusy: false,

  // --- optimizer ---------------------------------------------------------
  optimizeDedup: true,
  optimizeMerge: true,
  optimizeSimplify: true,
  optimizeSort: true,
  optimizeReloop: true,
  dedupTolerance: 0.05,
  mergeTolerance: 0.15,
  simplifyTolerance: 0.08,
  drawSpeed: 60,
  travelSpeed: 150,
  penLiftTime: 0.2,

  // --- results and ui ----------------------------------------------------
  metrics: null,
  vpypeRecipe: null,
  renderInfo: null,
  sheetPitch: 0,
  sheetClamped: false,
  aboutVisible: false,
  error: null,
  settingsOpen: false,
  shouldDraw: false,
  renderProgress: null,
  showLess: false,
  showThemeDetails: false,
  selectedTheme: 'white',
  themes: [
    { value: 'white', name: 'white', backgroundColor: '#ffffff', lineBackground: '#ffffff', lineColor: '#161616' },
    { value: 'beige', name: 'beige', backgroundColor: '#F7F2E8', lineBackground: '#F7F2E8', lineColor: 'rgb(22, 22, 22)' },
    { value: 'dark', name: 'dark', backgroundColor: '#3C3D3D', lineBackground: '#3C3D3D', lineColor: '#ffffff' },
    { value: 'blue', name: 'blue', backgroundColor: '#101E33', lineBackground: '#101E33', lineColor: '#D1D8E3' },
    { value: 'emerald', name: 'emerald', backgroundColor: '#182217', lineBackground: '#182217', lineColor: '#2CFA8A' },
  ],
};

// TODO: This should probably live in App.vue
let theme = appState.themes.find((theme) => theme.name === appState.selectedTheme);
appState.backgroundColor = tinycolor(theme.backgroundColor).toRgb();
appState.lineBackground = tinycolor(theme.lineBackground).toRgb();
appState.lineColor = tinycolor(theme.lineColor).toRgb();

export default appState;
