import type { AppTarget } from '../../core/types.ts';
import { randomUUID } from 'node:crypto';
import { GuestRecoveryContextSchema, GuestRecoveryExecutionSchema, type GuestAttemptBinding, type GuestRecoveryContext, type GuestRecoveryExecution, type GuestRecoverySource } from '../../core/guest-recovery.ts';
import type { RecordingBinding } from '../../core/recording.ts';
import { validateGuestBrowserEvidence, type GuestBrowserEvidence } from '../../core/guest-runtime.ts';
import { InstanceExecutionError } from '../../core/instances.ts';
import type { DesktopPlatform } from '../../appium/setup.ts';
import { targetProblem } from '../appid.ts';
import { failureStatus, RefusedError, StepError, type DriverOptions } from '../base.ts';
import { DesktopWebDriver } from '../desktop.ts';
import { guestAttemptRecovery } from './attempt-recovery.ts';

type Identity = { instanceId: string; machineId: string; workerId: string; generation: number };
interface GuestDriverAccess {
  prepare(origins: readonly string[]): Promise<string>;
  execution(cleanup?: boolean): Identity | null;
  unknown?(reason: string): void;
}

export class GuestDesktopDriver extends DesktopWebDriver {
  readonly #options: DriverOptions;
  readonly #access: GuestDriverAccess;
  #identity: Identity | null = null;
  #origins: readonly string[] | null = null;
  #closing = false;
  #ownerGuard: (() => void) | undefined;
  #recordingGuard: (() => void) | undefined;
  #recovery: { context: GuestRecoveryContext; execution: GuestRecoveryExecution; registered: (source: GuestRecoverySource) => void } | null = null;
  #attempt: GuestAttemptBinding | null = null;
  #registration: Promise<GuestAttemptBinding> | null = null;
  #runtimeSource: GuestRecoverySource | null = null;
  readonly #runtimeObservations: GuestBrowserEvidence[] = [];

  constructor(platform: DesktopPlatform, deviceId: string, access: GuestDriverAccess) {
    const options: DriverOptions & { onUncertain: (reason: string) => void } = {
      onUncertain: (reason) => access.unknown?.(reason),
    };
    super(platform, deviceId, options);
    this.#options = options;
    this.#access = access;
    super.setMutationGuard(() => this.#check());
  }

  #check(cleanup = false): void {
    const actual = this.#access.execution(cleanup);
    const expected = this.#identity;
    const attempt = this.#attempt;
    if (!actual || !expected || actual.instanceId !== expected.instanceId || actual.machineId !== expected.machineId
      || actual.workerId !== expected.workerId || actual.generation !== expected.generation
      || (attempt && (actual.machineId !== attempt.identity.machineId || actual.instanceId !== attempt.identity.contextId
        || actual.workerId !== attempt.workerId || actual.generation !== attempt.identity.generation))) {
      this.#access.unknown?.('guest_generation_changed');
      throw new StepError({ status: 'uncertain', ms: 0, error: 'guest 소유권·epoch·generation 미확인 — 명령을 재전송하지 않습니다.' });
    }
    if (!cleanup) this.#recordingGuard?.();
  }

  override setMutationGuard(guard: () => void): void {
    this.#ownerGuard = guard;
    super.setMutationGuard(() => { this.#check(); guard(); });
  }

  protected override beforeCommand(method: 'GET' | 'POST' | 'DELETE', path: string): void {
    if (!this.#closing && method !== 'GET' && !this.#attempt) throw new RefusedError('Register the original frozen guest attempt before browser dispatch.');
    if (this.#closing && method === 'DELETE' && /^\/session\/[^/]+$/.test(path)) {
      this.#check(true);
      this.#ownerGuard?.();
    } else super.beforeCommand(method, path);
  }

  protected override async ownedEndpoint(): Promise<{ url: string }> {
    const { serverUrl } = this.ownedRecordingEndpoint();
    return { url: serverUrl };
  }

  setRecordingGuard(guard: (() => void) | undefined): void {
    this.#recordingGuard = guard;
  }

  ownedRecordingEndpoint(cleanup = false): { serverUrl: string; identity: Identity } {
    if (!this.#options.serverUrl || !this.#identity) throw new InstanceExecutionError('guest_recording_preparation_required', 'Prepare the existing owned guest context and its approved origins before starting recording.');
    this.#check(cleanup);
    const serverUrl = this.#options.serverUrl;
    return { serverUrl, identity: { ...this.#identity } };
  }

  recordingUnknown(reason: string): void {
    this.#access.unknown?.(reason);
  }

  setGuestAttemptRecovery(context: GuestRecoveryContext, execution: GuestRecoveryExecution, registered: (source: GuestRecoverySource) => void): void {
    if (this.#recovery || this.#attempt || this.#registration) throw new RefusedError('The original guest attempt recovery authority cannot be replaced.');
    const original = GuestRecoveryContextSchema.parse(context);
    const scope = GuestRecoveryExecutionSchema.parse(execution);
    if (original.target.platform !== this.platform || original.target.deviceId !== this.deviceId || original.ownerId !== scope.ownerId || original.ownerId !== `attempt:${original.attemptId}` || !scope.resources.includes(`target:${this.deviceId}`)) throw new RefusedError('The frozen guest attempt does not match this target and original execution owner.');
    this.#recovery = { context: original, execution: scope, registered };
  }

  async registerGuestAttempt(binding: RecordingBinding, evidenceFile: string): Promise<GuestAttemptBinding> {
    const original = this.#recovery;
    const prepared = this.ownedRecordingEndpoint();
    if (!original || binding.attemptId !== original.context.attemptId || binding.runId !== original.context.runId
      || binding.deviceId !== this.deviceId || binding.platform !== this.platform || binding.generation !== prepared.identity.generation) throw new RefusedError('A recorder requires its original frozen attempt, resource, and generation authority.');
    if (this.#attempt && this.#attempt.evidenceFile !== evidenceFile) throw new RefusedError('The original evidence destination cannot be changed.');
    if (!this.#registration) {
      const worker = /^guest:([0-9a-f-]{36}):([1-9][0-9]*):([1-9][0-9]*)$/.exec(prepared.identity.workerId);
      if (!worker || worker[1] !== prepared.identity.machineId) throw new RefusedError('The original guest worker identity is unverified.');
      const identity = { machineId: prepared.identity.machineId, contextId: prepared.identity.instanceId, generation: prepared.identity.generation, epoch: Number(worker[3]), guestPid: Number(worker[2]), recorderId: randomUUID(), attemptId: binding.attemptId, runId: binding.runId };
      this.#registration = guestAttemptRecovery.register(prepared.serverUrl, { context: original.context, execution: original.execution, identity, evidenceFile }).then(value => {
        this.#check();
        if (value.binding.workerId !== prepared.identity.workerId) throw new RefusedError('The original native guest worker binding changed.');
        original.registered(value.source);
        this.#runtimeSource = value.source;
        this.#attempt = value.binding;
        return value.binding;
      });
    }
    const attempt = await this.#registration;
    if (attempt.evidenceFile !== evidenceFile || attempt.identity.contextId !== prepared.identity.instanceId || attempt.identity.generation !== prepared.identity.generation) throw new RefusedError('The original guest recorder binding cannot be replaced.');
    return structuredClone(attempt);
  }

  get guestAttemptBinding(): GuestAttemptBinding | null { return this.#attempt ? structuredClone(this.#attempt) : null; }
  get guestAttemptSource(): GuestRecoverySource | null { return this.#runtimeSource ? structuredClone(this.#runtimeSource) : null; }
  get guestBrowserObservations(): readonly GuestBrowserEvidence[] { return structuredClone(this.#runtimeObservations); }

  async observeGuestBrowserEvidence(): Promise<GuestBrowserEvidence> {
    const binding = this.#attempt, source = this.#runtimeSource;
    if (!binding || !source) throw new RefusedError('Guest runtime evidence requires the original registered attempt and existing browser session.');
    const endpoint = this.ownedRecordingEndpoint();
    this.#ownerGuard?.();
    const reply = await fetch(`${endpoint.serverUrl}/qautra/browser-evidence`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(40000),
      body: JSON.stringify({ source, nativeGeneration: binding.native.nativeGeneration, identity: binding.identity }),
    });
    if (!reply.ok || !reply.body) throw new RefusedError('The original guest browser runtime is fenced or unobserved.');
    const chunks: Uint8Array[] = []; let length = 0; const reader = reply.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 256 * 1024) throw new RefusedError('Guest runtime evidence exceeds its transport boundary.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    this.#check();
    this.#ownerGuard?.();
    const original = guestAttemptRecovery.read(`${binding.context.root}/.qa/instances`, source, binding.execution);
    const evidence = validateGuestBrowserEvidence(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown, original, source);
    const first = this.#runtimeObservations[0];
    if (first && (first.runtime.sessionId !== evidence.runtime.sessionId || first.runtime.ephemeral.profilePath !== evidence.runtime.ephemeral.profilePath)) throw new RefusedError('Guest runtime evidence cannot adopt a replacement browser session or profile.');
    this.#runtimeObservations.push(structuredClone(evidence));
    return evidence;
  }

  async prepareTarget(target: AppTarget): Promise<void> {
    const problem = targetProblem(this.platform, target);
    if (problem || target.kind !== 'web') throw new RefusedError(problem ?? 'guest 브라우저에는 승인된 웹 대상이 필요합니다.');
    if (!this.#origins || target.origins.length !== this.#origins.length || target.origins.some((origin, index) => origin !== this.#origins![index])) {
      if (this.#origins && this.#recovery) throw new RefusedError('The frozen guest attempt cannot replace its prepared context or origins.');
      if (this.#recordingGuard) throw new RefusedError('활성 recorder의 context·origin 권한을 다시 준비할 수 없습니다. 녹화 확정 후 새 attempt를 준비하세요.');
      if (this.#origins) await this.close();
      this.#options.serverUrl = await this.#access.prepare(target.origins);
      this.#identity = this.#access.execution();
      this.#origins = [...target.origins];
    }
    this.#check();
  }

  override async open(target: AppTarget): Promise<void> {
    const problem = targetProblem(this.platform, target);
    if (problem || target.kind !== 'web') throw new RefusedError(problem ?? 'guest 브라우저에는 승인된 웹 대상이 필요합니다.');
    try {
      await this.prepareTarget(target);
      await super.open(target);
    } catch (error) {
      if (error instanceof InstanceExecutionError) {
        if (error.effect === 'not_started') throw new RefusedError(error.message);
        this.#access.unknown?.(error.code);
        throw new StepError({ status: 'uncertain', ms: 0, error: error.message });
      }
      if (failureStatus(error) === 'uncertain') this.#access.unknown?.('guest_open_unknown');
      throw error;
    }
  }

  override async close(): Promise<void> {
    this.#closing = true;
    try { await super.close(); }
    catch (error) {
      this.#access.unknown?.('guest_close_unknown');
      throw error;
    }
    finally { this.#closing = false; }
  }
}
