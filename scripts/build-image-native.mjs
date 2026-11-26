// Opt-in only: npm ci/setup never invokes Cargo and no prebuilt binary is downloaded.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const names = { linux: 'libapp_qa_image.so', darwin: 'libapp_qa_image.dylib', win32: 'app_qa_image.dll' };
const library = names[process.platform];
if (!library || !['x64', 'arm64'].includes(process.arch)) throw new Error(`Optional image build is not configured for ${process.platform}-${process.arch}; use the default JS backend.`);
const dir = join(root, '.tools/native-image', `${process.platform}-${process.arch}`);
const target = join(root, '.tools/native-image/target');
mkdirSync(dir, { recursive: true, mode: 0o700 });
function sourceHash() {
  const hash = createHash('sha256');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src/lib.rs']) hash.update(`${name}\0`).update(readFileSync(join(root, 'native/image', name))).update('\0');
  return hash.digest('hex');
}
const compiledSource = sourceHash();
execFileSync('cargo', ['build', '--manifest-path', join(root, 'native/image/Cargo.toml'), '--locked', '--release'], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
const binary = join(dir, 'image.node');
if (sourceHash() !== compiledSource) throw new Error('Native sources changed during the build; rerun npm run build:image-native.');
// Replace the inode atomically: an already loaded addon must never be truncated in place.
const temporaryBinary = `${binary}.tmp-${process.pid}`;
copyFileSync(join(target, 'release', library), temporaryBinary);
renameSync(temporaryBinary, binary);
const manifest = join(dir, 'manifest.json'), temporaryManifest = `${manifest}.tmp-${process.pid}`;
writeFileSync(temporaryManifest, JSON.stringify({ apiVersion: 1, platform: process.platform, arch: process.arch, sourceHash: compiledSource, binaryHash: createHash('sha256').update(readFileSync(binary)).digest('hex') }, null, 2) + '\n', { mode: 0o600 });
renameSync(temporaryManifest, manifest);
console.log(`Optional image kernels built for ${process.platform}-${process.arch}. Verify with APP_QA_IMAGE_BACKEND=native npm test.`);
