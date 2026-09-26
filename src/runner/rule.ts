// `checkEach` rule evaluation (invariant 1) of a rule `ruleProblem` (src/spec/schema.ts) accepted; only a boolean result
// counts. json-logic-js reads a collection operand that is not a list as an empty one (`none` of a number is true), and
// a part an item lacks as null, so an unchecked evaluation could PASS without testing anything; every such case is an
// ERROR instead.
import jsonLogic from 'json-logic-js';
import { RULE_ITEM_LOGIC, RULE_LIST_OPERAND } from '../spec/schema.ts';

/**
 * The evaluation-time list check (`evaluable`), registered as an operation outside the rule operator allow list so no
 * rule can name it: wrapped around the operand, it sees the value in the operator's own scope (inside a collection's
 * logic, the item) and throws for anything else, which `judgeLines` reports as a broken rule.
 */
const LIST_CHECK = 'qa_list_operand';
jsonLogic.add_operation(LIST_CHECK, (value: unknown, op: string) => {
  if (Array.isArray(value) || (RULE_LIST_OPERAND[op]!.strings && typeof value === 'string')) return value;
  throw new Error(`${op}의 대상이 ${RULE_LIST_OPERAND[op]!.strings ? '배열이나 문자열' : '배열'}이 아님: ${JSON.stringify(value) ?? String(value)}`);
});

/**
 * `var` inside a collection's logic (`evaluable`), registered outside the rule operator allow list like `LIST_CHECK`:
 * the item itself for `""` or no operand, else the part of it the dotted path names, which the item must have — a part
 * it lacks throws, which `judgeLines` reports as a broken rule.
 */
const ITEM_VAR = 'qa_item_var';
jsonLogic.add_operation(ITEM_VAR, function (this: unknown, path?: string) {
  if (!path) return this;
  let value: unknown = this;
  for (const key of path.split('.')) {
    const holder: Record<string, unknown> | null = value === null || value === undefined ? null : Object(value);
    if (!holder || !Object.hasOwn(holder, key)) throw new Error(`컬렉션 항목 ${JSON.stringify(this) ?? String(this)}에 "${path}" 값이 없음`);
    value = holder[key];
  }
  return value;
});

/**
 * `rule` (which passed `ruleProblem`) as it is evaluated: every `RULE_LIST_OPERAND` operand wrapped in the `LIST_CHECK`
 * operation and every `var` inside a collection's logic (`item`) made an `ITEM_VAR`. The groups read outside every
 * collection's logic (what a line must have to be evaluated) are added to `reads`.
 */
function evaluable(rule: unknown, item: boolean, reads: Set<string>): unknown {
  if (Array.isArray(rule)) return rule.map((value) => evaluable(value, item, reads));
  if (rule === null || typeof rule !== 'object') return rule;
  const entries = Object.entries(rule);
  // Not an operator: json-logic-js returns it as data (`ruleProblem` refuses it anyway).
  if (entries.length !== 1) return rule;
  const [op, operand] = entries[0]!;
  const raw: unknown[] = Array.isArray(operand) ? operand : [operand];
  if (op === 'var') {
    if (item) return { [ITEM_VAR]: raw };
    reads.add(String(raw[0]));
    return rule;
  }
  const logicAt = Object.hasOwn(RULE_ITEM_LOGIC, op) ? RULE_ITEM_LOGIC[op] : undefined;
  const operands = raw.map((value, i) => evaluable(value, item || i === logicAt, reads));
  const list = Object.hasOwn(RULE_LIST_OPERAND, op) ? RULE_LIST_OPERAND[op]! : null;
  if (list) operands[list.at] = { [LIST_CHECK]: [operands[list.at], op] };
  return { [op]: operands };
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
 * list, or a part a collection item lacks: see `RULE_LIST_OPERAND`, `ITEM_VAR`) or a non-boolean result on any
 * evaluated line is a broken rule (ERROR, never a pass); then any violating line (it stands whatever else was seen) or
 * too few lines is FAIL; then a line that could not be evaluated is INCONCLUSIVE `check_unobserved`.
 */
export function judgeLines(rule: object, matches: readonly LineMatch[], min: number): Judgement {
  const reads = new Set<string>();
  const logic = evaluable(rule, false, reads);
  const violations: LineMatch[] = [];
  const unobserved: string[] = [];
  for (const m of matches) {
    const missing = [...reads].filter((name) => !Object.hasOwn(m.data, name));
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
