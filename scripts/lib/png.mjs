/**
 * Minimal dependency-free PNG encoder/decoder (Node zlib). Used for icons,
 * test fixtures and the reference-profile build script.
 *
 * The decoder reports color-management chunks so callers can refuse images
 * that are not plain sRGB instead of silently misreading them.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let c = 0xffffffff;
  for (const buf of buffers) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuf, data]));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode 8-bit RGBA pixels. `extraChunks` = [{type, data}] inserted before IDAT. */
export function encodePNG(width, height, rgba, { extraChunks = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...extraChunks.map((c) => chunk(c.type, c.data)),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced PNG to 8-bit RGBA.
 * Returns { width, height, rgba, colorChunks: string[] }.
 */
export function decodePNG(buffer) {
  if (!SIGNATURE.equals(buffer.subarray(0, 8))) throw new Error('Not a PNG file');
  let offset = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  const colorChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (['sRGB', 'iCCP', 'gAMA', 'cHRM', 'eXIf'].includes(type)) colorChunks.push(type);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('Missing IHDR');
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (interlace) throw new Error('Interlaced PNG is not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  if (!(bitDepth === 8 || (bitDepth === 16 && colorType !== 3))) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`Bad PNG filter ${filter}`);
      row[x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sample = (i, ch) => pixels[i * bpp + ch * bytesPerSample]; // high byte for 16-bit
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) r = g = b = sample(i, 0);
    else if (colorType === 4) {
      r = g = b = sample(i, 0);
      a = sample(i, 1);
    } else if (colorType === 2) {
      r = sample(i, 0);
      g = sample(i, 1);
      b = sample(i, 2);
    } else if (colorType === 6) {
      r = sample(i, 0);
      g = sample(i, 1);
      b = sample(i, 2);
      a = sample(i, 3);
    } else {
      const idx = pixels[i];
      r = palette[idx * 3];
      g = palette[idx * 3 + 1];
      b = palette[idx * 3 + 2];
      a = transparency && idx < transparency.length ? transparency[idx] : 255;
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba, colorChunks };
}
