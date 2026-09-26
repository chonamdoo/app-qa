// Step labels (run.started / reports) and run-time `${NAME}` expansion; kinds come from `src/spec/steps.ts`.
import type { StepSpec } from '../spec/schema.ts';
import { STEP_KIND_LABEL, stepKind } from '../spec/steps.ts';

function describe(value: unknown): string {
  if (value === true || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    if ('regex' in value) return `/${String(value.regex)}/`;
    return Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' || typeof v === 'number' ? v : describe(v) || JSON.stringify(v)}`)
      .join(', ');
  }
  return JSON.stringify(value);
}

/**
 * "탭: 출국장", "입력(2자) → 검색창", "반복: 3회" … Labels are built before the step runs, before the target is
 * observed, so a `type` label never carries the typed text (the field may turn out to be secure): only its length, or
 * `변수` when the text has a `${…}` placeholder. The evidence sanitizer masks profile `redact` matches and known
 * secrets in the rest.
 */
export function stepLabel(step: StepSpec): string {
  const kind = stepKind(step);
  if ('type' in step) return `${STEP_KIND_LABEL[kind]}(${step.type.includes('${') ? '변수' : `${[...step.type].length}자`}) → ${describe(step.into)}`;
  let detail: string;
  if ('which' in step) detail = Object.keys(step.which).join(' | ');
  else if ('repeat' in step) detail = step.repeat.times !== undefined ? `${step.repeat.times}회` : `조건 ${describe(step.repeat.while)}`;
  else if ('wait' in step) detail = typeof step.wait === 'number' ? `${step.wait}ms` : `${describe(step.wait.until)}까지`;
  else if ('checkEach' in step) detail = `/${step.checkEach.pattern}/`;
  else if ('remember' in step) detail = `${step.remember.name} ← ${describe(step.remember.from)}`;
  else if ('scroll' in step) detail = `${step.scroll.direction}${step.scroll.until ? ` → ${describe(step.scroll.until)}` : ''}`;
  else detail = describe(Object.entries(step).find(([key]) => key === kind)?.[1]);
  return detail ? `${STEP_KIND_LABEL[kind]}: ${detail}` : STEP_KIND_LABEL[kind];
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Unset variables named in one message. */
export class UnsetVariableError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`값이 없는 변수: ${names.join(', ')} (.env 또는 remember/with로 지정하세요)`);
    this.name = 'UnsetVariableError';
    this.names = names;
  }
}

/** Replaces `${NAME}` via `lookup`; throws UnsetVariableError listing every unresolved name. */
function expandString(text: string, lookup: (name: string) => string | undefined): string {
  const missing: string[] = [];
  const out = text.replace(VAR, (whole, name: string) => {
    const v = lookup(name);
    if (v === undefined) {
      missing.push(name);
      return whole;
    }
    return v;
  });
  if (missing.length) throw new UnsetVariableError([...new Set(missing)]);
  return out;
}

/** Same shape with every string expanded (object keys are DSL field names and stay as they are). */
function expandDeep<T>(value: T, lookup: (name: string) => string | undefined): T {
  if (typeof value === 'string') return expandString(value, lookup) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => expandDeep(v, lookup)) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, lookup);
  return out as T;
}

/**
 * Expands every string of a step at run time. Nested step lists (repeat.steps, which branches) stay raw and are
 * expanded when they run, so values remembered in between are visible; `use` paths are resolved at load time.
 */
export function expandStep(step: StepSpec, lookup: (name: string) => string | undefined): StepSpec {
  if ('repeat' in step) {
    const { steps, ...condition } = step.repeat;
    const { repeat: _r, ...common } = step;
    return { ...expandDeep(common, lookup), repeat: { ...expandDeep(condition, lookup), steps } };
  }
  if ('which' in step) {
    const which: Record<string, StepSpec[]> = {};
    for (const [option, branch] of Object.entries(step.which)) which[expandString(option, lookup)] = branch;
    const { which: _w, ...rest } = step;
    return { ...expandDeep(rest, lookup), which };
  }
  if ('use' in step) {
    const { use, ...rest } = step;
    return { ...expandDeep(rest, lookup), use };
  }
  return expandDeep(step, lookup);
}
