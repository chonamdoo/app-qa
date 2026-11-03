import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readFileSync, writeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectFixtureError, projectFixtureSha256 } from '../core/project-fixture.ts';

export function nativeBuildManifestSha256(files: readonly { name: string; sha256: string }[]): string {
  if (files.length === 0 || files.length > 100000 || new Set(files.map(file => file.name)).size !== files.length || files.some(file => !file.name || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new ProjectFixtureError('fixture_client_unverified');
  return projectFixtureSha256([...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function nativeBundleSha256(directory: string): string {
  const files: { name: string; sha256: string }[] = [];
  let total = 0;
  function walk(relative: string): void {
    const path = join(directory, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || files.length > 100000) throw new ProjectFixtureError('fixture_client_unverified');
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) walk(relative ? `${relative}/${name}` : name); return; }
    if (!stat.isFile() || (total += stat.size) > 2 * 1024 * 1024 * 1024) throw new ProjectFixtureError('fixture_client_unverified');
    const bytes = readFileSync(path);
    const after = lstatSync(path);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new ProjectFixtureError('fixture_client_unverified');
    files.push({ name: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  walk('');
  return nativeBuildManifestSha256(files);
}

export function readNativeMailboxFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144 || (stat.mode & 0o077) !== 0) throw new ProjectFixtureError('fixture_client_unverified');
    const bytes = Buffer.alloc(stat.size);
    let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) throw new ProjectFixtureError('fixture_client_unverified'); count += size; }
    const after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new ProjectFixtureError('fixture_client_unverified');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}

export function writeNativeMailboxFile(path: string, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > 16384) throw new ProjectFixtureError('fixture_input_invalid');
  const pending = `${path}.pending`;
  const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const original = fstatSync(fd);
  try {
    let count = 0;
    while (count < bytes.length) {
      const written = writeSync(fd, bytes, count, bytes.length - count);
      if (!written) throw new ProjectFixtureError('fixture_client_unverified', 'unknown');
      count += written;
    }
    fsyncSync(fd);
    linkSync(pending, path);
  } finally {
    try {
      const named = lstatSync(pending);
      if (named.dev !== original.dev || named.ino !== original.ino || !named.isFile()) throw new ProjectFixtureError('fixture_client_unverified', 'unknown');
      unlinkSync(pending);
    } finally { closeSync(fd); }
  }
}
