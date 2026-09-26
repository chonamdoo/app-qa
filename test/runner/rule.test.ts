import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupData, judgeLines, ruleProblem } from '../../src/runner/rule.ts';

const groups = new Set(['n', 's']);
const n = { var: 'n' };
const s = { var: 's' };
const positive = { '>': [n, 0] };

describe('checkEach rule operand counts', () => {
  it('refuses an allowed operator with an operand missing or extra, nested included', () => {
    // json-logic-js reads a missing operand as undefined and ignores extra ones: each of these computes something other
    // than what it says (NaN, a single value, a dropped operand), which a comparison can still call true.
    const cases: Record<string, unknown> = {
      '% without divisor': { '!=': [{ '%': [n] }, 0] },
      '% with three operands': { '==': [{ '%': [n, 2, 3] }, 0] },
      '/ without divisor': { '!=': [{ '/': [n] }, 0] },
      '/ with three operands': { '<': [{ '/': [n, 2, 3] }, 10] },
      '- with three operands': { '<': [{ '-': [n, 1, 2] }, 10] },
      '- without operands': { '<': [{ '-': [] }, n] },
      '* of one operand': { '<': [{ '*': [n] }, 10] },
      '+ of one operand': { '<': [{ '+': [n] }, 10] },
      'min without operands': { '<': [n, { min: [] }] },
      'max without operands': { '>': [n, { max: [] }] },
      'cat without operands': { '!=': [{ cat: [] }, s] },
      'substr without start': { '==': [{ substr: [s] }, 'x'] },
      'substr with four operands': { '==': [{ substr: [s, 0, 1, 2] }, 'x'] },
      'merge without operands': { in: [n, { merge: [] }] },
      'missing without keys': { and: [{ '!': { missing: [] } }, positive] },
      'missing_some without keys': { and: [{ '!': { missing_some: [1] } }, positive] },
      'if without else': { '==': [{ if: [positive, true] }, true] },
      '?: with a fourth operand': { '?:': [positive, true, false, true] },
      'all without logic': { all: [n] },
      'some without logic': { some: [n] },
      'none without logic': { none: [n] },
      'filter without logic': { in: [n, { filter: [n] }] },
      'map without logic': { in: [n, { map: [n] }] },
      'reduce without logic': { '==': [{ reduce: [n] }, 0] },
    };
    for (const [name, rule] of Object.entries(cases)) assert.match(ruleProblem(rule, groups) ?? 'accepted', /피연산자 \d+개 \(필요: /, name);
  });

  it('accepts each operator at the operand counts it is defined for', () => {
    const cases: Record<string, unknown> = {
      '% of two': { '==': [{ '%': [n, 2] }, 0] },
      '+ of three': { '<': [{ '+': [n, 1, 2] }, 100] },
      'unary -': { '<': [{ '-': n }, 0] },
      'binary -': { '<': [{ '-': [n, 1] }, 0] },
      '* of two': { '<': [{ '*': [n, 2] }, 100] },
      '/ of two': { '<': [{ '/': [n, 2] }, 100] },
      'min of one': { '<': [{ min: [n] }, 100] },
      'max of two': { '<': [{ max: [n, 5] }, 100] },
      'cat of one': { '==': [{ cat: s }, 'x'] },
      'substr with and without length': { and: [{ '==': [{ substr: [s, 0] }, 'x'] }, { '==': [{ substr: [s, 0, 1] }, 'x'] }] },
      'merge of two': { in: [n, { merge: [[1, 2], [3]] }] },
      'missing and missing_some': { and: [{ '!': { missing: ['n'] } }, { '!': { missing_some: [1, ['n', 's']] } }, positive] },
      'if with else, chained': { and: [{ '==': [{ if: [positive, true, false] }, true] }, { '==': [{ if: [positive, 1, { '<': [n, 0] }, 2, 3] }, 1] }] },
      '?: ternary': { '?:': [positive, true, false] },
      '< between': { '<': [0, n, 100] },
    };
    for (const [name, rule] of Object.entries(cases)) assert.equal(ruleProblem(rule, groups), null, name);
  });
});

describe('checkEach lines with unobserved groups', () => {
  const re = /대기(?: (?<wait>\d+)분)?(?:, (?<level>\S+))?/u;
  const lines = (...texts: string[]) => texts.map((line) => ({ line, data: groupData(re.exec(line)!.groups ?? {}) }));
  const below100 = { '<': [{ var: 'wait' }, 100] };

  it('a line missing a group the rule reads is INCONCLUSIVE, never a comparison with 0 or null', () => {
    for (const matched of [lines('대기'), lines('대기 8분', '대기')]) {
      const j = judgeLines(below100, matched, 1);
      assert.equal(j.verdict, 'INCONCLUSIVE', j.reason);
      assert.equal(j.code, 'check_unobserved');
      assert.match(j.reason, /"대기" \(wait 값 없음\)/);
    }
  });

  it('a violating line FAILs next to an unobserved one; a group the rule does not read may be missing', () => {
    const j = judgeLines(below100, lines('대기', '대기 150분'), 1);
    assert.equal(j.verdict, 'FAIL', j.reason);
    assert.equal(j.code, 'check_failed');
    assert.equal(judgeLines(below100, lines('대기 8분', '대기 9분, 원활'), 2).verdict, 'PASS');
  });
});
