import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AgentExecutionError } from '../core/agent.ts';
import { commitDirectory, ensureDir, sha256, writeAtomic } from '../core/fsx.ts';
import type { FrozenTest, PublishedRevision, RequiredCheck, RevisionCandidate, RevisionPayload, RevisionProblem, ScenarioOrigin } from '../core/regression.ts';
import { ProductSourceManifest, productDigest, validateProductSourceManifest } from '../core/product.ts';
import type { Platform } from '../core/types.ts';
import type { JSONSourceLedger } from '../core/source-json.ts';
import { loadTests, testIdOf, type LoadedTest } from '../spec/load.ts';
import { AppProfile, FlowSpec, patternGroups, profilePlatforms, ruleProblem, stepKind, TestSpec, type StepSpec } from '../spec/schema.ts';
import { type RegressionGrantOperation, RegressionGrantOperationKindSchema } from '../core/regression-grant.ts';
import { launchOperations } from './lifecycle.ts';
import { planExecutionFlows } from './execution-chains.ts';
import { ExecutionChainSchema, type ExecutionChain } from '../core/execution-chain.ts';

const HASH = /^[a-f0-9]{64}$/;
const UUID = z.uuid();
const MAX_SOURCE = 50 * 1024 * 1024;
const MAX_BUNDLE = 128 * 1024 * 1024;
function fail(code: string, text: string): never { throw new AgentExecutionError(code, text); }
const json = (value: unknown): string => JSON.stringify(value);
const digest = productDigest;
const inside = (root: string, file: string): boolean => { const rel = relative(root, file); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };

function boundedRead(root: string, input: string, maximum = MAX_SOURCE): { file: string; bytes: Buffer } {
  const file = realpathSync(resolve(root, input));
  if (!inside(root, file)) fail('source_outside_project', '시나리오 의존 파일이 프로젝트 밖에 있습니다');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maximum)) fail('source_size_limit', '시나리오 파일 크기 또는 형식이 허용 범위를 벗어났습니다');
    const bytes = Buffer.allocUnsafe(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (offset !== Number(stat.size) || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) fail('source_changed', '시나리오 파일이 읽는 동안 변경되었습니다');
    return { file, bytes: bytes.subarray(0, offset) };
  } finally { closeSync(fd); }
}

function install(file: string, bytes: string | Uint8Array): void {
  ensureDir(dirname(file));
  const temporary = `${file}.${randomUUID()}.stage`;
  writeAtomic(temporary, bytes);
  try {
    try { linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!boundedRead(dirname(file), file, Buffer.byteLength(bytes)).bytes.equals(Buffer.from(bytes))) fail('immutable_collision', '동일 식별자의 불변 기록이 다른 내용으로 존재합니다');
    }
  } finally { rmSync(temporary, { force: true }); commitDirectory(dirname(file)); }
}

function readRuntimeFiles(): RevisionPayload['runtime'] {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const files: { path: string; sha256: string }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('runtime_symlink', '실행 의미를 결정하는 소스 경로에 심볼릭 링크가 있습니다');
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:ts|js|swift|json)$/.test(entry.name)) files.push({ path: relative(root, file), sha256: sha256(boundedRead(root, file).bytes) });
    }
  };
  walk(join(root, 'src'));
  for (const name of ['package.json', 'package-lock.json']) if (existsSync(join(root, name))) files.push({ path: name, sha256: sha256(boundedRead(root, name).bytes) });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { node: process.versions.node, files, digest: digest({ node: process.versions, platform: process.platform, architecture: process.arch, files }) };
}

const loadedRuntimeDigest = readRuntimeFiles().digest;

export function regressionRuntime(): RevisionPayload['runtime'] {
  const current = readRuntimeFiles();
  if (current.digest !== loadedRuntimeDigest) fail('engine_source_changed', '실행 중 엔진 파일이 변경되었습니다. 현재 엔진을 종료한 뒤 같은 체크아웃에서 다시 시작해야 합니다');
  return current;
}

export function assertRegressionRuntime(revision: PublishedRevision): void {
  if (regressionRuntime().digest !== revision.definition.runtime.digest) fail('runtime_revision_changed', '발행 이후 실행 엔진·드라이버·assertion 의미가 변경되었습니다. 새 revision 검토가 필요합니다');
}

export function frozenLoadedTest(test: FrozenTest): LoadedTest {
  return { file: test.file, id: test.id, spec: TestSpec.parse(test.spec), profile: AppProfile.parse(test.profile), flows: new Map(test.flows.map(flow => [flow.file, FlowSpec.parse(flow.spec)])) };
}

export interface DeclaredAssertion {
  check: RequiredCheck;
  step: StepSpec;
  expectation: number | null;
}

export function qualifyFrozenTest(test: LoadedTest, options: { schema?: RevisionPayload['schema']; remainingSteps?: number } = {}): {
  assertions: DeclaredAssertion[];
  problems: RevisionProblem[];
  operations: ReadonlyMap<RegressionGrantOperation['kind'], ReadonlySet<Platform>>;
  expandedSteps: number;
} {
  const assertions: DeclaredAssertion[] = [];
  const problems: RevisionProblem[] = [];
  const operations = new Map<RegressionGrantOperation['kind'], Set<Platform>>();
  const occurrences = options.schema !== 'qautra/scenario-definition/v1' && options.schema !== 'qautra/scenario-definition/v2';
  const maximumSteps = options.remainingSteps ?? 5000;
  let expandedSteps = 0, limited = false;
  const requireOperation = (kind: RegressionGrantOperation['kind'], applicable: readonly Platform[]): void => {
    let required = operations.get(kind);
    if (!required) { required = new Set(); operations.set(kind, required); }
    for (const platform of applicable) required.add(platform);
  };
  const requireLaunch = (reset: TestSpec['reset'], custom: boolean, applicable: readonly Platform[]): void => {
    for (const platform of applicable) {
      const desktopWeb = platform === 'desktop-chrome' || platform === 'desktop-safari';
      for (const kind of launchOperations(reset, custom, desktopWeb)) requireOperation(kind, [platform]);
    }
  };
  const platforms = test.spec.platforms ?? profilePlatforms(test.profile);
  const desktopResetUnsupported = (mode: string | undefined, applicable: readonly Platform[]): boolean =>
    (mode === 'clear' || mode === 'reinstall') && applicable.some(platform => platform === 'desktop-chrome' || platform === 'desktop-safari');
  const problem = (path: string, code: string, message: string): void => { problems.push({ testId: test.id, path, code, message }); };
  if (!/^[\w.-]+$/.test(test.id) || test.id === '.' || test.id === '..') problem('id', 'unsafe_artifact_identity', '실행 identity는 증거 폴더의 안전한 단일 경로여야 합니다. 원 TC ID는 원문 매핑에 보존하세요');
  const selector = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problem(path, 'semantic_target', '요소는 명시적인 text/desc/id selector로 확정해야 합니다'); return; }
    const target = value as Record<string, unknown>;
    if ('intent' in target || !['text', 'desc', 'id'].some(key => key in target)) problem(path, 'semantic_target', '의도 기반 요소 대신 관찰 가능한 명시 selector가 필요합니다');
  };
  const add = (step: StepSpec, path: string, kind: string, expectation: number | null, value: unknown, applicable: Platform[]): void => {
    if (limited) return;
    if (occurrences && assertions.length >= 5000) {
      limited = true;
      problem(path, 'required_scope_limit', '반복 전개 후 필수 검증이 5000개를 넘습니다');
      return;
    }
    const id = `${test.id}:${path}`;
    assertions.push({ step, expectation, check: { id, testId: test.id, path, kind, description: json(value), scope: kind === 'see' ? 'observed-element' : 'observed-text', platforms: applicable } });
  };
  const walk = (steps: readonly StepSpec[], path: string, file: string, inherited: Platform[]): void => {
    for (let index = 0; index < steps.length && !limited; index++) {
      const step = steps[index]!;
      const at = `${path}[${index}]`;
      if (occurrences && expandedSteps >= maximumSteps) {
        limited = true;
        problem(at, 'required_scope_limit', '반복 전개 후 실행 단계가 한 실행본의 5000개 상한을 넘습니다');
        break;
      }
      expandedSteps++;
      const applicable = inherited.filter(platform => !step.platforms || step.platforms.includes(platform));
      if (!applicable.length) problem(at, 'empty_step_scope', '스텝에 실제 적용되는 필수 대상이 없습니다');
      if (step.optional) problem(at, 'optional_required_step', '필수 실행은 optional 실패를 건너뛸 수 없습니다');
      if (step.allowRisky) problem(at, 'unscoped_risk_approval', 'allowRisky는 발행된 실행 권한을 대신하지 않습니다');
      if (step.within || step.near) problem(at, 'semantic_relation', 'within/near 의미 기반 관계는 결정적인 요소 결합으로 확정해야 합니다');
      if (json(step).includes('${')) problem(at, 'unbound_input', '환경·기억값 변수를 고정 입력 또는 검토된 입력 결합으로 확정해야 합니다');
      if ('launch' in step && typeof step.launch === 'object' && desktopResetUnsupported(step.launch.reset, applicable)) problem(at, 'browser_lifecycle_capture_unsupported', '현재 page 영상은 browser 세션 교체를 연속 기록할 수 없어 이 초기화 단계를 발행할 수 없습니다');
      if ('launch' in step) {
        const options = typeof step.launch === 'object' ? step.launch : {};
        requireLaunch(options.reset ?? 'none', options.permissions !== undefined || options.arguments !== undefined, applicable);
      } else {
        const kind = stepKind(step) as RegressionGrantOperation['kind'];
        if (RegressionGrantOperationKindSchema.options.includes(kind)) {
          requireOperation(kind, kind === 'hideKeyboard' ? applicable.filter(platform => platform !== 'desktop-chrome' && platform !== 'desktop-safari') : applicable);
        }
      }
      if ('type' in step && step.submit) requireOperation('press', applicable);
      if ('claim' in step || 'which' in step || 'seeNot' in step) problem(at, 'runtime_model_dependency', '모델 판단이 필요한 조건은 결정적인 assertion으로 확정해야 합니다');
      for (const key of ['tap', 'longPress', 'into', 'clear', 'see'] as const) if (key in step) selector((step as unknown as Record<string, unknown>)[key], `${at}.${key}`);
      if ('tapAt' in step || 'swipe' in step) problem(at, 'unbound_coordinates', '고정 좌표는 fresh-frame identity 권한에 결합되지 않아 발행할 수 없습니다');
      if ('remember' in step) problem(at, 'unbound_runtime_value', 'remember 값은 검토된 입력 결합으로 확정해야 합니다');
      if ('scroll' in step && step.scroll.until) selector(step.scroll.until, `${at}.scroll.until`);
      if ('wait' in step && typeof step.wait === 'object') selector(step.wait.until, `${at}.wait.until`);
      if ('checkEach' in step) {
        if (step.checkEach.min < 1) problem(at, 'empty_assertion_samples', 'checkEach의 필수 표본은 1개 이상이어야 합니다');
        const invalid = ruleProblem(step.checkEach.rule, patternGroups(step.checkEach.pattern));
        if (invalid) problem(at, 'invalid_assertion_rule', invalid);
      }
      for (const kind of ['see', 'assertText', 'assertNoText', 'checkEach'] as const) if (kind in step) add(step, at, kind, null, (step as unknown as Record<string, unknown>)[kind], applicable);
      if (step.expect) {
        const list = Array.isArray(step.expect) ? step.expect : [step.expect];
        list.forEach((expectation, i) => {
          if ('claim' in expectation) problem(`${at}.expect[${i}]`, 'runtime_model_dependency', '기대 결과의 claim을 결정적 assertion으로 확정해야 합니다');
          if ('see' in expectation) selector(expectation.see, `${at}.expect[${i}].see`);
          const kind = Object.keys(expectation)[0]!;
          add(step, `${at}.expect[${i}]`, kind === 'text' ? 'assertText' : kind === 'noText' ? 'assertNoText' : kind, i, expectation, applicable);
        });
      }
      if ('repeat' in step) {
        if (step.repeat.while) problem(at, 'conditional_required_scope', '조건에 따라 필수 검증이 생략되는 반복은 고정 횟수 실행으로 분리해야 합니다');
        if (occurrences) {
          for (let iteration = 1; iteration <= (step.repeat.times ?? 1) && !limited; iteration++) {
            walk(step.repeat.steps, `${at}.repeat[${iteration}].steps`, file, applicable);
          }
        } else walk(step.repeat.steps, `${at}.repeat.steps`, file, applicable);
      }
      if ('use' in step) {
        const target = resolve(dirname(file), step.use);
        const flow = test.flows.get(target);
        if (!flow) problem(at, 'missing_frozen_flow', '고정된 하위 흐름이 없습니다');
        else walk(flow.steps, `${at}.use.steps`, target, applicable);
      }
    }
  };
  if (!platforms.length || new Set(platforms).size !== platforms.length) problem('platforms', 'invalid_required_targets', '필수 대상은 비어 있거나 중복될 수 없습니다');
  for (const platform of platforms) if (!profilePlatforms(test.profile).includes(platform)) problem('platforms', 'unsupported_profile_target', `프로필이 ${platform}을 지원하지 않습니다`);
  if (test.spec.when?.length) problem('when', 'conditional_required_scope', '자동 interrupt는 검토한 고정 실행 경로와 분리해야 합니다');
  if (desktopResetUnsupported(test.spec.reset, platforms)) problem('reset', 'browser_lifecycle_capture_unsupported', 'browser 세션을 교체하는 초기화는 현재 연속 녹화 경로에서 지원하지 않습니다');
  for (const kind of ['setup', 'cleanup', 'observe', 'capture-screen', 'record-video'] as const) requireOperation(kind, platforms);
  if (test.spec.start !== 'attach') requireLaunch(test.spec.reset, false, platforms);
  walk(test.spec.setup ?? [], 'setup', test.file, platforms);
  walk(test.spec.steps, 'steps', test.file, platforms);
  walk(test.spec.teardown ?? [], 'teardown', test.file, platforms);
  for (const platform of platforms) if (!assertions.some(assertion => assertion.check.platforms.includes(platform) && assertion.check.path.startsWith('steps['))) problem('steps', 'missing_required_assertion', `${platform}의 본 실행 단계에 필수 업무 assertion이 없습니다`);
  return { assertions, problems, operations, expandedSteps };
}

const DEFINITION_SCHEMA = {
  'qautra/scenario-revision/v1': 'qautra/scenario-definition/v1',
  'qautra/scenario-revision/v2': 'qautra/scenario-definition/v2',
  'qautra/scenario-revision/v3': 'qautra/scenario-definition/v3',
  'qautra/scenario-revision/v4': 'qautra/scenario-definition/v4',
} as const satisfies Record<PublishedRevision['schema'], RevisionPayload['schema']>;

export function createRevisionStore(paths: { root: string; appsDir: string; generatedDir: string }) {
  const root = realpathSync(paths.root);
  const base = join(root, '.qa', 'product');
  const candidates = ensureDir(join(base, 'candidates'));
  const revisions = ensureDir(join(base, 'revisions'));
  const blobs = ensureDir(join(base, 'blobs'));
  const Hash = z.string().regex(HASH);
  const Path = z.string().min(1).max(4096);
  const Check = z.strictObject({
    id: z.string().min(1).max(1000), testId: z.string().min(1).max(1000), path: Path, kind: z.string().min(1),
    description: z.string(), scope: z.enum(['observed-text', 'observed-element']), platforms: z.array(z.enum(['android', 'ios', 'desktop-chrome', 'desktop-safari'])).min(1).max(4),
  });
  const LegacyDefinition = z.strictObject({
    schema: z.enum(['qautra/scenario-definition/v1', 'qautra/scenario-definition/v2', 'qautra/scenario-definition/v3']),
    tests: z.array(z.strictObject({
      id: z.string().min(1), file: Path, spec: TestSpec, profile: AppProfile,
      flows: z.array(z.strictObject({ file: Path, spec: FlowSpec, source: Path.optional() })).max(1000),
      sourceManifest: Path.optional(), testSource: Path.optional(), profileSource: Path.optional(),
    })).min(1).max(1000),
    sources: z.array(z.strictObject({ path: Path, sha256: Hash, bytes: z.number().int().min(0).max(MAX_SOURCE), kind: z.enum(['test', 'flow', 'profile', 'requirement']) })).max(10_000),
    checks: z.array(Check).min(1).max(5000),
    runtime: z.strictObject({ node: z.string().min(1), files: z.array(z.strictObject({ path: Path, sha256: Hash })).max(20_000), digest: Hash }),
  });
  const Definition = z.discriminatedUnion('schema', [
    LegacyDefinition,
    LegacyDefinition.extend({ schema: z.literal('qautra/scenario-definition/v4'), chains: z.array(ExecutionChainSchema).max(500) }),
  ]);
  const Authority = z.strictObject({ principalId: z.string().min(1).max(200), channel: z.literal('local-ui'), approvedAt: z.iso.datetime() });
  const Publication = z.strictObject({
    schema: z.enum(['qautra/scenario-revision/v1', 'qautra/scenario-revision/v2', 'qautra/scenario-revision/v3', 'qautra/scenario-revision/v4']), revisionId: Hash, publishedAt: z.iso.datetime(), definition: Definition,
    review: z.strictObject({ candidateId: UUID, digest: Hash, checks: z.array(z.string().min(1)).min(1).max(5000), authority: Authority.optional() }),
  });
  const readObject = (file: string): unknown => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(boundedRead(root, file, MAX_BUNDLE).bytes)); }
    catch (error) { if (error instanceof AgentExecutionError) throw error; return fail('revision_record_invalid', '불변 실행 기록의 UTF-8·JSON 형식을 확인할 수 없습니다'); }
  };
  const sourceProblems = (test: FrozenTest, sources: RevisionPayload['sources'], bytes: ReadonlyMap<string, Buffer>, sourceJSON: Map<string, JSONSourceLedger>): RevisionProblem[] => {
    if (!test.spec.source) return [];
    const source = sources.find(source => source.path === test.sourceManifest);
    const raw = source && bytes.get(source.sha256);
    if (!raw) return [{ code: 'source_reconciliation_required', testId: test.id, path: 'source', message: '현재 원문 매핑과 실제 원본을 결합한 검토 기록이 없습니다' }];
    let manifest: unknown;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return [{ code: 'source_manifest_invalid', testId: test.id, path: 'source', message: '원문 manifest 형식이 올바르지 않습니다' }]; }
    return validateProductSourceManifest(manifest, sources, test.spec, { bytes, json: sourceJSON }).map(issue => ({ code: issue.code, testId: test.id, path: issue.locator, message: issue.message }));
  };
  const verifyDefinition = (definition: RevisionPayload, expected: string): ReadonlyMap<string, Buffer> => {
    const actualDigest = definition.schema === 'qautra/scenario-definition/v1' ? sha256(json(definition)) : digest(definition);
    if (!Definition.safeParse(definition).success || actualDigest !== expected) fail('revision_corrupt', '시나리오 revision의 형식·내용 digest가 일치하지 않습니다');
    if (new Set(definition.sources.map(source => source.path)).size !== definition.sources.length || new Set(definition.tests.map(test => test.id)).size !== definition.tests.length) fail('revision_corrupt', '원본 또는 실행 identity가 중복되었습니다');
    if (planExecutionFlows(definition.tests, definition.schema === 'qautra/scenario-definition/v4' ? definition.chains : []).problems.length) fail('revision_corrupt', '고정된 상태 의존 chain의 TC·순서·공통 자원 범위가 유효하지 않습니다');
    const captured = new Map<string, Buffer>();
    const sourceJSON = new Map<string, JSONSourceLedger>();
    let total = 0;
    for (const source of definition.sources) {
      total += source.bytes;
      if (total > MAX_BUNDLE) fail('bundle_size_limit', '고정 원본의 합계가 128 MiB를 넘습니다');
      if (!captured.has(source.sha256)) {
        const bytes = boundedRead(root, join(blobs, source.sha256)).bytes;
        if (bytes.byteLength !== source.bytes || sha256(bytes) !== source.sha256) fail('revision_corrupt', '고정 원본 파일의 크기 또는 digest가 일치하지 않습니다');
        captured.set(source.sha256, bytes);
      } else if (captured.get(source.sha256)!.byteLength !== source.bytes) fail('revision_corrupt', '동일 원본 digest의 크기가 다릅니다');
    }
    if (definition.schema === 'qautra/scenario-definition/v1') return captured;
    const original = (file: string | undefined): unknown => {
      const source = definition.sources.find(source => source.path === file);
      const bytes = source && captured.get(source.sha256);
      if (!bytes) fail('revision_corrupt', '실행 정의에 대응하는 고정 원본이 없습니다');
      try { return parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return fail('revision_corrupt', '고정된 실행 원본을 파싱할 수 없습니다'); }
    };
    let remainingSteps = 5000;
    const checks = definition.tests.flatMap(test => {
      if (definition.schema === 'qautra/scenario-definition/v2' || definition.schema === 'qautra/scenario-definition/v3' || definition.schema === 'qautra/scenario-definition/v4') {
        const spec = TestSpec.safeParse(original(test.testSource));
        const profile = AppProfile.safeParse(original(test.profileSource));
        if (!spec.success || !profile.success || json(spec.data) !== json(test.spec) || json(profile.data) !== json(test.profile) || testIdOf(test.file, spec.data) !== test.id || profile.data.id !== spec.data.app) fail('revision_corrupt', '실제 고정 원본과 실행 정의·프로필이 다릅니다');
        for (const flow of test.flows) {
          const parsed = FlowSpec.safeParse(original(flow.source));
          if (!parsed.success || json(parsed.data) !== json(flow.spec)) fail('revision_corrupt', '고정 flow 원본과 실행할 내용이 다릅니다');
        }
        if (sourceProblems(test, definition.sources, captured, sourceJSON).length) fail('source_review_invalid', '원본·현재 실행 정의·매핑의 검토가 유효하지 않습니다');
      }
      const qualified = qualifyFrozenTest(frozenLoadedTest(test), { schema: definition.schema, remainingSteps });
      remainingSteps -= qualified.expandedSteps;
      if (qualified.problems.length) fail('revision_corrupt', '발행된 실행 정의가 더 이상 유효하지 않습니다');
      return qualified.assertions.map(assertion => assertion.check);
    });
    if (!checks.length || json(checks) !== json(definition.checks)) fail('revision_corrupt', '발행된 필수 assertion 집합이 실행 정의와 다릅니다');
    return captured;
  };
  const load = async (id: string): Promise<{ revision: PublishedRevision; captured: ReadonlyMap<string, Buffer> }> => {
    if (!HASH.test(id)) fail('invalid_revision_id', '정확한 revision digest가 필요합니다');
    const raw = readObject(join(revisions, `${id}.json`));
    const parsed = Publication.safeParse(raw);
    if (!parsed.success) fail('revision_corrupt', '발행 기록의 형식이 올바르지 않습니다');
    const revision = parsed.data;
    if (revision.revisionId !== id || revision.review.digest !== id) fail('revision_corrupt', '발행 기록 식별자가 일치하지 않습니다');
    if (revision.definition.schema !== DEFINITION_SCHEMA[revision.schema] || revision.schema !== 'qautra/scenario-revision/v1' && !revision.review.authority) fail('revision_corrupt', '발행본의 실행 정의와 검토 주체가 일치하지 않습니다');
    const captured = verifyDefinition(revision.schema === 'qautra/scenario-revision/v1' ? (raw as { definition: RevisionPayload }).definition : revision.definition, id);
    const required = revision.definition.checks.map(check => check.id).sort();
    if (new Set(revision.review.checks).size !== revision.review.checks.length || json(required) !== json([...revision.review.checks].sort())) fail('revision_corrupt', '발행 검토 기록이 필수 검증을 모두 포함하지 않습니다');
    return { revision, captured };
  };
  const get = async (id: string): Promise<PublishedRevision> => (await load(id)).revision;
  return {
    async preview(inputs: readonly string[], chains: readonly ExecutionChain[] = []): Promise<RevisionCandidate> {
      if (!inputs.length || inputs.length > 100) fail('invalid_source_scope', '명시한 시나리오 입력 경로가 1–100개 필요합니다');
      for (const input of inputs) if (!inside(root, realpathSync(resolve(root, input)))) fail('source_outside_project', '입력 경로가 프로젝트 밖에 있습니다');
      const captured = new Map<string, Buffer>();
      const documentAliases = new Map<string, string>();
      const sourceJSON = new Map<string, JSONSourceLedger>();
      let total = 0;
      const capture = (input: string): { file: string; bytes: Buffer } => {
        const canonical = realpathSync(resolve(root, input));
        const previous = captured.get(canonical);
        if (previous) return { file: canonical, bytes: previous };
        const source = boundedRead(root, canonical);
        total += source.bytes.byteLength;
        if (total > MAX_BUNDLE || captured.size + documentAliases.size >= 10_000) fail('bundle_size_limit', '시나리오 원본·의존 파일의 크기 또는 개수 상한을 넘었습니다');
        captured.set(source.file, source.bytes);
        return source;
      };
      const captureRequirement = (path: string) => {
        const original = capture(path);
        if (path !== original.file) {
          const previous = documentAliases.get(path);
          if (previous && previous !== original.file) fail('source_changed', '동일 원문 경로의 실제 파일이 캡처 도중 바뀌었습니다');
          documentAliases.set(path, original.file);
          if (captured.size + documentAliases.size > 10_000) fail('bundle_size_limit', '시나리오 원본·의존 경로 개수 상한을 넘었습니다');
        }
      };
      const loaded = loadTests(inputs, { root, appsDir: paths.appsDir, readSource: file => new TextDecoder('utf-8', { fatal: true }).decode(capture(file).bytes) });
      const definition: RevisionPayload = {
        schema: 'qautra/scenario-definition/v4', chains: structuredClone([...chains]),
        tests: loaded.tests.map(test => ({
          id: test.id, file: test.file, spec: test.spec, profile: test.profile, testSource: capture(test.file).file,
          profileSource: capture([join(paths.appsDir, `${test.spec.app}.yaml`), join(paths.appsDir, `${test.spec.app}.yml`)].find(file => existsSync(file))!).file,
          flows: [...test.flows].map(([file, spec]) => ({ file, spec, source: capture(file).file })),
        })),
        sources: [], checks: [], runtime: regressionRuntime(),
      };
      const problems: RevisionProblem[] = loaded.errors.map(error => ({ code: 'spec_invalid', testId: error.id, path: relative(root, error.file), message: error.error.message }));
      if (!loaded.tests.length) problems.push({ code: 'empty_required_scope', testId: null, path: '', message: '실행할 확정 시나리오가 없습니다' });
      if (loaded.tests.length > 1000) problems.push({ code: 'required_scope_limit', testId: null, path: '', message: '한 실행본의 흐름 수가 1000개를 넘습니다' });
      problems.push(...planExecutionFlows(definition.tests, definition.chains).problems);
      let remainingSteps = 5000;
      for (let index = 0; index < loaded.tests.length; index++) {
        const test = loaded.tests[index]!;
        const qualified = qualifyFrozenTest(test, { remainingSteps });
        remainingSteps -= qualified.expandedSteps;
        for (const assertion of qualified.assertions) {
          if (definition.checks.length >= 5000) {
            problems.push({ code: 'required_scope_limit', testId: test.id, path: assertion.check.path, message: '한 실행본의 필수 검증이 5000개를 넘습니다' });
            break;
          }
          definition.checks.push(assertion.check);
        }
        problems.push(...qualified.problems);
        if (test.spec.source) {
          const source = capture(test.spec.source.plan);
          definition.tests[index]!.sourceManifest = source.file;
          let raw: unknown;
          try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)); }
          catch { raw = null; }
          const manifest = ProductSourceManifest.safeParse(raw);
          if (manifest.success) for (const document of manifest.data.documents) {
            captureRequirement(document.path);
            if (document.derivation) captureRequirement(document.derivation.path);
          }
        }
      }
      const tests = new Set(definition.tests.map(test => test.testSource));
      const flows = new Set(definition.tests.flatMap(test => test.flows.map(flow => flow.source)));
      const profiles = new Set(definition.tests.map(test => test.profileSource));
      const bytesByHash = new Map<string, Buffer>();
      for (const [file, bytes] of captured) {
        const hash = sha256(bytes);
        install(join(blobs, hash), bytes);
        bytesByHash.set(hash, bytes);
        const kind = tests.has(file) ? 'test' : flows.has(file) ? 'flow' : profiles.has(file) ? 'profile' : 'requirement';
        definition.sources.push({ path: file, sha256: hash, bytes: bytes.byteLength, kind });
      }
      if (documentAliases.size) {
        const canonicalSources = new Map(definition.sources.map(source => [source.path, source]));
        for (const [path, canonical] of documentAliases) {
          const source = canonicalSources.get(canonical)!;
          total += source.bytes;
          if (total > MAX_BUNDLE) fail('bundle_size_limit', '시나리오 원본·의존 경로의 합계가 128 MiB를 넘습니다');
          definition.sources.push({ ...source, path, kind: 'requirement' });
        }
      }
      definition.sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      for (const test of definition.tests) problems.push(...sourceProblems(test, definition.sources, bytesByHash, sourceJSON));
      const candidate: RevisionCandidate = { candidateId: randomUUID(), createdAt: new Date().toISOString(), digest: digest(definition), definition, problems };
      install(join(candidates, `${candidate.candidateId}.json`), json(candidate));
      return candidate;
    },
    async publish(candidateId: string, expected: string, reviewedChecks: readonly string[], reviewer: { principalId: string; channel: 'local-ui' }): Promise<PublishedRevision> {
      UUID.parse(candidateId);
      if (!HASH.test(expected)) fail('invalid_revision_id', '검토한 후보의 정확한 digest가 필요합니다');
      const raw = readObject(join(candidates, `${candidateId}.json`));
      const Candidate = z.strictObject({ candidateId: UUID, createdAt: z.iso.datetime(), digest: Hash, definition: Definition, problems: z.array(z.strictObject({ code: z.string(), testId: z.string().nullable(), path: z.string(), message: z.string() })) });
      const parsed = Candidate.safeParse(raw);
      if (!parsed.success) fail('candidate_invalid', '실행 후보의 형식이 올바르지 않습니다');
      const candidate = parsed.data;
      if (candidate.candidateId !== candidateId || candidate.digest !== expected || digest(candidate.definition) !== expected) fail('candidate_changed', '검토한 후보와 발행 요청의 내용이 다릅니다');
      if (candidate.definition.schema !== 'qautra/scenario-definition/v4') fail('operator_review_required', '이전 후보를 승계하지 않고 현재 정의로 새 후보를 검토해야 합니다');
      if (candidate.problems.length) fail('publication_blocked', `미해결 항목 ${candidate.problems.length}개가 있어 발행할 수 없습니다`);
      verifyDefinition(candidate.definition, expected);
      const required = candidate.definition.checks.map(check => check.id).sort();
      const reviewed = [...reviewedChecks].sort();
      if (new Set(reviewed).size !== reviewed.length || json(required) !== json(reviewed)) fail('incomplete_review', '검토한 필수 assertion 집합이 정확히 일치하지 않습니다');
      const publishedAt = new Date().toISOString();
      const authority = Authority.safeParse({ ...reviewer, approvedAt: publishedAt });
      if (!authority.success) fail('operator_review_required', '인증된 로컬 QA 검토 주체가 필요합니다');
      const revision: PublishedRevision = { schema: 'qautra/scenario-revision/v4', revisionId: expected, publishedAt, definition: candidate.definition, review: { candidateId, digest: expected, checks: reviewed, authority: authority.data } };
      const file = join(revisions, `${expected}.json`);
      if (existsSync(file)) return get(expected);
      install(file, json(revision));
      return revision;
    },
    get,
    async origin(revisionId: string, testId: string): Promise<ScenarioOrigin> {
      const { revision, captured } = await load(revisionId);
      const test = revision.definition.tests.find(test => test.id === testId);
      if (!test) fail('source_test_not_found', '발행본에 해당 TC가 없습니다');
      const identity = { schema: 'qautra/scenario-origin/v1' as const, revisionId, testId };
      if (!test.sourceManifest) return { ...identity, availability: 'not-captured', manifestSha256: null, manifest: null };
      const source = revision.definition.sources.find(source => source.path === test.sourceManifest && source.kind === 'requirement');
      const bytes = source && captured.get(source.sha256);
      if (!source || !bytes) fail('source_not_captured', '원 발행본의 고정 manifest가 없습니다. 현재 파일로 보충하지 않습니다');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return fail('source_manifest_invalid', '원 발행본의 고정 원문 manifest를 해석할 수 없습니다'); }
      const manifest = ProductSourceManifest.safeParse(raw);
      if (!manifest.success) fail('source_manifest_invalid', '원 발행본의 제품 원문 manifest 형식을 확인하지 못했습니다');
      return { ...identity, availability: 'verified', manifestSha256: source.sha256, manifest: manifest.data };
    },
    async list(): Promise<PublishedRevision[]> {
      const found: PublishedRevision[] = [];
      for (const file of readdirSync(revisions).sort()) if (/^[a-f0-9]{64}\.json$/.test(file)) found.push(await get(file.slice(0, -5)));
      return found;
    },
  };
}
