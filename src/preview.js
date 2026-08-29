/**
 * Draws a plot-ready LayerSet onto a canvas.
 *
 * The preview is a picture of the sheet, not of the map: the whole page is shown
 * with its margins, so what appears is what a plotter would draw. Pen widths are
 * in millimetres and are scaled with everything else, so a 0.25mm pen looks like a
 * 0.25mm pen rather than a hairline.
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} page   - from createPage
 * @param {Array}  layers - polylines in millimetres
 * @param {object} [options]
 * @param {string} [options.background] - paper colour
 * @param {boolean} [options.showMargins]
 * @param {object} [options.target] - where the drawable area sits, in CSS pixels
 *   ({x, y, width, height}). Given this, the sheet is placed so its drawable area
 *   covers exactly that rectangle, which is how the preview lines up with the
 *   region of the map it was rendered from. Without it the sheet is centred.
 */
export function drawPreview(canvas, page, layers, options = {}) {
  const { background = '#ffffff', showMargins = true, target = null } = options;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const cssWidth = canvas.clientWidth || canvas.width;
  const cssHeight = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let scale;
  let offsetX;
  let offsetY;

  if (target) {
    // Place the drawable area over the given rectangle; the paper margins then
    // fall outside it, which is what the margins are.
    scale = (target.width * dpr) / page.drawable.width;
    offsetX = target.x * dpr - page.drawable.x * scale;
    offsetY = target.y * dpr - page.drawable.y * scale;
  } else {
    // Fit the sheet into the canvas with a small surround.
    const padding = 12 * dpr;
    scale = Math.min(
      (canvas.width - padding * 2) / page.widthMm,
      (canvas.height - padding * 2) / page.heightMm
    );
    offsetX = (canvas.width - page.widthMm * scale) / 2;
    offsetY = (canvas.height - page.heightMm * scale) / 2;
  }

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // The sheet.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, page.widthMm, page.heightMm);

  if (showMargins) {
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.3;
    ctx.setLineDash([2, 2]);
    const { x, y, width, height } = page.drawable;
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const layer of layers) {
    ctx.strokeStyle = layer.penColor || '#000000';
    // Keep a very fine pen visible on a small preview without lying about it.
    ctx.lineWidth = Math.max(layer.penWidth || 0.3, 0.6 / scale);

    ctx.beginPath();
    for (const line of layer.polylines) {
      if (line.length < 4) continue;
      ctx.moveTo(line[0], line[1]);
      for (let i = 2; i < line.length; i += 2) ctx.lineTo(line[i], line[i + 1]);
    }
    ctx.stroke();
  }

  ctx.restore();
}

/** Human-readable plot cost, for the metrics panel. */
export function formatMetrics(metrics) {
  if (!metrics) return null;
  const { after, penUpChangePercent, pointChangePercent, secondsSaved } = metrics;

  const minutes = after.seconds / 60;
  const time =
    minutes < 1
      ? `${Math.round(after.seconds)}s`
      : minutes < 60
        ? `${minutes.toFixed(1)} min`
        : `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;

  return {
    time,
    penDown: `${(after.penDownMm / 1000).toFixed(1)} m`,
    penUp: `${(after.penUpMm / 1000).toFixed(1)} m`,
    lifts: after.penLifts.toLocaleString(),
    paths: after.paths.toLocaleString(),
    points: after.points.toLocaleString(),
    saved:
      secondsSaved > 1
        ? `saved ${(secondsSaved / 60).toFixed(1)} min, ${Math.abs(penUpChangePercent).toFixed(0)}% less travel`
        : null,
    simplified:
      pointChangePercent < -1 ? `${Math.abs(pointChangePercent).toFixed(0)}% fewer points` : null,
  };
}
