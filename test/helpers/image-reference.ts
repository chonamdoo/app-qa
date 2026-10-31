// Screenshot analysis without dependencies: PNG decode (zlib inflate of IDAT + scanline unfilter), difference hash
// for the settle fallback, and colour statistics for blank-screen / RedBox detection.
import { inflateSync } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, 8 bits per channel (alpha dropped, 16-bit reduced to the high byte). */
  rgb: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes non-interlaced 8/16-bit grey, RGB, palette, grey+alpha and RGBA PNGs; null for anything else or corrupt data. */
export function decodePng(png: Uint8Array): Raster | null {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      colorType = data[9]!;
      if (data[12] !== 0) return null; // interlaced
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || channels === undefined || (depth !== 8 && depth !== 16) || (colorType === 3 && (!palette || depth !== 8))) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const rgb = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  const step = depth / 8;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[start + 1 + i]!;
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return null;
      }
      line[i] = v & 0xff;
    }
    const o = y * width * 3;
    for (let px = 0; px < width; px++) {
      const s = px * bpp;
      let r: number;
      let g: number;
      let bl: number;
      if (colorType === 3) {
        const idx = line[s]! * 3;
        r = palette![idx] ?? 0;
        g = palette![idx + 1] ?? 0;
        bl = palette![idx + 2] ?? 0;
      } else if (channels <= 2) {
        r = g = bl = line[s]!;
      } else {
        r = line[s]!;
        g = line[s + step]!;
        bl = line[s + 2 * step]!;
      }
      rgb[o + px * 3] = r;
      rgb[o + px * 3 + 1] = g;
      rgb[o + px * 3 + 2] = bl;
    }
    [prev, line] = [line, prev];
  }
  return { width, height, rgb };
}

/**
 * 64-bit difference hash (hex): the image is box-averaged to 9×8 luma cells and each bit says whether a cell is
 * brighter than its right neighbour. Robust to caret blinks and compression noise; used only when the tree is unchanged.
 */
export function dHash(r: Raster): string {
  const cols = 9;
  const rows = 8;
  const sums = new Float64Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  // Sample every 2nd pixel in each direction: plenty for a 72-cell average and 4× faster.
  for (let y = 0; y < r.height; y += 2) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / r.height));
    for (let x = 0; x < r.width; x += 2) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / r.width));
      const o = (y * r.width + x) * 3;
      sums[cy * cols + cx]! += 0.299 * r.rgb[o]! + 0.587 * r.rgb[o + 1]! + 0.114 * r.rgb[o + 2]!;
      counts[cy * cols + cx]! += 1;
    }
  }
  let bits = 0n;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = sums[y * cols + x]! / Math.max(1, counts[y * cols + x]!);
      const b = sums[y * cols + x + 1]! / Math.max(1, counts[y * cols + x + 1]!);
      bits = (bits << 1n) | (a > b ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export interface ColorStats {
  /** Share of sampled pixels in the most common colour bucket (5 bits per channel). */
  dominantShare: number;
  /** Share of sampled pixels that are saturated red (RN RedBox background). */
  redShare: number;
}

export function colorStats(r: Raster): ColorStats {
  const buckets = new Map<number, number>();
  let total = 0;
  let red = 0;
  for (let y = 0; y < r.height; y += 4) {
    for (let x = 0; x < r.width; x += 4) {
      const o = (y * r.width + x) * 3;
      const R = r.rgb[o]!;
      const G = r.rgb[o + 1]!;
      const B = r.rgb[o + 2]!;
      const key = ((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      if (R >= 150 && G <= 90 && B <= 90) red++;
      total++;
    }
  }
  let top = 0;
  for (const n of buckets.values()) if (n > top) top = n;
  return { dominantShare: total ? top / total : 0, redShare: total ? red / total : 0 };
}
