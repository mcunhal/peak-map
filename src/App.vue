<template>
  <div class='app-container'>
    <div id='map' ref='map'></div>
    <canvas class='absolute height-map' ref='heightMap'></canvas>
    <div id='progress' :style="{opacity: renderProgress ? 1 : 0}">
      {{renderProgress && renderProgress.message}}
    </div>
    <div id="app" class='absolute'> 
      <div class='row control-panel'>
        <a v-if='shouldDraw'
           href="#"
           :class='{draw: true, settings: true, open: settingsOpen}'
           @click.prevent='settingsOpen = !settingsOpen'
           title='Change appearance, export to SVG'>
           {{settingsOpen ? 'Close settings' : 'Customize...'}}
        </a>
        <a href="#" class='draw peaks' :title='mainActionTitle' @click.prevent='onMainActionClick'>{{mainActionText}}</a>
      </div>
      <div class='settings-form' v-if='settingsOpen && shouldDraw'>
        <find-bounds></find-bounds>

        <h3>Terrain</h3>
        <div class='row'>
          <div class='col'>Algorithm</div>
          <div class='col c-2'>
            <select v-model='algorithm'>
              <option v-for='a in algorithms' :value='a.id' :key='a.id'>{{a.name}}</option>
            </select>
          </div>
        </div>
        <div class='row'><div class='col'></div><div class='col c-2 hint'>{{algorithmDescription}}</div></div>

        <div class='row'>
          <div class='col'>Elevation data</div>
          <div class='col c-2'>
            <select v-model='demSource'>
              <option v-for='s in demSources' :value='s.id' :key='s.id' :disabled='!s.available'>{{s.name}}</option>
            </select>
          </div>
        </div>
        <div class='row'>
          <div class='col'>Detail</div>
          <div class='col c-2'>
            <input type='range' min='200' max='1600' step='50' v-model='detail'>
            <input type='number' step='50' v-model='detail' min='200' max='1600'>
          </div>
        </div>
        <div class='row'><div class='col'></div><div class='col c-2 hint'>How finely the terrain is sampled. Sizes below are in millimetres on the paper, so this changes how much resolves, not how the map looks.</div></div>

        <template v-if="algorithm === 'ridgeline'">
          <div class='row'>
            <div class='col'>Line count</div>
            <div class='col c-2'>
              <input type='range' min='10' max='200' step='1' v-model='lineDensity'>
              <input type='number' step='1' v-model='lineDensity' min='10' max='200'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Relief height (mm)</div>
            <div class='col c-2'>
              <input type='range' min='2' max='120' step='1' v-model='heightScale'>
              <input type='number' step='1' v-model='heightScale' min='2' max='120'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Smoothing (mm)</div>
            <div class='col c-2'>
              <input type='range' min='0' max='6' step='0.1' v-model='smoothSteps'>
              <input type='number' step='0.1' v-model='smoothSteps' min='0' max='6'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Ocean level</div>
            <div class='col c-2'>
              <input type='range' min='-20' max='500' step='1' v-model='oceanLevel'>
              <input type='number' step='1' v-model='oceanLevel' min='-20' max='500'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Hide what is behind</div>
            <div class='col c-2'><input type='checkbox' v-model='occlude'></div>
          </div>
        </template>

        <template v-if='isContourFamily'>
          <div class='row'>
            <div class='col'>Interval (m)</div>
            <div class='col c-2'>
              <input type='number' step='10' v-model='contourInterval' placeholder='auto' min='1'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Contours, if auto</div>
            <div class='col c-2'>
              <input type='range' min='5' max='80' step='1' v-model='contourCount'>
              <input type='number' step='1' v-model='contourCount' min='5' max='80'>
            </div>
          </div>
        </template>

        <div class='row' v-if='isLit'>
          <div class='col'>Sun azimuth</div>
          <div class='col c-2'>
            <input type='range' min='0' max='359' step='1' v-model='sunAzimuth'>
            <input type='number' step='1' v-model='sunAzimuth' min='0' max='359'>
          </div>
        </div>
        <div class='row' v-if="algorithm === 'tanaka'">
          <div class='col'>Weight classes</div>
          <div class='col c-2'>
            <input type='range' min='1' max='6' step='1' v-model='tanakaClasses'>
            <input type='number' step='1' v-model='tanakaClasses' min='1' max='6'>
          </div>
        </div>

        <div class='row' v-if='isFlowFamily'>
          <div class='col'>Line spacing (mm)</div>
          <div class='col c-2'>
            <input type='range' min='0.4' max='8' step='0.1' v-model='separation'>
            <input type='number' step='0.1' v-model='separation' min='0.4' max='8'>
          </div>
        </div>

        <template v-if="algorithm === 'hillshade-hatching'">
          <div class='row'>
            <div class='col'>Hatch angle</div>
            <div class='col c-2'>
              <input type='range' min='0' max='179' step='1' v-model='hatchAngle'>
              <input type='number' step='1' v-model='hatchAngle' min='0' max='179'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Hatch spacing (mm)</div>
            <div class='col c-2'>
              <input type='range' min='0.2' max='4' step='0.1' v-model='hatchSpacing'>
              <input type='number' step='0.1' v-model='hatchSpacing' min='0.2' max='4'>
            </div>
          </div>
          <div class='row'>
            <div class='col'>Tonal levels</div>
            <div class='col c-2'>
              <input type='range' min='1' max='8' step='1' v-model='hatchLevels'>
              <input type='number' step='1' v-model='hatchLevels' min='1' max='8'>
            </div>
          </div>
        </template>

        <h3>Paper</h3>
        <div class='row'>
          <div class='col'>Size</div>
          <div class='col c-2'>
            <select v-model='paper'>
              <option v-for='p in papers' :value='p' :key='p'>{{p}}</option>
            </select>
            <select v-model='orientation'>
              <option value='landscape'>landscape</option>
              <option value='portrait'>portrait</option>
            </select>
          </div>
        </div>
        <div class='row'>
          <div class='col'>Margin (mm)</div>
          <div class='col c-2'>
            <input type='range' min='0' max='60' step='1' v-model='margin'>
            <input type='number' step='1' v-model='margin' min='0' max='60'>
          </div>
        </div>
        <div class='row'>
          <div class='col'>Sheet background</div>
          <div class='col c-2'>
            <input type='checkbox' v-model='includeBackground'>
            <input type='color' v-model='paperColor' :disabled='!includeBackground'>
            <span class='hint'>keep on to view the file; turn off for a bare plot</span>
          </div>
        </div>
        <div class='row'>
          <div class='col'>Terrain pen</div>
          <div class='col c-2'>
            <input type='color' v-model='terrainPenColor'>
            <input type='number' step='0.05' v-model='terrainPenWidth' min='0.05' max='2'>
          </div>
        </div>

        <div class='row'>
          <div class='col'>Compass</div>
          <div class='col c-2'>
            <input type='checkbox' v-model='showCompass'>
            <select v-model='compassCorner' :disabled='!showCompass'>
              <option v-for='c in compassCorners' :value='c' :key='c'>{{c}}</option>
            </select>
            <input type='number' step='1' min='4' max='40' v-model='compassRadius' :disabled='!showCompass'>
          </div>
        </div>
        <div class='row' v-if='showCompass'>
          <div class='col'></div>
          <div class='col c-2 hint'>Drawn as strokes, and turns with the map so north stays north.</div>
        </div>

        <h3>GPX routes</h3>
        <div class='row'>
          <div class='col'>Add files</div>
          <div class='col c-2'><input type='file' accept='.gpx' multiple @change='onGpxChosen'></div>
        </div>
        <div class='row' v-for='(track, i) in tracks' :key="'track' + i">
          <div class='col track-name'>{{track.name}}</div>
          <div class='col c-2'>
            <input type='color' v-model='track.color'>
            <input type='number' step='0.05' v-model='track.width' min='0.05' max='2'>
            <a href='#' @click.prevent='removeTrack(i)'>remove</a>
          </div>
        </div>
        <div class='row' v-if="tracks.length && trackMode === 'dotted'">
          <div class='col'>Dot pitch / length (mm)</div>
          <div class='col c-2'>
            <input type='number' step='0.1' min='0.2' max='6' v-model='dotPitch'>
            <input type='number' step='0.05' min='0.05' max='3' v-model='dotLength'>
          </div>
        </div>
        <div class='row' v-if='tracks.length'>
          <div class='col'>Behind a ridge</div>
          <div class='col c-2'>
            <select v-model='trackMode'>
              <option value='dotted'>draw as dots</option>
              <option value='hidden'>hide</option>
              <option value='visible'>always show</option>
            </select>
          </div>
        </div>

        <h3>Plot optimization</h3>
        <div class='row'>
          <div class='col'>Passes</div>
          <div class='col c-2 passes'>
            <label><input type='checkbox' v-model='optimizeDedup'> dedup</label>
            <label><input type='checkbox' v-model='optimizeMerge'> merge</label>
            <label><input type='checkbox' v-model='optimizeSort'> sort</label>
            <label><input type='checkbox' v-model='optimizeReloop'> reloop</label>
            <label><input type='checkbox' v-model='optimizeSimplify'> simplify</label>
          </div>
        </div>
        <div class='row'>
          <div class='col'>Tolerances (mm)</div>
          <div class='col c-2'>
            <input type='number' step='0.01' v-model='dedupTolerance' min='0' title='deduplicate'>
            <input type='number' step='0.01' v-model='mergeTolerance' min='0' title='merge'>
            <input type='number' step='0.01' v-model='simplifyTolerance' min='0' title='simplify'>
          </div>
        </div>

        <div v-if='metrics'>
          <h3>This plot</h3>
          <div class='row'><div class='col'>Estimated time</div><div class='col c-2'>{{metrics.time}}</div></div>
          <div class='row'><div class='col'>Pen down</div><div class='col c-2'>{{metrics.penDown}}</div></div>
          <div class='row'><div class='col'>Pen up</div><div class='col c-2'>{{metrics.penUp}}</div></div>
          <div class='row'><div class='col'>Pen lifts</div><div class='col c-2'>{{metrics.lifts}} over {{metrics.paths}} paths</div></div>
          <div class='row' v-if='metrics.saved'><div class='col'>Optimizer</div><div class='col c-2'>{{metrics.saved}}</div></div>
          <div class='row' v-if='sheetPitch > 0'>
            <div class='col'>Tilt</div>
            <div class='col c-2'>
              {{sheetPitch}}&deg; &mdash; drawn in perspective, far ground compressed
              <span v-if='sheetClamped'> (limited, to keep the horizon off the sheet)</span>
            </div>
          </div>
          <div class='row' v-if='renderInfo'>
            <div class='col'>Source</div>
            <div class='col c-2'>zoom {{renderInfo.zoom}}, {{renderInfo.tiles}} tiles, {{renderInfo.field}} samples, {{renderInfo.minElevation}} to {{renderInfo.maxElevation}} m</div>
          </div>
        </div>

        <div v-if='!showLess'>
          <h3>Export</h3>

          <div class='error padded' v-if='error'>
            <h5>Error occurred:</h5>
            <pre>{{error}}</pre>
          </div>

          <div class='row'>
            <a href='#' @click.prevent='doExportToSVG' class='col export'>Plot-ready SVG</a>
            <span class='col c-2'>Layered, in millimetres, one layer per pen.</span>
          </div>
          <div class='row'>
            <a href='#' @click.prevent='doExportToPNG' class='col export'>Preview image (.png)</a>
            <span class='col c-2'>The preview as a raster image.</span>
          </div>
          <div class='row' v-if='vpypeRecipe'>
            <div class='col'>vpype</div>
            <div class='col c-2'><pre class='recipe'>{{vpypeRecipe}}</pre></div>
          </div>

          <h3>About</h3>
          <div>
            <p>
            Topographic line maps built for pen plotting: layered SVG in millimetres,
            GPX routes on their own pens, and several ways of turning terrain into lines.
            </p>
            <p>
            A fork of <a href='https://github.com/anvaka/peak-map' target='_blank'>peak-map</a>
            by <a href='https://twitter.com/anvaka' target='_blank'>@anvaka</a>, whose hidden-line
            ridgeline renderer is still at the heart of it. Elevation comes from
            <a href='https://registry.opendata.aws/terrain-tiles/' target='_blank'>AWS Terrain Tiles</a>,
            so no API key is needed.
            </p>
          </div>
        </div>
        <div class='close-link' :class="{'map-visible': shouldDraw}">
          <a href="#" @click.prevent='showLess = !showLess'>{{showLess ? 'show more' : 'show less'}}</a>
          <a href="#" @click.prevent='settingsOpen = false'>close</a>
        </div>
      </div>

    </div>

    <div class='about-line'>
      <a href='#' @click.prevent='aboutVisible = true'>about website</a>
    </div>

    <about v-if='aboutVisible' @close='aboutVisible = false'></about>

    <editable-label v-if='shouldDraw && bounds && !renderProgress' v-model='mapName' class='map-name' :printable='true' :style='{color: lineColorHex}'></editable-label>
    <div v-if='shouldDraw && bounds && !renderProgress' class='license printable' :style='{color: lineColorHex}'>data <a href='https://www.openstreetmap.org/about/' target="_blank" :style='{color: lineColorHex}'>© OpenStreetMap</a> <a href='https://www.mapbox.com/about/maps/' target="_blank" :style='{color: lineColorHex}'>© Mapbox</a></div>
  </div>
</template>

<script>
import appState from './appState';
import Loading from './components/Loading.vue';
import FindBounds from './components/FindBounds.vue';
import EditableLabel from './components/EditableLabel.vue';
import About from './components/About.vue';

/** Settings that change the drawing, and so should trigger a re-render. */
const RENDER_INPUTS = [
  'algorithm', 'demSource', 'detail',
  'lineDensity', 'heightScale', 'smoothSteps', 'oceanLevel', 'occlude',
  'separation', 'contourInterval', 'contourCount', 'sunAzimuth', 'tanakaClasses',
  'hatchAngle', 'hatchSpacing', 'hatchLevels',
  'paper', 'orientation', 'margin', 'terrainPenColor', 'terrainPenWidth',
  'includeBackground', 'paperColor', 'dotPitch', 'dotLength',
  'showCompass', 'compassRadius', 'compassCorner', 'compassColor', 'compassPenWidth',
  'angle',
  'trackMode',
  'optimizeDedup', 'optimizeMerge', 'optimizeSimplify', 'optimizeSort', 'optimizeReloop',
  'dedupTolerance', 'mergeTolerance', 'simplifyTolerance',
];

function download(blob, name) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.URL.revokeObjectURL(url);
}

export default {
  name: 'App',
  data() {
    return appState;
  },
  components: { Loading, About, EditableLabel, FindBounds },

  mounted() {
    this.onResize = () => { appState.sizeDirty = true; };
    window.addEventListener('resize', this.onResize, true);
    appState.init();

    // Re-render on any setting that changes the drawing. Doing this by list
    // rather than a deep watcher keeps typing in a number field from firing a
    // render per keystroke on unrelated state.
    this.unwatch = RENDER_INPUTS.map((key) =>
      this.$watch(key, () => { if (this.shouldDraw) this.scheduleRender(); })
    );
    // Pen colour and width are per track, so they need their own deep watch.
    this.unwatch.push(
      this.$watch('tracks', () => { if (this.shouldDraw) this.scheduleRender(); }, { deep: true })
    );
  },

  beforeDestroy() {
    window.removeEventListener('resize', this.onResize, true);
    (this.unwatch || []).forEach((stop) => stop());
    clearTimeout(this.renderTimer);
  },

  computed: {
    mainActionText() {
      return this.shouldDraw ? 'Show the map' : 'Draw this region';
    },
    mainActionTitle() {
      return this.shouldDraw ? 'Show the original map' : 'Turn this region into lines';
    },
    algorithmDescription() {
      const found = this.algorithms.find((a) => a.id === this.algorithm);
      return found ? found.description : '';
    },
    isContourFamily() {
      return this.algorithm.indexOf('contours') === 0 || this.algorithm === 'tanaka';
    },
    isLit() {
      return this.algorithm === 'tanaka' || this.algorithm === 'hillshade-hatching';
    },
    isFlowFamily() {
      return this.algorithm.indexOf('streamlines') === 0 || this.algorithm === 'hachures';
    },
    lineColorHex() {
      return this.terrainPenColor;
    },
  },

  watch: {
    angle(newValue) {
      if (window.map) window.map.setBearing(Number.parseFloat(newValue));
    },
    shouldDraw() {
      this.error = null;
      this.updateMap();
    },
  },

  methods: {
    onMainActionClick() {
      this.shouldDraw = !this.shouldDraw;
    },

    /** Coalesce a burst of slider movements into one render. */
    scheduleRender() {
      clearTimeout(this.renderTimer);
      this.renderTimer = setTimeout(() => this.updateMap(), 250);
    },

    onGpxChosen(event) {
      const files = Array.from(event.target.files || []);
      if (files.length) appState.addGpxFiles(files);
      // Let the same file be chosen again after it is removed.
      event.target.value = '';
    },

    doExportToSVG() {
      const svg = appState.exportToSVG();
      if (!svg) {
        this.error = 'Nothing has been rendered yet.';
        return;
      }
      download(new Blob([svg], { type: 'image/svg+xml' }), (this.mapName || 'peak-map') + '.svg');
    },

    doExportToPNG() {
      const canvas = this.$refs.heightMap;
      if (!canvas) return;
      canvas.toBlob((blob) => {
        download(blob, (this.mapName || 'peak-map') + '.png');
      }, 'image/png');
    },
  },
};
</script>

<style lang='stylus'>
.hint
  font-size 12px
  opacity 0.75
.passes label
  margin-right 10px
  white-space nowrap
.track-name
  overflow hidden
  text-overflow ellipsis
  white-space nowrap
.recipe
  font-size 11px
  white-space pre-wrap
  overflow-x auto

@import('./variables.styl');

.app-container {
  font-family: 'Avenir', Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

#app {
  width: app-width;
  background: white;
  z-index: 4;
  box-shadow: 0 2px 4px rgba(0,0,0,.2);
}
h3 {
  font-weight: normal;
  margin: 12px 0;
}
.hide-print-message {
  position: absolute;
  right: 8px;
}
.options-container {
  border-top: 1px solid border-color;
  border-bottom: 1px solid border-color;
  background: secondary-background;
  margin: 0 -16px;
  padding: 8px 16px;
}
.options-container-toggle {
  position: absolute;
  height: 24px;
  right: 8px;
  display: block;
  padding: 5px;
  border: 1px solid transparent;
}
.options-container-toggle.is-open {
  background: secondary-background;
  border: 1px solid border-color;
  border-bottom: 0;
}
.height-map {
  position: absolute;
  z-index: 3;
  pointer-events: none;
  opacity: 0;
  transition: opacity 100ms ease-in-out;
  background-position: 0px 0px, 10px 10px;
  background-size: 20px 20px;
  background-image: linear-gradient(45deg, #bbb 25%, transparent 25%, transparent 75%, #bbb 75%, #bbb 100%),linear-gradient(45deg, #bbb 25%, white 25%, white 75%, #bbb 75%, #bbb 100%);
}
.close-link {
  margin-top: 8px;
  font-size: 10px;
  display: flex;
  justify-content: space-between;
}

.close-link.map-visible {
  display: flex;
  justify-content: space-between;
}

.col {
  align-items: center;
  display: flex;
  flex: 1;
  select {
    margin-right: 8px;
    min-width: 120px;
  }

  input[type="range"] {
    flex: 1;
  }
}
.col.c-2 {
  flex: 2
  margin-left: 4px;
}
.col.export {
  margin-right: 4px;
  align-items: stretch;
}

.row {
  margin-top: 4px;
  display: flex;
  flex-direction: row;
  min-height: 32px;
}

.colors {
    display: flex;
    flex-direction: row;

  .color-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 64px;
  }
  .color-label {
    font-size: 12px;
  }
}

.control-panel {
  height: 42px;
  margin: 0;
  justify-items: stretch;
  a {
    border-top: 2px solid transparent;
    display: flex;
    align-items: center;
    border-bottom: 1px solid border-color;
  }
  
  a.settings {
    border-right: 1px solid border-color;
    padding: 0 16px;
    &:hover {
      color: primary-action-color;
    }
  }
  a.settings.open {
    box-shadow: 0 -3px 4px rgba(0,0,0,0.2);
    border-top: 2px solid highlight-color;
    border-bottom: none;
  }
  .draw {
    flex: 1;
    justify-content: center;
  }
}

.settings-form {
  position: relative;
  padding: 24px 16px 8px 16px;
  overflow-y: auto;
  border-right: 1px solid border-color;
  max-height: calc(100vh - 134px);
  h3 {
    margin: 8px 0 0 0;
    text-align: right;
  }

  input[type='number'] {
    max-width: 42px;
  }
}

.mapboxgl-ctrl-top-right .mapboxgl-ctrl {
  margin: 0;
}
.app-container .mapboxgl-ctrl-geocoder{
  box-shadow: 0 2px 4px rgba(0,0,0,.2)
}

.mapboxgl-ctrl-geocoder input[type='text'] {
  font-family: 'Avenir', Helvetica, Arial, sans-serif;
  height: 42px;
}

.preview-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  font-size: 14px;
  align-items: center;
  display: flex;
  background-color: secondary-background;
  border: 1px solid border-color;
  margin: 8px -16px;

  .popup-help {
    text-align: center;
  }
}

.padded {
  padding: 12px;
}

.block {
  margin-top: 12px;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
}
a {
  color: primary-action-color;
  text-decoration: none;
}
.error pre {
  overflow-x: auto;
}

.loading-container {
  display: flex;
  align-items: center;
  justify-content: left;
  font-size: 14px;
  margin: 4px 0;
  svg {
    margin-right: 12px;
    margin-left: 12px;
  }
}
.about-line {
  position: fixed

  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 14px;
  a {
    background: rgba(255, 255, 255, 0.58)
    padding: 0 4px;
  }
}
.title {
  font-size: 18px;
}
.row {
  display: flex;
  flex-direction: row;
}
.center {
  justify-content: center;
}
.col {
  flex: 1;
}

#progress {
  transition: opacity .2s ease-in-out;
  animation: blink 4.5s ease-in-out infinite alternate;
  position: absolute;
  top: 41px;
  left: 0;
  width: app-width - 1px;
  z-index: 20;
  font-size: 12px;
  color: white;
  opacity: 0;
  text-align: center;
  background: rgb(255, 64, 129, 0.08);
  box-shadow: -1px 1px 4px rgba(134, 132, 132, 0.8)
  user-select: none;
}

@keyframes blink {
    0% { background: rgba(255, 64, 129, 0.88);  }
    33% { background: rgba(255, 64, 247, 0.88);  }
    66% { background: rgba(64, 191, 255, 0.88);  }
    100% { background: rgba(255, 64, 129, 0.88); }
}
.peaks {
  border-right: 1px solid border-color;
}

.map-name {
  position: fixed;
  right: 32px;
  bottom: 54px;
  font-size: 24px;
  color: #434343;
  z-index: 3;
  min-height: 46px;
  input {
    font-size: 24px;
    outline: none;
  }
}
.license {
  z-index: 3;
  text-align: right;
  position: fixed;
  font-family: labels-font;
  right: 32px;
  bottom: 32px;
  font-size: 12px;
  padding-right: 8px;
  a {
    text-decoration: none;
    display: inline-block;
    color: primary-text;
  }
}


@media (max-width: small-screen) {
  #app {
    width: 100%;
  }
  #progress {
    width: 100%;
  }

  .mapboxgl-ctrl-geocoder {
    display: none;
  }

  .title {
    font-size: 16px;
  }
  .map-name  {
    right: 8px;
    bottom: 24px;
  }
  .license  {
    right: 8px;
    bottom: 8px;
  }
}
</style>
