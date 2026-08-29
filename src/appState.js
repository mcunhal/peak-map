import tinycolor from 'tinycolor2';
import { DEFAULT_DEM_SOURCE, listSources } from './dem/sources';
import { listAlgorithms, DEFAULT_ALGORITHM } from './core/algorithms/index';
import { PAPER_SIZES } from './core/page';

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
  algorithm: DEFAULT_ALGORITHM,
  algorithms: listAlgorithms(),
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
  dotPitch: 0.9,
  dotLength: 0.3,

  // --- page --------------------------------------------------------------
  paper: 'A3',
  papers: Object.keys(PAPER_SIZES),
  orientation: 'landscape',
  margin: 15,
  paperColor: '#ffffff',
  includeBackground: true,
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
  tracks: [],
  trackMode: 'dotted',
  trackModes: ['dotted', 'hidden', 'visible'],

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
