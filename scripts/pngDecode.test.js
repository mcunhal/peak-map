import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from './pngDecode';

/**
 * Build a PNG so the decoder can be checked against known pixels. The filter type
 * is a parameter, because un-filtering is the part that goes wrong.
 */
function encodePng(width, height, channels, pixels, filter = 0) {
  const lineBytes = width * channels;
  const raw = Buffer.alloc((lineBytes + 1) * height);

  for (let y = 0; y < height; ++y) {
    const lineStart = y * (lineBytes + 1);
    raw[lineStart] = filter;
    for (let i = 0; i < lineBytes; ++i) {
      const value = pixels[y * lineBytes + i];
      const a = i >= channels ? pixels[y * lineBytes + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * lineBytes + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * lineBytes + i - channels] : 0;

      let encoded;
      switch (filter) {
        case 0: encoded = value; break;
        case 1: encoded = value - a; break;
        case 2: encoded = value - b; break;
        case 3: encoded = value - ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          encoded = value - pred;
          break;
        }
        default: throw new Error('bad filter');
      }
      raw[lineStart + 1 + i] = encoded & 0xff;
    }
  }

  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(0, body.length + 8); // CRC is not checked by the decoder
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decodePng', () => {
  const width = 5, height = 4;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; ++i) rgb[i] = (i * 37 + 11) % 256;

  it('decodes an unfiltered RGB image', () => {
    const image = decodePng(encodePng(width, height, 3, rgb, 0));
    expect(image.width).toBe(width);
    expect(image.height).toBe(height);
    expect(image.data[0]).toBe(rgb[0]);
    expect(image.data[1]).toBe(rgb[1]);
    expect(image.data[2]).toBe(rgb[2]);
    expect(image.data[3]).toBe(255);
  });

  it('reverses every filter type', () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const image = decodePng(encodePng(width, height, 3, rgb, filter));
      for (let p = 0; p < width * height; ++p) {
        expect(image.data[p * 4]).toBe(rgb[p * 3]);
        expect(image.data[p * 4 + 1]).toBe(rgb[p * 3 + 1]);
        expect(image.data[p * 4 + 2]).toBe(rgb[p * 3 + 2]);
      }
    }
  });

  it('keeps the alpha channel of an RGBA image', () => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; ++i) rgba[i] = (i * 13 + 5) % 256;
    const image = decodePng(encodePng(width, height, 4, rgba, 4));
    expect(image.data[3]).toBe(rgba[3]);
    expect(image.data[7]).toBe(rgba[7]);
  });

  it('round-trips a Terrarium-style elevation encoding', () => {
    // What matters is that decoded bytes reconstruct the original metres exactly.
    const metres = [0, 1, -1, 1234.5, 4392, -430];
    const pixels = new Uint8Array(metres.length * 3);
    metres.forEach((m, i) => {
      const v = Math.round((m + 32768) * 256);
      pixels[i * 3] = (v >> 16) & 0xff;
      pixels[i * 3 + 1] = (v >> 8) & 0xff;
      pixels[i * 3 + 2] = v & 0xff;
    });

    const image = decodePng(encodePng(metres.length, 1, 3, pixels, 4));
    metres.forEach((m, i) => {
      const r = image.data[i * 4], g = image.data[i * 4 + 1], b = image.data[i * 4 + 2];
      expect(r * 256 + g + b / 256 - 32768).toBeCloseTo(m, 3);
    });
  });

  it('refuses a file that is not a PNG', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/not a png/i);
  });

  it('refuses formats it would otherwise decode wrongly', () => {
    const png = encodePng(2, 2, 3, new Uint8Array(12), 0);
    png[24] = 16; // bit depth
    expect(() => decodePng(png)).toThrow(/bit depth/i);

    const paletted = encodePng(2, 2, 3, new Uint8Array(12), 0);
    paletted[25] = 3; // colour type: palette
    expect(() => decodePng(paletted)).toThrow(/colour type/i);
  });
});
