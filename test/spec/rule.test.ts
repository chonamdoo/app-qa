import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ruleProblem } from '../../src/spec/schema.ts';

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
      'if without else': { '==': [{ if: [positive, true] }, true] },
      '?: without else': { '!': { '?:': [positive, false] } },
      '?: with a fourth operand': { '?:': [positive, true, false, true] },
      // Comparisons ignore a third operand, except `<`/`<=` where it makes a between check; a fourth is ignored there.
      '== with three operands': { '==': [n, 1, 2] },
      '=== with three operands': { '===': [n, 1, 2] },
      '!= with three operands': { '!=': [n, 1, 1] },
      '!== with three operands': { '!==': [n, 1, 1] },
      '> with three operands': { '>': [n, 0, 100] },
      '>= with three operands': { '>=': [n, 0, 100] },
      '< with four operands': { '<': [0, n, 100, -1] },
      '<= with four operands': { '<=': [0, n, 100, -1] },
      '== with one operand': { '==': [n] },
      '! with two operands': { '!': [{ '<': [n, 0] }, true] },
      '!! with two operands': { '!!': [positive, false] },
      '!! without operands': { and: [positive, { '!!': [] }] },
      // `in` of a missing list is false (and `!` makes that true); a third operand is ignored.
      'in without a list': { '!': { in: [s] } },
      'in with three operands': { in: [s, 'abc', 'x'] },
      'and without operands': { and: [] },
      'or without operands': { or: [positive, { or: [] }] },
      'all without logic': { all: [n] },
      'some without logic': { some: [n] },
      'none without logic': { none: [n] },
      'filter without logic': { in: [n, { filter: [n] }] },
      'map without logic': { in: [n, { map: [n] }] },
      'reduce without logic': { '==': [{ reduce: [n] }, 0] },
      // The accumulator would start at null: `max` of -3 and null is 0, so "the largest is at least 0" would hold for -3.
      'reduce without an initial value': { '>=': [{ reduce: [{ merge: [n] }, { max: [{ var: 'current' }, { var: 'accumulator' }] }] }, 0] },
    };
    for (const [name, rule] of Object.entries(cases)) assert.match(ruleProblem(rule, groups) ?? 'accepted', /피연산자 \d+개 \(필요: /, name);
  });

  it('refuses an if whose last condition has no else: 4 and 6 operands, nested included', () => {
    // When neither condition holds json-logic-js answers null for the missing else, and `!` makes that true: n = 0
    // would PASS "n is neither positive nor negative is false".
    const repro = { '!': { if: [positive, false, { '<': [n, 0] }, false] } };
    assert.equal(ruleProblem(repro, groups), 'rule.!.if: 피연산자 4개 (필요: 3개 이상의 홀수)');
    const six = { and: [{ '>=': [s, ''] }, { if: [positive, true, { '<': [n, 0] }, true, { '==': [n, 0] }, false] }] };
    assert.equal(ruleProblem(six, groups), 'rule.and[1].if: 피연산자 6개 (필요: 3개 이상의 홀수)');
    const inItem = { all: [{ merge: [n] }, { if: [{ '>': [{ var: '' }, 0] }, true, { '<': [{ var: '' }, 0] }, true] }] };
    assert.equal(ruleProblem(inItem, groups), 'rule.all[1].if: 피연산자 4개 (필요: 3개 이상의 홀수)');
    // With the else the same rule is accepted, at 3 and 5 operands.
    assert.equal(ruleProblem({ '!': { if: [positive, false, { '<': [n, 0] }, false, true] } }, groups), null);
    assert.equal(ruleProblem({ '!': { if: [positive, false, true] } }, groups), null);
  });

  it('refuses a var default, outside and inside a collection’s logic', () => {
    // json-logic-js returns the default for a value that is not there: a group that did not match (or a part an item
    // lacks) would be read as a value the rule accepts instead of reported unobserved.
    assert.equal(ruleProblem({ '>': [{ var: ['n', 5] }, 0] }, groups), 'rule.>[0].var: 피연산자 2개 (필요: 1개)');
    assert.equal(ruleProblem({ '>': [{ var: ['n', null] }, 0] }, groups), 'rule.>[0].var: 피연산자 2개 (필요: 1개)');
    const inItem = { all: [{ merge: [n] }, { '>': [{ var: ['x', 5] }, 0] }] };
    assert.equal(ruleProblem(inItem, groups), 'rule.all[1].>[0].var: 피연산자 2개 (필요: 0~1개)');
    const itemDefault = { all: [{ merge: [n] }, { '>': [{ var: ['', 5] }, 0] }] };
    assert.equal(ruleProblem(itemDefault, groups), 'rule.all[1].>[0].var: 피연산자 2개 (필요: 0~1개)');
    // Without a default both read.
    assert.equal(ruleProblem({ all: [{ merge: [n] }, { '>': [{ var: ['x'] }, 0] }] }, groups), null);
    assert.equal(ruleProblem({ '>': [{ var: ['n'] }, 0] }, groups), null);
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
      'if with else, chained': { and: [{ '==': [{ if: [positive, true, false] }, true] }, { '==': [{ if: [positive, 1, { '<': [n, 0] }, 2, 3] }, 1] }] },
      '?: ternary': { '?:': [positive, true, false] },
      '< between': { '<': [0, n, 100] },
      '<= between': { '<=': [0, n, 100] },
      'in of two': { in: ['a', s] },
      '!! of one': { '!!': n },
    };
    for (const [name, rule] of Object.entries(cases)) assert.equal(ruleProblem(rule, groups), null, name);
  });
});

describe('checkEach operators that read groups without a var', () => {
  it('refuses missing and missing_some: a group they name is never checked for being observed', () => {
    // Both read `s` by name, not through `var`: a line where `s` did not match would be evaluated (as "missing") and
    // PASS on `n` alone instead of being INCONCLUSIVE check_unobserved.
    const cases: Record<string, unknown> = {
      missing: { and: [positive, { '!!': { missing: ['s'] } }] },
      // A key string where json-logic-js wants a list of keys.
      missing_some: { and: [positive, { '!': { missing_some: [1, 'n'] } }] },
      'missing_some over a key list': { and: [positive, { '!': { missing_some: [1, ['n', 's']] } }] },
    };
    for (const [name, rule] of Object.entries(cases)) {
      const op = name.split(' ', 1)[0];
      assert.match(ruleProblem(rule, groups) ?? 'accepted', new RegExp(`^rule\\.and\\[1\\]\\.!!?: 알 수 없는 JSONLogic 연산자 "${op}"$`), name);
    }
  });
});
