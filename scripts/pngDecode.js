/**
 * A minimal PNG decoder for Node, so the pipeline can be driven against real
 * elevation tiles outside a browser.
 *
 * The browser and worker path uses createImageBitmap and OffscreenCanvas, neither
 * of which Node has. Rather than take a dependency for what is only needed by
 * scripts and by the real-data tests, this decodes exactly the subset that terrain
 * tile servers actually serve: 8-bit non-interlaced RGB or RGBA. Anything else is
 * refused loudly rather than decoded wrongly.
 */
import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{width: number, height: number, data: Uint8ClampedArray}} RGBA
 */
export function decodePng(bytes) {
  const buffer = Buffer.from(bytes);

  for (let i = 0; i < SIGNATURE.length; ++i) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('Not a PNG file');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }

    offset = start + length + 4; // skip the CRC
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`Unsupported PNG colour type ${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));

  const lineBytes = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  // Un-filtered scanlines, needed as the reference for the next line's filter.
  const current = new Uint8Array(lineBytes);
  const previous = new Uint8Array(lineBytes);

  let pos = 0;
  for (let y = 0; y < height; ++y) {
    const filter = raw[pos++];

    for (let i = 0; i < lineBytes; ++i) {
      const value = raw[pos + i];
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;

      let x;
      switch (filter) {
        case 0: x = value; break;
        case 1: x = value + a; break;
        case 2: x = value + b; break;
        case 3: x = value + ((a + b) >> 1); break;
        case 4: x = value + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}`);
      }
      current[i] = x & 0xff;
    }
    pos += lineBytes;

    for (let x = 0; x < width; ++x) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = current[src];
      out[dst + 1] = current[src + 1];
      out[dst + 2] = current[src + 2];
      out[dst + 3] = channels === 4 ? current[src + 3] : 255;
    }

    previous.set(current);
  }

  return { width, height, data: out };
}

/** A tile loader for Node, matching the signature buildHeightField expects. */
export function createNodeTileLoader({ fetchImpl = fetch } = {}) {
  return async function loadTile(url, { signal } = {}) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      throw new Error(`Tile request failed with ${response.status}: ${url}`);
    }
    return decodePng(Buffer.from(await response.arrayBuffer()));
  };
}
