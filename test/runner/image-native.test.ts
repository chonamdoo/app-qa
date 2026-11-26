import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../../src/core/config.ts';
import { loadImageNative, nativeBytes, nativeColorRaster, nativeImageSourceHash, nativeRaster, type NativeImage } from '../../src/runner/image-native.ts';
import { colorStats, decodePng, dHash, imageBackendInfo, pngHash } from '../../src/runner/image.ts';
import * as reference from '../helpers/image-reference.ts';

const roots: string[] = [];
function dir(): string { const d = mkdtempSync(join(tmpdir(), 'qa-image-native-')); roots.push(d); return d; }
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const stub: NativeImage = { apiVersion: () => 1, decodeRgb: () => null, dHash: () => '0000000000000000', colorStats: () => ({ dominantShare: 0, redShare: 0 }) };
function artifact(meta: Record<string, unknown> = {}): string {
  const d = dir();
  const bytes = Buffer.from('test double, never executed');
  writeFileSync(join(d, 'image.node'), bytes);
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ apiVersion: 1, platform: process.platform, arch: process.arch, sourceHash: nativeImageSourceHash(), binaryHash: createHash('sha256').update(bytes).digest('hex'), ...meta }));
  return d;
}

describe('optional image capability selection', () => {
  it('keeps default installation usable when no native artifacts exist', () => {
    assert.deepEqual(loadImageNative({ mode: 'auto', artifactDir: dir() }), { native: null, reason: 'not-built' });
  });
  it('supports explicit JS selection without inspecting broken native artifacts', () => {
    assert.deepEqual(loadImageNative({ mode: 'js', artifactDir: artifact({ apiVersion: -1 }) }), { native: null, reason: 'explicit-js' });
  });
  it('fails visibly when native is explicitly required but unavailable', () => {
    assert.throws(() => loadImageNative({ mode: 'native', artifactDir: dir() }), /not built/);
  });
  it('rejects unknown selection values', () => {
    assert.throws(() => loadImageNative({ mode: 'unknown' }), /must be auto, js or native/);
  });
  for (const [field, value] of [['apiVersion', 99], ['platform', 'other'], ['arch', 'other'], ['sourceHash', 'stale']] as const) {
    it(`rejects a present artifact with incompatible ${field}`, () => {
      assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: artifact({ [field]: value }), load: () => stub }), /incompatible or stale/);
    });
  }
  it('rejects a binary checksum mismatch', () => {
    assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: artifact({ binaryHash: 'wrong' }), load: () => stub }), /checksum mismatch/);
  });
  it('does not silently hide a malformed manifest or partial installation', () => {
    const malformed = artifact(); writeFileSync(join(malformed, 'manifest.json'), '{broken');
    assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: malformed }), SyntaxError);
    const partial = dir(); writeFileSync(join(partial, 'image.node'), 'partial');
    assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: partial }), /ENOENT/);
  });
  it('checks addon API identity and preserves load failures', () => {
    assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: artifact(), load: () => ({}) }), /API mismatch/);
    const error = new Error('native loader failed');
    assert.throws(() => loadImageNative({ mode: 'auto', artifactDir: artifact(), load: () => { throw error; } }), (e) => e === error);
  });
  it('preserves native execution failures instead of selecting JS after a failure', () => {
    const error = new Error('native kernel failed');
    const selected = loadImageNative({ mode: 'auto', artifactDir: artifact(), load: () => ({ ...stub, dHash: () => { throw error; } }) });
    assert.throws(() => selected.native!.dHash(1, 1, new Uint8Array(3)), (e) => e === error);
  });
  it('can explicitly select the original implementation in a fresh process', () => {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', "import { imageBackendInfo } from './src/runner/image.ts'; console.log(JSON.stringify(imageBackendInfo()));"], { cwd: ROOT, env: { ...process.env, APP_QA_IMAGE_BACKEND: 'js' }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), { name: 'javascript', reason: 'explicit-js' });
  });
});

describe('image routing preserves the JS contract', () => {
  it('retains JS for empty, tiny and below-measured color workloads', () => {
    for (const [width, height] of ([[0, 0], [1, 1], [16, 16], [64, 64], [316, 240]] as const)) {
      const r = { width, height, rgb: new Uint8Array(width * height * 3) };
      assert.equal(nativeColorRaster(r), false);
      assert.deepEqual(colorStats(r), reference.colorStats(r));
      assert.equal(dHash(r), reference.dHash(r));
    }
  });
  it('uses the conservative measured color work floor, not a guessed crossover', () => {
    const r = { width: 320, height: 240, rgb: new Uint8Array(320 * 240 * 3) };
    assert.equal(nativeColorRaster(r), true);
    assert.deepEqual(colorStats(r), reference.colorStats(r));
  });
  it('retains JS behavior for unusual or truncated Raster values', () => {
    for (const r of [{ width: 1, height: 1, rgb: new Uint8Array(0) }, { width: -1, height: 1, rgb: new Uint8Array(0) }, { width: 0.5, height: 0.5, rgb: new Uint8Array(3) }]) {
      assert.equal(nativeRaster(r), false);
      assert.equal(dHash(r), reference.dHash(r));
      assert.deepEqual(colorStats(r), reference.colorStats(r));
    }
  });
  it('returns byte-identical decoded RGB and analysis for a real screenshot', () => {
    const png = readFileSync(join(ROOT, 'fixtures/android/easyway/launch.png'));
    const expected = reference.decodePng(png)!;
    const actual = decodePng(png)!;
    assert.deepEqual({ ...actual, rgb: Uint8Array.from(actual.rgb) }, expected);
    assert.equal(dHash(actual), reference.dHash(expected));
    assert.deepEqual(colorStats(actual), reference.colorStats(expected));
  });
  it('reports the selected capability', () => {
    assert.ok(['javascript', 'native'].includes(imageBackendInfo().name));
  });
  it('guards direct native calls against short RGB buffers', { skip: loadImageNative({ mode: 'auto' }).native === null }, () => {
    const native = loadImageNative({ mode: 'native' }).native!;
    assert.throws(() => native.dHash(1, 1, new Uint8Array()), /shorter/);
    assert.throws(() => native.colorStats(1, 1, new Uint8Array()), /shorter/);
  });
});

describe('engine screenshot hash cache', () => {
  it('retains screenshot-object identity hits and recomputes new objects', () => {
    const png = new Uint8Array(readFileSync(join(ROOT, 'fixtures/android/easyway/launch.png')));
    const expected = reference.dHash(reference.decodePng(png)!);
    assert.equal(pngHash(png), expected);
    png.fill(0); // A cached object is deliberately not decoded again, exactly as before.
    assert.equal(pngHash(png), expected);
    assert.equal(pngHash(new Uint8Array(png)), null);
    assert.equal(pngHash(null), null);
  });
  it('caches null results by object identity as well', () => {
    const valid = new Uint8Array(readFileSync(join(ROOT, 'fixtures/android/easyway/launch.png')));
    const initiallyInvalid = new Uint8Array(valid.length);
    assert.equal(pngHash(initiallyInvalid), null);
    initiallyInvalid.set(valid);
    assert.equal(pngHash(initiallyInvalid), null);
    assert.equal(pngHash(new Uint8Array(initiallyInvalid)), reference.dHash(reference.decodePng(valid)!));
  });
});

describe('shared backing at the native boundary', () => {
  it('snapshots SharedArrayBuffer in JS before Rust borrows the bytes', () => {
    const input = new Uint8Array(new SharedArrayBuffer(3));
    input.set([150, 90, 90]);
    const snapshot = nativeBytes(input);
    assert.equal(snapshot.buffer instanceof SharedArrayBuffer, false);
    assert.notEqual(snapshot, input);
    input.fill(0);
    assert.deepEqual([...snapshot], [150, 90, 90]);
  });
  it('borrows ordinary backing without a boundary copy', () => {
    const input = new Uint8Array([1, 2, 3]);
    assert.equal(nativeBytes(input), input);
  });
});
