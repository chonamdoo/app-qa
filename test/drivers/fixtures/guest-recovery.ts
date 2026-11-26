import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuestAttemptBindingSchema, type GuestRecoveryRegistration } from '../../../src/core/guest-recovery.ts';

export function guestRecoveryFixture(input: GuestRecoveryRegistration) {
  const directory = join(input.context.root, '.qa/instances/guest-attempts', input.identity.recorderId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const machinesRoot = join(input.context.root, '.qa/instances/machines');
  mkdirSync(machinesRoot, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(join(directory, 'key'), key, { mode: 0o600, flag: 'wx' });
  const binding = GuestAttemptBindingSchema.parse({
    ...input, schema: 'qautra/guest-attempt-binding/v1',
    native: { directory, machineId: input.identity.machineId, nativeGeneration: randomUUID(), recorderId: input.identity.recorderId },
    workerId: `guest:${input.identity.machineId}:${input.identity.guestPid}:${input.identity.epoch}`,
    machinesRoot, rootId: randomUUID(), bootTokenSha256: 'b'.repeat(64),
    artifacts: { diskIdentity: '1:2', auxiliaryIdentity: '1:3', hardwareHash: 'c'.repeat(64), machineHash: 'd'.repeat(64) },
  });
  function seal(name: string, value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    const bytes = JSON.stringify({ body: body.toString('base64'), signature: createHmac('sha256', key).update(`qautra/guest-${name}/v1\0`).update(body).digest('hex') });
    writeFileSync(join(directory, `${name}.json`), bytes, { mode: 0o600 });
    return createHash('sha256').update(bytes).digest('hex');
  }
  const source = { kind: 'macos-guest' as const, id: input.identity.recorderId, root: input.context.root, bindingSha256: seal('binding', binding) };
  return { source, binding, seal, directory, key };
}
