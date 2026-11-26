import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { RecordingBinding } from '../../src/core/recording.ts';
import type { WebTarget } from '../../src/core/types.ts';
import { GuestDesktopDriver } from '../../src/drivers/vm/driver.ts';
import { startGuestRecording } from '../../src/drivers/vm/recording.ts';
import { GUEST_RECORDING_CHUNK_BYTES, GuestRecordingCommand, type GuestRecordingIdentity } from '../../src/core/guest-recording-protocol.ts';
import { GuestRecoveryRegistrationSchema } from '../../src/core/guest-recovery.ts';
import { guestRecoveryFixture } from './fixtures/guest-recovery.ts';

const TARGET: WebTarget = { kind: 'web', platform: 'desktop-safari', appId: 'safari', url: 'https://example.test/', origins: ['https://example.test'], viewport: { width: 800, height: 600 } };

describe('guest recording evidence recovery boundary', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function fixture(mode: 'valid' | 'corrupt' | 'no-frame' | 'lost-stop' | 'lost-release' | 'changed-generation' | 'decode-failed' | 'other-device' = 'valid') {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qa-guest-video-')));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const contextId = randomUUID();
    const machineId = randomUUID();
    const guestPid = 241;
    const epoch = 872;
    const generation = 4;
    const owner = { instanceId: contextId, machineId, workerId: `guest:${machineId}:${guestPid}:${epoch}`, generation };
    const capability = `/${randomBytes(32).toString('hex')}`;
    const source = Buffer.alloc(GUEST_RECORDING_CHUNK_BYTES * 2 + 17, 0x6d);
    const digest = createHash('sha256').update(source).digest('hex');
    const readyAt = '2026-11-01T06:00:00.100Z';
    const calls: string[] = [];
    const unknown: string[] = [];
    let registered = false;
    let registrationCount = 0;
    let identity: GuestRecordingIdentity | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        assert.ok(request.url === `${capability}/qautra/recording` || request.url === `${capability}/qautra/recovery`);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url === `${capability}/qautra/recovery`) {
          assert.equal(calls.length, 0);
          registrationCount += 1;
          const registration = guestRecoveryFixture(GuestRecoveryRegistrationSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          response.end(JSON.stringify({ source: registration.source, binding: registration.binding }));
          return;
        }
        assert.equal(registered, true);
        const command = GuestRecordingCommand.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        calls.push(command.action);
        if (command.action === 'start') identity = command.identity;
        assert.ok(identity);
        assert.deepEqual(command.identity, identity);
        let result: unknown;
        switch (command.action) {
          case 'start':
          case 'status':
            result = { identity: mode === 'other-device' ? { ...identity, machineId: randomUUID() } : identity, state: 'recording', readyAt, firstFrameAt: '2026-11-01T06:00:00.000Z', capture: 'active', encoder: 'active', heartbeatAt: Date.now(), frames: mode === 'no-frame' ? 0 : 1, width: 800, height: 600, code: null };
            break;
          case 'stop':
            if (mode === 'lost-stop') { request.socket.destroy(); return; }
            result = {
              identity: mode === 'changed-generation' ? { ...identity, generation: identity.generation + 1 } : identity,
              state: 'finalized', readyAt, startedAt: '2026-11-01T06:00:00.000Z', endedAt: '2026-11-01T06:00:01.000Z',
              durationSeconds: 1, sha256: digest, bytes: source.length, frames: 3, width: 800, height: 600,
              media: mode === 'decode-failed' ? 'invalid' : 'valid', code: mode === 'decode-failed' ? 'guest_video_decode_failed' : null,
            };
            break;
          case 'read': {
            const data = Buffer.from(source.subarray(command.offset, command.offset + command.length));
            if (mode === 'corrupt' && command.offset > 0) data[0] = data[0]! ^ 1;
            result = { identity, offset: command.offset, data: data.toString('base64') };
            break;
          }
          case 'release':
            if (mode === 'lost-release') { request.socket.destroy(); return; }
            assert.equal(command.sha256, digest);
            result = { identity, released: true };
            break;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ version: 1, id: randomUUID(), ok: true, effect: 'completed', result }));
      })().catch(error => { response.destroy(error instanceof Error ? error : new Error('fixture_failure')); });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    cleanups.push(async () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close(error => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
      await promise;
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const driver = new GuestDesktopDriver('desktop-safari', `guest:${contextId}`, {
      prepare: async () => `http://127.0.0.1:${address.port}${capability}`,
      execution: () => owner,
      unknown: code => { unknown.push(code); },
    });
    await driver.prepareTarget(TARGET);
    const binding: RecordingBinding = { attemptId: randomUUID(), runId: 'run-evidence-recovery', platform: driver.platform, deviceId: driver.deviceId, generation };
    const runDir = join(directory, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    driver.setGuestAttemptRecovery({
      root: directory, runDir, runId: binding.runId, attemptId: binding.attemptId, revisionId: 'revision-original', testId: 'test-original',
      ownerId: `attempt:${binding.attemptId}`, fixtureSeedId: 'fixture-original', grantId: 'grant-original', grantSha256: 'a'.repeat(64), subjectSha256: 'b'.repeat(64),
      target: { platform: 'desktop-safari', deviceId: driver.deviceId },
    }, { ownerId: `attempt:${binding.attemptId}`, generation: 'global-original', resources: [`target:${driver.deviceId}`] }, () => { registered = true; });
    const input = { binding, file: join(runDir, 'attempt.mov'), signal: new AbortController().signal };
    return { driver, input, calls, unknown, source, digest, directory, owner, registrationCount: () => registrationCount };
  }

  it('syncs recovered bytes and releases the guest spool only after complete integrity checks', async () => {
    const f = await fixture();
    const recording = await startGuestRecording(f.driver, f.input);
    assert.equal(f.registrationCount(), 1);
    recording.assertHealthy();
    const first = recording.stop();
    assert.equal(recording.stop(), first);
    const segment = await first;
    assert.deepEqual(readFileSync(segment.file), f.source);
    assert.equal(segment.sha256, f.digest);
    assert.equal(segment.bytes, f.source.length);
    assert.equal(lstatSync(segment.file).mode & 0o777, 0o600);
    assert.equal(f.calls.filter(action => action === 'stop').length, 1);
    assert.equal(f.calls.filter(action => action === 'read').length, 3);
    assert.equal(f.calls.at(-1), 'release');
    assert.throws(() => recording.assertHealthy(), /not_active/);
  });

  it('does not dispatch a recorder without its original frozen attempt authority', async () => {
    const f = await fixture();
    const driver = new GuestDesktopDriver('desktop-safari', f.driver.deviceId, {
      prepare: async () => f.driver.ownedRecordingEndpoint().serverUrl,
      execution: () => f.owner,
    });
    await driver.prepareTarget(TARGET);
    await assert.rejects(startGuestRecording(driver, f.input), /original frozen attempt/);
    assert.equal(f.registrationCount(), 0);
    assert.deepEqual(f.calls, []);
  });

  it('does not replace the frozen callback or adopt a changed original guest generation', async () => {
    const f = await fixture();
    const recording = await startGuestRecording(f.driver, f.input);
    const original = f.driver.guestAttemptBinding;
    assert.ok(original);
    assert.throws(() => f.driver.setGuestAttemptRecovery(original.context, original.execution, () => {}), /cannot be replaced/);
    f.owner.generation += 1;
    assert.throws(() => f.driver.ownedRecordingEndpoint(), /generation/);
    await assert.rejects(recording.stop());
    assert.deepEqual(f.calls, ['start']);
    assert.equal(f.unknown.includes('guest_generation_changed'), true);
  });

  it('preserves corrupt recovered bytes as incomplete and never releases or retries the guest spool', async () => {
    const f = await fixture('corrupt');
    const recording = await startGuestRecording(f.driver, f.input);
    const stopping = recording.stop();
    await assert.rejects(stopping, { code: 'guest_recording_recovery_unknown', effect: 'unknown' });
    assert.equal(recording.stop(), stopping);
    assert.equal(f.calls.filter(action => action === 'stop').length, 1);
    assert.equal(f.calls.includes('release'), false);
    assert.ok(existsSync(f.input.file));
    assert.notDeepEqual(readFileSync(f.input.file), f.source);
    assert.equal((await recording.lost).message.includes('unknown'), true);
    const status = await recording.status();
    assert.equal(status.capture, 'stopped');
    assert.equal(status.encoder, 'finalized');
    assert.equal(status.spool, 'unknown');
  });

  it('does not accept a readiness acknowledgement with no valid video frame', async () => {
    const f = await fixture('no-frame');
    await assert.rejects(startGuestRecording(f.driver, f.input), { code: 'guest_recording_first_frame_unknown', effect: 'unknown' });
    assert.deepEqual(f.calls, ['start']);
    assert.equal(existsSync(f.input.file), false);
  });

  it('never follows an evidence destination symlink or deletes the guest copy on failed recovery', async () => {
    const f = await fixture();
    const victim = join(f.directory, 'existing-evidence');
    writeFileSync(victim, 'preserve', { mode: 0o600 });
    symlinkSync(victim, f.input.file);
    const recording = await startGuestRecording(f.driver, f.input);
    await assert.rejects(recording.stop(), { code: 'guest_recording_recovery_unknown', effect: 'unknown' });
    assert.equal(readFileSync(victim, 'utf8'), 'preserve');
    assert.equal(lstatSync(f.input.file).isSymbolicLink(), true);
    assert.equal(f.calls.includes('read'), false);
    assert.equal(f.calls.includes('release'), false);
  });

  it('keeps a lost stop acknowledgement unknown without sending stop again', async () => {
    const f = await fixture('lost-stop');
    const recording = await startGuestRecording(f.driver, f.input);
    const stopping = recording.stop();
    await assert.rejects(stopping, { code: 'guest_recording_ack_unknown', effect: 'unknown' });
    assert.equal(recording.stop(), stopping);
    assert.deepEqual(f.calls, ['start', 'stop']);
    assert.equal(f.unknown.includes('guest_recording_ack_unknown'), true);
  });

  it('rejects another generation before retrieving or releasing any finalized file', async () => {
    const f = await fixture('changed-generation');
    const recording = await startGuestRecording(f.driver, f.input);
    await assert.rejects(recording.stop(), { code: 'guest_recording_finalization_unknown', effect: 'unknown' });
    assert.deepEqual(f.calls, ['start', 'stop']);
    assert.equal(existsSync(f.input.file), false);
  });

  it('keeps decode failure separate from confirmed capture, encoder and spool cleanup', async () => {
    const f = await fixture('decode-failed');
    const recording = await startGuestRecording(f.driver, f.input);
    await assert.rejects(recording.stop(), { code: 'guest_video_decode_failed', effect: 'not_started' });
    const status = await recording.status();
    assert.equal(status.capture, 'stopped');
    assert.equal(status.encoder, 'finalized');
    assert.equal(status.spool, 'released');
    assert.equal(status.media, 'invalid');
    assert.deepEqual(readFileSync(f.input.file), f.source);
    assert.equal(f.calls.at(-1), 'release');
    assert.deepEqual(f.unknown, []);
  });

  it('refuses first frames attributed to another guest device', async () => {
    const f = await fixture('other-device');
    await assert.rejects(startGuestRecording(f.driver, f.input), { code: 'guest_recording_first_frame_unknown' });
    assert.equal(existsSync(f.input.file), false);
    assert.deepEqual(f.calls, ['start']);
  });

  it('distinguishes a lost spool release ACK from already stopped capture and durable local evidence', async () => {
    const f = await fixture('lost-release');
    const recording = await startGuestRecording(f.driver, f.input);
    const stopped = recording.stop();
    await assert.rejects(stopped, { code: 'guest_recording_ack_unknown', effect: 'unknown' });
    assert.equal(recording.stop(), stopped);
    const status = await recording.status();
    assert.equal(status.capture, 'stopped');
    assert.equal(status.encoder, 'finalized');
    assert.equal(status.file, 'durable');
    assert.equal(status.spool, 'unknown');
    assert.equal(f.calls.filter(action => action === 'stop').length, 1);
    assert.equal(f.calls.filter(action => action === 'release').length, 1);
    assert.deepEqual(readFileSync(f.input.file), f.source);
  });
});
