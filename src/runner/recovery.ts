import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AgentExecutionError } from '../core/agent.ts';
import { commitDirectory, ensureDir, readPrivateFile, sha256, writeJsonAtomic } from '../core/fsx.ts';
import { projectFixtureCanonical, type ProjectFixtureProof } from '../core/project-fixture.ts';
import { ExecutionRecoveryReceiptSchema, ResourceRecoveryObservationSchema, type AttemptRecoveryContext, type ChromeAttemptRecovery, type ExecutionRecoveryReceipt, type ExecutionRecoveryScope, type ResourceRecoveryObservation, type ResourceRecoverySource } from '../core/recovery.ts';
import { createProjectFixtureRecoveryObserver } from './project-fixture.ts';
import { readExecutionRecoveryAuthorization } from '../core/admission.ts';
import type { RegressionAttempt } from '../core/regression.ts';
import type { GuestAttemptRecovery } from '../core/guest-recovery.ts';
import { GuestRecordingFinal } from '../core/guest-recording-protocol.ts';

const unavailable = (code: string): AgentExecutionError => new AgentExecutionError(code, '원 실행의 native·증거·backend 복구 근거를 확인할 수 없습니다', 'unknown');
function within(root: string, file: string): boolean { const value = relative(root, file); return Boolean(value) && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep); }
function codeOf(error: unknown): string { return error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(error.code) ? error.code : 'recovery_source_unavailable'; }
function mark(row: ResourceRecoverySource, kind: ResourceRecoverySource['checks'][number]['kind'], status: ResourceRecoverySource['checks'][number]['status'], code: string | null = null): void { const check = row.checks.find(check => check.kind === kind)!; check.status = status; check.code = code; }
const Pointer = z.strictObject({ file: z.string().regex(/^[a-f0-9-]{36}\.json$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
function saveObservation(directory: string, value: ResourceRecoveryObservation): void {
  const folder = ensureDir(join(directory, 'recovery'));
  const file = `${randomUUID()}.json`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw unavailable('recovery_observation_too_large');
  const fd = openSync(join(folder, file), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  commitDirectory(folder);
  const attemptId = value.scope.ownerId.startsWith('attempt:') ? value.scope.ownerId.slice(8) : null;
  if (attemptId) {
    const attempts = ensureDir(join(folder, 'attempts'));
    writeJsonAtomic(join(attempts, `${sha256(attemptId)}.json`), { file, sha256: sha256(bytes) });
  }
  writeJsonAtomic(join(folder, 'latest.json'), { file, sha256: sha256(bytes) });
}
export function latestRecoveryObservation(directory: string, attemptId?: string): ResourceRecoveryObservation | null {
  let pointerBytes: Buffer;
  try { pointerBytes = readPrivateFile(join(directory, 'recovery', attemptId ? join('attempts', `${sha256(attemptId)}.json`) : 'latest.json'), 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unavailable('recovery_observation_unverified'); }
  try {
    const pointer = Pointer.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pointerBytes)));
    const bytes = readPrivateFile(join(directory, 'recovery', pointer.file), 16 * 1024 * 1024);
    if (sha256(bytes) !== pointer.sha256) throw unavailable('recovery_observation_unverified');
    const observation = ResourceRecoveryObservationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (attemptId && (observation.scope.ownerId !== `attempt:${attemptId}` || observation.sources.some(source => source.context && source.context.attemptId !== attemptId))) throw unavailable('recovery_observation_unverified');
    return observation;
  } catch { throw unavailable('recovery_observation_unverified'); }
}

export function attemptResourcesRecovered(directory: string, root: string, attempt: RegressionAttempt, native: ChromeAttemptRecovery, guest: GuestAttemptRecovery): boolean {
  try {
    const observation = latestRecoveryObservation(directory, attempt.attemptId);
    if (!observation || observation.scope.ownerId !== `attempt:${attempt.attemptId}`) return false;
    const authority = readExecutionRecoveryAuthorization(directory, observation.scope.generation);
    if (!authority || projectFixtureCanonical(authority.scope) !== projectFixtureCanonical(observation.scope) || !authority.scope.recoverySources.length) return false;
    return authority.scope.recoverySources.every(source => {
      const { context } = source.kind === 'macos-guest' ? guest.read(join(source.root, '.qa/instances'), source, authority.scope) : native.read(directory, source, authority.scope);
      return context.root === root && context.attemptId === attempt.attemptId && context.runId === attempt.runId && context.revisionId === attempt.revisionId && context.testId === attempt.testId
        && context.target.platform === attempt.target.platform && context.target.deviceId === attempt.target.deviceId && context.grantId === attempt.authorization.grantId && context.subjectSha256 === attempt.authorization.subjectSha256;
    });
  } catch { return false; }
}

export async function verifyExecutionRecovery(directory: string, scope: ExecutionRecoveryScope, nativeRecovery: ChromeAttemptRecovery, guestRecovery: GuestAttemptRecovery): Promise<ExecutionRecoveryReceipt> {
  const rows: ResourceRecoverySource[] = [];
  const materials: { row: ResourceRecoverySource; context: AttemptRecoveryContext }[] = [];
  const problems: string[] = [];
  const covered = new Set<string>();
  let identity: string | null = null;
  for (const reference of scope.recoverySources) {
    const row: ResourceRecoverySource = { reference, context: null, native: null, evidenceSha256: null, video: 'unavailable', segments: [], fixture: null, checks: (['binding', 'native-stop', 'evidence', 'fixture', 'late-effects'] as const).map(kind => ({ kind, status: 'unobserved', code: null })) };
    rows.push(row);
    try {
      const original = reference.kind === 'macos-guest'
        ? { kind: 'macos-guest' as const, binding: guestRecovery.read(join(reference.root, '.qa/instances'), reference, scope) }
        : { kind: 'owned-chrome' as const, binding: nativeRecovery.read(directory, reference, scope) };
      const currentIdentity = projectFixtureCanonical(original.binding.context);
      if (identity !== null && currentIdentity !== identity) throw unavailable('recovery_attempt_scope_mismatch');
      identity = currentIdentity; row.context = original.binding.context; mark(row, 'binding', 'verified');
      materials.push({ row, context: original.binding.context });
      if (original.kind === 'macos-guest') {
        const binding = original.binding;
        for (const resource of guestRecovery.scope(binding.native).resources) covered.add(resource);
        const actual = await guestRecovery.observe(binding.native);
        if (projectFixtureCanonical(actual.binding) !== projectFixtureCanonical(binding)) throw unavailable('recovery_guest_binding_changed');
        row.native = actual.nativeStop; row.video = actual.video;
        const final = GuestRecordingFinal.safeParse(actual.inventory?.final);
        const artifact = actual.inventory?.artifacts.find(item => item.name === 'video.mov' && item.location === 'evidence');
        if (actual.video === 'ready' && final.success && artifact) {
          const { sha256, bytes, durationSeconds, frames, width, height, startedAt, endedAt } = final.data;
          row.segments.push({ file: relative(binding.context.runDir, binding.evidenceFile).split(sep).join('/'), sha256, bytes, durationSeconds, frames, width, height, startedAt, endedAt, source: 'macos-guest-display' });
        }
        if (!actual.nativeStop || !actual.nativeStopSha256) mark(row, 'native-stop', 'blocked', 'guest_original_terminal_unobserved');
        else mark(row, 'native-stop', 'verified');
        if (!actual.nativeStop || actual.evidence !== 'finalized' || !actual.evidenceSha256) mark(row, 'evidence', 'blocked', 'guest_original_inventory_unfinalized');
        else { row.evidenceSha256 = actual.evidenceSha256; mark(row, 'evidence', 'verified'); }
      } else {
        const binding = original.binding;
        for (const resource of nativeRecovery.scope(binding.native).execution!.resources) covered.add(resource);
        const native = await nativeRecovery.observe(binding.native); row.native = native.native;
        for (const recording of native.recordings) {
          if (recording.binding.attemptId !== binding.context.attemptId || recording.binding.runId !== binding.context.runId || !within(binding.context.runDir, recording.file)) throw unavailable('recovery_recording_scope_mismatch');
          if (recording.segment) {
            const file = resolve(binding.context.runDir, recording.segment.file);
            if (file !== recording.file) throw unavailable('recovery_recording_scope_mismatch');
            row.segments.push({ ...recording.segment, file: relative(binding.context.runDir, file).split(sep).join('/') });
          }
        }
        row.video = native.recordings.length && native.recordings.every(recording => recording.state === 'stopped' && recording.status.media === 'valid') ? 'ready' : native.recordings.length ? 'incomplete' : 'unavailable';
        if (native.phase !== 'closed') mark(row, 'native-stop', 'blocked', 'native_stop_unconfirmed');
        else mark(row, 'native-stop', 'verified');
        if (native.phase !== 'closed' || !native.evidenceFinalized || !native.evidenceSha256) mark(row, 'evidence', 'blocked', 'native_evidence_unfinalized');
        else { row.evidenceSha256 = native.evidenceSha256; mark(row, 'evidence', 'verified'); }
      }
    } catch (error) {
      const check = row.checks.find(check => check.status !== 'verified')!;
      check.status = 'blocked'; check.code = codeOf(error);
    }
  }
  const fixtures = new Map<string, Promise<ProjectFixtureProof>>();
  const expires: number[] = [];
  for (const { row, context } of materials) {
    const key = projectFixtureCanonical([context.root, context.fixtureSeedId, context.attemptId, context.ownerId]);
    try {
      let request = fixtures.get(key);
      if (!request) { request = createProjectFixtureRecoveryObserver({ root: context.root, seedId: context.fixtureSeedId, attemptId: context.attemptId, ownerId: context.ownerId }).observe(); fixtures.set(key, request); }
      const proof = await request;
      if (proof.phase !== 'observe' || proof.attemptId !== context.attemptId || proof.ownerId !== context.ownerId || proof.subjectSha256 !== context.subjectSha256 || proof.effect !== 'unknown' || proof.comparison !== 'unobserved') throw unavailable('recovery_fixture_scope_mismatch');
      row.fixture = { receiptSha256: proof.receiptSha256, subjectSha256: proof.subjectSha256, observedAt: proof.observedAt, expiresAt: proof.expiresAt, cleanup: proof.cleanup, effect: proof.effect, comparison: proof.comparison };
      expires.push(Date.parse(proof.expiresAt));
      if (proof.cleanup === 'complete') { mark(row, 'fixture', 'verified'); mark(row, 'late-effects', 'verified'); }
      else { mark(row, 'fixture', 'blocked', 'fixture_cleanup_incomplete'); mark(row, 'late-effects', 'unobserved', 'fixture_effects_unverified'); }
    } catch (error) { mark(row, 'fixture', 'blocked', codeOf(error)); mark(row, 'late-effects', 'unobserved', codeOf(error)); }
  }
  if (!scope.recoverySources.length) problems.push('recovery_source_missing');
  if (scope.resources.some(resource => !covered.has(resource))) problems.push('recovery_resource_uncovered');
  if (expires.some(expiry => !Number.isFinite(expiry) || expiry <= Date.now())) problems.push('fixture_proof_stale');
  const verified = !problems.length && rows.length > 0 && rows.every(row => row.checks.every(check => check.status === 'verified'));
  let receipt: ExecutionRecoveryReceipt | null = null;
  if (verified) {
    const nativeStopSha256 = sha256(projectFixtureCanonical(rows.map(row => ({ reference: row.reference, native: row.native }))));
    const evidenceSha256 = sha256(projectFixtureCanonical(rows.map(row => ({ reference: row.reference, evidenceSha256: row.evidenceSha256 }))));
    const fixtureSha256 = sha256(projectFixtureCanonical(rows.map(row => ({ reference: row.reference, receiptSha256: row.fixture!.receiptSha256 }))));
    receipt = ExecutionRecoveryReceiptSchema.parse({ schema: 'qautra/execution-recovery/v1', scope, resources: scope.resources.map(resourceId => ({ resourceId, nativeStop: 'confirmed', nativeStopSha256, evidence: 'finalized', evidenceSha256, fixture: 'restored', fixtureSha256, lateEffects: 'resolved', lateEffectsSha256: fixtureSha256 })) });
  }
  const observation = ResourceRecoveryObservationSchema.parse({ schema: 'qautra/resource-recovery-observation/v1', kind: 'resource-verification-only', scope, observedAt: new Date().toISOString(), state: verified ? 'verified' : 'blocked', sources: rows, receipt, problems });
  saveObservation(directory, observation);
  if (!receipt || expires.some(expiry => expiry <= Date.now())) throw unavailable(!receipt ? 'execution_recovery_incomplete' : 'fixture_proof_stale');
  return receipt;
}
