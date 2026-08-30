#!/usr/bin/env node
/**
 * Fill the tile cache from DGT, using your own account.
 *
 * This is the half of the LiDAR path that cannot live in the browser: it holds
 * credentials, and it talks to an endpoint that sends no CORS headers. Both are
 * fine here and impossible there.
 *
 *   node scripts/fetchLidar.mjs --list
 *   node scripts/fetchLidar.mjs --region "Serra da Estrela" --dry-run
 *   node scripts/fetchLidar.mjs --region "Sintra"
 *   node scripts/fetchLidar.mjs --bbox -9.5,38.75,-9.32,38.85 --resolution 2m
 *
 * Credentials come from .env (DGT_USERNAME, DGT_PASSWORD), which is gitignored.
 * Data is CC-BY-4.0; anything served from the cache must keep the attribution.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { login, resolvePresigned } from './dgtAuth.mjs';
import { searchTiles, ATTRIBUTION } from '../src/dem/ptLidarCatalog.js';
import { SEED_REGIONS, estimateAll, estimateRegion, collectionFor, formatBytes, monthlyCostUSD } from './lidarRegions.mjs';

function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
    // 0.2s between downloads and a session check every ten files, matching what
  // the QGIS plugin does. The licence permits mirroring; hammering a public
  // service while doing it is still rude, and would trip rate limits besides.
  const args = { out: '.cache/lidar', resolution: '2m', kind: 'terrain', delay: 0.2 };
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--all') args.all = true;
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--bbox') args.bbox = argv[++i].split(',').map(Number);
    else if (a === '--resolution') args.resolution = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--delay') args.delay = Number(argv[++i]);
  }
  return args;
}

function printBudget() {
  const { rows, totalTiles, totalBytes } = estimateAll();
  console.log('\n  Seed regions\n');
  for (const r of rows) {
    console.log(`    ${r.name.padEnd(18)} ${r.resolution.padStart(5)}  ${String(r.tiles).padStart(5)} tiles  ${formatBytes(r.bytes).padStart(9)}`);
  }
  console.log(`    ${'-'.repeat(52)}`);
  console.log(`    ${'TOTAL'.padEnd(18)} ${''.padStart(5)}  ${String(totalTiles).padStart(5)} tiles  ${formatBytes(totalBytes).padStart(9)}`);
  console.log(`\n  R2 free tier is 10 GB; beyond it $${monthlyCostUSD(totalBytes).toFixed(2)}/month. Egress is free.\n`);
}

/** Regions the run covers, from --region, --all, or an explicit --bbox. */
function targets(args) {
  if (args.bbox) {
    if (args.bbox.length !== 4 || args.bbox.some((n) => !Number.isFinite(n))) {
      throw new Error('--bbox needs four numbers: west,south,east,north');
    }
    return [{ name: 'custom', resolution: args.resolution, bbox: args.bbox }];
  }
  if (args.all) {
    return args.resolution
      ? SEED_REGIONS.map((r) => ({ ...r, resolution: args.resolution }))
      : SEED_REGIONS;
  }
  if (args.region) {
    const found = SEED_REGIONS.find((r) => r.name.toLowerCase() === args.region.toLowerCase());
    if (!found) throw new Error(`Unknown region "${args.region}". Try --list.`);
    return [args.resolution ? { ...found, resolution: args.resolution } : found];
  }
  throw new Error('Pick what to fetch: --region <name>, --all, or --bbox w,s,e,n. --list shows the options.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return printBudget();

  loadEnv();
  const regions = targets(args);

  // Say the size before doing anything: these are square kilometres, and a
  // careless --all at 50cm would be a very long afternoon.
  let planned = 0;
  for (const region of regions) {
    const e = estimateRegion(region);
    planned += e.bytes;
    console.log(`  ${region.name}: ~${e.tiles} tiles, ~${formatBytes(e.bytes)} at ${region.resolution}`);
  }
  console.log(`  Total ~${formatBytes(planned)}\n`);
  if (args.dryRun) return console.log('  --dry-run, stopping here.\n');

  const jar = await login({
    username: process.env.DGT_USERNAME,
    password: process.env.DGT_PASSWORD,
  });
  console.log('  Signed in.\n');

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'ATTRIBUTION.txt'),
    `${ATTRIBUTION.text}\n${ATTRIBUTION.licenseUrl}\nSource: ${ATTRIBUTION.source}\n`);

  let fetched = 0, skipped = 0, missing = 0, bytes = 0;

  for (const region of regions) {
    const collection = collectionFor(region, args.kind);
    const tiles = await searchTiles({
      bbox: region.bbox, collection, fetchImpl: fetch, limit: args.limit || 5000,
    });
    console.log(`  ${region.name} (${collection}): catalogue lists ${tiles.length} tiles`);
    let done = 0;

    for (const tile of tiles) {
      const dest = join(args.out, `${tile.cacheKey}.tif`);
      if (existsSync(dest) && statSync(dest).size > 0) { skipped += 1; continue; }
      if (!tile.downloadUrl) { missing += 1; continue; }

      try {
        // Re-checking the session periodically: it expires, and finding out at
        // tile 1400 of 1920 would waste the whole run.
        if (done % 10 === 0 && done > 0) {
          await resolvePresigned(tiles[0].downloadUrl, jar);
        }
        const signed = await resolvePresigned(tile.downloadUrl, jar);
        const res = await fetch(signed);
        if (!res.ok) throw new Error(`object store said ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(dest, buf);
        fetched += 1; bytes += buf.length;
        process.stdout.write(`\r    ${fetched} fetched, ${skipped} already had, ${formatBytes(bytes)}   `);
      } catch (err) {
        missing += 1;
        console.warn(`\n    ${tile.cacheKey}: ${err.message}`);
      }
    }
    process.stdout.write('\n');
  }

  console.log(`\n  Done. ${fetched} fetched (${formatBytes(bytes)}), ${skipped} already present, ${missing} unavailable.`);
  console.log(`  Upload with: wrangler r2 object put <bucket>/<key> --file <path>\n`);
}

main().catch((err) => { console.error(`\n  ${err.message}\n`); process.exitCode = 1; });
