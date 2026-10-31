// Optional, explicitly built kernels. Missing capability falls back; present-but-broken artifacts fail visibly.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColorStats, Raster } from './image.ts';

export interface NativeImage {
  apiVersion(): number;
  decodeRgb(width: number, height: number, depth: number, color: number, raw: Uint8Array, palette: Uint8Array): Uint8Array | null;
  dHash(width: number, height: number, rgb: Uint8Array): string;
  colorStats(width: number, height: number, rgb: Uint8Array): ColorStats;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const SOURCE_FILES = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src/lib.rs'];

export function nativeImageSourceHash(): string {
  const hash = createHash('sha256');
  for (const name of SOURCE_FILES) hash.update(`${name}\0`).update(readFileSync(join(ROOT, 'native/image', name))).update('\0');
  return hash.digest('hex');
}

export function loadImageNative(options: { mode?: string; artifactDir?: string; load?: (path: string) => unknown } = {}): { native: NativeImage | null; reason: string } {
  const mode = options.mode ?? process.env.APP_QA_IMAGE_BACKEND ?? 'auto';
  if (!['auto', 'js', 'native'].includes(mode)) throw new Error('APP_QA_IMAGE_BACKEND must be auto, js or native');
  if (mode === 'js') return { native: null, reason: 'explicit-js' };
  const dir = options.artifactDir ?? join(ROOT, '.tools/native-image', `${process.platform}-${process.arch}`);
  const binary = join(dir, 'image.node');
  const manifest = join(dir, 'manifest.json');
  if (!existsSync(binary) && !existsSync(manifest)) {
    if (mode === 'native') throw new Error('Native image module is not built. Run npm run build:image-native, or select APP_QA_IMAGE_BACKEND=js.');
    return { native: null, reason: 'not-built' };
  }
  // Do not swallow malformed/stale metadata, load errors or later kernel exceptions.
  const meta = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  if (meta.apiVersion !== 1 || meta.platform !== process.platform || meta.arch !== process.arch || meta.sourceHash !== nativeImageSourceHash()) {
    throw new Error('Native image module is incompatible or stale. Rebuild with npm run build:image-native, or explicitly select APP_QA_IMAGE_BACKEND=js.');
  }
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
  if (actual !== meta.binaryHash) throw new Error('Native image module checksum mismatch. Rebuild with npm run build:image-native.');
  const native = (options.load ?? require)(binary) as NativeImage;
  if (native?.apiVersion?.() !== 1 || typeof native.decodeRgb !== 'function' || typeof native.dHash !== 'function' || typeof native.colorStats !== 'function') {
    throw new Error('Native image module API mismatch. Rebuild with npm run build:image-native.');
  }
  return { native, reason: 'built' };
}

/** Guard the internal u32 / borrowed RGB boundary; unusual Raster values retain the original JS semantics. */
export function nativeRaster(r: Raster): boolean {
  return r !== null && typeof r === 'object'
    && Number.isInteger(r.width) && Number.isInteger(r.height)
    && r.width >= 0 && r.height >= 0 && r.width <= 0xffffffff && r.height <= 0xffffffff
    && r.rgb instanceof Uint8Array && Number.isSafeInteger(r.width * r.height * 3)
    && r.rgb.byteLength >= r.width * r.height * 3;
}

// Lowest measured screenshot workload: 320x240 with ceil(w/4)*ceil(h/4)=4800 samples.
// This conservative measured-work floor is not a claimed optimal crossover.
export const NATIVE_COLOR_MIN_SAMPLES = 4800;
export function nativeColorRaster(r: Raster): boolean {
  if (!nativeRaster(r)) return false;
  const samples = Math.ceil(r.width / 4) * Math.ceil(r.height / 4);
  return samples >= NATIVE_COLOR_MIN_SAMPLES && samples <= 0xffffffff;
}

/** Never lend Rust a slice whose bytes another JS worker can mutate. Snapshot shared backing in JS first. */
export function nativeBytes(bytes: Uint8Array): Uint8Array {
  return bytes.buffer instanceof SharedArrayBuffer ? Uint8Array.from(bytes) : bytes;
}
