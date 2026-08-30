<template>
  <div class='lidar-panel'>
    <div class='row'>
      <div class='col'>Portugal LiDAR</div>
      <div class='col c-2'>
        <label class='inline'>
          <input type='checkbox' v-model='lidarEnabled'>
          use high-resolution elevation
        </label>
      </div>
    </div>

    <template v-if='lidarEnabled'>
      <div class='row'>
        <div class='col'>Resolution</div>
        <div class='col c-2'>
          <select v-model='lidarResolution'>
            <option value='auto'>auto — pick what the pen can show</option>
            <option value='50cm'>50 cm — tight sheets only</option>
            <option value='2m'>2 m — the usual choice</option>
          </select>
        </div>
      </div>
      <div class='row'>
        <div class='col'></div>
        <div class='col c-2 hint'>{{ resolutionHint }}</div>
      </div>

      <div class='row'>
        <div class='col'>Tile cache</div>
        <div class='col c-2'>
          <input
            type='text'
            v-model.trim='lidarCacheUrl'
            placeholder='https://tiles.example.com/lidar'
          >
        </div>
      </div>
      <div class='row'>
        <div class='col'></div>
        <div class='col c-2 hint' :class="{ warn: cacheWarning }">
          {{ cacheWarning || 'Where to fetch tiles from: a bucket, or a server on your network. Leave empty to use dropped files only.' }}
        </div>
      </div>

      <div class='row'>
        <div class='col'></div>
        <div class='col c-2'>
          <button type='button' @click='findTiles' :disabled='lidarBusy || !bounds'>
            {{ lidarBusy ? 'Looking…' : 'Find tiles for this sheet' }}
          </button>
        </div>
      </div>

      <div class='row' v-if='lidarStatus'>
        <div class='col'></div>
        <div class='col c-2 hint'>{{ lidarStatus }}</div>
      </div>

      <div
        class='drop-zone'
        :class="{ over: dragging }"
        @dragover.prevent='dragging = true'
        @dragleave.prevent='dragging = false'
        @drop.prevent='onDrop'
      >
        Drop <code>.tif</code> tiles here
        <input type='file' multiple accept='.tif,.tiff' @change='onPick'>
      </div>

      <ul class='tile-list' v-if='lidarTiles.length'>
        <li v-for='tile in lidarTiles' :key='tile.cacheKey'>
          <span class='state' :class='stateOf(tile)'>{{ stateLabel(tile) }}</span>
          <span class='name'>{{ tile.tileName }}</span>
          <a
            v-if="stateOf(tile) === 'needed' && tile.downloadUrl"
            :href='tile.downloadUrl'
            target='_blank'
            rel='noopener'
          >get from DGT</a>
        </li>
      </ul>

      <div class='row' v-if='lidarTiles.length'>
        <div class='col'></div>
        <div class='col c-2 hint'>
          Links open DGT, which asks you to sign in — the download cannot be made from
          here. Files land in your Downloads folder; drop them above.
        </div>
      </div>

      <div class='row attribution'>
        <div class='col'></div>
        <div class='col c-2 hint'>
          {{ attribution.text }} —
          <a :href='attribution.licenseUrl' target='_blank' rel='noopener'>{{ attribution.license }}</a>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import appState, { rememberCacheUrl } from '../appState';
import { searchTiles, chooseCollection, ATTRIBUTION } from '../dem/ptLidarCatalog';
import {
  loadFromCache,
  matchFileToTile,
  describeCoverage,
  describeCacheBase,
} from '../dem/lidarCache';
import { PAPER_SIZES } from '../core/page';

export default {
  name: 'LidarPanel',

  data() {
    return { appState, dragging: false, attribution: ATTRIBUTION };
  },

  computed: {
    lidarEnabled: {
      get() { return appState.lidarEnabled; },
      set(v) { appState.lidarEnabled = v; },
    },
    lidarResolution: {
      get() { return appState.lidarResolution; },
      set(v) { appState.lidarResolution = v; },
    },
    lidarCacheUrl: {
      get() { return appState.lidarCacheUrl; },
      set(v) {
        appState.lidarCacheUrl = v;
        rememberCacheUrl(v);
      },
    },

    /** Whether the configured cache can be reached from this page at all. */
    cacheVerdict() {
      return describeCacheBase(appState.lidarCacheUrl, window.location.protocol);
    },

    /** Said only when it is worth saying: a fault, not the ordinary empty case. */
    cacheWarning() {
      const verdict = this.cacheVerdict;
      return verdict.ok || !verdict.configured ? null : verdict.reason;
    },

    lidarTiles() { return appState.lidarTiles; },
    lidarLoaded() { return appState.lidarLoaded; },
    lidarBusy() { return appState.lidarBusy; },
    lidarStatus() { return appState.lidarStatus; },
    bounds() { return appState.bounds; },

    /** How wide the sheet is on the ground, which decides whether 50cm earns its place. */
    groundWidthM() {
      const b = appState.bounds;
      if (!b) return null;
      const midLat = ((b.north + b.south) / 2) * (Math.PI / 180);
      return Math.abs(b.east - b.west) * 111320 * Math.cos(midLat);
    },

    drawableMm() {
      const paper = PAPER_SIZES[appState.paper] || PAPER_SIZES.A3;
      const long = Math.max(paper.width, paper.height);
      const short = Math.min(paper.width, paper.height);
      const width = appState.orientation === 'landscape' ? long : short;
      return width - 2 * Number(appState.margin || 0);
    },

    resolutionHint() {
      const width = this.groundWidthM;
      if (!width) return 'Frame a sheet first.';
      const perMm = width / this.drawableMm;
      const auto = chooseCollection(width, this.drawableMm, { kind: appState.lidarKind });
      return `This sheet covers ${Math.round(width)} m across, ${perMm.toFixed(1)} m per mm. ` +
        `Auto would fetch ${auto}.`;
    },
  },

  methods: {
    stateOf(tile) {
      return appState.lidarLoaded.some((t) => t.cacheKey === tile.cacheKey) ? 'ready' : 'needed';
    },

    stateLabel(tile) {
      return this.stateOf(tile) === 'ready' ? 'ready' : 'needed';
    },

    collectionForSheet() {
      if (appState.lidarResolution === 'auto') {
        return chooseCollection(this.groundWidthM, this.drawableMm, { kind: appState.lidarKind });
      }
      const prefix = appState.lidarKind === 'surface' ? 'MDS' : 'MDT';
      return `${prefix}-${appState.lidarResolution}`;
    },

    async findTiles() {
      const b = appState.bounds;
      if (!b) return;

      appState.lidarBusy = true;
      appState.lidarStatus = 'Asking the DGT catalogue…';
      try {
        const collection = this.collectionForSheet();
        const tiles = await searchTiles({
          bbox: [b.west, b.south, b.east, b.north],
          collection,
          fetchImpl: window.fetch.bind(window),
        });
        appState.lidarTiles = tiles;

        // Anything already in our cache arrives without the user doing a thing.
        // A cache the browser will refuse to call is not consulted at all: every
        // tile would come back missing, which reads as an empty cache rather
        // than as a request that was never sent.
        const verdict = this.cacheVerdict;
        if (!verdict.ok) {
          appState.lidarLoaded = [];
          appState.lidarStatus = verdict.configured
            ? `Found ${tiles.length} tiles. ${verdict.reason}`
            : `Found ${tiles.length} tiles. Drop the files here to use them.`;
          return;
        }

        appState.lidarStatus = `Found ${tiles.length} tiles. Checking the cache…`;
        const { loaded } = await loadFromCache({ tiles, base: appState.lidarCacheUrl });
        appState.lidarLoaded = loaded;
        appState.lidarStatus = describeCoverage(tiles, loaded).text;
      } catch (err) {
        appState.lidarStatus = `Catalogue lookup failed: ${err.message}`;
      } finally {
        appState.lidarBusy = false;
      }
    },

    onPick(event) {
      this.addFiles([...event.target.files]);
      event.target.value = '';
    },

    onDrop(event) {
      this.dragging = false;
      this.addFiles([...event.dataTransfer.files]);
    },

    /**
     * Take dropped files, keeping only those this sheet is actually waiting for.
     *
     * Matching by name rather than by reading each file: a 50cm tile is twenty
     * megabytes, and decoding one only to find it belongs to another sheet
     * would be a slow way to learn nothing.
     */
    async addFiles(files) {
      const wanted = appState.lidarTiles;
      if (!wanted.length) {
        appState.lidarStatus = 'Find the tiles for this sheet first, so dropped files can be placed.';
        return;
      }

      const added = [];
      const ignored = [];
      for (const file of files) {
        const tile = matchFileToTile(file.name, wanted);
        if (!tile) { ignored.push(file.name); continue; }
        if (appState.lidarLoaded.some((t) => t.cacheKey === tile.cacheKey)) continue;
        added.push({ ...tile, bytes: await file.arrayBuffer() });
      }

      appState.lidarLoaded = [...appState.lidarLoaded, ...added];
      const coverage = describeCoverage(wanted, appState.lidarLoaded);
      appState.lidarStatus = ignored.length
        ? `${coverage.text}. Ignored ${ignored.length} file(s) not part of this sheet.`
        : coverage.text;
    },
  },
};
</script>

<style lang='styl'>
.lidar-panel
  // A cache the browser will refuse to call is a fault, not a hint: without
  // this it reads as ordinary guidance and the tiles look merely absent.
  .hint.warn
    color #c1121f
    opacity 1

  .drop-zone
    border 1px dashed currentColor
    opacity 0.7
    padding 10px
    margin 8px 0
    text-align center
    font-size 13px
    &.over
      opacity 1
    input[type=file]
      display block
      margin 6px auto 0
      font-size 11px

  .tile-list
    list-style none
    margin 4px 0
    padding 0
    max-height 160px
    overflow-y auto
    font-size 12px
    li
      display flex
      gap 8px
      align-items center
      padding 2px 0
    .state
      min-width 52px
      font-size 11px
      text-transform uppercase
      letter-spacing 0.04em
    .state.ready
      opacity 0.6
    .state.needed
      font-weight 600
    .name
      font-family monospace
    a
      margin-left auto
</style>
