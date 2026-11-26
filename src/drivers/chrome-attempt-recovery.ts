import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import { authenticChromeOwnerValue, chromeOwnerValueSignature } from '../core/chrome-owner-auth.ts';
import type { ChromeOwnerLocator } from '../core/chrome-owner.ts';
import { commitDirectory, readPrivateFile, sha256 } from '../core/fsx.ts';
import { NativeAttemptBindingSchema, StoredNativeAttemptBindingSchema, type AttemptRecoveryContext, type ChromeAttemptRecovery, type ExecutionRecoveryScope, type ExecutionRecoverySource, type NativeAttemptBinding } from '../core/recovery.ts';
import { observeChromeOwner } from './chrome-owner-client.ts';
import { readChromeOwnerMaterial } from './chrome-owner-storage.ts';

const unavailable = (code: string): AgentExecutionError => new AgentExecutionError(code, '원 실행의 native 복구 binding을 확인할 수 없습니다', 'unknown');
function validateBinding(body: NativeAttemptBinding, expected?: Pick<ExecutionRecoveryScope, 'ownerId' | 'generation'>): void {
  const material = readChromeOwnerMaterial(body.native), { context } = body, execution = material.seed.scope.execution;
  const runPath = relative(context.root, context.runDir);
  const runInsideRoot = resolve(context.root) === context.root && resolve(context.runDir) === context.runDir && runPath !== '' && runPath !== '..' && !runPath.startsWith(`..${sep}`) && !runPath.startsWith(sep);
  if (!runInsideRoot) throw unavailable('native_recovery_run_path_invalid');
  const ownerMatchesTarget = material.seed.scope.projectRoot === context.root && material.seed.scope.deviceId === context.target.deviceId;
  if (!ownerMatchesTarget) throw unavailable('native_recovery_target_mismatch');
  const attemptOwnsExecution = !!execution && execution.ownerId === context.ownerId && context.ownerId === `attempt:${context.attemptId}` && execution.resources.includes(`target:${context.target.deviceId}`);
  if (!execution || !attemptOwnsExecution) throw unavailable('native_recovery_owner_mismatch');
  const expectedGeneration = !expected || (execution.ownerId === expected.ownerId && execution.generation === expected.generation);
  if (!expectedGeneration) throw unavailable('native_recovery_generation_mismatch');
}
function register(locator: ChromeOwnerLocator, context: AttemptRecoveryContext): ExecutionRecoverySource {
  const body = NativeAttemptBindingSchema.parse({ schema: 'qautra/native-attempt-binding/v1', context, native: locator });
  validateBinding(body);
  const material = readChromeOwnerMaterial(locator);
  const value = StoredNativeAttemptBindingSchema.parse({ body, signature: chromeOwnerValueSignature(material.seed.replyKey, 'execution', body) });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(join(locator.directory, 'execution.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  commitDirectory(locator.directory);
  return { kind: 'owned-chrome', id: locator.ownerId, bindingSha256: sha256(bytes) };
}
function read(directory: string, source: ExecutionRecoverySource, scope: Pick<ExecutionRecoveryScope, 'ownerId' | 'generation'>): NativeAttemptBinding {
  try {
    const ownerDirectory = join(directory, 'native-owners', source.id);
    const bytes = readPrivateFile(join(ownerDirectory, 'execution.json'), 256 * 1024);
    if (sha256(bytes) !== source.bindingSha256) throw unavailable('native_recovery_binding_changed');
    const value = StoredNativeAttemptBindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (value.body.native.directory !== ownerDirectory || value.body.native.ownerId !== source.id) throw unavailable('native_recovery_binding_mismatch');
    validateBinding(value.body, scope);
    const material = readChromeOwnerMaterial(value.body.native);
    if (!authenticChromeOwnerValue(material.seed.replyKey, 'execution', value.body, value.signature)) throw unavailable('native_recovery_binding_changed');
    return value.body;
  } catch (error) { throw error instanceof AgentExecutionError ? error : unavailable('native_recovery_binding_unverified'); }
}
export const chromeAttemptRecovery: ChromeAttemptRecovery = {
  register, read, scope: locator => readChromeOwnerMaterial(locator).seed.scope, observe: observeChromeOwner,
};
