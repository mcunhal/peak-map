/**
 * Application configuration.
 *
 * The upstream project shipped a hardcoded personal Mapbox token here. That token
 * belonged to anvaka and has been removed. This fork runs key-free by default:
 * MapLibre for the map, an open raster basemap, and AWS Terrarium for elevation.
 */
import { DEFAULT_DEM_SOURCE } from './dem/sources';

export { DEFAULT_DEM_SOURCE };

/**
 * Basemap is only used to pick a region, so a plain raster style keeps us free of
 * API keys. OpenTopoMap suits the subject matter; OSM standard is the fallback.
 */
export const BASEMAPS = {
  opentopomap: {
    name: 'OpenTopoMap',
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
    maxzoom: 17,
    attribution:
      'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  osm: {
    name: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

export const DEFAULT_BASEMAP = 'opentopomap';

/** Build a MapLibre style document for a raster basemap. */
export function buildRasterStyle(basemapId = DEFAULT_BASEMAP) {
  const basemap = BASEMAPS[basemapId] || BASEMAPS[DEFAULT_BASEMAP];
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: basemap.tiles,
        tileSize: 256,
        maxzoom: basemap.maxzoom,
        attribution: basemap.attribution,
      },
    },
    layers: [
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}
