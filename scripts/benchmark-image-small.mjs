// Isolate the measured tiny-color regression without changing production kernels.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { original, raster } from '../test/helpers/image-data.mjs';
import * as integrated from '../src/runner/image.ts';
const apis = { original, integrated };
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)];
export function benchmarkImageSmall(output = new URL('../.tools/native-image/evidence/', import.meta.url)) {
  assert.equal(integrated.imageBackendInfo().name, 'native');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  let seed = 41247;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const small = [];
  for (const [w, h] of [[1, 1], [16, 16], [64, 64]]) {
    const r = raster(w, h, 47), expected = original.colorStats(r), n = 12000;
    for (const api of Object.values(apis)) for (let i = 0; i < 300; i++) api.colorStats(r);
    for (let round = 0; round < 7; round++) for (const impl of random() < .5 ? ['original', 'integrated'] : ['integrated', 'original']) {
      global.gc?.();
      const api = apis[impl]; let last, checksum = 0;
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i++) { last = api.colorStats(r); checksum += last.dominantShare; }
      const end = process.hrtime.bigint();
      assert.deepStrictEqual(last, expected); assert.ok(checksum > 0);
      small.push({ size: `${w}x${h}`, impl, round, n, nsPerCall: Number(end - start) / n });
    }
  }
  writeFileSync(new URL('integration-small-raw.json', output), JSON.stringify(small, null, 2), { mode: 0o600 });
  const smallSummary = [];
  for (const size of ['1x1', '16x16', '64x64']) for (const impl of ['original', 'integrated']) {
    const samples = small.filter(x => x.size === size && x.impl === impl).map(x => x.nsPerCall);
    smallSummary.push({ size, impl, p50ns: quantile(samples, .5), p95ns: quantile(samples, .95) });
  }
  writeFileSync(new URL('integration-small-summary.json', output), JSON.stringify(smallSummary, null, 2), { mode: 0o600 });
  return smallSummary;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) console.log(JSON.stringify(benchmarkImageSmall(), null, 2));
