import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { InstanceExecutionError } from '../../core/instances.ts';
import type { RecordingSegment, RecordingStatus, StartTargetRecording, TargetRecording } from '../../core/recording.ts';
import type { Driver } from '../../core/types.ts';
import { privateDirectory } from './backend-io.ts';
import { GuestDesktopDriver } from './driver.ts';
import { GUEST_RECORDING_CHUNK_BYTES, GUEST_RECORDING_LIMIT_MS, GuestRecordingCommand, GuestRecordingFinal, GuestRecordingIdentity, GuestRecordingStatus, sameRecordingIdentity } from '../../core/guest-recording-protocol.ts';

const Reply = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), id: z.uuid(), ok: z.literal(true), effect: z.literal('completed'), result: z.unknown() }),
  z.strictObject({ version: z.literal(1), id: z.uuid(), ok: z.literal(false), effect: z.enum(['not_started', 'unknown']), error: z.strictObject({ code: z.string().min(1).max(256), message: z.string().max(16384) }) }),
]);

function unknown(driver: GuestDesktopDriver, code: string): InstanceExecutionError {
  driver.recordingUnknown(code);
  return new InstanceExecutionError(code, 'Guest recording outcome is unknown; ownership and evidence are retained. Do not resend the command.', 'unknown');
}

async function command(driver: GuestDesktopDriver, endpoint: string, value: z.infer<typeof GuestRecordingCommand>, signal?: AbortSignal): Promise<unknown> {
  const timeout = value.action === 'stop' ? 245_000 : 35_000;
  let bytes: Uint8Array;
  try {
    const response = await fetch(`${endpoint}/qautra/recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.body) throw new Error('missing_reply');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512 * 1024) throw new Error('reply_limit');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    bytes = Buffer.concat(chunks, size);
  } catch { throw unknown(driver, 'guest_recording_ack_unknown'); }
  const parsed = Reply.safeParse((() => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { return null; }
  })());
  if (!parsed.success) throw unknown(driver, 'guest_recording_reply_unknown');
  if (!parsed.data.ok) {
    if (parsed.data.effect === 'unknown') throw unknown(driver, parsed.data.error.code);
    throw new InstanceExecutionError(parsed.data.error.code, parsed.data.error.message, 'not_started');
  }
  return parsed.data.result;
}

async function recover(driver: GuestDesktopDriver, endpoint: string, identity: GuestRecordingIdentity, metadata: z.infer<typeof GuestRecordingFinal>, file: string, state: RecordingStatus, receivedAt: string): Promise<RecordingSegment> {
  let output: FileHandle | undefined;
  try {
    privateDirectory(dirname(file));
    output = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const before = await output.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size !== 0) throw new Error('unsafe_destination');
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < metadata.bytes) {
      const length = Math.min(GUEST_RECORDING_CHUNK_BYTES, metadata.bytes - offset);
      const result = z.strictObject({ identity: GuestRecordingIdentity, offset: z.literal(offset), data: z.string().min(4).max(349528) }).safeParse(await command(driver, endpoint, { action: 'read', identity, offset, length }));
      if (!result.success || !sameRecordingIdentity(result.data.identity, identity) || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data.data)) throw new Error('invalid_chunk');
      const data = Buffer.from(result.data.data, 'base64');
      if (data.length !== length || data.toString('base64') !== result.data.data) throw new Error('invalid_chunk_size');
      let written = 0;
      while (written < data.length) {
        const result = await output.write(data, written, data.length - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error('incomplete_write');
        written += result.bytesWritten;
      }
      hash.update(data); offset += data.length;
    }
    await output.sync();
    const after = await output.stat();
    if (after.size !== metadata.bytes || after.ino !== before.ino || after.dev !== before.dev || hash.digest('hex') !== metadata.sha256) throw new Error('recovery_integrity_failed');
    const storedHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(metadata.bytes, GUEST_RECORDING_CHUNK_BYTES));
    let checked = 0;
    while (checked < metadata.bytes) {
      const { bytesRead } = await output.read(buffer, 0, Math.min(buffer.length, metadata.bytes - checked), checked);
      if (bytesRead <= 0) throw new Error('recovery_readback_incomplete');
      storedHash.update(buffer.subarray(0, bytesRead)); checked += bytesRead;
    }
    const final = await output.stat();
    const named = await lstat(file);
    if (storedHash.digest('hex') !== metadata.sha256 || final.size !== after.size || final.mtimeMs !== after.mtimeMs
      || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.ino !== final.ino || named.dev !== final.dev) throw new Error('recovery_file_changed');
    await output.close(); output = undefined;
    const descriptor = await open(`${file}.guest-recording.json`, 'wx', 0o600);
    try { await descriptor.writeFile(JSON.stringify(metadata)); await descriptor.sync(); } finally { await descriptor.close(); }
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    state.file = 'durable';
    const { sha256, bytes, durationSeconds, frames, width, height, startedAt, endedAt } = metadata;
    const segment: RecordingSegment = { file, sha256, bytes, durationSeconds, frames, width, height, startedAt, endedAt, source: 'macos-guest-display', timing: { basis: 'source', firstFrameReceivedAt: receivedAt, captureStartedAt: startedAt, captureEndedAt: endedAt } };
    state.segment = segment;
    state.diagnostics.push(`${file}.guest-recording.json`);
    const released = z.strictObject({ identity: GuestRecordingIdentity, released: z.literal(true) }).safeParse(await command(driver, endpoint, { action: 'release', identity, sha256: metadata.sha256 }));
    if (!released.success || !sameRecordingIdentity(released.data.identity, identity)) throw new Error('release_unconfirmed');
    state.spool = 'released';
    return segment;
  } catch (error) {
    if (error instanceof InstanceExecutionError && error.effect === 'unknown') throw error;
    throw unknown(driver, 'guest_recording_recovery_unknown');
  } finally { if (output) await output.close(); }
}

export async function startGuestRecording(driver: Driver, input: Parameters<StartTargetRecording>[0]): Promise<TargetRecording> {
  if (!(driver instanceof GuestDesktopDriver)) throw new InstanceExecutionError('guest_recording_driver_required', 'Recording requires the prepared product-owned macOS guest driver. Host screen capture is not a fallback.');
  if (input.signal.aborted) throw new InstanceExecutionError('guest_recording_cancelled', 'Recording was cancelled before dispatch.');
  const prepared = driver.ownedRecordingEndpoint();
  const url = new URL(prepared.serverUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/[0-9a-f]{64}$/.test(url.pathname)) throw new InstanceExecutionError('guest_recording_endpoint_refused', 'The recording endpoint must be the exact owned guest context capability.');
  const worker = /^guest:([0-9a-f-]{36}):([1-9][0-9]*):([1-9][0-9]*)$/.exec(prepared.identity.workerId);
  if (!worker || worker[1] !== prepared.identity.machineId || input.binding.platform !== driver.platform || input.binding.deviceId !== driver.deviceId || input.binding.generation !== prepared.identity.generation) throw new InstanceExecutionError('guest_recording_binding_refused', 'The attempt recording binding does not match the prepared context generation and worker.');
  const file = resolve(input.file);
  if (file !== input.file) throw new InstanceExecutionError('guest_recording_destination_refused', 'Use an absolute, owned evidence destination.');
  privateDirectory(dirname(file));
  const registered = await driver.registerGuestAttempt(input.binding, file);
  const identity = GuestRecordingIdentity.parse(registered.identity);
  const started = GuestRecordingStatus.safeParse(await command(driver, prepared.serverUrl, { action: 'start', identity }, input.signal));
  if (!started.success || !sameRecordingIdentity(started.data.identity, identity) || started.data.state !== 'recording' || started.data.readyAt === null || started.data.firstFrameAt === null || started.data.capture !== 'active' || started.data.encoder !== 'active' || started.data.frames < 1 || started.data.width < 2 || started.data.height < 2) throw unknown(driver, 'guest_recording_first_frame_unknown');
  const readyAt = started.data.readyAt;
  const receivedAt = new Date().toISOString();
  const state: RecordingStatus = { capture: 'active', encoder: 'active', spool: 'pending', file: 'pending', media: 'pending', diagnostics: [] };
  const firstFrameAt = started.data.firstFrameAt;
  let failure: Error | null = null;
  let stopped = false;
  let stopping = false;
  let stopPromise: Promise<RecordingSegment> | undefined;
  let poll: Promise<void> | undefined;
  let heartbeat = started.data.heartbeatAt;
  let lastFrameCount = started.data.frames;
  let heartbeatObserved = performance.now();
  let lastStatusAt = performance.now();
  const readyMonotonic = performance.now();
  const { promise: lost, resolve: resolveLoss } = Promise.withResolvers<Error>();
  const lose = (error: Error): void => {
    if (failure || stopped) return;
    failure = error; resolveLoss(error);
  };
  const assertHealthy = (): void => {
    if (failure) throw failure;
    if (stopped || stopping) throw new Error('guest_recording_not_active');
    if (input.signal.aborted || performance.now() - lastStatusAt > 6000 || performance.now() - heartbeatObserved > 6000 || performance.now() - readyMonotonic >= GUEST_RECORDING_LIMIT_MS) {
      const error = new Error('guest_recording_health_lost'); lose(error); throw error;
    }
  };
  driver.setRecordingGuard(assertHealthy);
  const abort = (): void => lose(new Error('guest_recording_cancelled'));
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  const timer = setInterval(() => {
    if (stopping || stopped || failure) return;
    try { assertHealthy(); } catch { return; }
    if (poll) return;
    poll = (async () => {
      try {
        const result = GuestRecordingStatus.safeParse(await command(driver, prepared.serverUrl, { action: 'status', identity }));
        if (stopping || stopped) return;
        if (!result.success || !sameRecordingIdentity(result.data.identity, identity) || result.data.state !== 'recording' || result.data.capture !== 'active' || result.data.encoder !== 'active' || result.data.frames < lastFrameCount || result.data.readyAt !== readyAt || result.data.firstFrameAt !== firstFrameAt || result.data.width !== started.data.width || result.data.height !== started.data.height || result.data.code !== null) throw new Error('guest_recording_status_lost');
        if (result.data.heartbeatAt > heartbeat) { heartbeat = result.data.heartbeatAt; heartbeatObserved = performance.now(); }
        else if (result.data.heartbeatAt < heartbeat) throw new Error('guest_recording_heartbeat_reversed');
        lastStatusAt = performance.now();
        lastFrameCount = result.data.frames;
        if (!stopping) assertHealthy();
      } catch (error) { lose(error instanceof Error ? error : new Error('guest_recording_status_lost')); }
    })().finally(() => { poll = undefined; });
  }, 1000);
  timer.unref();
  return {
    readyAt: receivedAt, firstFrameAt, lost, maxDurationMs: GUEST_RECORDING_LIMIT_MS, assertHealthy,
    async beforeDispatch() {
      assertHealthy();
      const result = GuestRecordingStatus.safeParse(await command(driver, prepared.serverUrl, { action: 'status', identity }));
      if (!result.success || !sameRecordingIdentity(result.data.identity, identity) || result.data.state !== 'recording' || result.data.capture !== 'active' || result.data.encoder !== 'active' || result.data.readyAt !== readyAt || result.data.firstFrameAt !== firstFrameAt || result.data.frames < lastFrameCount || result.data.code !== null) {
        const error = new Error('guest_recording_action_boundary_lost'); lose(error); throw error;
      }
      assertHealthy();
    },
    async status() {
      if (stopping && !stopped && (state.capture === 'unknown' || state.encoder === 'unknown')) {
        try {
          const result = GuestRecordingStatus.safeParse(await command(driver, prepared.serverUrl, { action: 'status', identity }));
          if (result.success && sameRecordingIdentity(result.data.identity, identity)) { state.capture = result.data.capture; state.encoder = result.data.encoder; }
        } catch {}
      }
      return structuredClone(state);
    },
    stop(): Promise<RecordingSegment> {
      if (stopPromise) return stopPromise;
      stopping = true; clearInterval(timer); input.signal.removeEventListener('abort', abort);
      stopPromise = (async (): Promise<RecordingSegment> => {
        if (poll) await poll;
        const actual = driver.ownedRecordingEndpoint(true);
        if (actual.serverUrl !== prepared.serverUrl || actual.identity.workerId !== prepared.identity.workerId || actual.identity.generation !== prepared.identity.generation || actual.identity.instanceId !== prepared.identity.instanceId || actual.identity.machineId !== prepared.identity.machineId) throw unknown(driver, 'guest_recording_owner_changed');
        const metadata = GuestRecordingFinal.safeParse(await command(driver, prepared.serverUrl, { action: 'stop', identity }));
        if (!metadata.success || !sameRecordingIdentity(metadata.data.identity, identity) || metadata.data.readyAt !== readyAt || metadata.data.width !== started.data.width || metadata.data.height !== started.data.height || metadata.data.frames < lastFrameCount
          || Date.parse(metadata.data.endedAt) <= Date.parse(metadata.data.startedAt) || metadata.data.startedAt !== firstFrameAt || Date.parse(metadata.data.startedAt) > Date.parse(readyAt)
          || Math.abs((Date.parse(metadata.data.endedAt) - Date.parse(metadata.data.startedAt)) / 1000 - metadata.data.durationSeconds) > 0.005) throw unknown(driver, 'guest_recording_finalization_unknown');
        state.capture = 'stopped'; state.encoder = 'finalized';
        state.media = metadata.data.media;
        const segment = await recover(driver, prepared.serverUrl, identity, metadata.data, file, state, receivedAt);
        stopped = true;
        driver.setRecordingGuard(undefined);
        if (metadata.data.media !== 'valid') {
          state.diagnostics.push(file);
          throw new InstanceExecutionError(metadata.data.code ?? 'guest_video_decode_failed', 'Guest capture and encoder stopped; the durable damaged original was recovered for diagnosis.', 'not_started');
        }
        return segment;
      })().catch(error => {
        if (state.capture === 'active') state.capture = 'unknown';
        if (state.encoder === 'active') state.encoder = 'unknown';
        if (state.spool !== 'released') state.spool = 'unknown';
        const result = error instanceof Error ? error : new Error('guest_recording_stop_unknown');
        lose(result); throw result;
      });
      return stopPromise;
    },
  };
}
