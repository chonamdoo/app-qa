import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guestRuntimeSourceHash } from '../src/drivers/vm/runtime.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, '.tools');
const output = join(tools, 'guest-runtime');
const receipt = 'qautra/guest-runtime-build/v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command}: build deadline exceeded`)); }, 300_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolveRun();
    else reject(new Error(`${command}: ${signal ?? `exit ${code}`}`));
  });
});

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('GuestRuntime requires an Apple Silicon Mac; no host-browser replacement is built.');
await mkdir(tools, { recursive: true, mode: 0o700 });
const toolsStat = await lstat(tools);
if (!toolsStat.isDirectory() || toolsStat.isSymbolicLink() || toolsStat.uid !== process.getuid()) throw new Error('Unsafe build directory');
try {
  const stat = await lstat(output);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Unsafe previous guest build');
  const previous = JSON.parse(await readFile(join(output, '.qautra-build.json'), 'utf8'));
  if (previous.schema !== receipt || previous.root !== root) throw new Error('Refusing unowned previous guest build');
} catch (error) { if (error.code !== 'ENOENT' || error.path !== output) throw error; }

const stage = await mkdtemp(join(tools, '.guest-runtime-'));
try {
  const directory = join(stage, 'GuestRuntime');
  const app = join(directory, 'QAutraGuestAgent.app');
  const contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS/QAutraGuestAgent');
  const helper = join(directory, 'QAutraGuestHost');
  await mkdir(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  await mkdir(join(contents, 'Resources'), { mode: 0o700 });
  const sourceHash = guestRuntimeSourceHash(root);
  const flags = ['-swift-version', '6', '-strict-concurrency=complete', '-target', 'arm64-apple-macos15.0', '-parse-as-library', '-O'];
  for (const [folder, target, frameworks] of [
    ['native', helper, ['AppKit', 'Virtualization', 'CryptoKit']],
    ['guest', executable, ['Foundation', 'Network', 'Security', 'CryptoKit', 'ScreenCaptureKit', 'AVFoundation', 'CoreMedia', 'CoreGraphics', 'CoreVideo']],
  ]) {
    const source = join(root, 'src/drivers/vm', folder);
    const files = (await readdir(source)).filter(name => name.endsWith('.swift')).sort().map(name => join(source, name));
    await run('/usr/bin/xcrun', ['swiftc', ...flags, ...files, ...frameworks.flatMap(name => ['-framework', name]), '-o', target]);
  }
  const guest = join(root, 'src/drivers/vm/guest');
  await cp(join(guest, 'Info.plist'), join(contents, 'Info.plist'));
  await cp(join(guest, 'com.qautra.guest-agent.plist'), join(contents, 'Resources/com.qautra.guest-agent.plist'));
  for (const file of ['setup-guest.sh', 'GuestSetup.txt']) await cp(join(guest, file), join(directory, file));
  await chmod(join(directory, 'setup-guest.sh'), 0o700);
  await cp(join(root, 'src/drivers/vm/native/LICENSE.e2evm'), join(directory, 'LICENSE.e2evm'));
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', join(root, 'src/drivers/vm/native/QAutraGuestHost.entitlements'), helper]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  await run('/usr/bin/codesign', ['--verify', '--strict', helper]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (guestRuntimeSourceHash(root) !== sourceHash) throw new Error('Guest source changed during build; refusing mixed identity');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 'qautra/guest-runtime/v1', platform: 'darwin', arch: 'arm64', sourceSha256: sourceHash, helperSha256: hash(await readFile(helper)), agentSha256: hash(await readFile(executable)) }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(stage, '.qautra-build.json'), JSON.stringify({ schema: receipt, root }) + '\n', { mode: 0o600 });
  const old = `${output}.old-${randomUUID()}`;
  let displaced = false;
  try { await rename(output, old); displaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, output); } catch (error) { if (displaced) await rename(old, output); throw error; }
  if (displaced) await rm(old, { recursive: true });
  console.log(join(output, 'GuestRuntime'));
} finally {
  await rm(stage, { recursive: true, force: true });
}
