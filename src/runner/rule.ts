// `checkEach` rules (invariant 1): a JSONLogic rule is evaluated only after every object in it was checked to be exactly
// one known operator with the operands it needs, every `var` names a group of the pattern, and at least one `var` is
// read; only a boolean result counts. json-logic-js treats `{}` or a multi-key object as a truthy data literal and
// compares a missing operand as `undefined` (`{"==":[]}` is true), and reads a collection operand that is not a list as
// an empty one (`none` of a number is true), so an unchecked rule could PASS without testing anything; every such case
// is an ERROR instead.
import jsonLogic from 'json-logic-js';

/**
 * json-logic-js 2.0.5 operators a rule may use, each with the operand count [min, max] it needs to compute anything: the
 * library reads a missing operand as `undefined` (`{"%":[n]}` is NaN, and `NaN != 0` is true) and ignores extra ones.
 * The allow list is this table, so no allowed operator goes unchecked. `log` is left out: it prints group values to
 * stdout, around the evidence sanitizer.
 */
const OPERATORS: Record<string, readonly [number, number]> = {
  '==': [2, 2],
  '===': [2, 2],
  '!=': [2, 2],
  '!==': [2, 2],
  '>': [2, 2],
  '>=': [2, 2],
  // A third operand makes a between check.
  '<': [2, 3],
  '<=': [2, 3],
  '!!': [1, 1],
  '!': [1, 1],
  '%': [2, 2],
  in: [2, 2],
  cat: [1, Infinity],
  // source, start, optional length.
  substr: [2, 3],
  '+': [2, Infinity],
  '*': [2, Infinity],
  // One operand negates.
  '-': [1, 2],
  '/': [2, 2],
  min: [1, Infinity],
  max: [1, Infinity],
  merge: [1, Infinity],
  // No default: a missing group must not turn into a value the rule accepts.
  var: [1, 1],
  missing: [1, Infinity],
  // need count, keys.
  missing_some: [2, 2],
  // condition, then, else; more pairs chain else-ifs.
  if: [3, Infinity],
  '?:': [3, 3],
  and: [1, Infinity],
  or: [1, Infinity],
  // array, logic applied to each item (reduce: optional initial value).
  filter: [2, 2],
  map: [2, 2],
  reduce: [2, 3],
  all: [2, 2],
  none: [2, 2],
  some: [2, 2],
};

/**
 * Operators whose operand at this index must be a list when evaluated, and whether a string counts: json-logic-js reads
 * any other value as an empty collection (`all`/`some`/`none` then answer without evaluating their logic, `filter`/`map`
 * give `[]`, `reduce` its initial value) and `in` of a non-list as false. `merge` takes any values (a non-list is one
 * item), so it needs no check.
 */
const LIST_OPERAND: Record<string, { at: number; strings: boolean }> = {
  all: { at: 0, strings: false },
  none: { at: 0, strings: false },
  some: { at: 0, strings: false },
  filter: { at: 0, strings: false },
  map: { at: 0, strings: false },
  reduce: { at: 0, strings: false },
  in: { at: 1, strings: true },
};

/**
 * The evaluation-time list check (`listChecked`), registered as an operation outside the `OPERATORS` allow list so no
 * rule can name it: wrapped around the operand, it sees the value in the operator's own scope (inside a collection's
 * logic, the item) and throws for anything else, which `judgeLines` reports as a broken rule.
 */
const LIST_CHECK = 'qa_list_operand';
jsonLogic.add_operation(LIST_CHECK, (value: unknown, op: string) => {
  if (Array.isArray(value) || (LIST_OPERAND[op]!.strings && typeof value === 'string')) return value;
  throw new Error(`${op}의 대상이 ${LIST_OPERAND[op]!.strings ? '배열이나 문자열' : '배열'}이 아님: ${JSON.stringify(value) ?? String(value)}`);
});

/** `rule` (which passed `ruleProblem`) with every `LIST_OPERAND` operand wrapped in the `LIST_CHECK` operation. */
function listChecked(rule: unknown): unknown {
  if (Array.isArray(rule)) return rule.map(listChecked);
  if (rule === null || typeof rule !== 'object') return rule;
  const entries = Object.entries(rule);
  // Not an operator: json-logic-js returns it as data (`ruleProblem` refuses it anyway).
  if (entries.length !== 1) return rule;
  const [op, operand] = entries[0]!;
  const operands = (Array.isArray(operand) ? operand : [operand]).map(listChecked);
  const list = Object.hasOwn(LIST_OPERAND, op) ? LIST_OPERAND[op]! : null;
  if (list) operands[list.at] = { [LIST_CHECK]: [operands[list.at], op] };
  return { [op]: operands };
}

function operandProblem(value: unknown, groups: ReadonlySet<string>, read: Set<string>, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const problem = operandProblem(item, groups, read, `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  return value !== null && typeof value === 'object' ? operatorProblem(value, groups, read, path) : null;
}

function operatorProblem(rule: unknown, groups: ReadonlySet<string>, read: Set<string>, path: string): string | null {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return `${path}: JSONLogic 연산자 객체가 아님`;
  const entries = Object.entries(rule);
  if (entries.length !== 1) return `${path}: 연산자 객체는 키가 정확히 1개여야 함 (${entries.length}개: ${entries.map(([k]) => k).join(', ') || '없음'})`;
  const [op, operand] = entries[0]!;
  if (!Object.hasOwn(OPERATORS, op)) return `${path}: 알 수 없는 JSONLogic 연산자 "${op}"`;
  // json-logic-js passes a non-array operand as the single operand.
  const operands: unknown[] = Array.isArray(operand) ? operand : [operand];
  const [min, max] = OPERATORS[op]!;
  if (operands.length < min || operands.length > max) {
    const need = min === max ? `${min}개` : max === Infinity ? `${min}개 이상` : `${min}~${max}개`;
    return `${path}.${op}: 피연산자 ${operands.length}개 (필요: ${need})`;
  }
  if (op === 'var') {
    const name = operands[0];
    if (typeof name !== 'string' || !name) return `${path}.var: pattern의 이름 그룹 이름(비어 있지 않은 문자열)이어야 함`;
    if (!groups.has(name)) return `${path}.var: "${name}"는 pattern의 이름 그룹이 아님`;
    read.add(name);
    return null;
  }
  return operandProblem(operand, groups, read, `${path}.${op}`);
}

/**
 * Why `rule` is not a checkable JSONLogic rule over the pattern's named `groups` (Korean), or null. Every object in it
 * must be one known operator with the operands it needs, and the rule must read at least one group.
 */
export function ruleProblem(rule: unknown, groups: ReadonlySet<string>): string | null {
  const read = new Set<string>();
  const problem = operatorProblem(rule, groups, read, 'rule');
  if (problem) return problem;
  return read.size ? null : 'rule: var가 없어 아무 값도 검사하지 않음';
}

export interface LineMatch {
  line: string;
  /** The groups the line matched; an optional group that did not take part is absent (never null or 0). */
  data: Record<string, string | number>;
}

type Judgement = { verdict: 'PASS' | 'FAIL' | 'ERROR' | 'INCONCLUSIVE'; code: string | null; reason: string };

/**
 * Verdict of a rule that passed `ruleProblem` over the matched lines. A line missing a group the rule reads (an optional
 * group that did not match) is not evaluated: its value was not observed. A throw (a collection operand that is not a
 * list included, see `LIST_OPERAND`) or a non-boolean result on any evaluated line is a broken rule (ERROR, never a
 * pass); then any violating line (it stands whatever else was seen) or too few lines is FAIL; then a line that could
 * not be evaluated is INCONCLUSIVE `check_unobserved`.
 */
export function judgeLines(rule: object, matches: readonly LineMatch[], min: number): Judgement {
  const reads = jsonLogic.uses_data(rule);
  const logic = listChecked(rule);
  const violations: LineMatch[] = [];
  const unobserved: string[] = [];
  for (const m of matches) {
    const missing = reads.filter((name) => !Object.hasOwn(m.data, name));
    if (missing.length) {
      unobserved.push(`"${m.line}" (${missing.join(', ')} 값 없음)`);
      continue;
    }
    let value: unknown;
    try {
      value = jsonLogic.apply(logic, m.data);
    } catch (err) {
      return { verdict: 'ERROR', code: 'invalid_rule', reason: `checkEach 규칙 평가 오류 ("${m.line}"): ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof value !== 'boolean') return { verdict: 'ERROR', code: 'invalid_rule', reason: `checkEach 규칙 결과가 참/거짓이 아님 ("${m.line}"): ${JSON.stringify(value)}` };
    if (!value) violations.push(m);
  }
  if (violations.length) return { verdict: 'FAIL', code: 'check_failed', reason: `규칙 위반 ${violations.length}줄: ${violations.map((v) => `"${v.line}" ${JSON.stringify(v.data)}`).join('; ')}` };
  if (matches.length < min) return { verdict: 'FAIL', code: 'check_min', reason: `패턴 일치 ${matches.length}줄 < 최소 ${min}줄` };
  if (unobserved.length) return { verdict: 'INCONCLUSIVE', code: 'check_unobserved', reason: `규칙이 읽는 그룹이 관찰되지 않은 ${unobserved.length}줄은 판정할 수 없음: ${unobserved.join('; ')}` };
  return { verdict: 'PASS', code: null, reason: `${matches.length}줄 모두 규칙 만족` };
}

/** Numbers from digit-only groups ("27", "1,234", "-3.5"); other groups stay strings; groups that did not match are left out. */
export function groupData(groups: Record<string, string | undefined>): Record<string, string | number> {
  const data: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(groups)) if (v !== undefined) data[k] = /^[+-]?\d[\d,]*(\.\d+)?$/.test(v) ? Number(v.replace(/,/g, '')) : v;
  return data;
}
