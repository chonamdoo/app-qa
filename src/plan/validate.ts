// Deterministic checks on LLM output before anything is written: TestSpec schema, allowed step kinds, no risky or
// unlabeled actions, no `allowRisky`, no keyboard submit (`type.submit`, `press` other than `back`), compilable regexes,
// declared `${VAR}`s, known `covers`, and full coverage (every requirement is covered by a valid test or listed as
// untestable with a reason).
import type { z } from 'zod';
import { labelRisk } from '../policy/risk.ts';
import { patternGroups, ruleProblem } from '../spec/rule.ts';
import { findStepKind, STEP_BRANCHES, TestSpec, type AppProfile } from '../spec/schema.ts';
import type { ScreenInfo } from './context.ts';
import { isPlainObject, visitJson } from './json.ts';

/** Step kinds a generated test may use. Not allowed: coordinate gestures (tapAt, swipe — unlabeled, e.g. swipe-to-delete),
 * deep links and subflows the model would have to invent (open, use), device state changes (location). */
export const ALLOWED_STEP_KINDS: Record<string, true> = {
  launch: true,
  tap: true,
  longPress: true,
  type: true,
  clear: true,
  press: true,
  hideKeyboard: true,
  see: true,
  seeNot: true,
  assertText: true,
  assertNoText: true,
  checkEach: true,
  claim: true,
  remember: true,
  which: true,
  repeat: true,
  scroll: true,
  back: true,
  wait: true,
  capture: true,
};


export interface CheckContext {
  app: string;
  profile: AppProfile;
  envNames: ReadonlySet<string>;
  /** Requirement ids the output must account for (the current batch). */
  requirementIds: ReadonlySet<string>;
  screens: readonly ScreenInfo[];
}

export interface Untestable {
  requirement: string;
  reason: string;
}

export interface CheckedTest {
  /** The test as it will be written (`app` set, `source` removed); only meaningful when `errors` is empty. */
  spec: Record<string, unknown>;
  /** `id`, `name` or `tests[i]`, for messages. */
  label: string;
  covers: string[];
  errors: string[];
  /** Non-fatal findings (e.g. a literal missing from the screen inventory); they keep the test in `draft`. */
  warnings: string[];
}

export interface CheckedOutput {
  tests: CheckedTest[];
  untestable: Untestable[];
  /** Output-level problems: shape, unknown untestable ids, uncovered requirements. */
  errors: string[];
}

export function checkOutput(raw: unknown, ctx: CheckContext): CheckedOutput {
  const out: CheckedOutput = { tests: [], untestable: [], errors: [] };
  if (!isPlainObject(raw) || !Array.isArray(raw.tests)) {
    out.errors.push('출력은 {"tests": [...], "untestable": [...]} JSON 객체여야 합니다');
    return out;
  }
  out.tests = raw.tests.map((t, i) => checkTest(t, i, ctx));
  const untestable = raw.untestable ?? [];
  if (!Array.isArray(untestable)) out.errors.push('untestable은 배열이어야 합니다');
  else {
    untestable.forEach((u, i) => {
      if (!isPlainObject(u) || typeof u.requirement !== 'string' || typeof u.reason !== 'string' || !u.reason.trim()) {
        out.errors.push(`untestable[${i}]: {"requirement": "<id>", "reason": "<사유>"} 형식이어야 합니다`);
      } else if (!ctx.requirementIds.has(u.requirement)) {
        out.errors.push(`untestable[${i}]: 알 수 없는 요구사항 id "${u.requirement}"`);
      } else out.untestable.push({ requirement: u.requirement, reason: u.reason.trim() });
    });
  }
  const accounted = new Set(out.untestable.map((u) => u.requirement));
  for (const t of out.tests) if (!t.errors.length) for (const c of t.covers) accounted.add(c);
  for (const id of ctx.requirementIds) {
    if (!accounted.has(id)) out.errors.push(`요구사항 ${id}: 유효한 테스트의 covers에도 untestable에도 없습니다`);
  }
  return out;
}

/** Revision feedback: every output-level and per-test error, one per line. */
export function formatErrors(checked: CheckedOutput): string[] {
  const lines = [...checked.errors];
  checked.tests.forEach((t, i) => {
    for (const e of t.errors) lines.push(`tests[${i}] (${t.label}): ${e}`);
  });
  return lines;
}

export function checkTest(raw: unknown, index: number, ctx: CheckContext): CheckedTest {
  if (!isPlainObject(raw)) return { spec: {}, label: `tests[${index}]`, covers: [], errors: ['테스트는 객체여야 합니다'], warnings: [] };
  const label = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : `tests[${index}]`;
  const { app: _app, source: _source, ...rest } = raw;
  const spec: Record<string, unknown> = { ...rest, app: ctx.app };
  const errors: string[] = [];
  const warnings: string[] = [];

  const covers = Array.isArray(raw.covers) ? raw.covers.filter((c): c is string => typeof c === 'string') : [];
  if (!covers.length) errors.push('covers에 요구사항 id가 하나 이상 필요합니다');
  for (const c of covers) if (!ctx.requirementIds.has(c)) errors.push(`covers: 알 수 없는 요구사항 id "${c}"`);
  if (raw.reset === 'clear' || raw.reset === 'reinstall') errors.push(`reset: ${raw.reset}는 앱 데이터를 지웁니다 — 자동 생성 테스트는 none|relaunch만`);

  const strings: string[] = [];
  const remembered = new Set<string>();
  visitJson(spec, (key, value, parent) => {
    if (typeof value === 'string') strings.push(value);
    if (key === 'allowRisky') errors.push('allowRisky는 자동 생성 테스트에 쓸 수 없습니다 (위험 동작이 필요하면 untestable: needs_approval)');
    if (key === 'id' && parent !== spec) errors.push(`id 셀렉터 "${String(value)}"는 쓸 수 없습니다 — 화면 인벤토리의 라벨을 쓰세요`);
    if (key === 'regex' && typeof value === 'string') {
      const flags = typeof parent.flags === 'string' ? parent.flags : '';
      try {
        new RegExp(value, flags);
      } catch {
        errors.push(`정규식이 올바르지 않습니다: /${value}/${flags}`);
      }
    }
    if (key === 'remember' && isPlainObject(value) && typeof value.name === 'string') remembered.add(value.name);
  });

  const walkSteps = (steps: unknown, path: string): void => {
    // A non-array here is reported by the TestSpec parse below.
    if (Array.isArray(steps)) steps.forEach((step, i) => checkStep(step, `${path}[${i}]`));
  };
  const checkStep = (step: unknown, path: string): void => {
    if (!isPlainObject(step)) {
      errors.push(`${path}: 스텝은 객체여야 합니다`);
      return;
    }
    const kind = findStepKind(step);
    if (!kind) {
      errors.push(`${path}: 알 수 없는 스텝 종류 (${Object.keys(step).join(', ') || '빈 객체'}) — 허용: ${Object.keys(ALLOWED_STEP_KINDS).join(', ')}`);
      return;
    }
    if (!ALLOWED_STEP_KINDS[kind]) {
      errors.push(`${path}: 자동 생성 테스트에 허용되지 않는 스텝 "${kind}" — 허용: ${Object.keys(ALLOWED_STEP_KINDS).join(', ')}`);
      return;
    }
    const parsed = STEP_BRANCHES[kind].safeParse(step);
    if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 4)) errors.push(`${path}${issuePath(issue.path)}: ${issue.message}`);
    const value = step[kind];
    if (kind === 'launch' && isPlainObject(value)) {
      if (value.permissions !== undefined) errors.push(`${path}: launch.permissions는 자동 생성 테스트에서 바꿀 수 없습니다`);
      if (value.reset === 'clear' || value.reset === 'reinstall') errors.push(`${path}: launch.reset ${value.reset}는 앱 데이터를 지웁니다 — none|relaunch만`);
    }
    // Invariant 8: Enter can send or confirm whatever the focused form does, and no label names that effect.
    if (kind === 'type' && step.submit === true) {
      errors.push(`${path}: type.submit은 자동 생성 테스트에 쓸 수 없습니다 (Enter가 전송·확정할 수 있음) — 입력 후 화면의 라벨 있는 버튼을 탭하거나, 필요하면 해당 요구사항은 untestable(needs_approval)`);
    }
    if (kind === 'press' && value !== 'back') {
      errors.push(`${path}: press ${JSON.stringify(value)}는 자동 생성 테스트에 쓸 수 없습니다 — press는 "back"만 허용 (Enter 등은 전송·확정할 수 있음), 필요하면 해당 요구사항은 untestable(needs_approval)`);
    }
    if (kind === 'tap' || kind === 'longPress') {
      for (const label of targetLabels(value)) {
        const risk = labelRisk(label, ctx.profile.risk, strings);
        if (risk.unknown) errors.push(`${path}: 라벨 없는 대상에는 행동할 수 없습니다`);
        else if (risk.risky) errors.push(`${path}: 위험 동작 대상 "${label}" (${risk.reasons.join(', ')}) — 해당 요구사항은 untestable(needs_approval)`);
      }
    }
    if (kind === 'checkEach' && isPlainObject(value) && typeof value.pattern === 'string') {
      let groups: Set<string> | null = null;
      try {
        groups = patternGroups(value.pattern);
      } catch {
        errors.push(`${path}: checkEach.pattern 정규식이 올바르지 않습니다`);
      }
      // The runner's own check: a rule it would refuse (ERROR invalid_rule) is refused here.
      const problem = groups && ruleProblem(value.rule, groups);
      if (problem) errors.push(`${path}: checkEach.${problem}`);
    }
    if (kind === 'which' && isPlainObject(value)) for (const [branch, sub] of Object.entries(value)) walkSteps(sub, `${path}.which[${JSON.stringify(branch)}]`);
    if (kind === 'repeat' && isPlainObject(value)) walkSteps(value.steps, `${path}.repeat.steps`);
  };
  walkSteps(spec.setup, 'setup');
  walkSteps(spec.steps, 'steps');
  walkSteps(spec.teardown, 'teardown');
  if (Array.isArray(spec.when)) spec.when.forEach((w, i) => isPlainObject(w) && walkSteps(w.do, `when[${i}].do`));

  for (const m of strings.join('\n').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = m[1]!;
    if (!ctx.envNames.has(name) && !remembered.has(name)) errors.push(`\${${name}}: .env.example에 선언되지 않았고 remember로 정한 이름도 아닙니다`);
  }

  if (!errors.length) {
    const parsed = TestSpec.safeParse(spec);
    if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 6)) errors.push(`${issuePath(issue.path).slice(1) || '(테스트)'}: ${issue.message}`);
  }

  if (ctx.screens.length) {
    const seen = ctx.screens.flatMap((s) => [...s.texts, ...s.candidates.map((c) => c.name)]);
    const unseen = new Set<string>();
    visitJson(spec, (key, value) => {
      if ((key === 'text' || key === 'desc' || key === 'assertText') && typeof value === 'string' && !value.includes('${')) {
        const want = value.normalize('NFC');
        if (!seen.some((t) => t.normalize('NFC').includes(want))) unseen.add(want);
      }
    });
    for (const s of unseen) warnings.push(`화면 인벤토리에 없는 문구 "${s}" — 실제 화면 문구인지 확인 필요`);
  }
  return { spec, label, covers, errors: [...new Set(errors)], warnings };
}

/** Labels the risk check must see for an acted-on target; `null` = no human-readable label (id-only selector). */
function targetLabels(target: unknown): (string | null)[] {
  if (typeof target === 'string') return [target];
  if (!isPlainObject(target)) return [null];
  const labels: string[] = [];
  for (const key of ['intent', 'text', 'desc'] as const) {
    const v = target[key];
    if (typeof v === 'string') labels.push(v);
    else if (isPlainObject(v) && typeof v.regex === 'string') labels.push(v.regex);
  }
  return labels.length ? labels : [null];
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');
}
