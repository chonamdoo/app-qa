// Bounded public-fixture comparison through the actual production cache/native boundary.
import assert from 'node:assert/strict';
import { benchmarkImageSmall } from './benchmark-image-small.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { original, workloads, digest } from '../test/helpers/image-data.mjs';
import * as integrated from '../src/runner/image.ts';

const output = new URL('../.tools/native-image/evidence/', import.meta.url);
const cache = new WeakMap();
function originalPngHash(png) {
  if (!png) return null;
  if (cache.has(png)) return cache.get(png);
  const raster = original.decodePng(png);
  const h = raster ? original.dHash(raster) : null;
  cache.set(png, h);
  return h;
}
const apis = { original: { ...original, pngHash: originalPngHash }, integrated };
const operations = ['pngHashCold', 'pngHashCached', 'decodeColorStats', 'decodeHashStats'];
function operation(api, op, input, png = input.png) {
  if (op.startsWith('pngHash')) return api.pngHash(png);
  const r = api.decodePng(png);
  if (op === 'decodeColorStats') return api.colorStats(r);
  return { hash: api.dHash(r), stats: api.colorStats(r) };
}
function score(v, op) {
  if (op.startsWith('pngHash')) return v.charCodeAt(0);
  if (op === 'decodeColorStats') return v.dominantShare + v.redShare;
  return v.hash.charCodeAt(0) + v.stats.dominantShare + v.stats.redShare;
}
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)];

if (!isMainThread) {
  const inputs = workerData.inputs;
  parentPort.on('message', (m) => {
    try {
      const { impl, op, inputIndex, n, gate, warmup } = m;
      const input = inputs[inputIndex], api = apis[impl];
      if (warmup) for (let i = 0; i < 5; i++) operation(api, op, input);
      const expected = operation(apis.original, op, input);
      assert.deepStrictEqual(operation(api, op, input), expected);
      // Fresh identities with the same immutable backing: a real WeakMap miss each cold call.
      const views = op === 'pngHashCold' ? Array.from({ length: n }, () => new Uint8Array(input.png.buffer, input.png.byteOffset, input.png.byteLength)) : null;
      global.gc?.();
      parentPort.postMessage({ kind: 'armed' });
      Atomics.wait(new Int32Array(gate), 0, 0);
      let last, checksum = 0;
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i++) { last = operation(api, op, input, views ? views[i] : input.png); checksum += score(last, op); }
      const end = process.hrtime.bigint();
      assert.deepStrictEqual(last, expected);
      assert.ok(Math.abs(checksum - n * score(expected, op)) <= Math.max(1e-9, Math.abs(checksum) * 1e-10));
      parentPort.postMessage({ kind: 'result', start: String(start), end: String(end), elapsedMs: Number(end - start) / 1e6, n, checksum, shared: input.png.buffer instanceof SharedArrayBuffer });
    } catch (e) { parentPort.postMessage({ kind: 'error', error: e.stack }); }
  });
  parentPort.postMessage({ kind: 'ready' });
} else {
  assert.equal(integrated.imageBackendInfo().name, 'native', 'Build the optional module and select APP_QA_IMAGE_BACKEND=native before benchmarking');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const inputs = workloads().filter(x => x.name.startsWith('fixtures/'));
  const counts = {};
  for (let i = 0; i < inputs.length; i++) for (const op of operations) {
    for (let warm = 0; warm < 3; warm++) operation(apis.original, op, inputs[i]);
    if (op === 'pngHashCached') { counts[i + op] = 500000; continue; }
    const start = performance.now();
    const png = inputs[i].png;
    for (let j = 0; j < 2; j++) operation(apis.original, op, inputs[i], new Uint8Array(png.buffer, png.byteOffset, png.byteLength));
    counts[i + op] = Math.max(2, Math.min(10000, Math.ceil(100 / ((performance.now() - start) / 2))));
  }
  const files = ['src/runner/image.ts', 'src/runner/image-native.ts', 'src/runner/engine.ts', 'native/image/src/lib.rs', 'native/image/Cargo.toml', 'native/image/Cargo.lock', 'native/image/build.rs'];
  const metadata = {
    baseline: '86d5685651ede2bec57000c9b36e32d4ac5ea217',
    checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(files.map(f => [f, digest(readFileSync(new URL('../' + f, import.meta.url)))])),
    versions: process.versions, platform: process.platform, arch: process.arch,
    cpuQuota: process.platform === 'linux' ? readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() : null,
    rounds: 7, percentileDefinition: 'nearest rank of per-worker batch elapsed / n; not individual request latency',
    inputs: inputs.map(x => ({ name: x.name, width: x.r.width, height: x.r.height, pngBytes: x.png.length, pngSha256: digest(x.png) })), at: new Date().toISOString(),
  };
  writeFileSync(new URL('integration-environment.json', output), JSON.stringify(metadata, null, 2));
  const raw = []; let seed = 41247;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const mode of ['one', 'independent', 'shared']) {
    const workerCount = mode === 'one' ? 1 : 4;
    const views = mode === 'shared' ? inputs.map(x => { const png = new Uint8Array(new SharedArrayBuffer(x.png.length)); png.set(x.png); return { name: x.name, png }; }) : inputs.map(x => ({ name: x.name, png: x.png }));
    const workers = Array.from({ length: workerCount }, () => new Worker(new URL(import.meta.url), { workerData: { inputs: views } }));
    const queues = workers.map(w => {
      const queued = [], waiting = [];
      w.on('message', m => { if (waiting.length) waiting.shift()(m); else queued.push(m); });
      w.on('error', e => { throw e; });
      return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
    });
    await Promise.all(queues.map(next => next()));
    for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) for (const op of operations) {
      const n = counts[inputIndex + op];
      for (let round = 0; round < 7; round++) for (const impl of random() < 0.5 ? ['original', 'integrated'] : ['integrated', 'original']) {
        const gate = new SharedArrayBuffer(4);
        for (const worker of workers) worker.postMessage({ impl, op, inputIndex, n, gate, warmup: round === 0 });
        const armed = await Promise.all(queues.map(next => next()));
        assert.ok(armed.every(x => x.kind === 'armed'), JSON.stringify(armed));
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, workerCount);
        const results = await Promise.all(queues.map(next => next()));
        assert.ok(results.every(x => x.kind === 'result'), JSON.stringify(results));
        if (mode === 'shared') assert.ok(results.every(x => x.shared));
        const start = results.reduce((v, r) => BigInt(r.start) < v ? BigInt(r.start) : v, BigInt(results[0].start));
        const end = results.reduce((v, r) => BigInt(r.end) > v ? BigInt(r.end) : v, BigInt(results[0].end));
        raw.push({ mode, input: inputs[inputIndex].name, op, impl, round, n, workerCount, spanMs: Number(end - start) / 1e6, throughput: n * workerCount / (Number(end - start) / 1e9), results });
      }
      writeFileSync(new URL('integration-raw.json', output), JSON.stringify(raw));
      console.log(JSON.stringify({ mode, input: inputs[inputIndex].name, op, n, batches: raw.length }));
    }
    await Promise.all(workers.map(w => w.terminate()));
  }
  const summary = [];
  for (const mode of ['one', 'independent', 'shared']) for (const input of inputs) for (const op of operations) for (const impl of ['original', 'integrated']) {
    const rows = raw.filter(x => x.mode === mode && x.input === input.name && x.op === op && x.impl === impl);
    const samples = rows.flatMap(r => r.results.map(v => v.elapsedMs / v.n)), rates = rows.map(r => r.throughput);
    summary.push({ mode, input: input.name, op, impl, workers: rows[0].workerCount, samples: samples.length, nPerWorker: rows[0].n, p50Ms: quantile(samples, .5), p95Ms: quantile(samples, .95), throughput: rows.reduce((v, r) => v + r.n * r.workerCount, 0) / (rows.reduce((v, r) => v + r.spanMs, 0) / 1000), throughputMin: Math.min(...rates), throughputMax: Math.max(...rates) });
  }
  writeFileSync(new URL('integration-summary.json', output), JSON.stringify(summary, null, 2));
  const fields = Object.keys(summary[0]);
  writeFileSync(new URL('integration-summary.csv', output), fields.join(',') + '\n' + summary.map(r => fields.map(f => r[f]).join(',')).join('\n') + '\n');
  benchmarkImageSmall(output);
  console.log('INTEGRATION_BENCHMARK_COMPLETE');
}
