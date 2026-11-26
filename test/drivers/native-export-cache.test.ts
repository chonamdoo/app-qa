import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { writeJsonAtomic } from '../../src/core/fsx.ts';
import { NativeDownloadCleanupReceipt, evidenceDigest, evidenceJSONDigest } from '../../src/core/product-evidence.ts';
import { NativeDownloadRegistry } from '../../src/server/native-downloads.ts';

const project = fileURLToPath(new URL('../../', import.meta.url));
const Output = z.strictObject({ state: z.enum(['closed', 'blocked']), retireCalls: z.number().int().nonnegative() });

describe('compiled Native export terminal custody boundary', {
  skip: process.platform === 'darwin' ? false : 'NativeExportCache.swift imports Darwin and CryptoKit; this fixture requires macOS and xcrun.',
}, () => {
  let binaryRoot: string | undefined;
  let executable: string;
  before(() => {
    binaryRoot = mkdtempSync(join(tmpdir(), 'qautra-native-export-binary-'));
    executable = join(binaryRoot, 'native-export-cache');
    const compiled = spawnSync('/usr/bin/xcrun', [
      'swiftc', '-parse-as-library', '-swift-version', '6', '-strict-concurrency=complete', '-O',
      join(project, 'mac/Sources/QAutra/Engine/NativeExportCache.swift'),
      fileURLToPath(new URL('./fixtures/NativeExportCacheFixture.swift', import.meta.url)), '-o', executable,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.ifError(compiled.error); assert.equal(compiled.signal, null, compiled.stderr); assert.equal(compiled.status, 0, compiled.stderr);
  });
  after(() => { if (binaryRoot) rmSync(binaryRoot, { recursive: true, force: true }); });

  function original(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-native-export-custody-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const registry = new NativeDownloadRegistry(root, Date.now), principal = 'native-cache-fixture';
    const bytes = Buffer.from('owned partial Native export bytes');
    const lease = registry.reserve({ exportID: randomUUID(), consentID: randomUUID(), principal, projectDigest: '1'.repeat(64), scopeDigest: '2'.repeat(64), policyDigest: '3'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), runIDs: ['original-run'], revocableRunIDs: ['original-run'], digests: [evidenceDigest(bytes)], bytes: bytes.length, sha256: evidenceDigest(bytes) });
    writeFileSync(lease.path, bytes, { flag: 'r+' });
    const receipt = NativeDownloadCleanupReceipt.parse({ schema: 'qautra/native-export-cleanup/v1', id: lease.id, secret: lease.secret, identity: lease.identity, payloadRemoved: true, localStaging: 'none', closedAt: new Date().toISOString() });
    const input = join(root, 'input.json'); writeJsonAtomic(input, { root: registry.root, lease });
    function recover() {
      const result = spawnSync(executable, [input], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.ifError(result.error); assert.equal(result.signal, null, result.stderr); assert.equal(result.status, 0, result.stderr);
      return Output.parse(JSON.parse(result.stdout));
    }
    return { root, registry, principal, lease, bytes, receipt, recover };
  }

  it('removes only the original pending inode and produces a server-accepted real cleanup receipt', t => {
    const f = original(t);
    assert.deepEqual(f.recover(), { state: 'closed', retireCalls: 1 });
    assert.equal(existsSync(f.lease.path), false);
    const receipt = NativeDownloadCleanupReceipt.parse(JSON.parse(readFileSync(join(f.lease.directory, 'cleanup.json'), 'utf8')));
    assert.deepEqual(receipt.identity, f.lease.identity); assert.equal(receipt.payloadRemoved, true);
    assert.deepEqual(f.registry.acknowledge(f.lease.id, f.lease.secret, f.principal), { closed: true });
    assert.deepEqual(new NativeDownloadRegistry(f.root, Date.now).pending(f.principal).records, []);
  });

  for (const marker of ['cleanup.json', 'closed.json']) {
    it(`keeps contradictory ${marker} and the same registered inode quarantined without retirement`, t => {
      const f = original(t), file = join(f.lease.directory, marker);
      writeJsonAtomic(file, marker === 'cleanup.json' ? f.receipt : { schema: 'qautra/native-export-closed/v1', id: f.lease.id, receiptDigest: evidenceJSONDigest(f.receipt) });
      const metadata = readFileSync(file), before = statSync(f.lease.path);
      assert.deepEqual(f.recover(), { state: 'blocked', retireCalls: 0 });
      const after = statSync(f.lease.path);
      assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]); assert.deepEqual(readFileSync(f.lease.path), f.bytes);
      assert.deepEqual(readFileSync(file), metadata); assert.equal(existsSync(join(f.lease.directory, 'retired.json')), false);
      assert.equal(f.registry.pending(f.principal).records[0]!.id, f.lease.id);
    });
  }

  it('never accepts missing payload without an original cleanup receipt as completed cleanup', t => {
    const f = original(t); unlinkSync(f.lease.path);
    assert.deepEqual(f.recover(), { state: 'blocked', retireCalls: 1 });
    assert.equal(existsSync(join(f.lease.directory, 'cleanup.json')), false);
    assert.throws(() => f.registry.acknowledge(f.lease.id, f.lease.secret, f.principal));
    const pending = f.registry.pending(f.principal).records;
    assert.equal(pending[0]!.id, f.lease.id); assert.equal(pending[0]!.retired, true);
    assert.equal(existsSync(join(f.lease.directory, 'closed.json')), false);
  });
});
