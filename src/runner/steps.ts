// Run-time `${NAME}` expansion of steps; step labels live with the step kinds in `src/spec/schema.ts`.
import type { StepSpec } from '../spec/schema.ts';

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
