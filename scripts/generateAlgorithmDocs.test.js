/**
 * Generates the SVG illustrations used by docs/algorithms/*.md.
 *
 * Not a real test: it is a probe, in the shape scripts/emitWeight.test.js and
 * scripts/probeHatchDrape.test.js already use, so it shares vitest's module
 * resolution (extensionless imports into src/) instead of needing its own
 * loader. Gated behind GENERATE so `npm test` never runs it.
 *
 * Run with:
 *   GENERATE=1 npx vitest run scripts/generateAlgorithmDocs.test.js
 */
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHeightField, cutBelow } from '../src/core/heightField';
import { renderTerrain } from '../src/core/algorithms/index';
import { renderRidgelineScene } from '../src/core/scene';
import { simplifyPolyline } from '../src/core/optimize';

const enabled = !!process.env.GENERATE;
const OUT = 'docs/algorithms/assets';

// A synthetic two-peak terrain, not real elevation data. The near peak (lower
// on the field, drawn first by ridgeline's nearest-first walk) is taller and
// overlaps the far peak in x, so occlusion has something to hide. The ripple
// on top gives every algorithm fine texture to react to: without it the
// ground is so smooth that smoothSteps, minLength and the hachure gap have
// nothing visible to trim.
const FIELD_W = 220;
const FIELD_H = 150;

function buildField(
  near = { cx: 0.45 * FIELD_W, cy: 0.68 * FIELD_H, sigma: 0.16 * FIELD_W, amp: 340 },
  far = { cx: 0.62 * FIELD_W, cy: 0.28 * FIELD_H, sigma: 0.2 * FIELD_W, amp: 250 }
) {
  const data = new Float32Array(FIELD_W * FIELD_H);

  const gaussian = (x, y, p) => {
    const d2 = (x - p.cx) ** 2 + (y - p.cy) ** 2;
    return p.amp * Math.exp(-d2 / (2 * p.sigma * p.sigma));
  };

  for (let y = 0; y < FIELD_H; ++y) {
    for (let x = 0; x < FIELD_W; ++x) {
      // Kept small on purpose: a stronger ripple reverses the gradient in the
      // near-flat corners far from both peaks, which marching squares reads
      // as tiny closed islands and streamlines read as a criss-crossed mess.
      // This amplitude stays under a typical contour interval, so it adds
      // texture without inventing terrain features that were not asked for.
      const ripple = 3 * Math.sin(x * 0.5) * Math.cos(y * 0.45) + 1.6 * Math.sin((x + y) * 0.24);
      data[y * FIELD_W + x] = gaussian(x, y, near) + gaussian(x, y, far) + ripple;
    }
  }

  return createHeightField({ width: FIELD_W, height: FIELD_H, data });
}

// --- SVG composition -------------------------------------------------------

const PANEL_W = 260;
const PANEL_H = Math.round((PANEL_W * FIELD_H) / FIELD_W);
const GAP = 18;
const LABEL_H = 24;
const MIN_STROKE = 0.35;
const MAX_STROKE = 1.5;

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** groups: Array<{weight?, polylines}> in field coordinates, as renderTerrain returns. */
// Streamline integration records a vertex every fraction of a sample, which
// is far finer than this panel's pixel grid can show. Simplifying before
// drawing is what keeps a dense sweep (separation down at 2-3 samples) from
// producing a multi-megabyte SVG for no visible gain — 0.35 samples is a
// third of a panel pixel, so nothing actually changes shape.
const SIMPLIFY_TOLERANCE = 0.6;

function renderPanel(groups) {
  const sx = PANEL_W / FIELD_W;
  const sy = PANEL_H / FIELD_H;
  const parts = [
    `<rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" fill="#fdfdfa" stroke="#c9c5ba" stroke-width="1"/>`,
  ];

  for (const group of groups) {
    const weight = group.weight ?? 1;
    const strokeWidth = (MIN_STROKE + (MAX_STROKE - MIN_STROKE) * weight).toFixed(2);
    for (const raw of group.polylines) {
      if (!raw || raw.length < 4) continue;
      const line = raw.length > 6 ? simplifyPolyline(raw, SIMPLIFY_TOLERANCE) : raw;
      let d = `M${(line[0] * sx).toFixed(1)} ${(line[1] * sy).toFixed(1)}`;
      for (let i = 2; i < line.length; i += 2) {
        d += ` L${(line[i] * sx).toFixed(1)} ${(line[i + 1] * sy).toFixed(1)}`;
      }
      parts.push(
        `<path d="${d}" fill="none" stroke="#20201c" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }
  return parts.join('');
}

/** panels: Array<{label, groups}> */
function composeStrip(panels) {
  const totalW = panels.length * PANEL_W + (panels.length - 1) * GAP;
  const totalH = PANEL_H + LABEL_H;
  const body = panels
    .map((p, i) => {
      const x = i * (PANEL_W + GAP);
      return (
        `<g transform="translate(${x},0)">${renderPanel(p.groups)}</g>` +
        `<text x="${x + PANEL_W / 2}" y="${PANEL_H + 17}" font-family="Menlo, Consolas, 'DejaVu Sans Mono', monospace" ` +
        `font-size="13" text-anchor="middle" fill="#3a382f">${escapeXml(p.label)}</text>`
      );
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">\n` +
    `<rect width="100%" height="100%" fill="#ffffff"/>\n${body}\n</svg>\n`
  );
}

function write(name, panels) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}.svg`, composeStrip(panels));
}

it.skipIf(!enabled)(
  'renders the parameter-sweep illustrations used in docs/algorithms',
  () => {
    const field = buildField();
    const run = (id, overrides) => renderTerrain(field, id, overrides);
    const panel = (label, groups) => ({ label, groups });

    // --- Ridge lines ---------------------------------------------------
    write('ridgeline-rowCount', [15, 30, 60, 120].map((v) =>
      panel(`rowCount = ${v}${v === 60 ? ' (default)' : ''}`, run('ridgeline', { rowCount: v }))
    ));
    write('ridgeline-heightScale', [20, 60, 120, 220].map((v) =>
      panel(`heightScale = ${v}${v === 60 ? ' (default)' : ''}`, run('ridgeline', { heightScale: v }))
    ));
    write('ridgeline-smoothSteps', [0, 2, 5, 10].map((v) =>
      panel(`smoothSteps = ${v}${v === 2 ? ' (default)' : ''}`, run('ridgeline', { smoothSteps: v, rowCount: 90 }))
    ));
    // A dedicated field for this one: a narrow, prominent foothill directly
    // in front of a taller, broader peak on the same column. Occlusion in
    // this renderer clips a farther row wherever its lifted position falls
    // below the horizon a nearer row already raised in that column — the
    // effect a single smooth hill barely triggers, and dense rows paper
    // over even when it does, since the next row over fills the gap. Sharing
    // a column with few, bold rows and an aggressive lift is what makes it
    // unambiguous: the far summit clears the foothill's shoulder and stays,
    // its lower flanks do not.
    const occlusionField = buildField(
      { cx: 0.5 * FIELD_W, cy: 0.85 * FIELD_H, sigma: 0.08 * FIELD_W, amp: 220 },
      { cx: 0.5 * FIELD_W, cy: 0.15 * FIELD_H, sigma: 0.16 * FIELD_W, amp: 340 }
    );
    write('ridgeline-occlude', [false, true].map((v) =>
      panel(
        `occlude = ${v}${v ? ' (default)' : ''}`,
        renderTerrain(occlusionField, 'ridgeline', { occlude: v, rowCount: 16, heightScale: 150 })
      )
    ));

    // --- Contour lines ---------------------------------------------------
    write('contours-count', [5, 10, 20, 35].map((v) =>
      panel(`count = ${v}${v === 25 ? ' (default)' : ''}`, run('contours', { count: v, interval: null }))
    ));
    write('contours-interval', [null, 100, 50, 20].map((v) =>
      panel(`interval = ${v === null ? 'auto' : v + ' m'}${v === null ? ' (default)' : ''}`, run('contours', { interval: v }))
    ));

    // --- Contours, one pen per level --------------------------------------
    // A lower count than the registry default keeps individual index/normal
    // contours distinguishable at this size; at 20+ overlapping rings the
    // weight difference reads as noise rather than a heavier line.
    write('contours-by-level-indexEvery', [2, 3, 5, 10].map((v) =>
      panel(`indexEvery = ${v}${v === 5 ? ' (default)' : ''}`, run('contours-by-level', { indexEvery: v, count: 12 }))
    ));

    // --- Illuminated contours (Tanaka) ------------------------------------
    // classes: 2 rather than the default 3 — a stark thick/thin split makes
    // the lit side rotating with azimuth obvious; at 3+ classes the middle
    // bucket blurs the two extremes together at this size.
    write('tanaka-azimuth', [0, 90, 180, 315].map((v) =>
      panel(`azimuth = ${v}°${v === 315 ? ' (default)' : ''}`, run('tanaka', { azimuth: v, count: 14, classes: 2 }))
    ));
    write('tanaka-classes', [1, 2, 3, 6].map((v) =>
      panel(`classes = ${v}${v === 3 ? ' (default)' : ''}`, run('tanaka', { classes: v, count: 14 }))
    ));
    write('tanaka-useHillshade', [false, true].map((v) =>
      panel(v ? 'useHillshade = true (default)' : 'useHillshade = false', run('tanaka', { useHillshade: v, count: 14 }))
    ));

    // --- Streamlines -------------------------------------------------------
    write('streamlines-separation', [3, 6, 12, 20].map((v) =>
      panel(`separation = ${v}${v === 5 ? ' (default)' : ''}`, run('streamlines', { separation: v }))
    ));
    write('streamlines-mode', ['slope', 'contour'].map((v) =>
      panel(`mode = '${v}'${v === 'slope' ? ' (default)' : ''}`, run('streamlines', { mode: v }))
    ));
    // A wider separation than the sweep above leaves more short stubs near
    // the ridge and saddle for minLength to have something to discard — at
    // the default separation almost every stroke already clears minLength=20.
    write('streamlines-minLength', [1, 4, 15, 40].map((v) =>
      panel(`minLength = ${v}${v === 4 ? ' (default)' : ''}`, run('streamlines', { minLength: v, separation: 9 }))
    ));

    // --- Streamlines along the hillside ------------------------------------
    write('streamlines-contour-separation', [4, 7, 12, 20].map((v) =>
      panel(`separation = ${v}${v === 5 ? ' (default)' : ''}`, run('streamlines-contour', { separation: v }))
    ));

    // --- Hachures ------------------------------------------------------------
    write('hachures-separation', [2, 4, 7, 12].map((v) =>
      panel(`separation = ${v}${v === 4 ? ' (default)' : ''}`, run('hachures', { separation: v }))
    ));
    write('hachures-stroke-range', [[0.8, 2], [1.5, 7], [2, 10], [4, 14]].map(([lo, hi]) =>
      panel(`minStroke=${lo} maxStroke=${hi}${lo === 1.5 && hi === 7 ? ' (default)' : ''}`, run('hachures', { minStroke: lo, maxStroke: hi, separation: 8 }))
    ));
    write('hachures-gap', [1, 2.5, 5, 9].map((v) =>
      panel(`gap = ${v}${v === 2.5 ? ' (default)' : ''}`, run('hachures', { gap: v }))
    ));

    // --- Hillshade hatching -----------------------------------------------
    write('hillshade-hatching-angle', [0, 45, 90, 135].map((v) =>
      panel(`angle = ${v}°${v === 45 ? ' (default)' : ''}`, run('hillshade-hatching', { angle: v }))
    ));
    write('hillshade-hatching-spacing', [1, 2, 4, 7].map((v) =>
      panel(`spacing = ${v}${v === 2 ? ' (default)' : ''}`, run('hillshade-hatching', { spacing: v }))
    ));
    write('hillshade-hatching-toneLevels', [1, 2, 4, 8].map((v) =>
      panel(`toneLevels = ${v}${v === 4 ? ' (default)' : ''}`, run('hillshade-hatching', { toneLevels: v }))
    ));
    write('hillshade-hatching-azimuth', [0, 90, 180, 315].map((v) =>
      panel(`azimuth = ${v}°${v === 315 ? ' (default)' : ''}`, run('hillshade-hatching', { azimuth: v }))
    ));

    // --- Shared: ocean level, illustrated once in the index ----------------
    const cut = cutBelow(field, 80);
    write('shared-ocean-level', [
      panel('oceanLevel = -∞ (default, nothing cut)', run('contours', { count: 15 })),
      panel('oceanLevel = 80', renderTerrain(cut, 'contours', { count: 15 })),
    ]);

    // --- Shared: drape, illustrated once in the index -----------------------
    // Draping is a composition-level option (composite.js / scene.js), not one
    // of any single algorithm's own defaults, so it does not belong to any one
    // sweep above. It projects a planar algorithm's flat output onto the same
    // displaced surface the ridge lines are drawn on, and cuts it where the
    // ground itself hides it — using a horizon built from every field row,
    // not only the drawn ones, so a contour is clipped by the terrain rather
    // than by whichever ridge-line strokes happen to cross above it.
    {
      const ridgeOptions = { rowCount: 40, heightScale: 85, smoothSteps: 2, occlude: true };
      const contourGroups = run('contours', { count: 14 });
      const drapes = [{ id: 'contours', polylines: contourGroups[0].polylines }];

      // Flat: the two algorithms drawn independently, exactly as `flat()` in
      // composite.js does for a combo with drape off — contours in plan view,
      // overlapping the ridge lines as ink on paper overlaps, nothing hidden.
      const flatGroups = [
        { weight: 1, polylines: run('ridgeline', ridgeOptions)[0].polylines },
        { weight: 1, polylines: contourGroups[0].polylines },
      ];

      // Draped, with the relief drawn: contours lifted onto the surface and
      // hidden-line removed against it, alongside the ridge lines that built
      // that surface.
      const drapedScene = renderRidgelineScene(field, { ...ridgeOptions, drapes, emitTerrain: true });
      const drapedGroups = [
        { weight: 1, polylines: drapedScene.terrain },
        { weight: 1, polylines: drapedScene.drapes[0].polylines },
      ];

      // Draped, relief not drawn: the ridge lines still build the surface and
      // still hide what is behind it, they just are not emitted — contours
      // alone, with true hidden-line removal.
      const drapedNoRidgeScene = renderRidgelineScene(field, { ...ridgeOptions, drapes, emitTerrain: false });
      const drapedNoRidgeGroups = [
        { weight: 1, polylines: drapedNoRidgeScene.drapes[0].polylines },
      ];

      write('shared-drape', [
        panel('flat (drape: false, default)', flatGroups),
        panel('drape: true, with ridge lines', drapedGroups),
        panel('drape: true, ridge lines not drawn', drapedNoRidgeGroups),
      ]);
    }

    console.log(`Wrote parameter-sweep SVGs to ${OUT}/`);
  },
  60000
);
