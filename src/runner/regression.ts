import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentExecutionError, type AgentCallContext } from '../core/agent.ts';
import { ensureDir, sha256, writeJsonAtomic } from '../core/fsx.ts';
import { acquireFileLock, type FileLock } from '../core/lock.ts';
import { AttemptConditionsReceiptSchema, RegressionRequestSchema, RegressionRunSchema as RunSchema, type PublishedRevision, type RegressionAttempt, type RegressionPreflight, type RegressionPreflightCheck, type RegressionRequest, type RegressionRun, type RegressionTarget } from '../core/regression.ts';
import { RegressionGrantError, type RegressionGrantBinding } from '../core/regression-grant.ts';
import { ProjectFixtureError } from '../core/project-fixture.ts';
import { assertRegressionGrant, listRegressionGrants, selectRegressionGrant } from '../policy/regression-grant.ts';
import { assertRegressionRuntime, createRevisionStore, frozenLoadedTest, qualifyFrozenTest } from './revisions.ts';
import { comparisonConditions, validAttemptConditions } from './conditions.ts';
import { ExecutionChainSchema } from '../core/execution-chain.ts';
import { planExecutionFlows } from './execution-chains.ts';

const Checks = z.array(z.string().min(1).max(1000)).max(5000);
const CompletionSchema = z.strictObject({
  runId: z.string().nullable(), business: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_RUN']), completedChecks: Checks,
  evidence: z.enum(['ready', 'incomplete']), cleanup: z.enum(['confirmed', 'unknown']), certainty: z.enum(['known', 'unknown']),
  code: z.string().nullable(), message: z.string().nullable(),
  conditions: AttemptConditionsReceiptSchema.optional(),
});
function fail(code: string, message: string, effect: 'not_started' | 'unknown' = 'not_started'): never { throw new AgentExecutionError(code, message, effect); }
const terminal = (state: RegressionRun['state']): boolean => ['finished', 'cancelled', 'blocked', 'unknown'].includes(state);
const targetKey = (target: RegressionTarget): string => JSON.stringify([target.platform, target.deviceId]);
const authorityKey = (appId: string, target: RegressionTarget): string => JSON.stringify([appId, target.platform, target.deviceId]);
type Scope = Extract<RegressionRequest, { method: 'regression.submit' | 'regression.preflight' }>;

export interface AttemptExecution {
  attempt: RegressionAttempt;
  revision: PublishedRevision;
  signal: AbortSignal;
  update(patch: Partial<Pick<RegressionAttempt, 'state' | 'runId' | 'evidence' | 'cleanup' | 'completedChecks'>>): void;
}
export type AttemptCompletion = z.infer<typeof CompletionSchema>;
export interface RegressionDependencies {
  root: string;
  appsDir: string;
  generatedDir: string;
  execute(input: AttemptExecution): Promise<AttemptCompletion>;
  /** Readiness and recording adapter of a target `supportsTarget` already accepted. */
  inspectTarget?(target: RegressionTarget): Promise<RegressionPreflightCheck[]>;
  /** Whether the engine can own, record and recover a frozen attempt on this exact target. Required: preflight and submit both refuse an unsupported target through it alone. */
  supportsTarget(target: RegressionTarget): boolean;
  /** Read-only adapter/credential prerequisites, not fixture preparation or live dispatch authority; return authority checks for binding.subject.target. */
  inspectAuthority?(binding: RegressionGrantBinding): Promise<RegressionPreflightCheck[]>;
  capacity?(): RegressionPreflightCheck;
  resourcesRecovered?(attempt: RegressionAttempt): boolean;
}

export function createRegressionService(deps: RegressionDependencies) {
  const base = ensureDir(join(deps.root, '.qa', 'product', 'regressions'));
  const revisions = createRevisionStore(deps);
  const runs = new Map<string, RegressionRun>();
  let owner: FileLock | null = null;
  let ready = false;
  let closing = false;
  let running: { run: RegressionRun; controller: AbortController; promise: Promise<void> } | null = null;
  let submissions = Promise.resolve();
  const path = (id: string): string => join(base, `${z.uuid().parse(id)}.json`);
  const snapshot = (run: RegressionRun): RegressionRun => structuredClone(run);
  const persist = (run: RegressionRun): void => {
    run.updatedAt = new Date().toISOString();
    RunSchema.parse(run);
    writeJsonAtomic(path(run.requestId), run);
  };
  const cancelQueued = (run: RegressionRun, code: string): void => {
    for (const attempt of run.attempts) if (attempt.state === 'queued') {
      attempt.state = 'cancelled'; attempt.code = code; attempt.message = '기기 동작을 시작하기 전에 취소됐습니다';
    }
  };
  const initialise = (): void => {
    if (ready) return;
    owner = acquireFileLock(join(base, 'manager.lock'), { purpose: '확정 회귀 실행 관리자' });
    try {
      for (const file of readdirSync(base).sort()) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const parsed = RunSchema.safeParse(JSON.parse(readFileSync(join(base, file), 'utf8')));
        if (!parsed.success) fail('run_record_corrupt', '실행 기록의 형식·필수 범위를 확인할 수 없습니다. 원본을 보존하고 복구해야 합니다');
        const run = parsed.data;
        if (`${run.requestId}.json` !== file) fail('run_record_corrupt', '실행 기록의 파일 식별자가 일치하지 않습니다');
        if (!terminal(run.state)) {
          const undispatched = run.state === 'queued' && run.attempts.every(attempt => attempt.state === 'queued' && attempt.runId === null && attempt.cleanup === 'not_started');
          run.state = undispatched ? 'cancelled' : 'unknown';
          run.code = undispatched ? 'engine_restart_not_resumed' : 'engine_restart_reconciliation_required';
          run.message = undispatched ? '이전 엔진의 대기 요청은 자동 재개하지 않습니다. 별도의 새 실행이 필요합니다' : '이전 엔진이 완료·증거·정리를 확인하지 못했습니다. 자동 재실행하지 않습니다';
          for (const attempt of run.attempts) if (!terminal(attempt.state)) {
            attempt.state = attempt.state === 'queued' ? 'cancelled' : 'unknown';
            attempt.code = run.code; attempt.message = run.message;
            if (attempt.cleanup !== 'not_started') attempt.cleanup = 'unknown';
            if (attempt.evidence !== 'ready') attempt.evidence = 'incomplete';
          }
          persist(run);
        }
        runs.set(run.requestId, run);
      }
      ready = true;
    } catch (error) { owner.release(); owner = null; throw error; }
  };
  const find = (id: string): RegressionRun => {
    initialise();
    const run = runs.get(z.uuid().parse(id));
    if (!run) fail('run_not_found', '지정한 request UUID의 실행 기록이 없습니다');
    return run;
  };
  const prepare = async (request: Scope, inspect?: (binding: RegressionGrantBinding) => Promise<void>): Promise<RegressionAttempt[]> => {
    if (new Set(request.revisionIds).size !== request.revisionIds.length || new Set(request.targets.map(targetKey)).size !== request.targets.length) fail('duplicate_required_scope', '필수 revision·대상을 중복할 수 없습니다');
    const authorizations = new Map(request.authorizations.map(authorization => [authorityKey(authorization.appId, authorization.target), authorization]));
    if (authorizations.size !== request.authorizations.length) fail('duplicate_authorization', '같은 앱·실제 대상의 권한을 중복할 수 없습니다');
    const used = new Set<string>();
    const usedTargets = new Set<string>();
    const attempts: RegressionAttempt[] = [];
    for (const revisionId of request.revisionIds) {
      const revision = await revisions.get(revisionId);
      assertRegressionRuntime(revision);
      if (revision.schema !== 'qautra/scenario-revision/v4' || revision.definition.schema !== 'qautra/scenario-definition/v4' || !revision.review.authority) fail('operator_review_required', '이전 실행본은 읽기 전용입니다. 현재 정의와 chain을 확인해 새 revision으로 발행해야 합니다');
      const plan = planExecutionFlows(revision.definition.tests, revision.definition.chains);
      if (plan.problems.length) fail('publication_invalid', '발행한 상태 의존 chain의 TC·순서·공통 자원 범위를 확인하지 못했습니다');
      for (const flow of plan.flows) {
        const test = flow.tests[0]!;
        const memberIds = new Set(flow.tests.map(member => member.id));
        const qualifications = flow.tests.map(member => qualifyFrozenTest(frozenLoadedTest(member)));
        if (qualifications.some(qualified => qualified.problems.length)) fail('publication_invalid', '발행한 정의에서 실제 동작 종류와 필수 검증을 확인하지 못했습니다');
        const declared = test.spec.platforms ?? [...new Set(revision.definition.checks.filter(check => check.testId === test.id).flatMap(check => check.platforms))];
        for (const target of request.targets) {
          if (!declared.includes(target.platform)) continue;
          usedTargets.add(targetKey(target));
          const key = authorityKey(test.spec.app, target);
          const authorization = authorizations.get(key);
          if (!authorization) fail('project_grant_required', '각 앱·실제 대상에 환경 책임자가 승인한 권한을 선택해야 합니다');
          try {
            const binding = selectRegressionGrant({
              root: deps.root, ...authorization,
              origins: test.profile.web?.origins ?? (test.profile.web ? [new URL(test.profile.web.url).origin] : []),
              applicationId: target.platform === 'android' ? test.profile.android?.package : target.platform === 'ios' ? test.profile.ios?.bundleId : undefined,
            });
            const requiredOperations = new Set(qualifications.flatMap(qualified => [...qualified.operations].filter(([, platforms]) => platforms.has(target.platform)).map(([kind]) => kind)));
            for (const kind of requiredOperations) {
              const operations = binding.subject.scope.operations.filter(operation => operation.kind === kind);
              if (operations.length !== 1) fail('grant_operation_denied', `${kind} 동작의 유일한 승인 범위를 확인할 수 없습니다`);
              assertRegressionGrant({ root: deps.root, binding, operation: operations[0]! });
            }
            if (inspect) await inspect(binding);
          } catch (error) {
            if (error instanceof RegressionGrantError) fail(error.code, '프로젝트 권한·현재 집행 근거·초기 상태를 확인하지 못했습니다. 환경 설정을 확인하세요');
            throw error;
          }
          used.add(key);
          const requiredChecks = revision.definition.checks.filter(check => memberIds.has(check.testId) && check.platforms.includes(target.platform)).map(check => check.id);
          if (!requiredChecks.length) fail('empty_required_assertions', '필수 업무 검증이 없는 대상은 실행할 수 없습니다');
          if (attempts.length >= 1000) fail('invalid_required_scope', '필수 attempt 수는 1–1000개여야 합니다');
          attempts.push({ attemptId: randomUUID(), revisionId, testId: test.id, ...(flow.chain ? { chain: flow.chain } : {}), target, authorization, state: 'queued', runId: null, business: 'NOT_RUN', evidence: 'pending', cleanup: 'not_started', requiredChecks, completedChecks: [], code: null, message: null });
        }
        for (const platform of new Set(declared)) if (!request.targets.some(target => target.platform === platform)) fail('required_target_missing', '발행한 필수 대상 플랫폼을 실행 범위에서 누락할 수 없습니다');
      }
    }
    if (!attempts.length) fail('invalid_required_scope', '필수 attempt 수는 1–1000개여야 합니다');
    if (request.targets.some(target => !usedTargets.has(targetKey(target)))) fail('target_scope_mismatch', '발행한 시나리오의 필수 범위에 속하지 않는 실제 대상이 포함돼 있습니다');
    if (used.size !== authorizations.size) fail('unused_authorization', '요청한 필수 범위에 속하지 않는 앱·대상 권한이 포함돼 있습니다');
    return attempts;
  };
  const execute = async (run: RegressionRun, controller: AbortController): Promise<void> => {
    try {
      for (const attempt of run.attempts) {
        if (run.stopRequested || controller.signal.aborted) { cancelQueued(run, 'not_run_after_stop'); break; }
        const revision = await revisions.get(attempt.revisionId);
        assertRegressionRuntime(revision);
        if (run.stopRequested || controller.signal.aborted) { cancelQueued(run, 'not_run_after_stop'); break; }
        run.state = 'preparing'; attempt.state = 'preparing'; persist(run);
        const parsed = CompletionSchema.safeParse(await deps.execute({
          attempt: structuredClone(attempt), revision, signal: controller.signal,
          update: patch => { Object.assign(attempt, patch); if (!run.stopRequested) run.state = attempt.state; persist(run); },
        }));
        if (!parsed.success) fail('attempt_result_invalid', '실행 결과의 효과·증거·정리 계약을 확인하지 못했습니다', 'unknown');
        const completed = parsed.data;
        attempt.runId = completed.runId; attempt.business = completed.business;
        if (completed.conditions) {
          if (!validAttemptConditions(completed.conditions, attempt, revision.definition.runtime) || (completed.conditions.status !== 'unverified' && (completed.certainty !== 'known' || completed.cleanup !== 'confirmed'))) fail('attempt_conditions_invalid', '실제 조건 원본과 비교 digest 또는 완료 근거가 일치하지 않습니다', 'unknown');
          attempt.conditions = completed.conditions;
        }
        attempt.completedChecks = [...new Set(completed.completedChecks)];
        attempt.evidence = completed.evidence; attempt.cleanup = completed.cleanup; attempt.code = completed.code; attempt.message = completed.message;
        const missing = attempt.requiredChecks.some(check => !attempt.completedChecks.includes(check));
        const unexpected = attempt.completedChecks.some(check => !attempt.requiredChecks.includes(check));
        if (attempt.business === 'PASS' && (missing || unexpected)) attempt.business = 'INCONCLUSIVE';
        if (missing && completed.business === 'PASS' || unexpected) {
          attempt.code = unexpected ? 'unexpected_assertion_receipt' : 'required_assertion_missing';
          attempt.message = unexpected ? '발행한 범위 밖의 assertion receipt가 반환되었습니다' : '발행된 필수 assertion을 모두 평가하지 않았습니다';
        }
        attempt.state = completed.certainty === 'unknown' || completed.cleanup === 'unknown' ? 'unknown'
          : completed.evidence !== 'ready' || (missing && attempt.business !== 'FAIL') || unexpected || attempt.business === 'NOT_RUN' ? 'blocked' : run.stopRequested ? 'cancelled' : 'finished';
        persist(run);
        if (attempt.state === 'unknown' || attempt.state === 'blocked') {
          for (const pending of run.attempts) if (pending.state === 'queued') {
            pending.state = 'blocked'; pending.code = 'previous_attempt_unconfirmed'; pending.message = '이전 attempt의 효과·증거·정리가 확인되지 않아 실행하지 않았습니다';
          }
          break;
        }
      }
      run.state = run.attempts.some(attempt => attempt.state === 'unknown') ? 'unknown'
        : run.attempts.some(attempt => attempt.state === 'blocked') ? 'blocked' : run.stopRequested ? 'cancelled' : 'finished';
    } catch (error) {
      const typed = error instanceof AgentExecutionError || error instanceof ProjectFixtureError || error instanceof RegressionGrantError;
      const known = typed && error.effect === 'not_started';
      run.state = known ? 'blocked' : 'unknown'; run.code = typed ? error.code : 'execution_unconfirmed';
      run.message = known ? error.message : '실행 관리자 실패로 효과·정리를 확인하지 못했습니다. 자동 재시도하지 않습니다';
      for (const attempt of run.attempts) if (!terminal(attempt.state)) {
        attempt.state = attempt.state === 'queued' || known ? 'blocked' : 'unknown'; attempt.code = run.code; attempt.message = run.message;
        if (attempt.cleanup === 'pending') attempt.cleanup = 'unknown';
        if (attempt.evidence !== 'ready') attempt.evidence = 'incomplete';
      }
    } finally { persist(run); }
  };
  // A run stays `unknown` in history forever. For queue admission only, it is released once every attempt record is terminal and
  // each attempt that may have touched a device either carries its own known-certainty confirmed cleanup or has operator-verified
  // resource recovery (`execution.reconcile`). Nothing is resubmitted.
  const unresolvedUnknown = (): boolean => [...runs.values()].some(run => {
    if (run.state !== 'unknown') return false;
    if (run.attempts.some(attempt => !terminal(attempt.state))) return true;
    const unconfirmed = run.attempts.filter(attempt => attempt.state === 'unknown' || (attempt.cleanup !== 'confirmed' && (attempt.cleanup !== 'not_started' || attempt.runId !== null)));
    return unconfirmed.some(attempt => !deps.resourcesRecovered?.(structuredClone(attempt)));
  });
  const pump = (): void => {
    if (closing || running || unresolvedUnknown()) return;
    const run = [...runs.values()].find(record => record.state === 'queued');
    if (!run) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => execute(run, controller));
    running = { run, controller, promise };
    void promise.catch(() => { closing = true; }).finally(() => { running = null; pump(); });
  };
  return {
    async call(input: RegressionRequest, context: AgentCallContext = {}): Promise<unknown> {
      const parsed = RegressionRequestSchema.safeParse(input);
      if (!parsed.success) fail('invalid_request', '회귀 실행 요청의 형식이 올바르지 않습니다');
      const request = parsed.data;
      initialise();
      if (closing) fail('engine_stopping', '엔진이 종료 중입니다');
      switch (request.method) {
        case 'scenario.preview': return revisions.preview(request.paths, request.chains);
        case 'scenario.publish': {
          if (!context.operatorReview) fail('operator_review_required', '일반 QA 화면에서 현재 실행 정의와 필수 검증을 확인한 뒤 발행하세요');
          return revisions.publish(request.candidateId, request.digest, request.reviewedChecks, context.operatorReview);
        }
        case 'scenario.get': return revisions.get(request.revisionId);
        case 'scenario.origin': {
          if (!context.operatorReview) fail('operator_review_required', '원문 snapshot은 인증된 로컬 QA 화면에서만 조회합니다');
          return revisions.origin(request.revisionId, request.testId);
        }
        case 'scenario.list': return revisions.list();
        case 'regression.grants': return listRegressionGrants(deps.root);
        case 'regression.preflight': {
          const checks: RegressionPreflightCheck[] = [];
          try {
            await prepare(request, async binding => {
              const target = binding.subject.target;
              if (!deps.inspectAuthority) {
                checks.push({ category: 'authority', target, status: 'unknown', code: 'authority_inspector_missing', message: '보호된 adapter·credential의 현재 사전 조건 검사기가 연결되지 않았습니다' });
                return;
              }
              try {
                const inspected = await deps.inspectAuthority(binding);
                if (!inspected.length || inspected.some(check => check.category !== 'authority' || !check.target || targetKey(check.target) !== targetKey(target))) {
                  checks.push({ category: 'authority', target, status: 'unknown', code: 'authority_inspection_incomplete', message: '선택한 실제 대상의 현재 권한 검사 결과를 확인하지 못했습니다' });
                } else checks.push(...inspected);
              } catch (error) {
                const typed = error instanceof AgentExecutionError || error instanceof ProjectFixtureError || error instanceof RegressionGrantError;
                checks.push({ category: 'authority', target, status: typed && error.effect === 'not_started' ? 'blocked' : 'unknown', code: typed ? error.code : 'authority_inspection_failed', message: typed ? error.message : '현재 보호된 adapter·credential 사전 조건을 확인하지 못했습니다' });
              }
            });
            checks.push({ category: 'definition', target: null, status: 'verified', code: null, message: '고정 실행본·필수 검증·대상 범위를 확인했습니다' });
          } catch (error) {
            checks.push({ category: 'definition', target: null, status: 'blocked', code: error instanceof AgentExecutionError ? error.code : 'preflight_failed', message: error instanceof AgentExecutionError ? error.message : '고정 범위와 실행 권한을 확인하지 못했습니다' });
          }
          for (const target of request.targets) {
            if (!deps.supportsTarget(target)) checks.push({ category: 'evidence', target, status: 'blocked', code: 'frozen_target_unsupported', message: '이 대상의 고정 회귀 실행 소유·녹화·복구 경로가 아직 없습니다. 다른 기기로 대체하지 않습니다' });
            else if (deps.inspectTarget) checks.push(...await deps.inspectTarget(target));
            else checks.push({ category: 'target', target, status: 'unknown', code: 'target_inspector_missing', message: '실제 대상·녹화 기능 검사기가 연결되지 않았습니다' });
          }
          checks.push(unresolvedUnknown()
            ? { category: 'capacity', target: null, status: 'blocked', code: 'execution_reconciliation_required', message: '원 unknown 실행의 자원 복구 승인을 확인하기 전에는 새 실행을 dispatch하지 않습니다' }
            : deps.capacity?.() ?? { category: 'capacity', target: null, status: 'unknown', code: 'capacity_inspector_missing', message: '사용자 전체의 실행 점유 상태를 확인하지 못했습니다' });
          const categories = new Set(checks.filter(check => !['blocked', 'unknown'].includes(check.status)).map(check => check.category));
          const result: RegressionPreflight = { canQueue: checks.every(check => check.status !== 'blocked' && check.status !== 'unknown') && ['definition', 'authority', 'target', 'evidence', 'capacity'].every(category => categories.has(category as RegressionPreflightCheck['category'])), checks };
          return result;
        }
        case 'regression.list': return [...runs.values()].map(snapshot).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        case 'regression.status': return snapshot(find(request.requestId));
        case 'regression.stop': {
          const run = find(request.requestId);
          if (terminal(run.state)) return snapshot(run);
          run.stopRequested = true;
          if (run.state === 'queued') { run.state = 'cancelled'; cancelQueued(run, 'not_run_after_stop'); }
          else run.state = 'stopping';
          persist(run);
          if (running?.run === run) running.controller.abort();
          return snapshot(run);
        }
        case 'regression.compare': {
          const before = find(request.before), after = find(request.after);
          const key = (attempt: RegressionAttempt): string => JSON.stringify([attempt.revisionId, attempt.testId, targetKey(attempt.target)]);
          const previous = new Map(before.attempts.map(attempt => [key(attempt), attempt]));
          return { before: before.requestId, after: after.requestId, readOnly: true, comparisons: after.attempts.map(attempt => {
            const old = previous.get(key(attempt));
            const prior = old ? comparisonConditions(old) : null, current = comparisonConditions(attempt);
            const verified = prior?.verified && current.verified;
            const changed = verified && (prior.changed || current.changed || old?.conditions?.materialSha256 !== attempt.conditions?.materialSha256);
            return { attemptId: attempt.attemptId, beforeAttemptId: old?.attemptId ?? null, comparable: Boolean(verified && !changed),
              classification: !old ? 'definition_or_target_changed' : !verified ? 'conditions_unverified' : changed ? 'changed_conditions' : 'same_conditions',
              reason: !old ? '고정 revision 또는 대상이 달라 직접 회귀 판정할 수 없습니다' : !verified ? (prior?.verified ? current.reason : prior?.reason) : changed ? '실제 관측한 환경·초기 상태·실행 조건이 다릅니다' : '완전한 실제 관측 조건과 필수 검증·증거·정리를 확인했습니다',
              before: old ? { business: old.business, evidence: old.evidence, cleanup: old.cleanup, conditions: old.conditions ?? null } : null,
              after: { business: attempt.business, evidence: attempt.evidence, cleanup: attempt.cleanup, conditions: attempt.conditions ?? null } };
          }) };
        }
        case 'regression.submit': {
          const submission = submissions.then(async () => {
            if (closing) fail('engine_stopping', '엔진이 종료 중입니다');
            const fingerprint = sha256(JSON.stringify({ revisionIds: request.revisionIds, targets: request.targets, authorizations: request.authorizations, name: request.name, evidence: request.evidence }));
            const previous = runs.get(request.requestId);
            if (previous) {
              if (previous.fingerprint !== fingerprint) fail('idempotency_conflict', '동일 request UUID를 다른 실행 범위로 재사용할 수 없습니다');
              return snapshot(previous);
            }
            context.signal?.throwIfAborted();
            const unsupported = request.targets.find(target => !deps.supportsTarget(target));
            if (unsupported) fail('frozen_target_unsupported', `${unsupported.platform} 대상은 아직 고정 회귀 실행의 소유·녹화·복구를 지원하지 않습니다. 다른 대상으로 대체하지 않습니다`);
            const attempts = await prepare(request);
            if (closing) fail('engine_stopping', '엔진이 종료 중입니다');
            context.signal?.throwIfAborted();
            const at = new Date().toISOString();
            const run: RegressionRun = { schema: 'qautra/regression-run/v1', requestId: request.requestId, fingerprint, name: request.name, createdAt: at, updatedAt: at, state: 'queued', revisionIds: request.revisionIds, targets: request.targets, authorizations: request.authorizations, evidence: request.evidence, attempts, stopRequested: false, code: null, message: null };
            persist(run); runs.set(run.requestId, run); pump();
            return snapshot(run);
          });
          submissions = submission.then(() => undefined, () => undefined);
          return submission;
        }
      }
    },
    async shutdown(): Promise<void> {
      closing = true;
      await submissions;
      if (running) {
        running.run.stopRequested = true; running.run.state = 'stopping'; persist(running.run); running.controller.abort();
        await running.promise;
      }
      for (const run of runs.values()) if (run.state === 'queued') { run.stopRequested = true; run.state = 'cancelled'; cancelQueued(run, 'engine_stopped_before_dispatch'); persist(run); }
      owner?.release(); owner = null;
    },
  };
}
