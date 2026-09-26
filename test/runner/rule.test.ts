import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ruleProblem } from '../../src/runner/rule.ts';

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
