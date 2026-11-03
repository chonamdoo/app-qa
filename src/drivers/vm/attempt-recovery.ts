import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readPrivateFile, sha256 } from '../../core/fsx.ts';
import { GuestAttemptBindingSchema, GuestRecoveryInventorySchema, GuestRecoveryLocatorSchema, GuestRecoveryRegistrationSchema, GuestRecoverySourceSchema, GuestRecoveryStopSchema, type GuestAttemptBinding, type GuestAttemptRecovery, type GuestRecoveryLocator, type GuestRecoveryObservation, type GuestRecoverySource } from '../../core/guest-recovery.ts';
import { InstanceExecutionError } from '../../core/instances.ts';
import { GuestRecordingFinal, GuestRecordingPartial, GuestRecordingStatus, sameRecordingIdentity } from '../../core/guest-recording-protocol.ts';
import { NativeGuestClient } from './runtime.ts';

const unavailable = (code: string): InstanceExecutionError => new InstanceExecutionError(code, 'The original guest generation, attempt binding, or terminal evidence is unverified. No replacement owner or test command is started.', 'unknown');
const Envelope = z.strictObject({ body: z.string().min(4).max(1024 * 1024), signature: z.string().regex(/^[a-f0-9]{64}$/) });
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
const beneath = (root: string, file: string): boolean => { const path = relative(root, file); return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep); };

interface SignedGuestValue { body: unknown; sha256: string }
function signed(directory: string, name: string, key: Uint8Array): SignedGuestValue {
  const bytes = readPrivateFile(join(directory, `${name}.json`), 1024 * 1024);
  const value = Envelope.parse(decode(bytes));
  const body = Buffer.from(value.body, 'base64');
  if (body.toString('base64') !== value.body) throw unavailable('guest_recovery_signature_invalid');
  const signature = createHmac('sha256', key).update(`qautra/guest-${name}/v1\0`).update(body).digest();
  if (!timingSafeEqual(signature, Buffer.from(value.signature, 'hex'))) throw unavailable('guest_recovery_signature_invalid');
  return { body: decode(body), sha256: sha256(bytes) };
}
function material(locator: GuestRecoveryLocator): { binding: GuestAttemptBinding; source: GuestRecoverySource; key: Uint8Array } {
  GuestRecoveryLocatorSchema.parse(locator);
  const key = readPrivateFile(join(locator.directory, 'key'), 32);
  if (key.length !== 32) throw unavailable('guest_recovery_key_invalid');
  const value = signed(locator.directory, 'binding', key);
  const binding = GuestAttemptBindingSchema.parse(value.body);
  const { context, identity, execution, native } = binding;
  if (JSON.stringify(native) !== JSON.stringify(GuestRecoveryLocatorSchema.parse(locator))
    || native.directory !== join(context.root, '.qa/instances/guest-attempts', identity.recorderId)
    || binding.machinesRoot !== join(context.root, '.qa/instances/machines')
    || resolve(context.root) !== context.root || !beneath(context.root, context.runDir) || !beneath(context.runDir, binding.evidenceFile)
    || resolve(context.runDir) !== context.runDir || resolve(binding.evidenceFile) !== binding.evidenceFile
    || identity.machineId !== native.machineId || identity.recorderId !== native.recorderId
    || identity.attemptId !== context.attemptId || identity.runId !== context.runId
    || execution.ownerId !== context.ownerId || context.ownerId !== `attempt:${context.attemptId}`
    || !execution.resources.includes(`target:${context.target.deviceId}`) || new Set(execution.resources).size !== execution.resources.length
    || binding.workerId !== `guest:${identity.machineId}:${identity.guestPid}:${identity.epoch}`) throw unavailable('guest_recovery_binding_mismatch');
  return { binding, source: { kind: 'macos-guest', id: identity.recorderId, root: context.root, bindingSha256: value.sha256 }, key };
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function artifactHash(file: string, expected: { identity: string; bytes: number; sha256: string }): void {
  let parent = dirname(file);
  const parents: { path: string; dev: number; ino: number }[] = [];
  while (parent !== dirname(parent)) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable('guest_recovery_artifact_boundary');
    if (parent === dirname(file) && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw unavailable('guest_recovery_artifact_boundary');
    parents.push({ path: parent, dev: info.dev, ino: info.ino });
    parent = dirname(parent);
  }
  const directory = realpathSync(dirname(file));
  if (directory !== dirname(file)) throw unavailable('guest_recovery_artifact_boundary');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size !== expected.bytes || `${before.dev}:${before.ino}` !== expected.identity) throw unavailable('guest_recovery_artifact_unsafe');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (count <= 0) throw unavailable('guest_recovery_artifact_changed');
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd), named = lstatSync(file);
    if (hash.digest('hex') !== expected.sha256 || !sameFile(before, after) || !sameFile(after, named) || named.isSymbolicLink() || named.nlink !== 1 || realpathSync(dirname(file)) !== directory) throw unavailable('guest_recovery_artifact_changed');
    for (const parent of parents) {
      const current = lstatSync(parent.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino) throw unavailable('guest_recovery_artifact_boundary');
    }
  } finally { closeSync(fd); }
}
function optionalSigned(directory: string, name: string, key: Uint8Array): SignedGuestValue | null {
  try { return signed(directory, name, key); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function observeStored(locator: GuestRecoveryLocator): GuestRecoveryObservation {
  const { binding, source, key } = material(locator);
  const stopValue = optionalSigned(locator.directory, 'stop', key);
  const inventoryValue = optionalSigned(locator.directory, 'inventory', key);
  const nativeStop = stopValue ? GuestRecoveryStopSchema.parse(stopValue.body) : null;
  const inventory = inventoryValue ? GuestRecoveryInventorySchema.parse(inventoryValue.body) : null;
  for (const value of [nativeStop, inventory]) {
    if (value && (value.recorderId !== source.id || value.bindingSha256 !== source.bindingSha256 || value.nativeGeneration !== locator.nativeGeneration)) throw unavailable('guest_recovery_terminal_mismatch');
  }
  if (inventory && !nativeStop) throw unavailable('guest_recovery_stop_missing');
  const problems: string[] = [];
  if (!nativeStop) problems.push('guest_original_terminal_unobserved');
  if (!inventory) problems.push('guest_original_inventory_unobserved');
  if (inventory) {
    const spool = join(binding.machinesRoot, locator.machineId, 'status/recordings', binding.identity.contextId, locator.recorderId);
    const names = new Set<string>();
    for (const artifact of inventory.artifacts) {
      if (names.has(artifact.name) || (artifact.location === 'evidence' && artifact.name !== 'video.mov')) throw unavailable('guest_recovery_inventory_invalid');
      names.add(artifact.name);
      artifactHash(artifact.location === 'evidence' ? binding.evidenceFile : join(spool, artifact.name), artifact);
    }
    const status = GuestRecordingStatus.safeParse(inventory.status);
    if (inventory.status !== null && (!status.success || !sameRecordingIdentity(status.data.identity, binding.identity))) throw unavailable('guest_recovery_recorder_mismatch');
    const descriptor = z.union([GuestRecordingFinal, GuestRecordingPartial]).safeParse(inventory.final);
    if (inventory.final !== null && (!descriptor.success || !sameRecordingIdentity(descriptor.data.identity, binding.identity))) throw unavailable('guest_recovery_recorder_mismatch');
    if (inventory.video === 'ready' && inventory.problems.length > 0) throw unavailable('guest_recovery_inventory_invalid');
    if (inventory.video === 'ready' || inventory.media === 'valid') {
      const final = GuestRecordingFinal.safeParse(inventory.final);
      const video = inventory.artifacts.find(artifact => artifact.name === 'video.mov');
      if (!final.success || !sameRecordingIdentity(final.data.identity, binding.identity) || final.data.media !== 'valid' || !video || video.sha256 !== final.data.sha256 || video.bytes !== final.data.bytes || inventory.encoder !== 'finalized') throw unavailable('guest_recovery_video_unverified');
    }
    problems.push(...inventory.problems);
  }
  return { binding, nativeStop, nativeStopSha256: stopValue?.sha256 ?? null, inventory, evidenceSha256: inventoryValue?.sha256 ?? null, evidence: inventory ? inventory.problems.length === 0 ? 'finalized' : 'incomplete' : 'unobserved', video: inventory?.video ?? 'unavailable', problems };
}

export const guestAttemptRecovery: GuestAttemptRecovery = {
  async register(endpoint, input) {
    const registration = GuestRecoveryRegistrationSchema.parse(input);
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^\/[a-f0-9]{64}$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw unavailable('guest_recovery_endpoint_refused');
    let bytes: Uint8Array;
    try {
      const reply = await fetch(`${endpoint}/qautra/recovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration), redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!reply.ok || !reply.body) throw unavailable('guest_recovery_registration_unknown');
      const chunks: Uint8Array[] = []; let length = 0; const reader = reply.body.getReader();
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 256 * 1024) throw unavailable('guest_recovery_reply_limit'); chunks.push(chunk.value); }
      } finally { await reader.cancel(); }
      bytes = Buffer.concat(chunks, length);
    } catch { throw unavailable('guest_recovery_registration_unknown'); }
    const result = z.strictObject({ source: GuestRecoverySourceSchema, binding: GuestAttemptBindingSchema }).parse(decode(bytes));
    const original = material(result.binding.native);
    if (original.source.bindingSha256 !== result.source.bindingSha256 || original.source.id !== result.source.id || original.source.root !== result.source.root
      || JSON.stringify({ context: original.binding.context, execution: original.binding.execution, identity: original.binding.identity, evidenceFile: original.binding.evidenceFile }) !== JSON.stringify(registration)) throw unavailable('guest_recovery_registration_mismatch');
    return { source: original.source, binding: original.binding };
  },
  read(directory, source, scope) {
    try {
      GuestRecoverySourceSchema.parse(source);
      const path = join(directory, 'guest-attempts', source.id);
      const bytes = readPrivateFile(join(path, 'binding.json'), 1024 * 1024);
      if (sha256(bytes) !== source.bindingSha256) throw unavailable('guest_recovery_binding_changed');
      const envelope = Envelope.parse(decode(bytes));
      const body = GuestAttemptBindingSchema.parse(decode(Buffer.from(envelope.body, 'base64')));
      if (body.native.directory !== path || body.context.root !== source.root) throw unavailable('guest_recovery_binding_mismatch');
      const original = material(body.native);
      if (original.source.id !== source.id || original.binding.execution.ownerId !== scope.ownerId || original.binding.execution.generation !== scope.generation) throw unavailable('guest_recovery_scope_changed');
      return original.binding;
    } catch (error) { throw error instanceof InstanceExecutionError ? error : unavailable('guest_recovery_binding_unverified'); }
  },
  scope(locator) { return material(locator).binding.execution; },
  async observe(locator) {
    const original = material(locator);
    const stored = observeStored(locator);
    if (stored.nativeStop) return stored;
    const client = new NativeGuestClient(original.binding.context.root, original.binding.machinesRoot, true);
    try { await client.request('recovery.observe', locator.machineId, { recorderId: locator.recorderId, nativeGeneration: locator.nativeGeneration }, 5000, false); }
    catch (error) { if (!(error instanceof InstanceExecutionError) || !['guest_owner_absent', 'guest_owner_timeout', 'guest_owner_disconnected'].includes(error.code)) throw error; }
    return observeStored(locator);
  },
};
