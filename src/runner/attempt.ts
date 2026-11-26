import { join } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import type { ActionKind } from '../core/events.ts';
import type { ExecutionAdmission } from '../core/admission.ts';
import { appendJsonl, sha256, writeJsonAtomic } from '../core/fsx.ts';
import type { AttemptVideoReceipt, StartTargetRecording } from '../core/recording.ts';
import { ProjectFixtureError, type ProjectFixtureBootstrap, type ProjectFixtureGuard, type ProjectFixtureProof } from '../core/project-fixture.ts';
import { RegressionGrantError, type RegressionGrantOperation } from '../core/regression-grant.ts';
import type { AppTarget, Driver, Verdict } from '../core/types.ts';
import type { AttemptConditionsReceipt } from '../core/regression.ts';
import { assertRegressionGrant, selectRegressionGrant } from '../policy/regression-grant.ts';
import { createProjectFixtureGuard } from './project-fixture.ts';
import type { TestResult } from '../report/types.ts';
import type { FrozenSessionAuthority } from './engine.ts';
import type { RunOptions, RunResult } from './index.ts';
import type { AttemptCompletion, AttemptExecution } from './regression.ts';
import { AttemptRecordingStartError, startAttemptRecording } from './recording.ts';
import { frozenLoadedTest, qualifyFrozenTest } from './revisions.ts';
import { EvidenceSanitizer } from './sanitize.ts';
import { createAttemptConditions } from './conditions.ts';
import type { AttemptRecoveryContext } from '../core/recovery.ts';
import { planExecutionFlows } from './execution-chains.ts';
import { publishedRevisionEvidence } from './revision-evidence.ts';

interface FixtureBrowserClient {
  applyProjectFixture(bootstrap: ProjectFixtureBootstrap, entryURL: string): Promise<void>;
  projectFixtureWitness(url: string): Promise<unknown>;
  setMutationGuard(guard: () => void): void;
  readonly ownedChromeIdentity: Readonly<Record<string, unknown>> | null;
}

export interface FrozenAttemptDependencies {
  root: string;
  appsDir: string;
  admission: ExecutionAdmission;
  run(options: RunOptions): Promise<RunResult>;
  browserClient(driver: Driver): FixtureBrowserClient | null;
  observeConditions(driver: Driver): Promise<Pick<AttemptConditionsReceipt, 'browser' | 'guest'>>;
  bindRecoverySource(driver: Driver, context: AttemptRecoveryContext): void;
  prepareRecording(driver: Driver, target: AppTarget): Promise<'before-open' | 'after-open'>;
  startRecording(driver: Driver, input: Parameters<StartTargetRecording>[0]): ReturnType<StartTargetRecording>;
  execution(deviceId: string, cleanup?: boolean): { runtime: 'owned-chrome' | 'macos-guest'; instanceId: string; machineId: string | null; workerId: string; generation: number } | null;
  unknown(deviceId: string, reason: string): void;
}

type AttemptOwner = NonNullable<ReturnType<FrozenAttemptDependencies['execution']>>;

/** The `target-receipt.json` record. Host input non-interference is not measured yet, so it is recorded as inferred, never as verified. */
export function attemptTargetReceipt(attemptId: string, target: unknown, owner: AttemptOwner, conditions: Pick<AttemptConditionsReceipt, 'browser' | 'guest'>, verifiedAt: string) {
  const chrome = owner.runtime === 'owned-chrome';
  return {
    schema: 'qautra/attempt-target/v3', attemptId, target, browser: conditions.browser?.identity ?? null,
    ...(conditions.guest === undefined ? {} : { guest: conditions.guest }),
    hostInputBoundary: { transport: 'none', status: 'inferred-unmeasured', basis: chrome ? 'owned-chrome-runtime' : 'owned-macos-guest-runtime' },
    captureScope: chrome ? 'chrome-page' : 'macos-guest-display', verifiedAt,
  } as const;
}

interface DispatchPreparationSteps {
  check(): void;
  inFlight(): boolean;
  /** Opens the recording boundary of the coming dispatch. */
  open(): Promise<void>;
  /** Closes that recording boundary. */
  close(): void;
  /** Fetches a fresh client witness and returns when its proof expires (epoch ms). */
  witness(): Promise<number>;
}

/**
 * The client proof behind each dispatch. Every approval fetches its own witness, and a preparation an approval left
 * without a dispatch is dropped before anything else runs, so no dispatch acts on a proof fetched for another one.
 */
export function createDispatchPreparation(steps: DispatchPreparationSteps) {
  let expiresAt: number | null = null;
  const release = (): void => {
    if (expiresAt === null || steps.inFlight()) return;
    expiresAt = null;
    steps.close();
  };
  return {
    held: (): boolean => expiresAt !== null,
    expired: (now: number): boolean => expiresAt !== null && !(expiresAt > now),
    release,
    async prepare(): Promise<void> {
      release();
      steps.check();
      await steps.open();
      try { expiresAt = await steps.witness(); }
      catch (error) { steps.close(); throw error; }
    },
    /** The dispatch used the preparation; its own `finished` closes the recording boundary. */
    consumed(): void { expiresAt = null; },
  };
}

export async function executeFrozenAttempt(input: AttemptExecution, deps: FrozenAttemptDependencies): Promise<AttemptCompletion> {
  const { attempt, revision } = input;
  if (revision.schema !== 'qautra/scenario-revision/v4' || revision.definition.schema !== 'qautra/scenario-definition/v4' || !revision.review.authority) {
    throw new AgentExecutionError('operator_review_required', '현재 occurrence identity로 검토·발행한 실행 정의가 필요합니다');
  }
  const plan = planExecutionFlows(revision.definition.tests, revision.definition.chains);
  const flow = plan.flows.find(flow => flow.tests[0]!.id === attempt.testId);
  if (plan.problems.length || !flow) throw new AgentExecutionError('frozen_test_missing', '발행한 시나리오에 정확한 독립 흐름·전체 상태 의존 chain이 없습니다');
  if (JSON.stringify(flow.chain) !== JSON.stringify(attempt.chain ?? null)) throw new AgentExecutionError('frozen_chain_changed', '접수한 TC membership·순서가 고정된 chain과 다릅니다');
  const tests = flow.tests.map(frozenLoadedTest);
  const test = tests[0]!;
  const memberIds = new Set(tests.map(test => test.id));
  const qualifications = tests.map(test => qualifyFrozenTest(test));
  if (qualifications.some(qualified => qualified.problems.length)) throw new AgentExecutionError('publication_invalid', '확정 실행 정의에 해결되지 않은 검증 문제가 있습니다');
  const binding = selectRegressionGrant({
    root: deps.root, ...attempt.authorization,
    origins: test.profile.web?.origins ?? (test.profile.web ? [new URL(test.profile.web.url).origin] : []),
    applicationId: attempt.target.platform === 'android' ? test.profile.android?.package : attempt.target.platform === 'ios' ? test.profile.ios?.bundleId : undefined,
  });
  const ownerId = `attempt:${attempt.attemptId}`;
  const fixture: ProjectFixtureGuard = createProjectFixtureGuard({ root: deps.root, binding, attemptId: attempt.attemptId, ownerId });
  const operation = (kind: string): RegressionGrantOperation => {
    const matches = binding.subject.scope.operations.filter(operation => operation.kind === kind);
    if (matches.length !== 1) throw new AgentExecutionError('grant_operation_denied', `${kind} 동작의 유일한 승인 범위를 확인할 수 없습니다`);
    return matches[0]!;
  };
  for (const kind of ['observe', 'capture-screen', 'record-video']) assertRegressionGrant({ root: deps.root, binding, operation: operation(kind) });
  const required = new Map(qualifications.flatMap(qualified => qualified.assertions).filter(assertion => assertion.check.platforms.includes(attempt.target.platform)).map(assertion => [assertion.check.id, assertion.check]));
  if (!required.size || JSON.stringify([...required.keys()].sort()) !== JSON.stringify([...attempt.requiredChecks].sort())) throw new AgentExecutionError('frozen_assertion_scope_changed', '접수한 필수 검증과 전체 흐름의 고정 assertion 집합이 다릅니다');
  const reservation = await deps.admission.wait(ownerId, `target:${attempt.target.deviceId}`, input.signal);
  const completed = new Map<string, Verdict>();
  const clean = new EvidenceSanitizer([...new Set(revision.definition.tests.flatMap(test => test.profile.redact))]);
  const failed = new AbortController();
  const signal = AbortSignal.any([input.signal, failed.signal]);
  let driver: Driver | null = null;
  let client: FixtureBrowserClient | null = null;
  let runId: string | null = null;
  let runDir: string | null = null;
  const evaluated: TestResult[] = [];
  let fallback: TestResult[] = [];
  let video: Awaited<ReturnType<typeof startAttemptRecording>> | null = null;
  let videoReceipt: AttemptVideoReceipt | null = null;
  let closed = true, inFlight = false, unknown = false, closing = false, finalized = false;
  let fixtureAttempted = false, fixtureUncertain = false, reportComplete = false;
  let recorderAttempted = false;
  let mode: 'before-open' | 'after-open' | null = null;
  let owner: ReturnType<FrozenAttemptDependencies['execution']> = null;
  let actualTarget: unknown = null;
  let observedConditions: Pick<AttemptConditionsReceipt, 'browser' | 'guest'> = { browser: null };
  let initialConditions: ProjectFixtureProof | null = null;
  const failureState: { problem: { code: string; message: string } | null } = { problem: null };
  let approvedAction: ActionKind | null = null;
  const recordProblem = (error: unknown, fallbackCode: string): void => {
    failureState.problem ??= { code: error instanceof AgentExecutionError || error instanceof RegressionGrantError || error instanceof ProjectFixtureError ? error.code : fallbackCode,
      message: clean.text(error instanceof Error ? error.message : String(error)) };
    if ((error instanceof AgentExecutionError || error instanceof ProjectFixtureError) && error.effect === 'unknown') unknown = true;
  };
  const markUnknown = (reason: string): void => {
    unknown = true;
    reservation.unknown(reason);
    deps.unknown(attempt.target.deviceId, reason);
  };
  const checkOwner = (cleanup = false): void => {
    const current = deps.execution(attempt.target.deviceId, cleanup);
    if (!owner || !current || JSON.stringify(current) !== JSON.stringify(owner)) throw new AgentExecutionError('attempt_owner_changed', '실제 instance·worker·generation 소유권이 변경되었습니다', 'unknown');
  };
  const check = (duringDispatch = false): void => {
    if (closing) { checkOwner(true); return; }
    signal.throwIfAborted();
    if (unknown || (inFlight && !duringDispatch)) throw new AgentExecutionError('attempt_effect_unknown', '이전 명령 효과가 미확인이라 재전송하지 않습니다', 'unknown');
    for (const kind of ['observe', 'capture-screen', 'record-video']) assertRegressionGrant({ root: deps.root, binding, operation: operation(kind) });
    if (!video) throw new AgentExecutionError('required_recording_not_ready', '필수 첫 영상 프레임 확인 전에는 동작할 수 없습니다');
    if (inFlight) video.assertHealthy();
    if (preparation.expired(Date.now())) throw new AgentExecutionError('fixture_proof_stale', '권한 확인 중 live proof가 만료되어 입력하지 않습니다');
    checkOwner();
  };
  const preparation = createDispatchPreparation({
    check: () => check(),
    inFlight: () => inFlight,
    open: async () => {
      if (!client) throw new AgentExecutionError('fixture_native_bootstrap_unsupported', '실제 client authority를 확인할 수 없는 native 대상으로 대체하지 않습니다');
      await video!.beforeDispatch();
    },
    close: () => video?.finished(),
    witness: async () => {
      await fixture.observe(signal);
      fixture.acceptClientWitness(await client!.projectFixtureWitness(fixture.clientWitnessRequest().url));
      const proof = fixture.currentProof();
      if (!proof) throw new AgentExecutionError('fixture_proof_missing', '실제 client proof가 없습니다');
      return Date.parse(proof.expiresAt);
    },
  });
  const prepareDispatch = preparation.prepare;
  const release = (): void => { preparation.release(); approvedAction = null; };
  const authority: Omit<FrozenSessionAuthority, 'assertion'> = {
    bindings: {},
    check,
    prepare: prepareDispatch,
    release,
    target: (target, _obs, _mutation, risk, action) => {
      check();
      approvedAction = null;
      if (!target || target.state.includes('disabled')) return { status: 'stale_target', reason: '같은 활성 요소를 새 관찰에서 확인하지 못했습니다' };
      if (risk.risky) {
        if (risk.unknown || risk.boundary !== 'business') return { status: 'blocked_by_policy', reason: risk.reasons.join(', ') };
        const scoped = operation(action);
        assertRegressionGrant({ root: deps.root, binding, operation: scoped });
        if (scoped.effect !== 'fixture-write' && scoped.effect !== 'external-send') {
          return { status: 'blocked_by_policy', reason: '위험 업무 동작에 승인된 fixture-write 또는 테스트 sink 전송 범위가 없습니다' };
        }
      }
      approvedAction = action;
      return { status: 'approved' };
    },
    label: risk => { release(); check(); approvedAction = null; return risk.risky ? { status: 'blocked_by_policy', reason: risk.reasons.join(', ') } : { status: 'approved' }; },
    elementIdentity: () => undefined,
    beforeDispatch: async kind => {
      if (!preparation.held()) await prepareDispatch();
      check();
      if (approvedAction !== null && approvedAction !== kind) throw new AgentExecutionError('grant_action_changed', '준비한 대상 동작과 실제 dispatch 종류가 다릅니다');
      const proof = fixture.assertCurrentProof(operation(kind));
      if (!runDir) throw new AgentExecutionError('attempt_record_missing', '실행 기록이 준비되지 않았습니다');
      appendJsonl(join(runDir, 'fixture-dispatch-proofs.jsonl'), { attemptId: attempt.attemptId, kind, proof });
    },
    dispatching: () => { check(); video!.assertHealthy(); inFlight = true; },
    finished: outcome => {
      inFlight = false; preparation.consumed(); approvedAction = null;
      try {
        if (outcome.status === 'uncertain') { fixture.markDispatchUnknown(); markUnknown('uncertain_regression_action'); }
      } finally { video?.finished(); }
    },
  };
  const authorities = new Map(tests.map(test => [test.id, {
    ...authority,
    assertion: (path, result, evidenceDir) => {
      const assertion = required.get(`${test.id}:${path}`);
      if (!assertion || !runDir || !runId) throw new AgentExecutionError('unexpected_assertion_receipt', '실행 정의에 결합되지 않은 assertion 결과는 받지 않습니다');
      if (completed.has(assertion.id)) throw new AgentExecutionError('duplicate_assertion_receipt', '같은 필수 assertion 결과를 덮어쓰지 않습니다');
      appendJsonl(join(runDir, 'assertions.jsonl'), {
        schema: 'qautra/assertion-receipt/v1', assertionId: assertion.id, definitionSha256: sha256(JSON.stringify(assertion)), revisionId: revision.revisionId,
        runId, attemptId: attempt.attemptId, target: attempt.target, evidenceDir,
        verdict: result.verdict, code: result.code, reason: clean.text(result.reason), evaluatedAt: new Date().toISOString(), scope: assertion.scope,
      });
      completed.set(assertion.id, result.verdict);
      input.update({ completedChecks: [...completed.keys()] });
    },
  } satisfies FrozenSessionAuthority] as const));
  const startVideo = async (): Promise<void> => {
    if (!driver || !runDir || !runId || !owner || video) throw new AgentExecutionError('recording_target_invalid', '정확한 attempt·소유 target·첫 recorder가 필요합니다');
    recorderAttempted = true;
    try {
      video = await startAttemptRecording({
        binding: { attemptId: attempt.attemptId, runId, platform: attempt.target.platform, deviceId: attempt.target.deviceId, generation: owner.generation },
        runDir, start: request => deps.startRecording(driver!, { ...request, captureExpiresAt: new Date(Math.min(Date.parse(binding.expiresAt), Date.parse(binding.evidenceExpiresAt))).toISOString(), sanitize: clean.text }), signal,
      });
    } catch (error) {
      if (error instanceof AttemptRecordingStartError) videoReceipt = error.receipt;
      throw error;
    }
    video.signal.addEventListener('abort', () => failed.abort(video!.signal.reason), { once: true });
    if (video.signal.aborted) failed.abort(video.signal.reason);
  };
  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true; closing = true;
    input.update({ state: 'finalizing', evidence: 'finalizing' });
    if (fixtureAttempted) {
      try {
        if (!fixture.currentProof() && fixtureUncertain) await fixture.observe();
        if (fixture.currentProof()) await fixture.settle();
      } catch (error) { recordProblem(error, 'fixture_settle_failed'); markUnknown('fixture_settle_unconfirmed'); }
    }
    if (video) {
      preparation.release();
      try { videoReceipt = await video.finalize(); }
      catch (error) { recordProblem(error, 'evidence_finalize_failed'); }
    }
  };
  const watch = setInterval(() => {
    if (closing || !video) return;
    try { for (const kind of ['capture-screen', 'record-video']) assertRegressionGrant({ root: deps.root, binding, operation: operation(kind) }); }
    catch (error) { recordProblem(error, 'capture_authority_changed'); failed.abort(error); }
  }, 1000).unref();
  let completion: AttemptCompletion;
  try {
    try {
      const output = await deps.run({
        paths: [], platform: attempt.target.platform, deviceIds: { [attempt.target.platform]: attempt.target.deviceId }, junit: true, signal,
        frozen: {
          ownerId, tests, clean, chain: flow.chain,
          authority: testId => {
            const bound = authorities.get(testId);
            if (!bound) throw new AgentExecutionError('frozen_test_changed', '고정 흐름 밖의 TC에는 실행 권위를 제공하지 않습니다');
            return bound;
          },
          created: (directory, id) => {
            runId = id; runDir = directory;
            writeJsonAtomic(join(directory, 'scenario-revision.json'), publishedRevisionEvidence(revision, clean));
            writeJsonAtomic(join(directory, 'attempt-manifest.json'), { schema: 'qautra/attempt-manifest/v2', attemptId: attempt.attemptId, revisionId: revision.revisionId, testId: test.id, ...(flow.chain ? { chain: flow.chain } : {}), target: attempt.target, requiredChecks: attempt.requiredChecks, requiredVideo: true, executionMode: 'deterministic-only', grantId: binding.grantId, grantSha256: binding.grantSha256, evidenceSha256: binding.evidenceSha256 });
            input.update({ runId: id });
          },
          beforeOpen: async (actualDriver, device, target) => {
            driver = actualDriver; closed = false;
            client = deps.browserClient(actualDriver);
            if (device.id !== attempt.target.deviceId || device.platform !== attempt.target.platform || device.state !== 'booted' || !client) throw new AgentExecutionError('actual_target_mismatch', '승인된 실제 browser context·기기·상태가 attempt와 다릅니다');
            if (!device.id.startsWith('chrome:') && !device.id.startsWith('guest:')) throw new AgentExecutionError('host_input_refused', '개인 브라우저·호스트 포인터·키보드로 대체하지 않습니다');
            mode = await deps.prepareRecording(driver, target);
            owner = deps.execution(device.id);
            if (!owner) throw new AgentExecutionError('attempt_owner_unconfirmed', '준비한 실제 target 소유권을 확인하지 못했습니다', 'unknown');
            actualTarget = { device, owner };
            if (!runId || !runDir) throw new AgentExecutionError('attempt_record_required', '원 실행 기록 없이 native 복구 binding을 만들지 않습니다');
            if (attempt.target.platform !== 'desktop-chrome' && attempt.target.platform !== 'desktop-safari') throw new AgentExecutionError('native_recovery_binding_required', '실제 대상의 원 native 복구 등록 경로가 필요합니다');
            deps.bindRecoverySource(driver, {
              root: deps.root, runDir, runId, attemptId: attempt.attemptId, revisionId: revision.revisionId, testId: test.id,
              ownerId, fixtureSeedId: fixture.recoverySeedId, grantId: binding.grantId, grantSha256: binding.grantSha256, subjectSha256: attempt.authorization.subjectSha256,
              target: { platform: attempt.target.platform, deviceId: device.id },
            });
            if (mode === 'before-open') await startVideo();
          },
          opened: async actualDriver => {
            try {
              if (actualDriver !== driver || !client) throw new AgentExecutionError('actual_driver_changed', '점유한 실제 driver가 바뀌었습니다', 'unknown');
              checkOwner();
              if (mode === 'after-open') await startVideo();
              check();
              fixtureAttempted = true;
              try { await fixture.prepare(signal); }
              catch (error) { fixtureUncertain = error instanceof ProjectFixtureError && error.effect === 'unknown'; throw error; }
              await fixture.withBootstrap(payload => client!.applyProjectFixture(payload, fixture.clientWitnessRequest().entryURL));
              fixture.acceptClientWitness(await client.projectFixtureWitness(fixture.clientWitnessRequest().url));
              initialConditions = fixture.initialProof() ?? null;
              observedConditions = await deps.observeConditions(actualDriver);
              client.setMutationGuard(() => check(true));
              writeJsonAtomic(join(runDir!, 'target-receipt.json'), attemptTargetReceipt(attempt.attemptId, actualTarget, owner!, observedConditions, new Date().toISOString()));
              writeJsonAtomic(join(runDir!, 'fixture-initial.json'), fixture.initialProof());
              input.update({ state: 'running', evidence: 'recording', cleanup: 'pending' });
            } catch (error) { recordProblem(error, 'attempt_open_failed'); throw error; }
          },
          evaluated: result => { evaluated.push(result); },
          beforeClose: finalize,
          closed: confirmed => { closed = confirmed; if (!confirmed) markUnknown('attempt_close_unconfirmed'); },
        },
      });
      fallback = output.tests.filter(result => memberIds.has(result.id) && result.platform === attempt.target.platform);
      reportComplete = true;
    } catch (error) {
      if (inFlight) { fixture.markDispatchUnknown(); markUnknown('attempt_dispatch_unconfirmed'); }
      recordProblem(error, 'attempt_engine_failed');
    }
    await finalize();
    let fixtureFinal: ProjectFixtureProof | undefined;
    if (fixture.currentProof()) {
      try { fixtureFinal = await fixture.cleanup(); }
      catch (error) { recordProblem(error, 'fixture_cleanup_failed'); markUnknown('fixture_cleanup_unconfirmed'); }
    } else if (fixtureUncertain) markUnknown('fixture_prepare_unconfirmed');
    const result = evaluated.find(result => result.verdict === 'FAIL') ?? fallback.find(result => result.verdict === 'FAIL')
      ?? evaluated.find(result => result.verdict !== 'PASS') ?? fallback.find(result => result.verdict !== 'PASS') ?? evaluated[0] ?? fallback[0] ?? null;
    const receipt = videoReceipt as AttemptVideoReceipt | null;
    const checks = [...completed.values()];
    const business: AttemptCompletion['business'] = evaluated.some(result => result.verdict === 'FAIL') || checks.includes('FAIL') ? 'FAIL'
      : evaluated.length === tests.length && evaluated.every(result => result.verdict === 'PASS') && required.size === completed.size && checks.every(verdict => verdict === 'PASS') ? 'PASS'
      : evaluated.length ? 'INCONCLUSIVE' : 'NOT_RUN';
    const fixtureClean = !fixtureAttempted || (!fixture.currentProof() && !fixtureUncertain) || fixtureFinal?.cleanup === 'complete';
    const recorderClean = !recorderAttempted || receipt?.cleanup === 'confirmed';
    if (!closed || inFlight || !recorderClean || !fixtureClean) markUnknown('attempt_ownership_unconfirmed');
    completion = {
      runId, business, completedChecks: [...completed.keys()],
      evidence: receipt?.state === 'ready' && reportComplete ? 'ready' : 'incomplete', cleanup: closed && recorderClean && fixtureClean ? 'confirmed' : 'unknown',
      certainty: unknown ? 'unknown' : 'known', code: failureState.problem?.code ?? result?.code ?? (receipt?.state !== 'ready' ? 'required_video_incomplete' : null),
      message: failureState.problem?.message ?? result?.reason ?? '시나리오를 실행하지 못했습니다',
      conditions: createAttemptConditions({
        attemptId: attempt.attemptId, revisionId: revision.revisionId, testId: attempt.testId, target: attempt.target, runId,
        initial: initialConditions, final: fixtureFinal ?? null, ...observedConditions, worker: owner,
        runtime: revision.definition.runtime, subject: binding.subject,
      }),
    };
    if (runDir) {
      writeJsonAtomic(join(runDir, 'conditions-receipt.json'), completion.conditions);
      writeJsonAtomic(join(runDir, 'fixture-final.json'), fixtureFinal ?? fixture.currentProof() ?? null);
      writeJsonAtomic(join(runDir, 'attempt-result.json'), { schema: 'qautra/attempt-result/v2', attemptId: attempt.attemptId, revisionId: revision.revisionId, ...completion });
    }
    if (completion.cleanup === 'unknown' || completion.certainty === 'unknown' || !reportComplete) reservation.unknown('attempt_completion_unconfirmed');
    else { reservation.closing(); reservation.ended(); }
    return completion;
  } catch (error) {
    reservation.unknown('attempt_finalization_unconfirmed');
    throw error;
  } finally { clearInterval(watch); }
}
