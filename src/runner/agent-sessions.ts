import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentAction, AgentActionResult, AgentCallContext, AgentError, AgentMeta, AgentObservation, AgentReply, AgentSessionView, Effect, ScriptDisposition, SessionRequest, SessionRequestInput } from '../core/agent.ts';
import { AgentExecutionError, SessionRequestSchema } from '../core/agent.ts';
import type { EventSink } from '../core/events.ts';
import { newRunId, sha256 } from '../core/fsx.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Candidate, DeviceInfo, Driver, Platform, Point, Rect } from '../core/types.ts';
import { DESTRUCTIVE_CONTEXT } from '../policy/risk.ts';
import { writeReports } from '../report/index.ts';
import { countQaStatuses, qaStatus } from '../report/status.ts';
import { SUMMARY_SCHEMA, type RunSummary } from '../report/types.ts';
import { loadAppProfile, type LoadedTest } from '../spec/load.ts';
import { profilePlatforms, TestSpec, type AppProfile, type StepSpec } from '../spec/schema.ts';
import { appTarget, TestSession, type Clock, type DirectSessionAuthority, type OcrFn } from './engine.ts';
import { decodePng } from './image.ts';
import type { Approval, Obs } from './prepare.ts';
import { EvidenceSanitizer, maskValue, SanitizedStore } from './sanitize.ts';
import { RunStore } from './store.ts';
import { countVerdicts } from './verdict.ts';

export interface AgentSessionLease {
  ended(): void;
  unknown(reason: string): void;
}
export interface AgentSessionDeps {
  root: string;
  runsDir: string;
  appsDir: string;
  clock: Clock;
  ocr: OcrFn | null;
  createDriver(platform: Platform, deviceId: string): Driver;
  pickDevice(platform: Platform, id?: string): Promise<DeviceInfo>;
  acquireSession(platform: Platform, deviceId: string, runId: string, sessionId: string): AgentSessionLease;
  execution?(deviceId: string, cleanup?: boolean): { runtime?: 'owned-chrome' | 'macos-guest'; instanceId: string; machineId: string | null; workerId: string; generation: number } | null;
  openFailureProvenRejected(error: unknown): boolean;
  events?: EventSink;
}
export interface AgentSessions {
  call(request: SessionRequestInput, context?: AgentCallContext): Promise<AgentReply>;
  beginScript(scriptId: string, sessionIds: readonly string[]): Promise<void>;
  endScript(scriptId: string, disposition: ScriptDisposition): Promise<void>;
  stopScript(scriptId: string, reason: string): void;
  scriptEffect(scriptId: string): Effect;
  sanitize<T>(value: T, sessionIds?: readonly string[]): T;
  shutdown(): Promise<void>;
}
interface HeldTarget { candidate: Candidate; elementId: string | null | undefined }
interface Entry {
  view: AgentSessionView;
  profile: AppProfile;
  driver: Driver;
  lease: AgentSessionLease;
  engine: TestSession;
  store: RunStore;
  out: SanitizedStore;
  latest: AgentObservation | null;
  targets: Map<string, HeldTarget>;
  action: AgentAction | null;
  context: AgentCallContext;
  operation: 'open' | 'read' | 'action' | 'close' | null;
  busy: boolean;
  inFlight: boolean;
  effect: Effect;
  scriptEffect: Effect;
  failure: AgentError | null;
  asserted: boolean;
  closeAttempted: boolean;
  terminalEmitted: boolean;
}
function fault(code: string, message: string, effect: Effect = 'not_started'): never {
  throw new AgentExecutionError(code, message, effect);
}
const refuse = (reason: string): Approval<object> => ({ status: 'blocked_by_policy', reason });
const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameCandidate = (a: Candidate, b: Candidate): boolean => a.nodeId === b.nodeId && a.resourceId === b.resourceId && a.role === b.role && a.name === b.name && a.value === b.value && a.state.join() === b.state.join() && sameRect(a.rect, b.rect);

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new AgentExecutionError('UNKNOWN_OUTCOME', '기기 응답 기한 초과 — 재전송하지 않음', 'unknown')), ms);
  try {
    return await Promise.race([work, timeout.promise]);
  } finally { clearTimeout(timer); }
}

export function createAgentSessions(deps: AgentSessionDeps): AgentSessions {
  const entries = new Map<string, Entry>();
  const workerId = randomUUID();
  let shuttingDown = false;
  let pendingOpens = 0;

  const sanitize = <T>(value: T, ids?: readonly string[]): T => {
    const cleaners = (ids ? ids.flatMap((id) => { const e = entries.get(id); return e ? [e] : []; }) : [...entries.values()]).map((e) => e.out.clean);
    const text = (s: string): string => cleaners.reduce((v, clean) => clean.text(v), s);
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return text(v);
      if (Array.isArray(v)) return v.map(visit);
      if (v === null || typeof v !== 'object') return v;
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [text(k), visit(item)]));
    };
    return visit(value) as T;
  };
  const persist = (e: Entry): void => {
    e.store.writeRecord('session.json', e.out.clean.deep(e.view), 'verdict');
    const result = e.engine.agentResult();
    result.durationMs = Date.now() - Date.parse(e.view.createdAt);
    if (e.view.state === 'unknown' || (e.failure && (result.verdict === 'PASS' || result.verdict === 'SKIPPED'))) {
      result.verdict = 'ERROR'; result.code = e.failure?.code ?? 'UNKNOWN_OUTCOME'; result.reason = e.failure?.message ?? e.view.stopReason ?? '결과 미확인';
    } else if (!e.asserted && result.verdict === 'PASS') {
      result.verdict = 'INCONCLUSIVE'; result.code = 'business_assertion_missing'; result.reason = '세션 동작·관찰 기록 — 명시적인 업무 assertion 없음';
    }
    result.qaStatus = qaStatus(result);
    const summary: RunSummary = {
      $schema: SUMMARY_SCHEMA, kind: 'run', runId: e.view.runId, startedAt: e.view.createdAt, finishedAt: new Date().toISOString(),
      durationMs: result.durationMs, platform: e.view.platform,
      devices: [{ platform: e.view.platform, id: e.view.deviceId, name: e.view.deviceId }],
      counts: countVerdicts([result.verdict]), qaCounts: countQaStatuses([result.qaStatus]), tests: [result], reportPath: 'report.html', junitPath: null,
    };
    e.store.writeRecord('summary.json', e.out.clean.deep(summary), 'verdict');
    writeReports(e.store.runDir, summary, { junit: false, root: deps.root });
    if (e.view.state === 'closed' && !e.terminalEmitted) {
      e.out.emit({ type: 'run.finished', runId: e.view.runId, counts: summary.counts, reportPath: join(e.store.runDir, 'report.html'), junitPath: null });
      e.terminalEmitted = true;
    }
    e.store.writeManifest();
  };
  const persistAll = (owned: readonly Entry[]): void => {
    const failures: unknown[] = [];
    for (const e of owned) {
      try { persist(e); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '세션 증거를 안전하게 기록할 수 없음');
  };
  const check = (e: Entry): void => {
    if (!e.operation) fault('scope_denied', '활성 세션 호출 밖 명령');
    if (e.context.signal?.aborted) fault('cancelled', '요청이 취소됨', e.inFlight || e.view.state === 'unknown' ? 'unknown' : e.effect);
    if (e.context.scriptId && e.view.activeScriptId !== e.context.scriptId) fault('script_stopped', '코드 묶음의 변경 권한이 회수됨');
    if (e.view.state !== 'ready' && e.view.state !== 'opening' && e.operation !== 'read' && e.operation !== 'close') fault('session_stopped', e.view.stopReason ?? '세션 변경이 중지됨', e.view.state === 'unknown' ? 'unknown' : 'not_started');
    if (e.view.generation !== undefined) {
      const current = deps.execution?.(e.view.deviceId, e.operation === 'close');
      if (!current || current.instanceId !== e.view.instanceId || current.machineId !== e.view.machineId || current.generation !== e.view.generation || current.workerId !== e.view.workerId) {
        e.lease.unknown('execution_generation_changed');
        fault('execution_generation_changed', '실행 context 소유권·epoch·generation이 변경됨 — 재전송하지 않음', 'unknown');
      }
    }
  };
  const heldFor = (e: Entry, target: Candidate): HeldTarget | undefined => {
    if (e.action && 'ref' in e.action) return e.targets.get(e.action.ref);
    return [...e.targets.values()].find((h) => h.candidate.nodeId === target.nodeId);
  };
  const authority = (entry: () => Entry): DirectSessionAuthority => ({
    resolveTarget: (model) => {
      const e = entry();
      if (!e.action || !('ref' in e.action)) return null;
      const held = e.targets.get(e.action.ref);
      return held ? model.candidates.find((candidate) => sameCandidate(held.candidate, candidate)) ?? null : null;
    },
    check: () => check(entry()),
    target: (target, obs, _mutation, risk) => {
      const e = entry(); check(e);
      if (risk.risky) return refuse(`결정적 위험 정책: ${risk.reasons.join(', ')}`);
      if (!target) return refuse('관찰에서 승인할 대상을 확인하지 못함');
      const held = heldFor(e, target);
      if (!held || !sameCandidate(held.candidate, target)) return { status: 'stale_target', reason: '관찰한 요소의 identity·위치·값·상태가 바뀜' };
      if (target.state.includes('disabled') || obs.model.snapshot.nodes.find((n) => n.id === target.nodeId)?.flags.enabled === false) return refuse('비활성 요소');
      return { status: 'approved' };
    },
    label: (risk) => {
      const e = entry(); check(e);
      if (e.action?.kind === 'tapAt' && e.profile.agent?.coordinates && e.profile.agent.mutations.includes('tapAt') && risk.unknown) return { status: 'approved' };
      return risk.risky ? refuse(`결정적 위험 정책: ${risk.reasons.join(', ')}`) : { status: 'approved' };
    },
    elementIdentity: (target) => heldFor(entry(), target)?.elementId,
    beforeDispatch: async (kind, detail) => {
      const e = entry(); check(e);
      if (e.view.state === 'opening' && kind === 'launch') return;
      const action = e.action;
      if (!action || action.kind === 'assertText' || !e.profile.agent?.mutations.includes(action.kind)) fault('scope_denied', '프로젝트가 승인하지 않은 변경 동작');
      if (action.kind === 'open' && !e.profile.web) fault('unsupported_capability', 'native deep link 범위는 승인되지 않음');
      if (action.kind === 'tapAt') {
        if (!e.profile.agent.coordinates || !e.latest) fault('scope_denied', '화면 좌표 조작 권한 없음');
        const fresh = await e.engine.agentObserve();
        if (!fresh.png || sha256(fresh.png) !== e.latest.screenshot.sha256 || !sameRect(fresh.model.snapshot.screen, e.latest.screen)) fault('stale_frame', '관찰한 화면·배율이 바뀜 — 좌표를 재사용하지 않음');
        if (fresh.model.texts.some((text) => DESTRUCTIVE_CONTEXT.some((pattern) => pattern.test(text)))) fault('blocked_by_policy', '파괴적 확인 화면에서는 좌표 조작할 수 없음');
        const p = detail.point;
        const s = fresh.model.snapshot.screen;
        if (!p || p.x < s.x || p.y < s.y || p.x >= s.x + s.width || p.y >= s.y + s.height) fault('coordinate_out_of_bounds', '화면 밖 좌표');
        if (await e.driver.isHittable?.(p, null) === false) fault('stale_target', '좌표 입력 지점이 가려짐');
      }
      check(e);
    },
    dispatching: () => { const e = entry(); check(e); e.inFlight = true; e.effect = 'unknown'; },
    finished: (outcome) => {
      const e = entry();
      e.inFlight = false;
      e.effect = e.view.state === 'unknown' || e.failure?.effect === 'unknown' || outcome.status === 'uncertain' ? 'unknown' : outcome.status === 'completed' ? 'completed' : 'not_started';
      if (e.view.activeScriptId && e.effect !== 'not_started') e.scriptEffect = e.scriptEffect === 'unknown' ? 'unknown' : e.effect;
      if (outcome.status === 'uncertain') stop(e, { code: 'UNKNOWN_OUTCOME', message: 'UNKNOWN_OUTCOME — 자동 재전송 금지', effect: 'unknown' });
    },
  });
  const observe = async (e: Entry): Promise<AgentObservation> => {
    const obs = await e.engine.agentObserve();
    if (!obs.png) fault('evidence_unavailable', '필수 screenshot 없음');
    const raster = decodePng(obs.png);
    if (!raster) fault('evidence_unavailable', '필수 screenshot을 해석할 수 없음');
    const s = obs.model.snapshot.screen;
    if (s.width <= 0 || s.height <= 0) fault('evidence_unavailable', '화면 좌표계가 유효하지 않음');
    const targets = new Map<string, HeldTarget>();
    const candidates = [];
    for (const candidate of obs.model.candidates) {
      const ref = randomUUID();
      const node = obs.model.snapshot.nodes.find((n) => n.id === candidate.nodeId);
      const elementId = candidate.actionable || candidate.role === 'input' || candidate.role === 'secure-input' ? await e.driver.elementIdAt?.(candidate.tapPoint, node?.rect ?? null) : undefined;
      targets.set(ref, { candidate, elementId });
      const { key: _key, nodeId: _nodeId, ...publicCandidate } = candidate;
      candidates.push({ ...publicCandidate, value: candidate.value !== null && (candidate.role === 'input' || candidate.role === 'secure-input') ? maskValue(candidate.value) : candidate.value, ref });
    }
    const revision = e.view.revision + 1;
    const dir = `observations/${revision}`;
    const screenshot = e.out.png(`${dir}/screen.png`, obs.png);
    e.out.source(`${dir}/source.xml`, obs.model.snapshot.rawSource);
    e.out.elements(`${dir}/elements.json`, obs.model);
    const value: AgentObservation = {
      sessionId: e.view.sessionId, revision, at: obs.model.snapshot.takenAt, screen: s,
      candidates, texts: obs.model.texts, truncated: obs.model.snapshot.depthCapped,
      coverage: { spatial: PLATFORM_INFO[e.view.platform].host === 'desktop' ? 'desktop-viewport' : 'device-screen', text: 'normalized-visible-text', wholePage: false, allRenderedSurfaces: false },
      screenshot: { path: screenshot, sha256: sha256(obs.png), width: raster.width, height: raster.height, scaleX: raster.width / s.width, scaleY: raster.height / s.height, privacy: 'raw-pixels-approved-fixture-only' },
      capabilities: e.view.capabilities,
    };
    e.targets = targets; e.latest = value; e.view.revision = revision;
    e.view.latestFrame = { revision, at: value.at, screenshot: value.screenshot };
    e.out.json(`${dir}/observation.json`, value, 'elements');
    persist(e);
    return e.out.clean.deep(value);
  };
  const stop = (e: Entry, error: AgentError): void => {
    if (e.view.state === 'closed') return;
    const uncertain = e.inFlight || error.effect === 'unknown' || e.effect === 'unknown' || e.view.state === 'unknown';
    const failure: AgentError = uncertain ? { ...error, effect: 'unknown' } : error;
    if (!e.failure || (failure.effect === 'unknown' && e.failure.effect !== 'unknown')) e.failure = failure;
    e.view.state = uncertain ? 'unknown' : 'stopped';
    if (uncertain) {
      try { e.lease.unknown(e.failure.code); }
      catch (failure) { e.failure.message += `; 소유권 상태 기록 실패: ${String(failure)}`; }
    }
    e.view.stopReason = e.out.clean.text(e.failure.message);
  };
  const close = async (e: Entry): Promise<AgentSessionView> => {
    if (e.view.state === 'closed') return e.view;
    if (e.busy || e.inFlight) fault('UNKNOWN_OUTCOME', '실행 중인 기기의 종료를 확인할 수 없음 — 자원을 재사용하지 않음', 'unknown');
    if (e.closeAttempted) fault('UNKNOWN_OUTCOME', '이전 세션 종료가 미확인 상태 — 자동 재시도하지 않음', 'unknown');
    e.view.state = 'closing'; e.operation = 'close';
    let confirmed = false;
    try {
      persist(e);
      e.closeAttempted = true; e.inFlight = true;
      await bounded((async () => {
        try { await e.driver.close(); } finally { e.inFlight = false; }
      })(), 15_000);
      const problem = e.driver.displayProblem?.();
      if (problem) fault('UNKNOWN_OUTCOME', problem, 'unknown');
      confirmed = true;
      e.effect = e.failure?.effect === 'unknown' ? 'unknown' : 'completed';
      if (e.view.activeScriptId) e.scriptEffect = e.scriptEffect === 'unknown' ? 'unknown' : e.effect;
      e.view.state = 'closed'; persist(e); e.lease.ended();
      return e.view;
    } catch (error) {
      let message = e.out.clean.text(error instanceof Error ? error.message : String(error));
      if (confirmed && e.view.state === 'closed') {
        e.view.state = 'unknown';
        e.lease.unknown('evidence_finalization_unconfirmed');
        fault('evidence_unavailable', `native 종료는 확인됐지만 필수 증거를 확정하지 못했습니다: ${message}`, 'unknown');
      }
      if (!e.closeAttempted) {
        stop(e, { code: 'evidence_unavailable', message, effect: 'not_started' });
        fault('evidence_unavailable', message);
      }
      stop(e, { code: 'UNKNOWN_OUTCOME', message: `세션 종료 미확인: ${message}`, effect: 'unknown' });
      e.view.state = 'unknown';
      message = e.view.stopReason ?? message;
      try { persist(e); } catch (failure) { message += `; 증거 기록 실패: ${String(failure)}`; }
      fault('UNKNOWN_OUTCOME', e.out.clean.text(message), 'unknown');
    } finally {
      e.operation = null;
    }
  };
  const open = async (request: Extract<SessionRequest, { method: 'session.open' }>, context: AgentCallContext, meta: AgentMeta): Promise<AgentSessionView> => {
    if (context.scriptId) fault('scope_denied', '코드 묶음은 새 기기·세션 권한을 만들 수 없음');
    if (pendingOpens + [...entries.values()].filter((e) => e.view.state !== 'closed').length >= 16) fault('capacity_exceeded', '활성 세션 상한 16개');
    const profile = loadAppProfile(request.app, deps.appsDir);
    if (!profile.agent || !profile.agent.deviceIds.includes(request.deviceId)) fault('scope_denied', '합성 fixture·화면·기기가 프로젝트에서 명시적으로 승인되지 않음');
    if (!profilePlatforms(profile).includes(request.platform)) fault('unsupported_capability', '프로필이 지원하지 않는 플랫폼');
    const target = appTarget(profile, request.platform);
    if (!target) fault('unsupported_capability', '플랫폼 대상 없음');
    let device: DeviceInfo;
    pendingOpens++;
    try { device = await deps.pickDevice(request.platform, request.deviceId); } finally { pendingOpens--; }
    if (device.id !== request.deviceId || device.platform !== request.platform || device.state !== 'booted') fault('device_unavailable', '명시한 준비된 기기와 실제 대상이 일치하지 않음');
    const runId = newRunId();
    const driver = deps.createDriver(request.platform, device.id);
    const sessionId = randomUUID();
    const clean = new EvidenceSanitizer(profile.redact);
    const store = new RunStore(join(deps.runsDir, runId), runId, deps.events);
    const desktop = PLATFORM_INFO[request.platform].host === 'desktop';
    const view: AgentSessionView = {
      sessionId, runId, workerId, instanceId: randomUUID(), app: profile.id, platform: request.platform, surface: target.kind,
      deviceId: device.id, version: device.osVersion || null, state: 'opening', activeScriptId: null, revision: 0, createdAt: new Date().toISOString(), stopReason: null, evidenceDir: runId,
      capabilities: { semantic: true, coordinates: profile.agent.coordinates && profile.agent.mutations.includes('tapAt'), coordinateSpace: desktop ? 'css-px' : request.platform === 'ios' ? 'points' : 'device-px', hostGlobalInput: desktop, webview: false, recording: false, mutationKinds: profile.agent.mutations.filter((kind) => kind !== 'open' || target.kind === 'web'), modelRequired: false, isolation: desktop ? 'exclusive-host-display' : 'exclusive-device' },
    };
    Object.assign(meta, { sessionId, runId, workerId, instanceId: view.instanceId });
    const test: LoadedTest = { id: sessionId, file: join(deps.appsDir, `${profile.id}.yaml`), profile, flows: new Map(), spec: TestSpec.parse({ id: sessionId, name: `Agent session: ${profile.name}`, app: profile.id, start: 'launch', reset: 'none', budget: { steps: 512, seconds: 3600, jevCalls: 1 }, steps: [{ launch: { reset: 'none' } }] }) };
    let e: Entry;
    const engine = new TestSession({ runId, store, clean, driver, device, clock: deps.clock, jev: { client: null, calibration: null, problem: 'Direct scoped execution does not invoke Jev' }, ocr: deps.ocr, relFile: null, direct: authority(() => e) }, test, request.platform, target);
    const lease = deps.acquireSession(request.platform, device.id, runId, sessionId);
    const execution = deps.execution?.(device.id);
    if (execution) {
      view.instanceId = execution.instanceId; view.machineId = execution.machineId;
      view.workerId = execution.workerId; view.generation = execution.generation;
      view.capabilities.hostGlobalInput = false;
      view.capabilities.isolation = execution.runtime === 'owned-chrome' ? 'owned-browser-context' : request.platform === 'desktop-safari' ? 'guest-desktop' : 'guest-browser-session';
      Object.assign(meta, { workerId: view.workerId, instanceId: view.instanceId });
    }
    e = { view, profile, driver, lease, engine, store, out: new SanitizedStore(store, clean), latest: null, targets: new Map(), action: null, context, operation: 'open', busy: true, inFlight: false, effect: 'not_started', scriptEffect: 'not_started', failure: null, asserted: false, closeAttempted: false, terminalEmitted: false };
    entries.set(sessionId, e);
    let attempted = false;
    let opened = false;
    try {
      driver.setMutationGuard?.(() => check(e));
      e.out.emit({ type: 'run.started', runId, runDir: store.runDir, tests: [TestSession.announce(test, [request.platform])], devices: [{ platform: device.platform, id: device.id, name: device.name }] });
      store.writeRecord('session.json', view, 'verdict');
      check(e);
      attempted = true; e.inFlight = true;
      await bounded((async () => {
        try { await driver.open(target); } finally { e.inFlight = false; }
      })(), 120_000);
      opened = true; e.effect = 'completed';
      const step = await bounded(engine.agentStart(), 120_000);
      if (step.verdict !== 'PASS') fault(step.code ?? 'session_start_failed', step.reason, e.effect);
      context.signal?.throwIfAborted();
      e.view.state = 'ready';
      await observe(e);
      e.busy = false; e.context = {}; e.operation = null;
      return clean.deep(e.view);
    } catch (error) {
      const proven = !attempted || (!opened && !e.inFlight && deps.openFailureProvenRejected(error) && !driver.displayProblem?.());
      const effect: Effect = proven ? 'not_started' : e.inFlight || !opened || e.effect === 'unknown' || (error instanceof AgentExecutionError && error.effect === 'unknown') ? 'unknown' : 'completed';
      const code = error instanceof AgentExecutionError ? error.code : proven ? attempted ? 'session_start_rejected' : 'evidence_unavailable' : effect === 'unknown' ? 'UNKNOWN_OUTCOME' : 'session_start_failed';
      stop(e, { code, message: clean.text(error instanceof Error ? error.message : String(error)), effect });
      try {
        if (proven) { lease.ended(); e.view.state = 'closed'; } else { lease.unknown(e.view.stopReason!); }
      } catch (failure) {
        stop(e, { code: 'UNKNOWN_OUTCOME', message: `소유권 정리 미확인: ${String(failure)}`, effect: 'unknown' });
      }
      e.busy = false; e.context = {}; e.operation = null;
      try { persist(e); } catch (failure) { e.failure!.message += `; 증거 기록 실패: ${clean.text(String(failure))}`; }
      fault(e.failure!.code, e.failure!.message, e.failure!.effect);
    }
  };
  const stepOf = (e: Entry, action: AgentAction, timeout: number, expectNoChange: boolean): StepSpec => {
    const common = { timeout, expectNoChange };
    const target = () => {
      if (!('ref' in action)) return fault('invalid_ref', '요소 참조 없음');
      const held = e.targets.get(action.ref);
      if (!held) return fault('stale_ref', '다른 세션 또는 오래된 관찰의 요소 참조');
      const c = held.candidate;
      return c.resourceId ? { id: c.resourceId } : { intent: c.name };
    };
    switch (action.kind) {
      case 'tap': return { tap: target(), ...common };
      case 'longPress': return { longPress: target(), holdMs: action.holdMs, ...common };
      case 'type': return { type: action.text, into: target(), append: action.append, secure: action.secure, ...common };
      case 'clear': return { clear: target(), ...common };
      case 'tapAt': {
        const o = e.latest!; const s = o.screen;
        const x = action.units === 'screenshot-px' ? s.x + action.x / o.screenshot.scaleX : action.x;
        const y = action.units === 'screenshot-px' ? s.y + action.y / o.screenshot.scaleY : action.y;
        if (x < s.x || y < s.y || x >= s.x + s.width || y >= s.y + s.height) fault('coordinate_out_of_bounds', '관찰한 화면 밖 좌표');
        return { tapAt: { x: (x - s.x) / s.width, y: (y - s.y) / s.height }, ...common };
      }
      case 'scroll': return { scroll: { direction: action.direction, max: 1 }, ...common };
      case 'back': return { back: true, ...common };
      case 'press': return { press: action.key, ...common };
      case 'open': return { open: action.url, ...common };
      case 'assertText': return action.absent ? { assertNoText: action.text, ...common } : { assertText: action.text, ...common };
    }
  };
  const checkTextScope = (absent: boolean, scope: string | undefined): void => {
    if ((absent || scope !== undefined) && scope !== 'observed-text') fault('unsupported_observation_scope', '텍스트 부재는 scope: observed-text로만 검사할 수 있으며 전체 페이지·시각적 표면의 부재는 검증하지 않음');
  };
  const call: AgentSessions['call'] = async (input, context = {}) => {
    const meta: AgentMeta = { requestId: randomUUID(), at: new Date().toISOString(), ...(context.scriptId ? { jobId: context.scriptId } : {}) };
    let e: Entry | undefined;
    let entered = false;
    try {
      const parsed = SessionRequestSchema.safeParse(input);
      if (!parsed.success) fault('invalid_request', '세션 요청 형식이 유효하지 않음');
      const request = parsed.data;
      if (shuttingDown) fault('engine_stopping', '엔진이 종료 중임');
      if (context.signal?.aborted) fault('cancelled', '요청이 취소됨');
      if (request.method === 'session.open') return { ok: true, result: await open(request, context, meta), meta };
      if (request.method === 'session.list') {
        if (context.scriptId) fault('scope_denied', '코드 묶음은 엔진의 다른 세션을 열람할 수 없음');
        return { ok: true, result: [...entries.values()].map((entry) => entry.out.clean.deep(entry.view)), meta };
      }
      if (context.allowedSessionIds && !context.allowedSessionIds.includes(request.sessionId)) fault('scope_denied', '코드 묶음의 허용 세션 밖 요청');
      e = entries.get(request.sessionId);
      if (!e) fault('session_not_found', '명시한 세션 없음');
      if (context.scriptId && e.view.activeScriptId !== context.scriptId) fault('scope_denied', '코드 묶음이 소유하지 않은 세션');
      Object.assign(meta, { sessionId: e.view.sessionId, runId: e.view.runId, revision: e.view.revision, workerId: e.view.workerId, instanceId: e.view.instanceId });
      if (request.method === 'session.status') return { ok: true, result: e.out.clean.deep(e.view), meta };
      if (e.view.activeScriptId && e.view.activeScriptId !== context.scriptId) fault('session_busy', '다른 코드 묶음이 세션을 소유함');
      if (request.method === 'session.close') return { ok: true, result: e.out.clean.deep(await close(e)), meta };
      if (e.busy) fault('session_busy', '다른 호출이 세션을 사용 중임');
      if (e.view.state === 'closed' || e.view.state === 'closing' || e.view.state === 'opening') fault('session_not_ready', '관찰 가능한 열린 세션이 아님');
      e.busy = true; entered = true; e.context = context; e.effect = 'not_started'; e.operation = request.method === 'session.act' ? 'action' : 'read';
      if (request.method === 'session.observe' || request.method === 'session.screenshot') {
        const observation = await observe(e); meta.revision = observation.revision;
        return { ok: true, result: observation, meta };
      }
      if (request.method === 'session.act') {
        e.action = request.action;
        if (request.action.kind === 'type') e.out.clean.addSecret(request.action.text);
        if (e.view.state !== 'ready') fault('session_stopped', e.view.stopReason ?? '세션 변경이 중지됨', e.view.state === 'unknown' ? 'unknown' : 'not_started');
        if (!e.latest || request.revision !== e.view.revision) fault('stale_revision', '요청 revision이 이 세션의 최신 관찰과 다름');
        if (request.action.kind !== 'assertText' && !e.profile.agent!.mutations.includes(request.action.kind)) fault('scope_denied', '프로젝트가 승인하지 않은 동작');
        if (request.action.kind === 'assertText') checkTextScope(request.action.absent, request.action.scope);
        const step = await e.engine.agentStep(stepOf(e, request.action, request.timeoutMs, request.expectNoChange));
        if (step.verdict !== 'PASS') fault(step.code ?? 'action_failed', step.reason, e.effect);
        if (request.action.kind === 'assertText') e.asserted = true;
        e.action = null;
        const observation = await observe(e); meta.revision = observation.revision;
        return { ok: true, result: { observation, effect: e.effect, step: { seq: step.seq, verdict: step.verdict, code: step.code, reason: step.reason, evidenceDir: step.evidenceDir } } satisfies AgentActionResult, meta };
      }
      checkTextScope(request.absent, request.scope);
      const step = await e.engine.agentStep(request.absent ? { assertNoText: request.text, timeout: request.timeoutMs } : { assertText: request.text, timeout: request.timeoutMs });
      if (step.verdict !== 'PASS') fault(step.code ?? 'wait_failed', step.reason, e.effect);
      const observation = await observe(e); meta.revision = observation.revision;
      return { ok: true, result: { observation, effect: 'not_started', step: { seq: step.seq, verdict: step.verdict, code: step.code, reason: step.reason, evidenceDir: step.evidenceDir } } satisfies AgentActionResult, meta };
    } catch (error) {
      const known = error instanceof AgentExecutionError;
      const failure: AgentError = { code: known ? error.code : context.signal?.aborted ? 'cancelled' : 'execution_error', message: error instanceof Error ? error.message : String(error), effect: known ? error.effect : e?.inFlight ? 'unknown' : e?.effect ?? 'not_started' };
      const scopeRefusal = known && error.code === 'unsupported_observation_scope';
      if (e && entered && scopeRefusal) e.failure ??= failure;
      if (e && entered && !scopeRefusal && (e.action || context.scriptId)) stop(e, failure);
      if (context.scriptId && !scopeRefusal) {
        try { stopScript(context.scriptId, failure.message); } catch (writeError) { failure.message += `; 증거 기록 실패: ${String(writeError)}`; }
      }
      if (e && entered) {
        try { persist(e); } catch (writeError) { failure.message += `; 증거 기록 실패: ${String(writeError)}`; }
      }
      return { ok: false, error: e ? e.out.clean.deep(failure) : { ...failure, message: sanitize(failure.message) }, meta };
    } finally {
      if (e && entered) { e.busy = false; e.action = null; e.context = {}; e.operation = null; }
    }
  };
  const stopScript = (scriptId: string, reason: string): void => {
    const owned = [...entries.values()].filter((e) => e.view.activeScriptId === scriptId);
    for (const e of owned) stop(e, { code: e.inFlight ? 'UNKNOWN_OUTCOME' : 'script_stopped', message: reason, effect: e.inFlight ? 'unknown' : e.scriptEffect });
    persistAll(owned);
  };
  return {
    call, sanitize, stopScript,
    scriptEffect: (scriptId) => {
      let effect: Effect = 'not_started';
      for (const e of entries.values()) if (e.view.activeScriptId === scriptId) {
        if (e.inFlight || e.scriptEffect === 'unknown' || e.view.state === 'unknown') return 'unknown';
        if (e.scriptEffect === 'completed') effect = 'completed';
      }
      return effect;
    },
    beginScript: async (scriptId, sessionIds) => {
      if (shuttingDown || !sessionIds.length || new Set(sessionIds).size !== sessionIds.length) fault('scope_denied', '코드 묶음 세션 범위가 유효하지 않음');
      const targets = sessionIds.map((id) => {
        const e = entries.get(id);
        if (!e || e.view.state !== 'ready' || e.busy || e.view.activeScriptId) return fault('session_not_ready', '명시한 세션이 닫힘·중지됨·사용 중 상태임');
        return e;
      });
      for (const e of targets) { e.view.activeScriptId = scriptId; e.scriptEffect = 'not_started'; }
      try {
        persistAll(targets);
      } catch (error) {
        for (const e of targets) e.view.activeScriptId = null;
        let message = `코드 묶음 예약 증거 기록 실패: ${String(error)}`;
        try { persistAll(targets); } catch (rollbackError) { message += `; 예약 해제 기록 실패: ${String(rollbackError)}`; }
        fault('evidence_unavailable', message);
      }
    },
    endScript: async (scriptId, disposition) => {
      const owned = [...entries.values()].filter((e) => e.view.activeScriptId === scriptId);
      if (disposition !== 'completed') for (const e of owned) stop(e, { code: e.inFlight ? 'UNKNOWN_OUTCOME' : 'script_stopped', message: `코드 묶음 종료: ${disposition}`, effect: e.inFlight ? 'unknown' : e.scriptEffect });
      for (const e of owned) e.view.activeScriptId = null;
      persistAll(owned);
    },
    shutdown: async () => {
      shuttingDown = true;
      for (const e of entries.values()) if (e.view.activeScriptId) stop(e, { code: e.inFlight ? 'UNKNOWN_OUTCOME' : 'engine_stopping', message: '엔진 연결 종료', effect: e.inFlight ? 'unknown' : e.scriptEffect });
      const results = await Promise.allSettled([...entries.values()].filter((e) => e.view.state !== 'closed').map((e) => close(e)));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '세션 종료 미확인 — 소유권을 해제하지 않음');
    },
  };
}
