import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { GuestRecoveryInventory } from '../../src/core/guest-recovery.ts';
import { guestAttemptRecovery } from '../../src/drivers/vm/attempt-recovery.ts';
import { NativeGuestClient } from '../../src/drivers/vm/runtime.ts';
import { guestRecoveryFixture } from './fixtures/guest-recovery.ts';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('original frozen guest attempt recovery', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-original-guest-'))); roots.push(root);
    const runDir = join(root, 'run'); mkdirSync(runDir, { mode: 0o700 });
    const attemptId = randomUUID(), machineId = randomUUID(), contextId = randomUUID(), recorderId = randomUUID();
    const deviceId = `guest:${contextId}`, ownerId = `attempt:${attemptId}`;
    const f = guestRecoveryFixture({
      context: { root, runDir, runId: 'original-run', attemptId, revisionId: 'original-revision', testId: 'original-test', ownerId, fixtureSeedId: 'original-fixture', grantId: 'original-grant', grantSha256: 'e'.repeat(64), subjectSha256: 'f'.repeat(64), target: { platform: 'desktop-safari', deviceId } },
      execution: { ownerId, generation: 'original-global-generation', resources: [`target:${deviceId}`, `guest:${machineId}`] },
      identity: { machineId, contextId, recorderId, generation: 4, epoch: 872, guestPid: 241, attemptId, runId: 'original-run' },
      evidenceFile: join(runDir, 'original.mov'),
    });
    const spool = join(f.binding.machinesRoot, machineId, 'status/recordings', contextId, recorderId);
    function stop(nativeGeneration = f.binding.native.nativeGeneration) {
      return f.seal('stop', { schema: 'qautra/guest-native-stop/v1', recorderId, bindingSha256: f.source.bindingSha256, nativeGeneration, observedAt: '2026-11-03T00:00:01.000Z', observation: 'vz-delegate-stop' });
    }
    function inventory(mode: 'valid' | 'partial' | 'invalid' = 'valid') {
      mkdirSync(spool, { recursive: true, mode: 0o700 });
      const status = { identity: f.binding.identity, state: mode === 'partial' ? 'failed' : 'finalized', readyAt: '2026-11-03T00:00:00.100Z', firstFrameAt: '2026-11-03T00:00:00.000Z', heartbeatAt: 872, frames: 3, width: 800, height: 600, code: mode === 'partial' ? 'guest_recording_owner_revoked' : null, capture: 'stopped', encoder: 'finalized' };
      const bytes = Buffer.from('synthetic recorder bytes; not a real video or runtime PASS');
      const final = mode === 'partial'
        ? { identity: f.binding.identity, state: 'incomplete', capture: 'stopped', encoder: 'finalized', media: 'partial', readyAt: status.readyAt, startedAt: status.firstFrameAt, frames: 3, width: 800, height: 600, code: 'guest_recording_owner_revoked' }
        : { identity: f.binding.identity, state: 'finalized', readyAt: status.readyAt, startedAt: status.firstFrameAt, endedAt: '2026-11-03T00:00:01.000Z', sha256: digest(bytes), bytes: bytes.length, durationSeconds: 1, frames: 3, width: 800, height: 600, media: mode, code: mode === 'invalid' ? 'guest_video_decode_failed' : null };
      const files = { 'status.json': Buffer.from(JSON.stringify(status)), 'final.json': Buffer.from(JSON.stringify(final)), 'video.mov': bytes };
      const artifacts: GuestRecoveryInventory['artifacts'] = [];
      for (const [name, data] of Object.entries(files)) {
        writeFileSync(join(spool, name), data, { mode: 0o600 });
        const info = lstatSync(join(spool, name));
        artifacts.push({ name: name as 'status.json' | 'final.json' | 'video.mov', location: 'spool', identity: `${info.dev}:${info.ino}`, bytes: data.length, sha256: digest(data) });
      }
      const value: GuestRecoveryInventory = { schema: 'qautra/guest-recorder-inventory/v1', recorderId, nativeGeneration: f.binding.native.nativeGeneration, bindingSha256: f.source.bindingSha256, sealedAt: '2026-11-03T00:00:01.100Z', capture: 'closed', encoder: 'finalized', media: mode, video: mode === 'valid' ? 'ready' : 'incomplete', artifacts, status, final, problems: [] };
      const sha256 = f.seal('inventory', value);
      return { value, sha256, bytes };
    }
    return { ...f, root, runDir, spool, stop, inventory };
  }

  it('reads the exact original resource scope and never substitutes a current owner', () => {
    const f = fixture();
    const binding = guestAttemptRecovery.read(join(f.root, '.qa/instances'), f.source, f.binding.execution);
    assert.deepEqual(binding, f.binding);
    assert.deepEqual(guestAttemptRecovery.scope(binding.native), f.binding.execution);
    for (const scope of [{ ...f.binding.execution, ownerId: 'attempt:another' }, { ...f.binding.execution, generation: 'replacement' }]) {
      assert.throws(() => guestAttemptRecovery.read(join(f.root, '.qa/instances'), f.source, scope), { code: 'guest_recovery_scope_changed' });
    }
  });

  it('does not retrofit original authority onto an unsigned older generation', () => {
    const f = fixture();
    unlinkSync(join(f.directory, 'key'));
    const before = readFileSync(join(f.directory, 'binding.json'));
    assert.throws(() => guestAttemptRecovery.read(join(f.root, '.qa/instances'), f.source, f.binding.execution), { code: 'guest_recovery_binding_unverified' });
    assert.deepEqual(readFileSync(join(f.directory, 'binding.json')), before);
    assert.equal(existsSync(join(f.directory, 'key')), false);
  });

  it('keeps missing original VZ and recorder terminal evidence blocked without starting a helper', async () => {
    const f = fixture();
    const before = readdirSync(f.binding.machinesRoot);
    const observed = await guestAttemptRecovery.observe(f.binding.native);
    assert.equal(observed.nativeStop, null);
    assert.equal(observed.evidence, 'unobserved');
    assert.deepEqual(observed.problems, ['guest_original_terminal_unobserved', 'guest_original_inventory_unobserved']);
    assert.deepEqual(readdirSync(f.binding.machinesRoot), before);
    assert.equal(existsSync(join(f.binding.machinesRoot, 'runtime/control.sock')), false);
    const client = new NativeGuestClient(f.root, f.binding.machinesRoot);
    await assert.rejects(client.request('recovery.observe', f.binding.identity.machineId, {}, 100, false), { code: 'guest_owner_absent' });
  });

  for (const changed of ['machine', 'context', 'epoch', 'worker', 'resource', 'binding'] as const) {
    it(`rejects ${changed} mutation while retaining original source bytes`, () => {
      const f = fixture();
      const original = readFileSync(join(f.directory, 'binding.json'));
      const value = structuredClone(f.binding);
      if (changed === 'machine') value.identity.machineId = randomUUID();
      if (changed === 'context') value.identity.contextId = randomUUID();
      if (changed === 'epoch') value.identity.epoch += 1;
      if (changed === 'worker') value.workerId += '-replacement';
      if (changed === 'resource') value.execution.resources = ['target:someone-else'];
      if (changed === 'binding') value.context.revisionId = 'replacement-revision';
      f.seal('binding', value);
      assert.throws(() => guestAttemptRecovery.read(join(f.root, '.qa/instances'), f.source, f.binding.execution), { code: 'guest_recovery_binding_changed' });
      assert.notDeepEqual(readFileSync(join(f.directory, 'binding.json')), original);
    });
  }

  it('rejects a different native machine or per-start generation locator', async () => {
    const f = fixture();
    await assert.rejects(guestAttemptRecovery.observe({ ...f.binding.native, machineId: randomUUID() }), { code: 'guest_recovery_binding_mismatch' });
    await assert.rejects(guestAttemptRecovery.observe({ ...f.binding.native, nativeGeneration: randomUUID() }), { code: 'guest_recovery_binding_mismatch' });
  });

  it('does not treat an inventory alone as historical VZ delegate proof', async () => {
    const f = fixture(); f.inventory();
    await assert.rejects(guestAttemptRecovery.observe(f.binding.native), { code: 'guest_recovery_stop_missing' });
  });

  it('keeps a confirmed original stop distinct from missing evidence', async () => {
    const f = fixture(); const stopHash = f.stop();
    const observed = await guestAttemptRecovery.observe(f.binding.native);
    assert.equal(observed.nativeStopSha256, stopHash);
    assert.equal(observed.evidence, 'unobserved');
    assert.equal(observed.video, 'unavailable');
  });

  it('retains partial media as incomplete even with closed capture and a sealed inventory', async () => {
    const f = fixture(); f.stop(); const stored = f.inventory('partial');
    const observed = await guestAttemptRecovery.observe(f.binding.native);
    assert.ok(observed.nativeStop);
    assert.equal(observed.inventory?.capture, 'closed');
    assert.equal(observed.inventory?.encoder, 'finalized');
    assert.equal(observed.evidence, 'finalized');
    assert.equal(observed.evidenceSha256, stored.sha256);
    assert.equal(observed.inventory?.media, 'partial');
    assert.equal(observed.video, 'incomplete');
    assert.deepEqual(readFileSync(join(f.spool, 'video.mov')), stored.bytes);
  });

  it('does not promote invalid preserved media to a complete video', async () => {
    const f = fixture(); f.stop(); f.inventory('invalid');
    const observed = await guestAttemptRecovery.observe(f.binding.native);
    assert.equal(observed.evidence, 'finalized');
    assert.equal(observed.inventory?.media, 'invalid');
    assert.equal(observed.video, 'incomplete');
  });

  it('rejects a terminal witness from another original native generation', async () => {
    const f = fixture(); f.stop(randomUUID());
    await assert.rejects(guestAttemptRecovery.observe(f.binding.native), { code: 'guest_recovery_terminal_mismatch' });
  });

  it('rejects changed media and never deletes the original spool', async () => {
    const f = fixture(); f.stop(); f.inventory();
    writeFileSync(join(f.spool, 'video.mov'), 'changed', { mode: 0o600 });
    await assert.rejects(guestAttemptRecovery.observe(f.binding.native), { code: 'guest_recovery_artifact_unsafe' });
    assert.equal(readFileSync(join(f.spool, 'video.mov'), 'utf8'), 'changed');
  });

  it('refuses symlink media without following or deleting the other file', async () => {
    const f = fixture(); f.stop(); const stored = f.inventory();
    const victim = join(f.runDir, 'other-original.mov'); writeFileSync(victim, stored.bytes, { mode: 0o600 });
    unlinkSync(join(f.spool, 'video.mov')); symlinkSync(victim, join(f.spool, 'video.mov'));
    await assert.rejects(guestAttemptRecovery.observe(f.binding.native));
    assert.deepEqual(readFileSync(victim), stored.bytes);
  });
});
