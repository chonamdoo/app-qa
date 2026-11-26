import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('compiled native cold owner recovery', {
  skip: process.platform === 'darwin' && process.arch === 'arm64' ? false : 'Native macOS guest ownership requires Apple Silicon and Virtualization.framework.',
}, () => {
  let scratch: string | undefined;
  let executable: string;
  before(() => {
    scratch = realpathSync(mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.qa-native-recovery-')));
    executable = join(scratch, 'native-recovery');
    const source = fileURLToPath(new URL('../../src/drivers/vm/native/', import.meta.url));
    const files = readdirSync(source).filter(file => file.endsWith('.swift') && file !== 'QAutraGuestHostMain.swift').sort().map(file => join(source, file));
    const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '6', '-strict-concurrency=complete', '-O', ...files,
      fileURLToPath(new URL('./fixtures/NativeRecoveryFixture.swift', import.meta.url)),
      '-framework', 'AppKit', '-framework', 'Virtualization', '-framework', 'CryptoKit', '-o', executable],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  after(() => { if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true }); });
  function run(scenario: string): unknown {
    const result = spawnSync(executable, [scenario, join(scratch!, scenario, '.qa/instances/machines')], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }
  const retained = { sameMachine: true, diskIdentityPreserved: true, diskContentPreserved: true, noDisplay: true };
  it('preserves the original disk and identity while explicitly reconciling an unlocked cold unknown owner', () => {
    assert.deepEqual(run('force'), { fault: null, state: 'stopped', phase: 'idle', ...retained });
  });
  it('does not silently reconcile through a graceful stop request', () => {
    assert.deepEqual(run('graceful'), { fault: 'invalid_transition', state: 'unknown', phase: 'unknown', ...retained });
  });
  for (const resource of ['image', 'machine', 'sidecar']) {
    it(`keeps ownership unknown when another real process holds the ${resource} lease`, () => {
      assert.deepEqual(run(`${resource}-busy`), { fault: 'resource_busy', state: 'unknown', phase: 'unknown', ...retained });
    });
  }
  it('refuses recovery after the recorded hardware identity changes', () => {
    assert.deepEqual(run('changed-artifact'), { fault: 'artifact_identity_changed', state: 'unknown', phase: 'unknown', ...retained });
  });
  it('does not promote cold lock possession into an original recorder or VZ terminal witness', () => {
    assert.deepEqual(run('historical'), { state: 'stopped', registrationFault: 'guest_original_owner_unverified', observationFault: 'guest_recovery_path_invalid', archiveCreated: false });
  });
});
