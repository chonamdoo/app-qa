// `checkEach` rules (invariant 1): a JSONLogic rule is evaluated only after every object in it was checked to be exactly
// one known operator, and only a boolean result counts. json-logic-js treats `{}` or a multi-key object as a truthy data
// literal, so an unchecked rule could PASS without testing anything; every such case is an ERROR instead.
import jsonLogic from 'json-logic-js';

/** json-logic-js 2.0.5 operators. `log` is left out: it prints group values to stdout, around the evidence sanitizer. */
const OPERATORS: Record<string, true> = {
  '==': true,
  '===': true,
  '!=': true,
  '!==': true,
  '>': true,
  '>=': true,
  '<': true,
  '<=': true,
  '!!': true,
  '!': true,
  '%': true,
  in: true,
  cat: true,
  substr: true,
  '+': true,
  '*': true,
  '-': true,
  '/': true,
  min: true,
  max: true,
  merge: true,
  var: true,
  missing: true,
  missing_some: true,
  if: true,
  '?:': true,
  and: true,
  or: true,
  filter: true,
  map: true,
  reduce: true,
  all: true,
  none: true,
  some: true,
};

function operandProblem(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const problem = operandProblem(item, `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  return value !== null && typeof value === 'object' ? ruleProblem(value, path) : null;
}

/** Why `rule` is not a checkable JSONLogic rule (Korean), or null. Every object in it must be one known operator. */
export function ruleProblem(rule: unknown, path = 'rule'): string | null {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return `${path}: JSONLogic 연산자 객체가 아님`;
  const entries = Object.entries(rule);
  if (entries.length !== 1) return `${path}: 연산자 객체는 키가 정확히 1개여야 함 (${entries.length}개: ${entries.map(([k]) => k).join(', ') || '없음'})`;
  const [op, operand] = entries[0]!;
  if (!Object.hasOwn(OPERATORS, op)) return `${path}: 알 수 없는 JSONLogic 연산자 "${op}"`;
  return operandProblem(operand, `${path}.${op}`);
}

export interface LineMatch {
  line: string;
  data: Record<string, string | number | null>;
}

/**
 * Verdict of a rule that passed `ruleProblem` over the matched lines. A throw or a non-boolean result on any line is a
 * broken rule (ERROR, never a pass); then too few lines or any violating line is FAIL.
 */
export function judgeLines(rule: object, matches: readonly LineMatch[], min: number): { verdict: 'PASS' | 'FAIL' | 'ERROR'; code: string | null; reason: string } {
  const violations: LineMatch[] = [];
  for (const m of matches) {
    let value: unknown;
    try {
      value = jsonLogic.apply(rule, m.data);
    } catch (err) {
      return { verdict: 'ERROR', code: 'invalid_rule', reason: `checkEach 규칙 평가 오류 ("${m.line}"): ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof value !== 'boolean') return { verdict: 'ERROR', code: 'invalid_rule', reason: `checkEach 규칙 결과가 참/거짓이 아님 ("${m.line}"): ${JSON.stringify(value)}` };
    if (!value) violations.push(m);
  }
  if (matches.length < min) return { verdict: 'FAIL', code: 'check_min', reason: `패턴 일치 ${matches.length}줄 < 최소 ${min}줄` };
  if (violations.length) return { verdict: 'FAIL', code: 'check_failed', reason: `규칙 위반 ${violations.length}줄: ${violations.map((v) => `"${v.line}" ${JSON.stringify(v.data)}`).join('; ')}` };
  return { verdict: 'PASS', code: null, reason: `${matches.length}줄 모두 규칙 만족` };
}

/** Numbers from digit-only groups ("27", "1,234", "-3.5"); other groups stay strings; missing groups are null. */
export function groupData(groups: Record<string, string | undefined>): Record<string, string | number | null> {
  const data: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(groups)) data[k] = v === undefined ? null : /^[+-]?\d[\d,]*(\.\d+)?$/.test(v) ? Number(v.replace(/,/g, '')) : v;
  return data;
}
