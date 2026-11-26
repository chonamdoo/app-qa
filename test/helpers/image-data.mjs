// Deterministic public-fixture and synthetic inputs, frozen against image-reference.ts @86d5685.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const original = await import('./image-reference.ts');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const fixtureNames = () => execFileSync('git', ['-C', repo, 'ls-files', 'fixtures/**/*.png'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

export function raster(width, height, seed = 1) {
  let v = seed >>> 0;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) {
    v = (Math.imul(v, 1664525) + 1013904223) >>> 0;
    rgb[i] = v >>> 24;
  }
  return { width, height, rgb };
}

export function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
export const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function pngCase(w, h, type = 2, depth = 8, filter = 0, seed = 1, options = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const step = depth / 8, bpp = channels * step, stride = w * bpp;
  const source = raster(stride, h, seed).rgb.subarray(0, stride * h);
  const expected = new Uint8Array(w * h * 3);
  const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 120, 120, 120]);
  if (type === 3) for (let i = 0; i < source.length; i++) source[i] %= 6;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = Array.isArray(filter) ? filter[y % filter.length] : filter;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const value = source[y * stride + i];
      const a = i >= bpp ? source[y * stride + i - bpp] : 0;
      const b = y ? source[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? source[(y - 1) * stride + i - bpp] : 0;
      let predict = 0;
      if (f === 1) predict = a;
      if (f === 2) predict = b;
      if (f === 3) predict = (a + b) >> 1;
      if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predict = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (value - predict) & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = y * stride + x * bpp, o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) expected[o + k] = type === 3 ? (palette[source[s] * 3 + k] ?? 0) : channels <= 2 ? source[s] : source[s + k * step];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4);
  ihdr.set([depth, type, 0, 0, options.interlace ?? 0], 8);
  const compressed = options.compressed ?? deflateSync(options.raw ?? raw), split = Math.floor(compressed.length / 2);
  const parts = [signature, chunk('IHDR', ihdr)];
  if (type === 3 && !options.noPalette) parts.push(chunk('PLTE', palette));
  parts.push(chunk('IDAT', compressed.subarray(0, split)), chunk('IDAT', compressed.subarray(split)), chunk('IEND', Buffer.alloc(0)));
  return { png: Buffer.concat(parts), expected: { width: w, height: h, rgb: expected } };
}

export function pngCases() {
  const out = [];
  for (const type of [0, 2, 3, 4, 6]) for (const depth of type === 3 ? [8] : [8, 16]) for (const filter of [0, 1, 2, 3, 4, [0, 1, 2, 3, 4]]) for (const [w, h] of [[1, 1], [13, 11]]) {
    out.push({ name: `type${type}-depth${depth}-filter${filter}-${w}x${h}`, ...pngCase(w, h, type, depth, filter, 31 + type + depth) });
  }
  return out;
}

export function invalidPngCases() {
  const valid = pngCase(3, 3).png;
  const variants = [
    ['empty', Buffer.alloc(0)], ['signature', Buffer.alloc(40)], ['truncated', valid.subarray(0, 32)],
    ['interlaced', pngCase(3, 3, 2, 8, 0, 1, { interlace: 1 }).png],
    ['palette-missing', pngCase(3, 3, 3, 8, 0, 1, { noPalette: true }).png],
    ['inflate', pngCase(3, 3, 2, 8, 0, 1, { compressed: Buffer.from('broken') }).png],
    ['raw-short', pngCase(3, 3, 2, 8, 0, 1, { raw: Buffer.alloc(2) }).png],
    ['filter', pngCase(3, 3, 2, 8, 7).png],
  ];
  for (const depth of [1, 2, 4, 12]) { const b = Buffer.from(valid); b[24] = depth; variants.push([`depth${depth}`, b]); }
  for (const type of [1, 5, 7]) { const b = Buffer.from(valid); b[25] = type; variants.push([`type${type}`, b]); }
  for (const n of [0, 1, 4, 7, 8, 12]) variants.push([`short-IHDR-${n}`, Buffer.concat([signature, chunk('IHDR', Buffer.alloc(n)), chunk('IEND', Buffer.alloc(0))])]);
  const crcIgnored = Buffer.from(valid); crcIgnored[29] ^= 255; variants.push(['crc-ignored', crcIgnored]);
  const headerIgnored = Buffer.from(valid); headerIgnored[26] = 17; headerIgnored[27] = 9; variants.push(['compression-header-ignored', headerIgnored]);
  variants.push(['trailing', Buffer.concat([valid, Buffer.from('trailing')])]);
  return variants;
}

export const hexCases = [['0', '0'], ['ff', '00'], ['ABCDEF', '123456'], ['00000f', 'F'], ['1'.repeat(257), 'f'.repeat(256)], ['ff ', '00'], ['0', 'f'.repeat(4096)]];
export const invalidHex = [['', '0'], ['zz', '0'], ['-1', '0'], ['0x1', '0'], [' 1', '0']];
export function capture(fn) {
  try { return { value: fn() }; }
  catch (e) { return { error: { name: e.name, code: e.code ?? null, message: e.message } }; }
}

export function workloads() {
  let selected = [];
  for (const name of fixtureNames()) {
    const png = readFileSync(`${repo}/${name}`), r = original.decodePng(png);
    if (r && !selected.some(a => a.r.width === r.width && a.r.height === r.height)) selected.push({ name, png, r });
  }
  selected = selected.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  const real = [selected[0], selected[Math.floor(selected.length / 2)], selected.at(-1)].filter((x, i, a) => x && a.indexOf(x) === i);
  return [...real, ...[[320, 240], [1280, 720], [1920, 1080]].map(([w, h]) => {
    const p = pngCase(w, h, 2, 8, [0, 1, 2, 3, 4], 42);
    return { name: `synthetic-${w}x${h}`, png: p.png, r: p.expected };
  })];
}
