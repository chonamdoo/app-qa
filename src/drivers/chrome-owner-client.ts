import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentExecutionError } from '../core/agent.ts';
import { ChromeOwnerRecordingSchema, ChromeOwnerReplySchema, ChromeOwnerRequestSchema, ChromeOwnerResults, ChromeRecordingBindingSchema, type ChromeNativeStatus, type ChromeOwnerLocator, type ChromeOwnerRecording, type ChromeOwnerRequestInput, type ChromeOwnerScope, type ChromeOwnerState } from '../core/chrome-owner.ts';
import { authenticChromeOwnerReply, readChromeOwnerResponse, type ChromeOwnerCredentials } from '../core/chrome-owner-auth.ts';
import { readPrivateFile, sha256 } from '../core/fsx.ts';
import { recordingCleanupConfirmed, type StartTargetRecording, type TargetRecording } from '../core/recording.ts';
import type { OwnedChromeEndpoint } from './owned-chrome.ts';
import { assertChromeOwnerMaterial, createChromeOwnerMaterial, readChromeOwnerAddress, readChromeOwnerMaterial, readChromeOwnerState, type ChromeOwnerMaterial } from './chrome-owner-storage.ts';

type Method = ChromeOwnerRequestInput['method'];
type Result<M extends Method> = z.infer<(typeof ChromeOwnerResults)[M]>;
const unknown = (code: string, message: string): AgentExecutionError => new AgentExecutionError(code, message, 'unknown');
function validateState(material: ChromeOwnerMaterial, state: ChromeOwnerState): ChromeOwnerState {
  if (state.seedSha256 !== material.locator.seedSha256 || JSON.stringify(state.scope) !== JSON.stringify(material.seed.scope)) throw unknown('native_scope_changed', '원 native 소유자·세대와 응답이 다릅니다');
  if (state.phase === 'ready' && (!state.endpoint || state.native?.browser.state !== 'running' || state.native.driver.state !== 'running' || state.native.profile !== 'retained')) throw unknown('native_state_invalid', '준비 상태에 실제 browser·driver·profile 소유 증거가 없습니다');
  const files = new Set<string>();
  let binding: string | null = null;
  for (const record of state.recordings) {
    const local = relative(state.scope.projectRoot, resolve(record.file));
    if (!local || local === '..' || local.startsWith(`..${sep}`) || local.startsWith(sep) || record.binding.deviceId !== state.scope.deviceId || record.binding.generation !== (state.scope.instance?.generation ?? null) || files.has(record.file) || (binding !== null && binding !== JSON.stringify(record.binding))) throw unknown('native_recording_scope_changed', '원 capture 경로·binding·세대가 변경되었습니다');
    files.add(record.file); binding = JSON.stringify(record.binding);
    if (record.state === 'stopped' && (!record.segment || record.segment.file !== record.file || record.segment.source !== 'chrome-page' || !recordingCleanupConfirmed(record.status) || record.status.media !== 'valid' || record.status.file !== 'durable')) throw unknown('native_recording_state_invalid', '녹화 완료 상태에 원 미디어·정리 증거가 없습니다');
    if (record.state === 'recording' && (!record.readyAt || !record.firstFrameAt)) throw unknown('native_recording_state_invalid', '녹화 준비 상태에 실제 첫 프레임 시각이 없습니다');
  }
  if (state.phase === 'closed') {
    const stopped = (fact: NonNullable<ChromeOwnerState['native']>['browser']): boolean => ['stopped', 'spawn-failed', 'not-started'].includes(fact.state);
    if (!state.native || !stopped(state.native.browser) || !stopped(state.native.driver) || state.native.profile === 'retained' || !state.evidenceFinalized || !state.evidenceFile || !/^evidence-[a-f0-9-]{36}\.jsonl$/.test(state.evidenceFile) || !state.evidenceSha256 || state.recordings.some(record => ['starting', 'recording', 'stopping'].includes(record.state) || !recordingCleanupConfirmed(record.status))) throw unknown('native_closed_unverified', '실제 native 종료·capture 정리·저장된 증거가 모두 확인되지 않았습니다');
  }
  return state;
}
function terminalState(material: ChromeOwnerMaterial): ChromeOwnerState {
  const state = validateState(material, readChromeOwnerState(material));
  if (state.phase !== 'closed' || !state.evidenceFile || !state.evidenceSha256) throw unknown('native_stop_unconfirmed', '원 native 종료가 아직 확정되지 않았습니다');
  if (sha256(readPrivateFile(join(material.locator.directory, state.evidenceFile), 64 * 1024 * 1024)) !== state.evidenceSha256) throw unknown('native_evidence_unverified', '원 native 증거 목록이 변경되었거나 저장되지 않았습니다');
  return state;
}
async function requestOwner<M extends Method>(material: ChromeOwnerMaterial, recovery: boolean, input: Extract<ChromeOwnerRequestInput, { method: M }>, timeoutMs = 5000): Promise<Result<M>> {
  assertChromeOwnerMaterial(material);
  const command = ChromeOwnerRequestSchema.parse({ ...input, id: randomUUID(), ownerId: material.locator.ownerId, seedSha256: material.locator.seedSha256 });
  const port = readChromeOwnerAddress(material);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/control`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-qautra-owner-token': recovery ? material.seed.recoveryToken : material.seed.controlToken, 'x-qautra-owner-request': command.id },
      body: JSON.stringify(command),
    });
    const text = await readChromeOwnerResponse(response, 2 * 1024 * 1024);
    if (!authenticChromeOwnerReply(material.seed.replyKey, command.id, response.status, text, response.headers.get('x-qautra-owner-signature'))) throw unknown('native_reply_unverified', 'Native 응답 서명·challenge를 확인하지 못했습니다');
    const reply = ChromeOwnerReplySchema.parse(JSON.parse(text));
    if (!response.ok || reply.id !== command.id || reply.ownerId !== material.locator.ownerId) throw unknown('native_reply_unverified', '원 native 요청과 응답 identity가 다릅니다');
    if (!reply.ok) throw new AgentExecutionError(reply.error.code, reply.error.message, reply.error.effect);
    return ChromeOwnerResults[input.method].parse(reply.result) as Result<M>;
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    throw unknown('native_response_unknown', '원 native 응답을 받지 못했습니다. 실행·정리 요청을 자동 재전송하지 않습니다');
  }
}
export async function observeChromeOwner(locator: ChromeOwnerLocator): Promise<ChromeOwnerState> {
  const material = readChromeOwnerMaterial(locator);
  try {
    const state = validateState(material, await requestOwner(material, true, { method: 'status' }));
    return state.phase === 'closed' ? terminalState(material) : state;
  }
  catch { return terminalState(material); }
}
export async function stopChromeOwner(locator: ChromeOwnerLocator): Promise<ChromeOwnerState> {
  const material = readChromeOwnerMaterial(locator);
  try { validateState(material, await requestOwner(material, true, { method: 'native.stop' }, 180_000)); }
  catch (error) { try { return terminalState(material); } catch { throw error; } }
  return terminalState(material);
}
export interface ChromeOwnerOptions {
  projectRoot: string; registryRoot?: string; deviceId: string;
  execution?: ChromeOwnerScope['execution']; instance?: ChromeOwnerScope['instance'];
  onCreated?: (locator: ChromeOwnerLocator) => void;
}
export class ChromeOwnerClient implements OwnedChromeEndpoint {
  readonly #material: ChromeOwnerMaterial;
  readonly locator: ChromeOwnerLocator;
  #state: ChromeOwnerState | null = null;
  #failure: Error | null = null;
  #start: Promise<void> | null = null;
  #close: Promise<void> | null = null;
  #closing = false;
  #poll: NodeJS.Timeout | null = null;
  #polling = false;
  readonly #captures = new Map<string, { view: ChromeOwnerRecording; lost: PromiseWithResolvers<Error> }>();
  constructor(options: ChromeOwnerOptions) {
    this.#material = createChromeOwnerMaterial(options);
    this.locator = Object.freeze({ ...this.#material.locator });
    options.onCreated?.(this.locator);
  }
  get credentials(): ChromeOwnerCredentials { return { token: this.#material.seed.controlToken, replyKey: this.#material.seed.replyKey }; }
  get url(): string { return `http://127.0.0.1:${readChromeOwnerAddress(this.#material)}/webdriver`; }
  #endpoint(): NonNullable<ChromeOwnerState['endpoint']> { if (!this.#state?.endpoint) throw unknown('native_endpoint_unavailable', '원 Chrome endpoint를 확인할 수 없습니다'); return this.#state.endpoint; }
  get debuggerAddress(): string { return this.#endpoint().debuggerAddress; }
  get profile(): string { return this.#endpoint().profile; }
  get binary(): string { return this.#endpoint().binary; }
  get args(): readonly string[] { return this.#endpoint().args; }
  nativeStatus(): ChromeNativeStatus { if (!this.#state?.native) throw unknown('native_status_unavailable', '원 native 종료를 확인할 수 없습니다'); return structuredClone(this.#state.native); }
  assertHealthy(): void { if (this.#failure) throw this.#failure; if (this.#closing || this.#state?.phase !== 'ready') throw unknown('native_owner_not_ready', '원 native 소유자가 새 동작을 허용하지 않습니다'); }
  #latch(error: Error): void {
    this.#failure ??= error;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    for (const capture of this.#captures.values()) capture.lost.resolve(this.#failure);
  }
  #accept(state: ChromeOwnerState): void {
    validateState(this.#material, state);
    const views = new Map(state.recordings.map(view => [view.id, view]));
    for (const [id, capture] of this.#captures) {
      const view = views.get(id);
      if (!view || view.file !== capture.view.file || JSON.stringify(view.binding) !== JSON.stringify(capture.view.binding)) throw unknown('native_capture_identity_changed', '원 capture가 다른 기록으로 변경되었습니다');
    }
    this.#state = state;
    for (const [id, capture] of this.#captures) {
      const view = views.get(id)!;
      capture.view = view;
      if (view.problem) capture.lost.resolve(new AgentExecutionError(view.problem.code, view.problem.message, view.problem.effect));
    }
    if (!this.#closing && !['ready', 'preparing'].includes(state.phase)) this.#latch(unknown(state.problem?.code ?? 'native_owner_fenced', state.problem?.message ?? '원 native 소유자가 새 동작을 차단했습니다'));
  }
  async start(): Promise<void> {
    if (this.#start) return this.#start;
    this.#start = (async () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./chrome-owner-worker.ts', import.meta.url)), this.locator.directory, this.locator.ownerId, this.locator.seedSha256], {
        cwd: this.#material.seed.runtimeRoot, detached: true, stdio: 'ignore',
        env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      });
      child.once('error', () => this.#latch(unknown('native_owner_start_unknown', '원 native owner 시작 응답을 확인하지 못했습니다')));
      child.once('exit', () => {
        try { this.#state = terminalState(this.#material); }
        catch { this.#latch(unknown('native_owner_exit_unconfirmed', '원 native owner가 종료되었으나 browser·driver·증거 저장은 미확인입니다')); }
      });
      child.unref();
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        if (this.#failure) throw this.#failure;
        try {
          await requestOwner(this.#material, false, { method: 'heartbeat' });
          this.#accept(await requestOwner(this.#material, false, { method: 'status' }));
          if (this.#state?.phase === 'ready') {
            this.#poll = setInterval(() => void this.#tick(), 1000).unref();
            return;
          }
          if (this.#state?.phase === 'closed') throw unknown('native_start_failed', '원 native Chrome을 준비하지 못했습니다');
        } catch (error) {
          if (this.#failure || !(error instanceof Error) || ('code' in error && error.code !== 'ENOENT' && !(error instanceof AgentExecutionError && error.code === 'native_response_unknown'))) throw error;
        }
        await delay(50);
      }
      throw unknown('native_owner_readiness_unknown', '원 native owner 준비를 확인하지 못했습니다. 다른 owner를 시작하지 않습니다');
    })().catch(error => { this.#latch(error instanceof Error ? error : unknown('native_owner_start_unknown', '원 native 준비 결과가 미확인입니다')); throw error; });
    return this.#start;
  }
  async #tick(): Promise<void> {
    if (this.#polling || this.#closing || this.#failure) return;
    this.#polling = true;
    try { await requestOwner(this.#material, false, { method: 'heartbeat' }); this.#accept(await requestOwner(this.#material, false, { method: 'status' })); }
    catch (error) { if (!this.#closing) this.#latch(error instanceof Error ? error : unknown('native_owner_unknown', '원 native 상태가 미확인입니다')); }
    finally { this.#polling = false; }
  }
  async close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#close = (async () => {
      try { this.#accept(await requestOwner(this.#material, false, { method: 'native.stop' }, 180_000)); }
      catch (error) { try { this.#accept(terminalState(this.#material)); return; } catch { throw error; } }
      this.#accept(terminalState(this.#material));
    })();
    return this.#close;
  }
  async startRecording(input: Parameters<StartTargetRecording>[0]): Promise<TargetRecording> {
    this.assertHealthy(); input.signal.throwIfAborted();
    const id = randomUUID(), binding = ChromeRecordingBindingSchema.parse(input.binding), file = resolve(input.file);
    const lost = Promise.withResolvers<Error>();
    const cancel = (): void => {
      lost.resolve(unknown('capture_permission_withdrawn', '원 capture가 취소되었습니다'));
      void requestOwner(this.#material, false, { method: 'recording.cancel', recordingId: id }).catch(error => this.#latch(error instanceof Error ? error : unknown('native_capture_cancel_unknown', '원 capture 취소가 미확인입니다')));
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    let initial: ChromeOwnerRecording;
    try { initial = await requestOwner(this.#material, false, { method: 'recording.start', recordingId: id, binding, file, captureExpiresAt: input.captureExpiresAt ?? null }, 30_000); }
    catch (error) { input.signal.removeEventListener('abort', cancel); this.#latch(error instanceof Error ? error : unknown('native_capture_start_unknown', '원 capture 시작 결과가 미확인입니다')); throw error; }
    if (initial.id !== id || initial.file !== file || JSON.stringify(initial.binding) !== JSON.stringify(binding)) throw unknown('native_capture_identity_changed', '원 capture 시작 응답이 다른 기록입니다');
    const capture = { view: initial, lost }; this.#captures.set(id, capture);
    const update = (value: ChromeOwnerRecording): ChromeOwnerRecording => {
      const parsed = ChromeOwnerRecordingSchema.parse(value);
      if (parsed.id !== id || parsed.file !== file || JSON.stringify(parsed.binding) !== JSON.stringify(binding)) throw unknown('native_capture_identity_changed', '원 capture 응답이 다른 기록입니다');
      capture.view = parsed;
      if (parsed.problem) lost.resolve(new AgentExecutionError(parsed.problem.code, parsed.problem.message, parsed.problem.effect));
      return parsed;
    };
    if (initial.state !== 'recording' || !initial.readyAt || !initial.firstFrameAt) {
      input.signal.removeEventListener('abort', cancel);
      throw new AgentExecutionError(initial.problem?.code ?? 'native_capture_not_ready', initial.problem?.message ?? '원 capture 준비를 확정하지 못했습니다', initial.problem?.effect ?? 'unknown');
    }
    let stopped: Promise<NonNullable<ChromeOwnerRecording['segment']>> | null = null;
    const healthy = (): void => { this.assertHealthy(); if (input.signal.aborted) throw unknown('capture_permission_withdrawn', '원 capture가 취소되었습니다'); if (capture.view.problem || capture.view.state !== 'recording') throw unknown(capture.view.problem?.code ?? 'native_capture_lost', capture.view.problem?.message ?? '원 capture가 새 동작을 기록할 수 없습니다'); };
    return {
      readyAt: initial.readyAt, firstFrameAt: initial.firstFrameAt, maxDurationMs: initial.maxDurationMs, lost: lost.promise,
      assertHealthy: healthy,
      beforeDispatch: async () => { healthy(); await requestOwner(this.#material, false, { method: 'recording.before', recordingId: id }); },
      status: async () => {
        try { update(await requestOwner(this.#material, false, { method: 'recording.status', recordingId: id })); }
        catch (error) { lost.resolve(error instanceof Error ? error : unknown('native_capture_status_unknown', '원 capture 상태가 미확인입니다')); throw error; }
        return structuredClone(capture.view.status);
      },
      stop: async () => {
        stopped ??= (async () => {
          try {
            const view = update(await requestOwner(this.#material, false, { method: 'recording.stop', recordingId: id }, 180_000));
            if (view.state !== 'stopped' || !view.segment || !recordingCleanupConfirmed(view.status) || view.status.media !== 'valid' || view.status.file !== 'durable') throw unknown(view.problem?.code ?? 'native_recording_stop_unknown', view.problem?.message ?? '원 capture 종료·미디어를 확정하지 못했습니다');
            return view.segment;
          } finally { input.signal.removeEventListener('abort', cancel); }
        })();
        return stopped;
      },
    };
  }
}
