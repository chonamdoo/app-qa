// Runner programmatic API (architecture §10): the CLI, the engine server and the planner all call these.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentExecutionError, AgentRequestSchema, type AgentRequest, type AgentService, type AgentSessionView } from '../core/agent.ts';
import { createExecutionAdmission, type ExecutionAdmission } from '../core/admission.ts';
import { InstanceExecutionError, type InstanceProfile, type InstanceRequest } from '../core/instances.ts';
import type { RegressionPreflightCheck, RegressionRequest, RegressionTarget } from '../core/regression.ts';
import { RegressionGrantError } from '../core/regression-grant.ts';
import { ProjectFixtureError } from '../core/project-fixture.ts';
import { PATHS } from '../core/config.ts';
import type { EventSink } from '../core/events.ts';
import { newRunId, sha256, writeJson, writeSecure } from '../core/fsx.ts';
import { PLATFORM_INFO, PLATFORMS } from '../core/platform.ts';
import type { AppTarget, DeviceInfo, Driver, Platform, ScreenModel, Verdict, WebTarget } from '../core/types.ts';
import { acquireDeviceLock, createDriver, failureStatus, listDevices, pickDevice } from '../drivers/index.ts';
import { createGuestMachineBackend } from '../drivers/vm/backend.ts';
import { DesktopWebDriver } from '../drivers/desktop.ts';
import { prepareTargetRecording, startTargetRecording } from '../drivers/recording.ts';
import { GuestDesktopDriver } from '../drivers/vm/driver.ts';
import { JevClient } from '../jev/client.ts';
import { loadJevConfig } from '../jev/config.ts';
import { loadCalibration } from '../jev/gates.ts';
import { buildScreenModel, candidateRow, normLabel, runOcr } from '../observe/index.ts';
import { OCR_HELPER } from '../ocr/ocr.ts';
import { exitCodeFor } from '../report/console.ts';
import { writeReports } from '../report/index.ts';
import { countQaStatuses, qaStatus, type QaStatus } from '../report/status.ts';
import { SUMMARY_SCHEMA, type RunSummary, type TestResult } from '../report/types.ts';
import { writeWebQa } from '../report/webqa.ts';
import { loadAppProfile, loadTests, type LoadedTest } from '../spec/load.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';
import { appTarget, DEFAULT_TIMEOUT_MS, TestSession, type Clock, type FrozenSessionAuthority, type JevSetup, type OcrFn, type SessionEnv } from './engine.ts';
import { createAgentScripts } from './agent-scripts.ts';
import { createAgentSessions } from './agent-sessions.ts';
import { createDesktopInstances, type DesktopInstances } from './desktop-instances.ts';
import { createRegressionService } from './regression.ts';
import { executeFrozenAttempt } from './attempt.ts';
import { writeInventory } from './inventory.ts';
import { EvidenceSanitizer } from './sanitize.ts';
import { assessRisk } from '../policy/risk.ts';
import { inspectProjectFixtureAuthority } from './project-fixture.ts';
import { RunStore } from './store.ts';
import { countVerdicts } from './verdict.ts';
import { attemptResourcesRecovered, latestRecoveryObservation, verifyExecutionRecovery } from './recovery.ts';
import { NativeAttemptBindingSchema, type ExecutionRecoveryView, ExecutionRecoveryViewSchema, type InstanceRecoverySummary } from '../core/recovery.ts';
import { chromeAttemptRecovery } from '../drivers/chrome-attempt-recovery.ts';
import { guestAttemptRecovery } from '../drivers/vm/attempt-recovery.ts';
import { planExecutionFlows } from './execution-chains.ts';
import type { ExecutionChain } from '../core/execution-chain.ts';
import { observeAttemptBrowser } from './conditions.ts';

export type { DecisionSummary, StepResult, TestResult } from '../report/types.ts';
export { appTarget } from './engine.ts';

export interface RunResult {
  runId: string;
  runDir: string;
  counts: Record<Verdict, number>;
  qaCounts: Record<QaStatus, number>;
  tests: TestResult[];
  reportPath: string;
  junitPath: string | null;
  /** Run-relative `web-qa/plan.json` + `result.json` (check-run v1) when the run had website results, else empty. */
  webQa: string[];
}

export interface RunOptions {
  paths: string[];
  platform: Platform | 'all';
  deviceIds?: Partial<Record<Platform, string>>;
  tags?: string[];
  junit?: boolean;
  events?: EventSink;
  signal?: AbortSignal;
  frozen?: {
    ownerId: string;
    tests: readonly LoadedTest[];
    chain: ExecutionChain | null;
    clean: EvidenceSanitizer;
    authority(testId: string): FrozenSessionAuthority;
    created(runDir: string, runId: string): void;
    beforeOpen(driver: Driver, device: DeviceInfo, target: AppTarget, runDir: string, runId: string): Promise<void>;
    opened(driver: Driver, device: DeviceInfo, runDir: string, runId: string): Promise<void>;
    evaluated(result: TestResult): void;
    beforeClose(): Promise<void>;
    closed(confirmed: boolean): void;
  };
}

export interface SmokeOptions {
  app: string;
  platform: Platform;
  deviceId?: string;
  crawl?: 'tabs';
  events?: EventSink;
  signal?: AbortSignal;
}

export interface ScreenOptions {
  app: string;
  platform: Platform;
  deviceId?: string;
  events?: EventSink;
  signal?: AbortSignal;
}

/** Injection seam (tests, alternative device backends). Anything omitted uses the real implementation. */
export interface RunnerDeps {
  createDriver(platform: Platform, deviceId: string): Driver;
  pickDevice(platform: Platform, id?: string): Promise<DeviceInfo>;
  /** Throws when another live process holds the device. */
  acquireLock(deviceId: string, runId?: string, cancel?: () => Promise<void>): { release(): void };
  jev(): JevSetup;
  ocr: OcrFn | null;
  clock: Clock;
  root: string;
  runsDir: string;
  appsDir: string;
  inventoryDir: string;
  fixturesDir: string;
  instanceProfiles?: () => Promise<readonly InstanceProfile[]>;
  admission: ExecutionAdmission;
  uncertain?: (reason: string) => void;
}

const realClock: Clock = { now: () => performance.now(), sleep: (ms) => delay(ms) };

/** Jev client + calibration from the environment; problems are carried as a reason (Jev steps then ERROR). */
function realJev(): JevSetup {
  let client: JevClient | null = null;
  let problem: string | null = null;
  try {
    client = new JevClient(loadJevConfig());
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  let calibration = null;
  try {
    calibration = loadCalibration(client?.model);
  } catch (err) {
    problem ??= `캘리브레이션 파일 오류: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { client, calibration, problem };
}

function resolveDeps(partial: Partial<RunnerDeps> = {}): RunnerDeps {
  const admission: ExecutionAdmission = partial.admission ?? createExecutionAdmission(undefined, {
    verifyRecovery: scope => verifyExecutionRecovery(admission.directory, scope, chromeAttemptRecovery, guestAttemptRecovery),
  });
  return {
    createDriver: partial.createDriver ?? ((platform, id) => createDriver(platform, id)),
    pickDevice: partial.pickDevice ?? pickDevice,
    acquireLock: partial.acquireLock ?? ((id) => acquireDeviceLock(id)),
    jev: partial.jev ?? realJev,
    ocr: partial.ocr !== undefined ? partial.ocr : existsSync(OCR_HELPER) ? runOcr : null,
    clock: partial.clock ?? realClock,
    root: partial.root ?? PATHS.root,
    runsDir: partial.runsDir ?? PATHS.runs,
    appsDir: partial.appsDir ?? PATHS.apps,
    inventoryDir: partial.inventoryDir ?? PATHS.inventory,
    fixturesDir: partial.fixturesDir ?? PATHS.fixtures,
    admission,
    uncertain: partial.uncertain,
  };
}

function posixRel(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A test × platform that could not run (spec error, no device, locked, session failure, cancelled), sanitized like a
 * session's result by `clean` (profile `redact` and the secrets it knows; a spec that did not load: built-ins only).
 */
function unrunResult(
  base: { id: string; name: string; file: string | null; app: string; test: LoadedTest | null },
  platform: Platform,
  verdict: Verdict,
  code: string,
  reason: string,
  device: DeviceInfo | null,
  clean: EvidenceSanitizer,
): TestResult {
  const spec = base.test?.spec;
  return clean.deep({
    id: base.id,
    name: base.name,
    file: base.file,
    app: base.app,
    platform,
    surface: base.test ? (base.test.profile.web ? 'web' : 'app') : null,
    deviceId: device?.id ?? null,
    deviceName: device?.name ?? null,
    verdict,
    code,
    qaStatus: qaStatus({ verdict, code }),
    reason,
    durationMs: 0,
    covers: spec?.covers ?? [],
    tags: spec?.tags ?? [],
    status: spec?.source?.status ?? null,
    plan: spec?.source?.plan ?? null,
    steps: [],
    warnings: [],
    health: [],
    logs: null,
    crash: [],
    evidenceDir: `${base.id}/${platform}`,
  });
}

/** A lock released at most once, including cleanup for work that never ran. */
interface Held {
  lock: { release(): void } | null;
}

interface Slot extends Held {
  platform: Platform;
  device: DeviceInfo | null;
  problem: { code: string; reason: string } | null;
}

function releaseHeld(held: Held): void {
  const lock = held.lock;
  held.lock = null;
  lock?.release();
}

function isDesktop(platform: Platform): boolean {
  return PLATFORM_INFO[platform].host === 'desktop';
}

async function closeDriver(driver: Driver): Promise<void> {
  await driver.close();
  const problem = driver.displayProblem?.();
  if (problem) throw new Error(problem);
}

export interface AgentExecutionService extends AgentService {
  runnerDeps: Partial<RunnerDeps>;
  devices(): Promise<DeviceInfo[]>;
  frame(platform: Platform, deviceId: string): Promise<Uint8Array>;
}

export function createAgentService(partial: Partial<RunnerDeps> = {}, events?: EventSink): AgentExecutionService {
  const d = resolveDeps(partial);
  let profiles: readonly InstanceProfile[] = [];
  let instances: DesktopInstances | undefined;
  let regressions: ReturnType<typeof createRegressionService> | undefined;
  let stopping = false;
  let instanceRecovery: InstanceRecoverySummary | null = null;
  const recoveryView = (attemptId?: string): ExecutionRecoveryView => ExecutionRecoveryViewSchema.parse({
    kind: 'resource-verification-only', admission: d.admission.status(),
    observation: latestRecoveryObservation(d.admission.directory, attemptId), instances: attemptId ? null : instanceRecovery, originalOutcomePreserved: true,
  });
  const legacy = new Map<string, { sessionId: string; cancel: (() => Promise<void>) | undefined; lease: ReturnType<DesktopInstances['acquire']>; unknown: boolean }>();
  const desktopPlatform = (platform: Platform): platform is 'desktop-chrome' | 'desktop-safari' => platform === 'desktop-chrome' || platform === 'desktop-safari';
  const instanceRequest = (request: AgentRequest): request is InstanceRequest => request.method.startsWith('instance.');
  const regressionRequest = (request: AgentRequest): request is RegressionRequest => request.method.startsWith('scenario.') || request.method.startsWith('regression.');
  const desktop = (): DesktopInstances => {
    if (stopping && !instances) throw new AgentExecutionError('engine_stopping', '엔진이 종료 중임');
    instances ??= createDesktopInstances({
      root: d.root, backend: createGuestMachineBackend(d.root), profiles: () => profiles, admissionDirectory: d.admission.directory, nativeRecovery: chromeAttemptRecovery,
      cancelExecution: async sessionId => {
        const held = [...legacy.values()].find(entry => entry.sessionId === sessionId);
        if (held) {
          if (!held.cancel) throw new AgentExecutionError('guest_cancel_unavailable', '이 실행의 취소·종료 확인 경로가 없습니다.');
          await held.cancel();
          return;
        }
        const status = await sessions.call({ method: 'session.status', sessionId });
        if (!status.ok) throw new AgentExecutionError(status.error.code, status.error.message, status.error.effect);
        const view = status.result as AgentSessionView;
        if (view.activeScriptId) {
          const cancelled = await scripts.call({ method: 'script.cancel', scriptId: view.activeScriptId });
          if (!cancelled.ok) throw new AgentExecutionError(cancelled.error.code, cancelled.error.message, cancelled.error.effect);
        }
        const reply = await sessions.call({ method: 'session.close', sessionId });
        if (!reply.ok) throw new AgentExecutionError(reply.error.code, reply.error.message, reply.error.effect);
      },
    });
    return instances;
  };
  const managedDevice = (id: string): boolean => id.startsWith('guest:') || id.startsWith('chrome:');
  const frozenTargetSupported = (target: RegressionTarget): boolean => desktopPlatform(target.platform) && managedDevice(target.deviceId);
  const unknown = (id: string, reason: string): void => {
    const held = legacy.get(id);
    if (held) { held.unknown = true; held.lease.unknown(reason); }
    d.uncertain?.(reason);
  };
  class OwnedInstanceDriver extends DesktopWebDriver {
    constructor(id: string) {
      super('desktop-chrome', id, {
        onUncertain: reason => unknown(id, reason),
        nativeOwner: async () => {
          const instance = desktop().execution(id), execution = await d.admission.ownerContext();
          if (!instance || instance.runtime !== 'owned-chrome' || !execution || !execution.resources.includes(`target:${id}`)) throw new AgentExecutionError('chrome_owner_unconfirmed', '원 instance·전역 실행 세대를 확인하지 못했습니다', 'unknown');
          return {
            projectRoot: d.root, registryRoot: join(d.admission.directory, 'native-owners'),
            execution: { ...execution, resources: [...execution.resources] },
            instance: { instanceId: instance.instanceId, generation: instance.generation, workerId: instance.workerId },
            onCreated: locator => desktop().bindNativeOwner(id, locator),
          };
        },
      });
    }
    override async open(target: AppTarget): Promise<void> {
      if (target.kind !== 'web') throw new AgentExecutionError('web_target_required', 'Chrome에는 승인된 웹 대상이 필요합니다');
      await desktop().prepare(this.deviceId, target.origins);
      await super.open(target);
      const owner = desktop().execution(this.deviceId);
      if (!owner || owner.runtime !== 'owned-chrome') throw new AgentExecutionError('chrome_owner_unconfirmed', '실제 Chrome context의 소유권을 확인하지 못했습니다', 'unknown');
      const connection = this.ownedChromeConnection();
      desktop().bindOwnedChrome(this.deviceId, { ...connection, identity: { instanceId: owner.instanceId, generation: owner.generation, workerId: owner.workerId, ...connection.identity } });
    }
  }
  const driver = (platform: Platform, id: string): Driver => {
    if (!desktopPlatform(platform) || partial.createDriver) return d.createDriver(platform, id);
    if (platform === 'desktop-chrome' && id.startsWith('chrome:')) return new OwnedInstanceDriver(id);
    if (!id.startsWith('guest:')) throw new AgentExecutionError('owned_instance_required', 'QAutra 소유 Chrome context 또는 준비된 실제 Safari worker를 선택하세요. 개인 브라우저는 대체 경로가 아닙니다.');
    const held = legacy.get(id);
    return new GuestDesktopDriver(platform, id, {
      prepare: origins => desktop().prepare(id, origins),
      execution: cleanup => {
        if (held && legacy.get(id) !== held) return null;
        const owner = desktop().execution(id, cleanup);
        return owner?.runtime === 'macos-guest' ? owner : null;
      },
      unknown: reason => unknown(id, reason),
    });
  };
  const select = (platform: Platform, id?: string): Promise<DeviceInfo> => desktopPlatform(platform) && !partial.pickDevice ? desktop().pick(platform, id) : d.pickDevice(platform, id);
  const runnerDeps: Partial<RunnerDeps> = {
    ...d, createDriver: driver, pickDevice: select,
    acquireLock: (id, runId, cancel) => {
      if (!managedDevice(id) || partial.createDriver) return d.acquireLock(id, runId, cancel);
      const sessionId = randomUUID();
      const held = { sessionId, cancel, lease: desktop().acquire(id, runId ?? null, sessionId, runId ? 'run' : 'screen'), unknown: false };
      legacy.set(id, held);
      return { release: () => {
        if (held.unknown) return;
        held.lease.ended();
        if (legacy.get(id) === held) legacy.delete(id);
      } };
    },
  };
  const sessions = createAgentSessions({
    root: d.root, runsDir: d.runsDir, appsDir: d.appsDir, clock: d.clock, ocr: d.ocr, events,
    createDriver: driver, pickDevice: select,
    execution: (id, cleanup) => managedDevice(id) && !partial.createDriver ? desktop().execution(id, cleanup) : null,
    openFailureProvenRejected: error => failureStatus(error) === 'rejected',
    acquireSession: (platform, deviceId, runId, sessionId) => {
      const reservation = d.admission.acquire(`session:${sessionId}`, `target:${deviceId}`);
      let lease: { ended(): void; unknown(reason: string): void };
      try {
        if (desktopPlatform(platform) && !partial.createDriver) lease = desktop().acquire(deviceId, runId, sessionId);
        else {
          const lock = d.acquireLock(deviceId, runId);
          let uncertain = false;
          lease = { ended: () => { if (!uncertain) lock.release(); }, unknown: () => { uncertain = true; } };
        }
      } catch (error) { reservation.ended(); throw error; }
      return {
        ended: () => { lease.ended(); reservation.closing(); reservation.ended(); },
        unknown: reason => { reservation.unknown(reason); lease.unknown(reason); },
      };
    },
  });
  const scripts = createAgentScripts(sessions, { root: d.root });
  const regression = (): ReturnType<typeof createRegressionService> => regressions ??= createRegressionService({
    root: d.root, appsDir: d.appsDir, generatedDir: join(d.root, 'tests', 'generated'),
    resourcesRecovered: attempt => attemptResourcesRecovered(d.admission.directory, d.root, attempt, chromeAttemptRecovery, guestAttemptRecovery),
    supportsTarget: frozenTargetSupported,
    execute: input => executeFrozenAttempt(input, {
      root: d.root, appsDir: d.appsDir, admission: d.admission,
      run: options => runTests(options, runnerDeps),
      browserClient: driver => driver instanceof DesktopWebDriver ? driver : null,
      observeConditions: async driver => {
        if (driver instanceof GuestDesktopDriver) {
          const source = driver.guestAttemptSource, binding = driver.guestAttemptBinding;
          if (!source || !binding) throw new AgentExecutionError('guest_original_binding_unobserved', '원 guest의 등록된 실행 권위를 확인하지 못했습니다');
          return { browser: null, guest: { source, binding, browser: await driver.observeGuestBrowserEvidence() } };
        }
        if (driver instanceof DesktopWebDriver) return { browser: await observeAttemptBrowser(driver.ownedChromeIdentity) };
        throw new AgentExecutionError('actual_target_proof_unavailable', '실제 대상의 runtime 관측 경로가 없습니다');
      },
      bindRecoverySource: (driver, context) => {
        if (driver instanceof GuestDesktopDriver) {
          const execution = d.admission.ownerContext();
          if (!execution || execution.ownerId !== context.ownerId) throw new AgentExecutionError('execution_scope_changed', '원 전역 실행 세대를 확인하지 못했습니다', 'unknown');
          driver.setGuestAttemptRecovery(context, { ...execution, resources: [...execution.resources] }, source => d.admission.registerRecoverySource(execution, source));
          return;
        }
        if (!(driver instanceof DesktopWebDriver)) throw new AgentExecutionError('native_recovery_binding_required', '원 driver의 native 복구 등록 경로가 필요합니다');
        driver.setNativeOwnerObserver(locator => {
          const execution = d.admission.ownerContext();
          if (!execution || execution.ownerId !== context.ownerId) throw new AgentExecutionError('execution_scope_changed', '원 전역 실행 세대를 확인하지 못했습니다', 'unknown');
          const source = chromeAttemptRecovery.register(locator, NativeAttemptBindingSchema.shape.context.parse(context));
          d.admission.registerRecoverySource(execution, source);
        });
      },
      prepareRecording: prepareTargetRecording,
      startRecording: startTargetRecording,
      execution: (id, cleanup) => managedDevice(id) && !partial.createDriver ? desktop().execution(id, cleanup) : null,
      unknown,
    }),
    inspectAuthority: async binding => {
      try {
        inspectProjectFixtureAuthority({ root: d.root, binding });
        return [{ category: 'authority', target: binding.subject.target, status: 'verified', code: null,
          message: '보호된 adapter·credential·준비/정리·capture 범위를 확인했습니다. 현재 backend/client 증명과 첫 영상 frame은 점유 후 별도로 확인합니다.' }];
      } catch (error) {
        return [{ category: 'authority', target: binding.subject.target, status: 'blocked',
          code: error instanceof ProjectFixtureError || error instanceof RegressionGrantError ? error.code : 'fixture_authority_unavailable',
          message: '프로젝트의 보호된 adapter·credential 또는 허용 동작이 준비되지 않았습니다. 환경 책임자가 최초 구성을 완료해야 합니다.' }];
      }
    },
    inspectTarget: async target => {
      try {
        profiles = await partial.instanceProfiles?.() ?? [];
        const devices = desktopPlatform(target.platform) && !partial.pickDevice ? await desktop().devices(target.platform) : [await d.pickDevice(target.platform, target.deviceId)];
        const actual = devices.filter(device => device.id === target.deviceId && device.platform === target.platform);
        const ready = actual.length === 1 && actual[0]!.state === 'booted';
        return [
          { category: 'target', target, status: ready ? 'available' : 'blocked', code: ready ? null : 'target_not_ready', message: ready ? '등록된 실제 대상이 준비되어 있습니다. 점유 후 identity와 초기 상태를 다시 확인합니다' : '선택한 정확한 실제 대상이 준비되지 않았습니다' },
          { category: 'evidence', target, status: 'available', code: null, message: '실제 target 녹화 어댑터가 연결되어 있습니다. metadata는 준비 완료 증거가 아니며 점유 후 첫 실제 프레임을 확인합니다' },
        ] satisfies RegressionPreflightCheck[];
      } catch (error) {
        return [{ category: 'target', target, status: 'blocked', code: error instanceof InstanceExecutionError ? error.code : 'target_inspection_failed', message: '실제 대상과 녹화 지원을 확인하지 못했습니다' }];
      }
    },
    capacity: () => {
      const status = d.admission.status();
      return { category: 'capacity', target: null, status: status.state === 'unknown' ? 'blocked' : status.state === 'active' ? 'waiting' : 'available', code: status.state === 'unknown' ? 'execution_reconciliation_required' : null,
        message: status.state === 'unknown' ? '이전 실행의 자원·증거·효과 정리를 대조하기 전에는 재사용하지 않습니다' : status.state === 'active' ? '사용자 전체 동시 흐름 1개를 사용 중입니다. 현재 실행의 정리 후 순차 진행합니다' : '사용자 전체 동시 흐름 1개를 사용할 수 있습니다' };
    },
  });
  let shutdown: Promise<void> | undefined;
  return {
    runnerDeps,
    devices: async () => {
      const rows = (await Promise.all([listDevices('android'), listDevices('ios')])).flat();
      profiles = await partial.instanceProfiles?.() ?? [];
      try { rows.push(...await desktop().devices()); }
      catch (error) { events?.emit({ type: 'log', level: 'error', source: 'instances', message: `브라우저 기기 조회 실패: ${message(error)} — 모바일 기기는 별도로 유지합니다.` }); }
      return rows;
    },
    frame: async (platform, deviceId) => {
      if (!desktopPlatform(platform) || !managedDevice(deviceId)) throw new AgentExecutionError('owned_instance_required', '명시한 소유 context의 승인된 관측 화면을 선택하세요.');
      const reply = await sessions.call({ method: 'session.list' });
      if (!reply.ok) throw new AgentExecutionError(reply.error.code, reply.error.message, reply.error.effect);
      const views = reply.result as AgentSessionView[];
      const current = desktop().execution(deviceId);
      const owned = views.filter(view => view.deviceId === deviceId && view.platform === platform && view.state !== 'closed'
        && current && view.machineId === current.machineId && view.generation === current.generation && view.workerId === current.workerId);
      if (owned.length !== 1 || !owned[0]!.latestFrame) throw new AgentExecutionError('guest_frame_unavailable', '승인된 열린 QA 세션의 관측 화면이 아직 없습니다.');
      return readFileSync(join(d.runsDir, owned[0]!.runId, owned[0]!.latestFrame!.screenshot.path));
    },
    call: async (input, context = {}) => {
      const meta = { requestId: randomUUID(), at: new Date().toISOString() };
      if (stopping) return { ok: false, error: { code: 'engine_stopping', message: '엔진이 종료 중임', effect: 'not_started' }, meta };
      const parsed = AgentRequestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: { code: 'invalid_request', message: '실행 요청 형식이 유효하지 않음', effect: 'not_started' }, meta };
      const request = parsed.data;
      try {
        if (request.method === 'execution.status' || request.method === 'execution.reconcile') {
          if (context.scriptId || context.allowedSessionIds) throw new AgentExecutionError('scope_denied', '코드 묶음은 전역 실행 복구 권한을 가질 수 없습니다.');
          if (request.method === 'execution.reconcile') {
            if (!context.operatorReview) throw new AgentExecutionError('operator_action_required', '원 자원 복구 확인은 로컬 QA 앱의 명시적 사용자 작업으로만 수행합니다.');
            context.signal?.throwIfAborted();
            const status = d.admission.status();
            if (status.state === 'active') throw new AgentExecutionError('execution_active', '진행 중인 실행은 복구 확인으로 중지하거나 해제하지 않습니다.');
            if (status.state === 'unknown') await d.admission.reconcile();
            profiles = await partial.instanceProfiles?.() ?? [];
            instanceRecovery = await desktop().reconcileOwnedChrome();
          }
          return { ok: true, result: recoveryView(request.method === 'execution.status' ? request.attemptId : undefined), meta };
        }
        if (instanceRequest(request)) {
          if (context.scriptId || context.allowedSessionIds) throw new AgentExecutionError('scope_denied', '코드 묶음은 인스턴스 생성·부팅·자원 권한을 확장할 수 없습니다.');
          if (!['instance.list', 'instance.status'].includes(request.method) && !context.operatorReview) throw new AgentExecutionError('operator_action_required', '인스턴스 생성·준비·표시는 로컬 QA 앱의 명시적 사용자 작업으로만 수행합니다.');
          context.signal?.throwIfAborted();
          profiles = await partial.instanceProfiles?.() ?? [];
          if (stopping) throw new AgentExecutionError('engine_stopping', '프로필 조회 중 엔진이 종료됨 — 실행하지 않음');
          context.signal?.throwIfAborted();
          return { ok: true, result: await desktop().call(request), meta };
        }
        if (regressionRequest(request)) {
          if (context.scriptId || context.allowedSessionIds) throw new AgentExecutionError('scope_denied', '코드 묶음은 시나리오 발행·새 실행·자원 권한을 만들 수 없습니다.');
          return { ok: true, result: await regression().call(request, context), meta };
        }
        if ('scriptId' in request) return await scripts.call(request, context);
        return await sessions.call(request, context);
      } catch (error) {
        const known = error instanceof AgentExecutionError || error instanceof InstanceExecutionError || error instanceof RegressionGrantError || error instanceof ProjectFixtureError;
        return {
          ok: false,
          error: {
            code: known ? error.code : 'execution_error',
            message: sessions.sanitize(message(error)),
            effect: error instanceof ProjectFixtureError ? error.effect === 'not_started' ? 'not_started' : 'unknown'
              : error instanceof AgentExecutionError || error instanceof InstanceExecutionError || error instanceof RegressionGrantError ? error.effect
                : ['session.open', 'session.act', 'session.close', 'script.run', 'instance.create', 'instance.start', 'instance.stop', 'instance.prepare'].includes(request.method) ? 'unknown' : 'not_started',
            fixtureEffect: error instanceof ProjectFixtureError ? error.effect : undefined,
          },
          meta,
        };
      }
    },
    shutdown: () => {
      stopping = true;
      d.admission.close();
      shutdown ??= (async () => {
        const failures: unknown[] = [];
        try { await regressions?.shutdown(); } catch (error) { failures.push(error); }
        try { await scripts.shutdown(); } catch (error) { failures.push(error); }
        try { await sessions.shutdown(); } catch (error) { failures.push(error); }
        const cancelled = await Promise.allSettled([...new Set([...legacy.values()].map(held => held.cancel))].map(async cancel => {
          if (!cancel) throw new AgentExecutionError('guest_cancel_unavailable', '실행 취소 경로가 없어 소유권을 해제하지 않음', 'unknown');
          await cancel();
        }));
        for (const result of cancelled) if (result.status === 'rejected') failures.push(result.reason);
        try { await instances?.shutdown(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, '직접 실행 종료 미확인 — 자원을 재사용하지 않음');
      })();
      return shutdown;
    },
  };
}

function executionControl(signal?: AbortSignal): { signal: AbortSignal; cancel(): Promise<void>; finish(): void } {
  const controller = new AbortController();
  const ended = Promise.withResolvers<void>();
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    cancel: async () => { controller.abort(); await ended.promise; },
    finish: () => ended.resolve(),
  };
}

/** Picks and locks one device per platform; failures remain local to that platform. */
async function claimDevices(d: RunnerDeps, platforms: readonly Platform[], ids: Partial<Record<Platform, string>> | undefined, runId: string, cancel: () => Promise<void>): Promise<Map<Platform, Slot>> {
  const slots = new Map<Platform, Slot>();
  for (const platform of platforms) {
    const slot: Slot = { platform, device: null, lock: null, problem: null };
    slots.set(platform, slot);
    try {
      slot.device = await d.pickDevice(platform, ids?.[platform]);
    } catch (err) {
      slot.problem = { code: 'no_device', reason: `${platform} 기기 없음: ${message(err)}` };
      continue;
    }
    try {
      slot.lock = d.acquireLock(slot.device.id, runId, cancel);
    } catch (err) {
      slot.problem = { code: 'device_locked', reason: `기기 ${slot.device.id} 사용 중: ${message(err)}` };
    }
  }
  return slots;
}

/** Identifies the tested website configuration for the web-qa export: a digest of every web profile in the run. */
function webBuildId(profiles: readonly AppProfile[]): string {
  const web = new Map(profiles.flatMap((p) => (p.web ? [[p.id, p.web] as const] : [])));
  const config = [...web].sort(([a], [b]) => a.localeCompare(b));
  return `config-${sha256(JSON.stringify(config)).slice(0, 16)}`;
}

function finishRun(
  store: RunStore,
  d: RunnerDeps,
  meta: {
    kind: RunSummary['kind'];
    startedAt: string;
    t0: number;
    platform: RunSummary['platform'];
    slots: Map<Platform, Slot>;
    junit: boolean;
    profiles: readonly AppProfile[];
  },
  tests: TestResult[],
): RunResult {
  const counts = countVerdicts(tests.map((t) => t.verdict));
  const qaCounts = countQaStatuses(tests.map((t) => t.qaStatus));
  const summary: RunSummary = {
    $schema: SUMMARY_SCHEMA,
    kind: meta.kind,
    runId: store.runId,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(d.clock.now() - meta.t0),
    platform: meta.platform,
    devices: [...meta.slots.values()].flatMap((s) => (s.device ? [{ platform: s.platform, id: s.device.id, name: s.device.name }] : [])),
    counts,
    qaCounts,
    tests,
    reportPath: 'report.html',
    junitPath: meta.junit ? 'junit.xml' : null,
  };
  store.writeRecord('summary.json', summary, 'report');
  const { reportPath, junitPath } = writeReports(store.runDir, summary, { junit: meta.junit, root: d.root });
  const webQa = writeWebQa(store.runDir, summary, { buildId: webBuildId(meta.profiles), runnerExitCode: exitCodeFor(counts) });
  store.emit({ type: 'run.finished', runId: store.runId, counts, reportPath, junitPath });
  store.writeManifest();
  return { runId: store.runId, runDir: store.runDir, counts, qaCounts, tests, reportPath, junitPath, webQa };
}

async function withExecutionSlot<T>(d: RunnerDeps, input: AbortSignal | undefined, ownerId: string | undefined, use: (deps: RunnerDeps, signal: AbortSignal) => Promise<T>): Promise<T> {
  const reservation = await d.admission.wait(ownerId ?? randomUUID(), `flow:${randomUUID()}`, input);
  const failed = new AbortController();
  const signal = input ? AbortSignal.any([input, failed.signal]) : failed.signal;
  const scoped: RunnerDeps = { ...d, uncertain: reason => {
    reservation.unknown(reason);
    failed.abort(reason);
    d.uncertain?.(reason);
  } };
  try {
    const result = await use(scoped, signal);
    reservation.closing();
    reservation.ended();
    return result;
  } catch (error) {
    if (error instanceof AgentExecutionError && error.effect === 'not_started') {
      reservation.closing(); reservation.ended();
    } else reservation.unknown('execution_finalization_unconfirmed');
    throw error;
  }
}

/**
 * Holds user-wide admission through execution, evidence and cleanup; platforms and tests run sequentially.
 * Test failures return results; invalid inputs and unconfirmed native cleanup propagate.
 */
export async function runTests(opts: RunOptions, deps?: Partial<RunnerDeps>): Promise<RunResult> {
  const d = resolveDeps(deps);
  return withExecutionSlot(d, opts.signal, opts.frozen?.ownerId, (scoped, signal) => runTestsOwned({ ...opts, signal }, scoped));
}

async function runTestsOwned(opts: RunOptions, d: RunnerDeps): Promise<RunResult> {
  const requested: readonly Platform[] = opts.platform === 'all' ? PLATFORMS : [opts.platform];
  if (opts.frozen && opts.platform === 'all') throw new AgentExecutionError('explicit_attempt_target_required', '확정 attempt는 실제 대상 하나에 결합되어야 합니다');
  const sources = opts.frozen ? { tests: opts.frozen.tests, errors: [] } : loadTests(opts.paths, { root: d.root, appsDir: d.appsDir, tags: opts.tags });
  const execution = planExecutionFlows(sources.tests, opts.frozen?.chain ? [opts.frozen.chain] : []);
  if (execution.problems.length) throw new AgentExecutionError('invalid_execution_chain', execution.problems.map(problem => problem.message).join('; '));
  if (opts.frozen && execution.flows.length !== 1) throw new AgentExecutionError('explicit_attempt_flow_required', '확정 attempt는 독립 흐름 또는 전체 상태 의존 chain 하나에 결합되어야 합니다');
  const loaded = { tests: execution.flows.flatMap(flow => flow.tests), errors: sources.errors };
  if (opts.frozen && loaded.tests.some(test => !(test.spec.platforms ?? profilePlatforms(test.profile)).includes(requested[0]!) || !profilePlatforms(test.profile).includes(requested[0]!))) throw new AgentExecutionError('frozen_target_scope_mismatch', 'chain의 모든 TC가 같은 실제 필수 대상에 결합되어야 합니다');
  const runId = newRunId();
  const control = executionControl(opts.signal);
  opts = { ...opts, signal: control.signal };
  const store = new RunStore(join(d.runsDir, runId), runId, opts.events);
  opts.frozen?.created(store.runDir, runId);
  const startedAt = new Date().toISOString();
  const t0 = d.clock.now();

  // test × platform plan
  const planned: { test: LoadedTest; platform: Platform }[] = [];
  const early: TestResult[] = [];
  const covered = new Set<Platform>();
  for (const test of loaded.tests) {
    const declared = test.spec.platforms;
    const available = profilePlatforms(test.profile);
    for (const p of available) covered.add(p);
    for (const platform of requested) {
      const base = { id: test.id, name: test.spec.name, file: posixRel(d.root, test.file), app: test.spec.app, test };
      if (declared && !declared.includes(platform)) continue;
      if (!available.includes(platform)) {
        if (declared) early.push(unrunResult(base, platform, 'ERROR', 'app_not_configured', `앱 프로필 ${test.spec.app}에 ${platform} 설정이 없습니다`, null, new EvidenceSanitizer(test.profile.redact)));
        continue;
      }
      planned.push({ test, platform });
    }
  }
  // A file that failed to load has no known profile: under `all` it is reported on the platforms the run covers.
  const errorPlatforms = opts.platform === 'all' && covered.size > 0 ? PLATFORMS.filter((p) => covered.has(p)) : requested;
  for (const e of loaded.errors) {
    for (const platform of errorPlatforms) {
      early.push(unrunResult({ id: e.id, name: e.id, file: posixRel(d.root, e.file), app: '', test: null }, platform, 'ERROR', 'spec_invalid', e.error.message, null, new EvidenceSanitizer([])));
    }
  }

  const slots = await claimDevices(
    d,
    requested.filter((p) => planned.some((x) => x.platform === p)),
    opts.deviceIds,
    runId,
    control.cancel,
  );
  const results: TestResult[] = [];
  try {
    const jev = opts.frozen ? { client: null, calibration: null, problem: 'runtime_model_forbidden' } : d.jev();
    store.emit({
      type: 'run.started',
      runId,
      runDir: store.runDir,
      tests: loaded.tests.map((t) => TestSession.announce(t, planned.filter((x) => x.test === t).map((x) => x.platform))),
      devices: [...slots.values()].flatMap((s) => (s.device ? [{ platform: s.platform, id: s.device.id, name: s.device.name }] : [])),
    });
    if (!d.ocr) store.emit({ type: 'log', level: 'warn', source: 'runner', message: 'OCR 도우미가 없어 OCR 없이 실행합니다 (qa setup으로 설치)' });
    for (const r of early) {
      store.emit({ type: 'test.finished', runId, testId: r.id, platform: r.platform, verdict: r.verdict, reason: r.reason, durationMs: 0 });
    }

    const runSlot = async (slot: Slot): Promise<TestResult[]> => {
      const mine = planned.filter((x) => x.platform === slot.platform);
      const out: TestResult[] = [];
      const skip = (test: LoadedTest, verdict: Verdict, code: string, reason: string) => {
        const base = { id: test.id, name: test.spec.name, file: posixRel(d.root, test.file), app: test.spec.app, test };
        const r = unrunResult(base, slot.platform, verdict, code, reason, slot.device, new EvidenceSanitizer(test.profile.redact));
        store.emit({ type: 'test.finished', runId, testId: r.id, platform: r.platform, verdict, reason: r.reason, durationMs: 0 });
        out.push(r);
      };
      if (slot.problem || !slot.device) {
        for (const { test } of mine) skip(test, 'ERROR', slot.problem?.code ?? 'no_device', slot.problem?.reason ?? '기기 없음');
        return out;
      }
      const device = slot.device;
      const driver = d.createDriver(slot.platform, device.id);
      const chain: { clean: EvidenceSanitizer; continuity: NonNullable<SessionEnv['continuity']>; predecessor: string | null } | undefined = opts.frozen?.chain
        ? { clean: opts.frozen.clean, continuity: { lastActionAt: null, recentScroll: false }, predecessor: null } : undefined;
      let sessionProblem: string | null = null;
      // One session per app: capabilities are app-specific.
      const apps = [...new Set(mine.map((x) => x.test.spec.app))];
      for (const app of apps) {
        const group = mine.filter((x) => x.test.spec.app === app);
        if (opts.signal?.aborted) {
          for (const { test } of group) skip(test, 'SKIPPED', 'cancelled', '실행이 취소되어 건너뜀');
          continue;
        }
        if (sessionProblem !== null) {
          for (const { test } of group) skip(test, 'ERROR', 'session_failed', sessionProblem);
          continue;
        }
        const profile = group[0]!.test.profile;
        const target = appTarget(profile, slot.platform)!;
        let opening = false;
        try {
          await opts.frozen?.beforeOpen(driver, device, target, store.runDir, runId);
          opening = true;
          await driver.open(target);
          opening = false;
          await opts.frozen?.opened(driver, device, store.runDir, runId);
        } catch (err) {
          if (opening && failureStatus(err) !== 'rejected') d.uncertain?.('driver_open_unconfirmed');
          for (const { test } of group) skip(test, 'ERROR', 'session_failed', `자동화 세션을 열 수 없음: ${message(err)}`);
          if (opts.frozen) {
            try { await opts.frozen.beforeClose(); }
            finally {
              try { await driver.close(); opts.frozen.closed(!driver.displayProblem?.()); }
              catch { opts.frozen.closed(false); d.uncertain?.('driver_open_cleanup_unconfirmed'); }
            }
          } else {
            try { await closeDriver(driver); }
            catch (error) { d.uncertain?.('driver_open_cleanup_unconfirmed'); throw error; }
          }
          if (isDesktop(slot.platform) && (failureStatus(err) !== 'rejected' || driver.displayProblem?.())) {
            sessionProblem = new EvidenceSanitizer(profile.redact).text(
              `기기 ${device.id}의 브라우저 세션 시작을 확인하지 못해 남은 테스트를 실행하지 않음: ${message(err)}`,
            );
          }
          continue;
        }
        const clean = new EvidenceSanitizer(profile.redact);
        const checkSession = () => {
          const problem = isDesktop(slot.platform) ? driver.displayProblem?.() : null;
          if (problem) sessionProblem = clean.text(problem);
        };
        try {
          checkSession();
          for (const { test } of group) {
            if (sessionProblem !== null) {
              skip(test, 'ERROR', 'session_failed', sessionProblem);
              continue;
            }
            if (opts.signal?.aborted) {
              skip(test, 'SKIPPED', 'cancelled', '실행이 취소되어 건너뜀');
              continue;
            }
            if (chain?.predecessor) {
              skip(test, 'ERROR', 'chain_predecessor_failed', `선행 TC ${chain.predecessor}의 상태를 확인하지 못해 후행 TC를 실행하지 않았습니다`);
              continue;
            }
            const session = new TestSession(
              { runId, store, clean: chain?.clean ?? opts.frozen?.clean ?? new EvidenceSanitizer(test.profile.redact), driver, device, clock: d.clock, jev, ocr: d.ocr, relFile: posixRel(d.root, test.file), signal: opts.signal, onUncertain: d.uncertain, ...(chain ? { continuity: chain.continuity } : {}), ...(opts.frozen ? { frozen: opts.frozen.authority(test.id) } : {}) },
              test,
              slot.platform,
              target,
            );
            const result = await session.run();
            out.push(result);
            if (chain && (result.verdict !== 'PASS' || result.steps.some(step => step.verdict !== 'PASS'))) chain.predecessor = test.id;
            opts.frozen?.evaluated(result);
            checkSession();
          }
        } finally {
          checkSession();
          try {
            await opts.frozen?.beforeClose();
          } finally {
            if (opts.frozen) {
              try { await driver.close(); opts.frozen.closed(!driver.displayProblem?.()); }
              catch (error) { opts.frozen.closed(false); d.uncertain?.('driver_close_unconfirmed'); throw error; }
            } else {
              try { await closeDriver(driver); }
              catch (error) { d.uncertain?.('driver_close_unconfirmed'); throw error; }
            }
          }
        }
      }
      return out;
    };
    for (const slot of slots.values()) {
      try { results.push(...await runSlot(slot)); }
      finally { releaseHeld(slot); }
    }
  } finally {
    try {
      for (const slot of slots.values()) releaseHeld(slot);
    } finally { control.finish(); }
  }

  const byKey = new Map(results.map((r) => [`${r.id} ${r.platform}`, r]));
  const ordered: TestResult[] = [];
  for (const test of loaded.tests) for (const p of requested) {
    const r = byKey.get(`${test.id} ${p}`);
    if (r) ordered.push(r);
  }
  ordered.push(...early);
  const profiles = loaded.tests.map((t) => t.profile);
  return finishRun(store, d, { kind: 'run', startedAt, t0, platform: opts.platform, slots, junit: opts.junit ?? false, profiles }, ordered);
}

/** Smoke-test pseudo spec: relaunch, no DSL steps (the session drives smoke itself). */
function smokeTest(profile: AppProfile): LoadedTest {
  return {
    file: join(PATHS.root, 'smoke'),
    id: 'smoke',
    spec: { name: `스모크: ${profile.name}`, app: profile.id, start: 'launch', reset: 'relaunch', steps: [] },
    profile,
    flows: new Map(),
  };
}

/**
 * Observe-only smoke on one locked device: launch → settle → health → screenshot → inventory.
 * `crawl:'tabs'` visits risk-filtered tab bar items and returns to the first tab.
 */
export async function runSmoke(opts: SmokeOptions, deps?: Partial<RunnerDeps>): Promise<RunResult> {
  return withExecutionSlot(resolveDeps(deps), opts.signal, undefined, (d, signal) => runSmokeOwned({ ...opts, signal }, d));
}

async function runSmokeOwned(opts: SmokeOptions, d: RunnerDeps): Promise<RunResult> {
  const profile = loadAppProfile(opts.app, d.appsDir);
  // Every record of the smoke run, in the session or around it, passes one sanitizer (built before anything is written).
  const clean = new EvidenceSanitizer(profile.redact);
  const target = appTarget(profile, opts.platform);
  if (!target) throw new Error(`앱 프로필 ${opts.app}에 ${opts.platform} 설정이 없습니다`);
  const runId = newRunId();
  const control = executionControl(opts.signal);
  opts = { ...opts, signal: control.signal };
  const store = new RunStore(join(d.runsDir, runId), runId, opts.events);
  const startedAt = new Date().toISOString();
  const t0 = d.clock.now();
  const test = smokeTest(profile);
  const slots = await claimDevices(d, [opts.platform], { [opts.platform]: opts.deviceId }, runId, control.cancel);
  const slot = slots.get(opts.platform)!;
  let result: TestResult;
  try {
    store.emit({
      type: 'run.started',
      runId,
      runDir: store.runDir,
      tests: [clean.deep({ id: test.id, name: test.spec.name, platforms: [opts.platform], steps: ['앱 시작: relaunch', '화면 점검: launch', ...(opts.crawl ? ['탭 순회'] : [])] })],
      devices: slot.device ? [{ platform: opts.platform, id: slot.device.id, name: slot.device.name }] : [],
    });
    const base = { id: test.id, name: test.spec.name, file: null, app: profile.id, test };
    if (slot.problem || !slot.device) {
      result = unrunResult(base, opts.platform, 'ERROR', slot.problem?.code ?? 'no_device', slot.problem?.reason ?? '기기 없음', null, clean);
    } else {
      const driver = d.createDriver(opts.platform, slot.device.id);
      let opened = false;
      try {
        await driver.open(target);
        opened = true;
        const session = new TestSession(
          { runId, store, clean, driver, device: slot.device, clock: d.clock, jev: d.jev(), ocr: d.ocr, relFile: null, signal: opts.signal, onUncertain: d.uncertain },
          test,
          opts.platform,
          target,
        );
        result = await session.runSmoke({ crawl: opts.crawl === 'tabs', inventoryDir: d.inventoryDir });
      } catch (err) {
        if (!opened && failureStatus(err) !== 'rejected') d.uncertain?.('driver_open_unconfirmed');
        result = opened
          ? unrunResult(base, opts.platform, 'ERROR', 'internal', `실행 오류: ${message(err)}`, slot.device, clean)
          : unrunResult(base, opts.platform, 'ERROR', 'session_failed', `자동화 세션을 열 수 없음: ${message(err)}`, slot.device, clean);
      } finally {
        try { await closeDriver(driver); }
        catch (error) { d.uncertain?.('driver_close_unconfirmed'); throw error; }
      }
    }
  } finally {
    try {
      releaseHeld(slot);
    } finally { control.finish(); }
  }
  store.emit({ type: 'test.finished', runId, testId: result.id, platform: result.platform, verdict: result.verdict, reason: result.reason, durationMs: result.durationMs });
  return finishRun(store, d, { kind: 'smoke', startedAt, t0, platform: opts.platform, slots, junit: false, profiles: [profile] }, [result]);
}

/**
 * A fresh browser session shows a blank tab: opens the start URL and waits (≤ the default step timeout) until the page
 * shows content, so inspect/capture observe the site rather than about:blank.
 */
async function openStartPage(driver: Driver, target: WebTarget, d: RunnerDeps, profile: AppProfile): Promise<void> {
  const opened = await driver.openUrl(target, target.url);
  if (opened.status !== 'completed') throw new Error(`시작 페이지를 열 수 없음(${opened.status}): ${opened.error ?? target.url}`);
  const deadline = d.clock.now() + DEFAULT_TIMEOUT_MS;
  for (;;) {
    const model = buildScreenModel(await driver.snapshot({ screenshot: false }), { volatile: profile.volatile });
    if (model.candidates.length > 0 || model.texts.length > 0) return;
    if (d.clock.now() >= deadline) throw new Error(`시작 페이지가 ${DEFAULT_TIMEOUT_MS}ms 안에 내용을 표시하지 않음: ${target.url}`);
    await d.clock.sleep(250);
  }
}

/** Opens a locked device, runs `use`, and propagates unconfirmed desktop cleanup. */
async function withScreen<T>(opts: ScreenOptions, d: RunnerDeps, use: (driver: Driver, device: DeviceInfo, profile: AppProfile) => Promise<T>): Promise<T> {
  return withExecutionSlot(d, opts.signal, undefined, (scoped, signal) => withScreenOwned({ ...opts, signal }, scoped, use));
}

async function withScreenOwned<T>(opts: ScreenOptions, d: RunnerDeps, use: (driver: Driver, device: DeviceInfo, profile: AppProfile) => Promise<T>): Promise<T> {
  const profile = loadAppProfile(opts.app, d.appsDir);
  const target = appTarget(profile, opts.platform);
  if (!target) throw new Error(`앱 프로필 ${opts.app}에 ${opts.platform} 설정이 없습니다`);
  const device = await d.pickDevice(opts.platform, opts.deviceId);
  const control = executionControl(opts.signal);
  opts = { ...opts, signal: control.signal };
  let lock: { release(): void } | null = null;
  try {
    lock = d.acquireLock(device.id, undefined, control.cancel);
    const driver = d.createDriver(opts.platform, device.id);
    try {
      await driver.open(target);
      if (target.kind === 'web') await openStartPage(driver, target, d, profile);
      opts.signal?.throwIfAborted();
      return await use(driver, device, profile);
    } finally {
      try { await closeDriver(driver); }
      catch (error) { d.uncertain?.('driver_close_unconfirmed'); throw error; }
    }
  } finally {
    try {
      lock?.release();
    } finally { control.finish(); }
  }
}

export interface InspectResult {
  table: string;
  model: ScreenModel;
}

/** Candidate table of the current screen: Observe's row format plus risk and fast-path uniqueness columns. */
export function renderInspectTable(model: ScreenModel, profile: AppProfile | null): string {
  const counts = new Map<string, number>();
  for (const c of model.candidates) counts.set(normLabel(c.name), (counts.get(normLabel(c.name)) ?? 0) + 1);
  const rows = model.candidates.map((c) => {
    const risk = c.actionable ? assessRisk(c, model, profile) : null;
    const n = counts.get(normLabel(c.name)) ?? 0;
    const unique = !c.name ? '라벨 없음' : n === 1 ? '유일' : `중복 ${n}`;
    return `${candidateRow(c)} | ${risk ? (risk.risky ? `위험: ${risk.reasons.join(', ')}` : '안전') : '-'} | ${unique} | ${c.tapPoint.x},${c.tapPoint.y}`;
  });
  const s = model.snapshot;
  return [
    '키 | 역할 | 이름 | 상태 | 영역 | 위험 | fast path | 탭 지점',
    ...rows,
    `후보 ${model.candidates.length}개 · 가려진 노드 ${model.occludedNodeIds.length}개 · 텍스트 ${model.texts.length}줄${model.sparse ? ' · 희소(OCR 대상)' : ''}${model.overflow ? ' · 254개 초과' : ''}${s.depthCapped ? ' · 트리 깊이 상한 도달' : ''} · 포그라운드 ${s.foregroundApp ?? '알 수 없음'}${s.pageUrl ? ` · 페이지 ${s.pageUrl}` : ''}`,
  ].join('\n');
}

export async function inspectScreen(opts: ScreenOptions, deps?: Partial<RunnerDeps>): Promise<InspectResult> {
  const d = resolveDeps(deps);
  return withScreen(opts, d, async (driver, _device, profile) => {
    const snap = await driver.snapshot({ screenshot: false });
    const clean = new EvidenceSanitizer(profile.redact);
    clean.observe(snap);
    const model = clean.deep(buildScreenModel(snap, { volatile: profile.volatile }));
    return { table: renderInspectTable(model, profile), model };
  });
}

export interface CaptureResult {
  xml: string;
  png: string;
  meta: string;
  inventory: string;
}

/**
 * Saves the current screen as a fixture triplet `fixtures/<platform>/<app>/<name>.{xml,png,meta.json}` + inventory.
 * The XML and inventory pass the evidence sanitizer (password values, profile `redact`, built-in PII).
 */
export async function captureScreen(opts: ScreenOptions & { name: string }, deps?: Partial<RunnerDeps>): Promise<CaptureResult> {
  if (!/^[\w.-]+$/.test(opts.name)) throw new Error(`캡처 이름은 영문·숫자·._- 만 허용됩니다: ${opts.name}`);
  const d = resolveDeps(deps);
  return withScreen(opts, d, async (driver, device, profile) => {
    const snap = await driver.snapshot({ screenshot: true });
    const png = snap.screenshotPng ?? (await driver.screenshot());
    const base = join(d.fixturesDir, opts.platform, opts.app, opts.name);
    const clean = new EvidenceSanitizer(profile.redact);
    clean.observe(snap);
    writeSecure(`${base}.xml`, clean.source(snap.rawSource));
    writeSecure(`${base}.png`, png);
    writeJson(`${base}.meta.json`, {
      platform: opts.platform,
      app: opts.app,
      name: opts.name,
      windowRect: snap.screen,
      capturedAt: snap.takenAt,
      device: `${device.id} (${device.name}, ${device.osVersion})`,
      source: 'QAutra capture (Appium /source)',
      foregroundApp: snap.foregroundApp,
      surface: snap.surface,
      pageUrl: snap.pageUrl === null ? null : clean.text(snap.pageUrl),
      keyboardShown: snap.keyboardShown,
      maxDepth: snap.maxDepth,
      depthCapped: snap.depthCapped,
    });
    const model = buildScreenModel(snap, { volatile: profile.volatile });
    const inventory = writeInventory(d.inventoryDir, opts.app, opts.platform, opts.name, model, 'capture', clean);
    opts.events?.emit({ type: 'log', level: 'info', source: 'capture', message: `화면 캡처 저장: ${relative(d.root, base)} (후보 ${model.candidates.length}개)` });
    return { xml: `${base}.xml`, png: `${base}.png`, meta: `${base}.meta.json`, inventory };
  });
}
