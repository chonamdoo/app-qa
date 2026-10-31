// New tests against a byte-identical frozen JS reference, not against the selected backend itself.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { original, fixtureNames, repo, pngCase, pngCases, invalidPngCases, raster, hexCases, invalidHex, capture, digest } from '../test/helpers/image-data.mjs';
import * as candidate from '../src/runner/image.ts';
const output = new URL('../.tools/native-image/evidence/', import.meta.url);
let checks = 0;
function equal(a, b, label) { assert.deepStrictEqual(a, b, label); checks++; }
function normalized(r) { return r && { width: r.width, height: r.height, rgb: Uint8Array.from(r.rgb) }; }

if (!isMainThread) {
  const { png, r, expected } = workerData;
  assert.ok(png.buffer instanceof SharedArrayBuffer && r.rgb.buffer instanceof SharedArrayBuffer);
  for (let i = 0; i < 30; i++) {
    equal(normalized(candidate.decodePng(png)), normalized(original.decodePng(png)), 'concurrent decode');
    equal(candidate.dHash(r), expected.hash, 'concurrent hash');
    equal(candidate.colorStats(r), expected.stats, 'concurrent stats');
  }
  parentPort.postMessage({ checks });
} else {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const records = [];
  const record = (name, value) => records.push({ name, value });
  for (const c of pngCases()) {
    equal(normalized(candidate.decodePng(c.png)), c.expected, c.name);
    record(c.name, digest(candidate.decodePng(c.png).rgb));
    const offset = Buffer.concat([Buffer.alloc(7), c.png, Buffer.alloc(9)]).subarray(7, 7 + c.png.length);
    equal(normalized(candidate.decodePng(offset)), c.expected, 'byteOffset');
  }
  for (const [name, png] of invalidPngCases()) {
    const expected = capture(() => normalized(original.decodePng(png)));
    equal(capture(() => normalized(candidate.decodePng(png))), expected, name);
    record(name, expected);
  }
  for (const name of fixtureNames()) {
    const png = readFileSync(`${repo}/${name}`), r = original.decodePng(png);
    assert.ok(r, name);
    equal(normalized(candidate.decodePng(png)), r, name);
    equal(candidate.dHash(r), original.dHash(r), name + 'hash');
    equal(candidate.colorStats(r), original.colorStats(r), name + 'stats');
    record(name, { pngSha256: digest(png), rgbSha256: digest(r.rgb), width: r.width, height: r.height, hash: candidate.dHash(r), stats: candidate.colorStats(r) });
  }
  for (const [w, h] of [[0, 0], [0, 8], [8, 0], [1, 1], [2, 2], [9, 8], [17, 15], [32, 32], [73, 65], [129, 111]]) for (let seed = 1; seed <= 12; seed++) {
    const r = raster(w, h, seed);
    equal(candidate.dHash(r), original.dHash(r), 'random hash');
    equal(candidate.colorStats(r), original.colorStats(r), 'random stats');
    record(`raster-${w}-${h}-${seed}`, { hash: candidate.dHash(r), stats: candidate.colorStats(r) });
  }
  const red = { width: 32, height: 32, rgb: Uint8Array.from({ length: 3072 }, (_, i) => i % 3 === 0 ? 150 : 90) };
  equal(candidate.colorStats(red), { dominantShare: 1, redShare: 1 }, 'inclusive red threshold');
  equal(candidate.dHash(raster(0, 0)), '0000000000000000', 'empty hash');
  equal(candidate.colorStats(raster(0, 0)), { dominantShare: 0, redShare: 0 }, 'empty stats');
  for (const pair of [...hexCases, ...invalidHex]) {
    equal(capture(() => candidate.hammingHex(...pair)), capture(() => original.hammingHex(...pair)), 'hamming');
    record('hex-' + pair.join('/'), capture(() => candidate.hammingHex(...pair)));
  }
  for (let i = 0; i < 250; i++) {
    const a = digest(raster(9, 8, i).rgb), b = digest(raster(7, 9, i + 1).rgb);
    equal(candidate.hammingHex(a, b), original.hammingHex(a, b), 'random hamming');
  }
  const serialized = JSON.stringify(records);
  equal(digest(Buffer.from(serialized)), 'a4f010397f57c8cbb06c5c78e2c9009b79b78e664ac773e2f42170bc23023679', 'frozen original oracle @86d5685');
  const png = readFileSync(`${repo}/${fixtureNames()[0]}`), r = original.decodePng(png);
  const sharedPng = new Uint8Array(new SharedArrayBuffer(png.length)), sharedRgb = new Uint8Array(new SharedArrayBuffer(r.rgb.length));
  sharedPng.set(png); sharedRgb.set(r.rgb);
  const workers = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    let received = false;
    const w = new Worker(new URL(import.meta.url), { workerData: { png: sharedPng, r: { ...r, rgb: sharedRgb }, expected: { hash: original.dHash(r), stats: original.colorStats(r) } } });
    w.on('message', value => { received = true; resolve(value); });
    w.on('error', reject);
    w.on('exit', code => { if (!received) reject(new Error(`Image equivalence worker exited ${code} without a result`)); });
  })));
  checks += workers.reduce((n, w) => n + w.checks, 0);
  const p = pngCase(17, 15, 6, 16, [0, 1, 2, 3, 4], 91).png;
  for (let end = 33; end < p.length; end += 7) equal(capture(() => candidate.decodePng(p.subarray(0, end))), capture(() => original.decodePng(p.subarray(0, end))), `truncation ${end}`);
  for (let seed = 0; seed < 150; seed++) {
    const input = Buffer.from(p), index = 41 + (Math.imul(seed + 1, 7919) >>> 0) % (p.length - 41);
    input[index] ^= (seed % 255) + 1;
    equal(capture(() => candidate.decodePng(input)), capture(() => original.decodePng(input)), `corruption ${seed}`);
  }
  const result = { mode: candidate.imageBackendInfo().name + '-integrated-differential', passed: true, checks, fixtureCount: fixtureNames().length, pngSyntheticCases: pngCases().length, invalidPngCases: invalidPngCases().length, sharedWorkers: 4, at: new Date().toISOString() };
  writeFileSync(new URL('equivalence-result.json', output), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
