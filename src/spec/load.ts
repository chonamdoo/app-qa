// Test discovery and loading: *.e2e.yaml → TestSpec (+ app profile + `use:` subflows), with precise Korean errors
// `file:line: path: message`. Strings keep their `${NAME}` placeholders; the runner expands them at run time.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { z } from 'zod';
import { expandHome, PATHS } from '../core/config.ts';
import { AppProfile, FlowSpec, Step, TestSpec, type StepSpec } from './schema.ts';

export interface SpecProblem {
  /** Dotted/indexed path inside the document, e.g. `steps[2].tap`. Empty for the document root. */
  path: string;
  /** 1-based line of the offending node (nearest existing ancestor when the key is missing). */
  line: number | null;
  message: string;
}

/** A test, flow or profile file that failed to parse or validate. `message` lists every problem, one per line. */
export class SpecError extends Error {
  readonly file: string;
  readonly problems: SpecProblem[];
  constructor(file: string, problems: SpecProblem[]) {
    const rel = relative(PATHS.root, file);
    const shown = rel && !rel.startsWith('..') ? rel : file;
    super(problems.map((p) => `${shown}${p.line ? `:${p.line}` : ''}: ${p.path ? `${p.path}: ` : ''}${p.message}`).join('\n'));
    this.name = 'SpecError';
    this.file = file;
    this.problems = problems;
  }
}

export interface LoadedTest {
  /** Absolute path of the *.e2e.yaml file. */
  file: string;
  /** `spec.id`, else the file name without `.e2e.yaml`. */
  id: string;
  spec: TestSpec;
  profile: AppProfile;
  /** Every subflow reachable from this test, keyed by absolute path. */
  flows: Map<string, FlowSpec>;
}

export interface LoadResult {
  tests: LoadedTest[];
  /** Files that could not be loaded; the runner reports them as ERROR tests. */
  errors: { file: string; id: string; error: SpecError }[];
}

const TEST_SUFFIX = /\.e2e\.ya?ml$/;
const FLOW_SUFFIX = /\.flow\.ya?ml$/;
const SKIP_DIRS: Record<string, true> = { node_modules: true, '.qa': true, '.tools': true, '.git': true };
/** `use:` nesting limit (test → flow → flow …). */
export const MAX_FLOW_DEPTH = 5;
/** Keys whose array values are step lists. */
const STEP_LISTS: Record<string, true> = { steps: true, setup: true, teardown: true, do: true };

/** The test id used for evidence directories and traceability. */
export function testIdOf(file: string, spec: Pick<TestSpec, 'id'> | null): string {
  return spec?.id ?? basename(file).replace(TEST_SUFFIX, '');
}

/** Expands files and directories into sorted absolute `*.e2e.yaml` paths (default: `tests/`). Missing paths throw. */
export function discoverTests(paths: readonly string[], opts: { root?: string } = {}): string[] {
  const root = opts.root ?? PATHS.root;
  const inputs = paths.length ? paths : [join(root, 'tests')];
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS[entry.name]) walk(join(dir, entry.name));
      } else if (TEST_SUFFIX.test(entry.name)) out.add(join(dir, entry.name));
    }
  };
  for (const p of inputs) {
    const abs = resolve(root, expandHome(p));
    if (!existsSync(abs)) {
      if (paths.length === 0) continue; // default tests/ may not exist yet
      throw new Error(`테스트 경로가 없습니다: ${p}`);
    }
    if (statSync(abs).isDirectory()) walk(abs);
    else if (TEST_SUFFIX.test(abs)) out.add(abs);
    else throw new Error(`테스트 파일은 *.e2e.yaml 이어야 합니다: ${p}`);
  }
  return [...out].sort();
}

/** Loads and validates `apps/<id>.yaml` (or `.yml`). */
export function loadAppProfile(id: string, dir: string = PATHS.apps): AppProfile {
  const file = [join(dir, `${id}.yaml`), join(dir, `${id}.yml`)].find((f) => existsSync(f));
  if (!file) throw new SpecError(join(dir, `${id}.yaml`), [{ path: '', line: null, message: `앱 프로필이 없습니다 (앱 id '${id}')` }]);
  const profile = parseFile(file, AppProfile);
  if (profile.id !== id) throw new SpecError(file, [{ path: 'id', line: null, message: `프로필 id '${profile.id}'가 파일 이름 '${id}'와 다릅니다` }]);
  return profile;
}

/**
 * Discovers and loads tests. Invalid files, missing profiles, broken subflows and duplicate ids become `errors`
 * (other tests still load). `tags` keeps tests having at least one of them.
 */
export function loadTests(paths: readonly string[], opts: { root?: string; appsDir?: string; tags?: readonly string[] } = {}): LoadResult {
  const profiles = new Map<string, AppProfile | SpecError>();
  const result: LoadResult = { tests: [], errors: [] };
  const seen = new Map<string, string>();
  for (const file of discoverTests(paths, { root: opts.root })) {
    let loaded: LoadedTest;
    try {
      loaded = loadTestFile(file, (app) => {
        let p = profiles.get(app);
        if (!p) {
          try {
            p = loadAppProfile(app, opts.appsDir);
          } catch (err) {
            if (!(err instanceof SpecError)) throw err;
            p = err;
          }
          profiles.set(app, p);
        }
        if (p instanceof SpecError) throw new SpecError(file, [{ path: 'app', line: null, message: p.message }]);
        return p;
      });
    } catch (err) {
      if (!(err instanceof SpecError)) throw err;
      result.errors.push({ file, id: testIdOf(file, null), error: err });
      continue;
    }
    if (opts.tags?.length && !loaded.spec.tags?.some((t) => opts.tags!.includes(t))) continue;
    const prev = seen.get(loaded.id);
    if (prev) {
      const error = new SpecError(file, [{ path: 'id', line: null, message: `테스트 id '${loaded.id}'가 ${relative(PATHS.root, prev)}와 중복됩니다` }]);
      result.errors.push({ file, id: loaded.id, error });
      continue;
    }
    seen.set(loaded.id, file);
    result.tests.push(loaded);
  }
  return result;
}

/** Loads one test file with its subflows; `profileOf` supplies the app profile (throws SpecError when missing). */
export function loadTestFile(file: string, profileOf: (app: string) => AppProfile): LoadedTest {
  const spec = parseFile(file, TestSpec);
  const flows = new Map<string, FlowSpec>();
  const lists: [string, StepSpec[] | undefined][] = [
    ['setup', spec.setup],
    ['steps', spec.steps],
    ['teardown', spec.teardown],
    ...(spec.when ?? []).map((w, i): [string, StepSpec[]] => [`when[${i}].do`, w.do]),
  ];
  const problems: SpecProblem[] = [];
  for (const [path, steps] of lists) if (steps) collectFlows(file, steps, path, [file], flows, problems);
  if (problems.length) throw new SpecError(file, problems);
  return { file, id: testIdOf(file, spec), spec, profile: profileOf(spec.app), flows };
}

/** Walks a step list (incl. nested repeat/which), loading every `use:` target relative to `file`. */
function collectFlows(file: string, steps: readonly StepSpec[], path: string, stack: string[], flows: Map<string, FlowSpec>, problems: SpecProblem[]): void {
  steps.forEach((step, i) => {
    const here = `${path}[${i}]`;
    if ('repeat' in step) collectFlows(file, step.repeat.steps as StepSpec[], `${here}.repeat.steps`, stack, flows, problems);
    if ('which' in step) {
      for (const [option, branch] of Object.entries(step.which)) collectFlows(file, branch as StepSpec[], `${here}.which.${option}`, stack, flows, problems);
    }
    if (!('use' in step)) return;
    const problem = (message: string) => problems.push({ path: `${here}.use`, line: null, message });
    if (step.use.includes('${')) return problem('use 경로에는 ${…} 변수를 쓸 수 없습니다');
    if (!FLOW_SUFFIX.test(step.use)) return problem(`하위 흐름 파일은 *.flow.yaml 이어야 합니다: ${step.use}`);
    const target = resolve(dirname(file), expandHome(step.use));
    if (stack.includes(target)) return problem(`하위 흐름 순환: ${[...stack, target].map((f) => basename(f)).join(' → ')}`);
    if (stack.length > MAX_FLOW_DEPTH) return problem(`하위 흐름 중첩이 ${MAX_FLOW_DEPTH}단계를 넘습니다`);
    if (!existsSync(target)) return problem(`하위 흐름 파일이 없습니다: ${relative(PATHS.root, target)}`);
    if (!flows.has(target)) {
      let flow: FlowSpec;
      try {
        flow = parseFile(target, FlowSpec);
      } catch (err) {
        if (!(err instanceof SpecError)) throw err;
        return problem(err.message);
      }
      flows.set(target, flow);
    }
    // Re-walked also when loaded through another route, so a cycle through this route is still detected.
    collectFlows(target, flows.get(target)!.steps, 'steps', [...stack, target], flows, problems);
  });
}

/** Parses YAML and validates it with `schema`, mapping every failure to a located Korean problem. */
function parseFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new SpecError(file, [{ path: '', line: null, message: `파일을 읽을 수 없습니다: ${(err as Error).message}` }]);
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true });
  if (doc.errors.length) {
    throw new SpecError(
      file,
      doc.errors.map((e) => ({ path: '', line: e.linePos?.[0]?.line ?? null, message: `YAML 구문 오류: ${e.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '')}` })),
    );
  }
  const data: unknown = doc.toJS();
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const lineOf = (path: readonly PropertyKey[]): number | null => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n) as unknown[], true);
      if (node && (isMap(node) || isSeq(node) || isScalar(node)) && node.range) return lineCounter.linePos(node.range[0]).line;
    }
    return null;
  };
  const problems = explainIssues(parsed.error.issues, data, []).map((p) => ({ path: formatPath(p.path), line: lineOf(p.path), message: p.message }));
  throw new SpecError(file, problems);
}

type Issue = z.core.$ZodIssue;

/** Step option by kind key (`tap`, `see`, …): the first key of each union member's shape. */
const STEP_BY_KIND: Record<string, z.ZodType> = Object.fromEntries(
  (Step.options as unknown as { shape: Record<string, unknown> }[]).map((o) => [Object.keys(o.shape)[0]!, o as unknown as z.ZodType]),
);
const STEP_KINDS = Object.keys(STEP_BY_KIND);

const CUSTOM_MESSAGES: Record<string, string> = {
  'selector needs intent, text, desc or id': '셀렉터에는 intent, text, desc, id 중 하나가 필요합니다',
  'which needs ≥2 branches': 'which에는 분기가 2개 이상 필요합니다',
  'repeat needs times or while (max 10 iterations)': 'repeat에는 times 또는 while이 필요합니다 (최대 10회)',
};

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let v = data;
  for (const key of path) v = v !== null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[key] : undefined;
  return v;
}

/** True when `path` points at an element of a step list (steps/setup/teardown/do, repeat.steps, which branches). */
function isStepPath(path: readonly PropertyKey[]): boolean {
  const n = path.length;
  if (n < 2 || typeof path[n - 1] !== 'number') return false;
  const list = path[n - 2];
  return (typeof list === 'string' && STEP_LISTS[list] === true) || path[n - 3] === 'which';
}

function explainIssues(issues: readonly Issue[], data: unknown, prefix: readonly PropertyKey[]): { path: PropertyKey[]; message: string }[] {
  const out: { path: PropertyKey[]; message: string }[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union') {
      const value = valueAt(data, path);
      if (isStepPath(path)) {
        out.push(...explainStep(value, data, path));
        continue;
      }
      // Target (string | selector) and similar unions: report the branch matching the value's shape.
      const branches = issue.errors;
      const pick = typeof value === 'string' ? branches[0] : value !== null && typeof value === 'object' ? branches[branches.length - 1] : undefined;
      if (pick?.length) out.push(...explainIssues(pick, data, path));
      else out.push({ path, message: '문자열 또는 셀렉터 객체여야 합니다' });
      continue;
    }
    out.push({ path, message: issueMessage(issue, valueAt(data, path)) });
  }
  return out;
}

function explainStep(value: unknown, data: unknown, path: PropertyKey[]): { path: PropertyKey[]; message: string }[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [{ path, message: '스텝은 객체여야 합니다 (예: tap: 출국장)' }];
  const kinds = Object.keys(value).filter((k) => STEP_BY_KIND[k] !== undefined);
  if (kinds.length === 0) {
    return [{ path, message: `알 수 없는 스텝 종류 (키: ${Object.keys(value).join(', ') || '없음'}). 허용: ${STEP_KINDS.join(', ')}` }];
  }
  if (kinds.length > 1) return [{ path, message: `한 스텝에 종류가 여러 개입니다: ${kinds.join(', ')}` }];
  const checked = STEP_BY_KIND[kinds[0]!]!.safeParse(value);
  return checked.success ? [{ path, message: '스텝 형식 오류' }] : explainIssues(checked.error.issues, data, path);
}

function issueMessage(issue: Issue, value: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return value === undefined ? `필수 항목이 없습니다 (${issue.expected})` : `${issue.expected} 타입이어야 합니다`;
    case 'unrecognized_keys':
      return `알 수 없는 키: ${issue.keys.join(', ')}`;
    case 'too_small':
      if (issue.origin === 'array') return `최소 ${String(issue.minimum)}개가 필요합니다`;
      if (issue.origin === 'string') return Number(issue.minimum) <= 1 ? '비어 있으면 안 됩니다' : `최소 ${String(issue.minimum)}자가 필요합니다`;
      return `${String(issue.minimum)} ${issue.inclusive ? '이상' : '초과'}이어야 합니다`;
    case 'too_big':
      if (issue.origin === 'array') return `최대 ${String(issue.maximum)}개까지 허용됩니다`;
      return `${String(issue.maximum)} ${issue.inclusive ? '이하' : '미만'}이어야 합니다`;
    case 'invalid_value':
      return `허용 값: ${issue.values.map((v) => String(v)).join(', ')}`;
    case 'invalid_format':
      return `형식이 올바르지 않습니다${'pattern' in issue && issue.pattern ? ` (${String(issue.pattern)})` : ''}`;
    case 'custom':
      return CUSTOM_MESSAGES[issue.message] ?? issue.message;
    default:
      return issue.message;
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) out += typeof key === 'number' ? `[${key}]` : out ? `.${String(key)}` : String(key);
  return out;
}
