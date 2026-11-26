import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const project = fileURLToPath(new URL('../../', import.meta.url));
describe('compiled owned guest boot-share boundaries', {
  skip: process.platform === 'darwin' ? false : 'NativeStorage.swift imports Darwin and CryptoKit; this fixture requires macOS and xcrun.',
}, () => {
  let binaryRoot: string | undefined;
  let scratch: string | undefined;
  let observed: Record<string, string>;
  before(() => {
    binaryRoot = mkdtempSync(join(tmpdir(), 'qa-native-share-binary-'));
    mkdirSync(join(project, '.qa'), { recursive: true, mode: 0o700 });
    scratch = realpathSync(mkdtempSync(join(project, '.qa/native-share-test-')));
    const executable = join(binaryRoot, 'native-boot-share');
    const compiled = spawnSync('/usr/bin/xcrun', [
      'swiftc', '-parse-as-library', '-swift-version', '6', '-strict-concurrency=complete', '-O',
      join(project, 'src/drivers/vm/native/NativeProtocol.swift'),
      join(project, 'src/drivers/vm/native/NativeStorage.swift'),
      fileURLToPath(new URL('./fixtures/NativeBootShareFixture.swift', import.meta.url)), '-o', executable,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.ifError(compiled.error);
    assert.equal(compiled.signal, null, compiled.stderr);
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(executable, [scratch], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    observed = z.record(z.string(), z.string()).parse(JSON.parse(result.stdout));
  });
  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (binaryRoot) rmSync(binaryRoot, { recursive: true, force: true });
  });
  it('permits retained video larger than boot metadata through the recorder size limit', () => {
    assert.equal(observed.retained32MiB, 'accepted');
    assert.equal(observed.retained1GiB, 'accepted');
  });
  it('rejects the combined spool budget plus one byte', () => {
    assert.equal(observed.overBudget, 'unsafe_share');
  });
  it('still refuses public, symbolic, hardlinked and special-file spool entries', () => {
    for (const key of ['publicVideo', 'symlinkVideo', 'hardlinkedVideo', 'fifoVideo']) assert.equal(observed[key], 'unsafe_share', key);
  });
});
