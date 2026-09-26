import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ruleProblem } from '../../src/spec/schema.ts';
import { groupData, judgeLines } from '../../src/runner/rule.ts';

const groups = new Set(['n', 's']);
const n = { var: 'n' };
const s = { var: 's' };

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

describe('checkEach if without an else', () => {
  it('is refused before evaluation; with the else, n = 0 violates "neither positive nor negative is false"', () => {
    const zero = [{ line: '값 0', data: { n: 0 } }];
    const negative = { '<': [n, 0] };
    // json-logic-js reads the missing else as null, and `!` makes that true: evaluated, n = 0 would PASS.
    const noElse = { '!': { if: [{ '>': [n, 0] }, false, negative, false] } };
    assert.match(ruleProblem(noElse, groups) ?? 'accepted', /^rule\.!\.if: 피연산자 4개 \(필요: 3개 이상의 홀수\)$/);
    const withElse = { '!': { if: [{ '>': [n, 0] }, false, negative, false, true] } };
    assert.equal(ruleProblem(withElse, groups), null);
    const j = judgeLines(withElse, zero, 1);
    assert.deepEqual([j.verdict, j.code], ['FAIL', 'check_failed'], j.reason);
    assert.equal(judgeLines(withElse, [{ line: '값 3', data: { n: 3 } }], 1).verdict, 'PASS');
  });
});

describe('checkEach collection operands', () => {
  const at = (value: number | string) => [{ line: `값 ${value}`, data: { n: value, s: String(value) } }];
  const item = { var: '' };

  it('a collection operator over a value that is not a list is ERROR invalid_rule, never an empty collection', () => {
    // json-logic-js reads a number as an empty collection: `none` is then true without evaluating its logic.
    const cases: Record<string, object> = {
      none: { none: [n, { '==': [item, 0] }] },
      all: { '!': { all: [n, { '==': [item, 0] }] } },
      some: { '!': { some: [n, { '==': [item, 0] }] } },
      filter: { '==': [{ filter: [n, true] }, []] },
      map: { '==': [{ map: [n, true] }, []] },
      reduce: { '==': [{ reduce: [n, true, 0] }, 0] },
      'in of a number': { '!': { in: [1, n] } },
    };
    for (const [name, rule] of Object.entries(cases)) {
      assert.equal(ruleProblem(rule, groups), null, name);
      const j = judgeLines(rule, at(5), 1);
      assert.equal(j.verdict, 'ERROR', `${name}: ${j.reason}`);
      assert.equal(j.code, 'invalid_rule', name);
      assert.match(j.reason, /의 대상이 배열(이나 문자열)?이 아님: 5/, name);
    }
    // A string is not a list either, except for `in` (substring).
    assert.equal(judgeLines({ none: [s, { '==': [item, 'x'] }] }, at('abc'), 1).verdict, 'ERROR');
    assert.equal(judgeLines({ in: ['b', s] }, at('abc'), 1).verdict, 'PASS');
    assert.equal(judgeLines({ in: ['z', s] }, at('abc'), 1).verdict, 'FAIL');
  });

  it('checks each operand in its own scope: collections over merged values and inside another collection’s logic', () => {
    // Collection logic reads the item (`var: ""`, `var: []`) or reduce's `current`/`accumulator`, never a group: the
    // rules pass the check, and a line needs only the groups read outside that logic.
    const line = (value: number) => [{ line: `값 ${value}`, data: { n: value } }];
    const allPositive = { all: [{ merge: [n, 1] }, { '>': [item, 0] }] };
    const sum = { '<': [{ reduce: [{ merge: [n, 2] }, { '+': [{ var: 'current' }, { var: 'accumulator' }] }, 0] }, 10] };
    // The inner `in` looks into each item: list items pass, a number item is ERROR.
    const holds3 = (list: unknown[]) => ({ and: [{ '>=': [n, 0] }, { some: [{ merge: list }, { in: [3, { var: [] }] }] }] });
    for (const rule of [allPositive, sum, holds3([n, 4])]) assert.equal(ruleProblem(rule, groups), null, JSON.stringify(rule));
    assert.equal(judgeLines(allPositive, line(5), 1).verdict, 'PASS');
    assert.equal(judgeLines(allPositive, line(-5), 1).verdict, 'FAIL');
    assert.equal(judgeLines(sum, line(5), 1).verdict, 'PASS');
    assert.equal(judgeLines(sum, line(9), 1).verdict, 'FAIL');
    assert.equal(judgeLines(holds3([[[1, 3]], [[2]]]), line(0), 1).verdict, 'PASS');
    assert.equal(judgeLines(holds3([[[1, 2]], [[4]]]), line(0), 1).verdict, 'FAIL');
    const j = judgeLines(holds3([n, 4]), line(0), 1);
    assert.equal(j.verdict, 'ERROR', j.reason);
    assert.match(j.reason, /in의 대상이 배열이나 문자열이 아님: 0/);
    // A line without a group read outside the logic is still unobserved (the item names are not groups it lacks).
    const unseen = judgeLines(allPositive, [{ line: '값 없음', data: {} }], 1);
    assert.deepEqual([unseen.verdict, unseen.code], ['INCONCLUSIVE', 'check_unobserved'], unseen.reason);
    assert.match(unseen.reason, /"값 없음" \(n 값 없음\)$/);
  });

  it('a var inside a collection’s logic reads the item: a group name there is refused, a part the item lacks is ERROR, never null', () => {
    // `n` inside `none` reads `n` of the item 5: json-logic-js gives null, `null > 0` is false, so "no item is
    // positive" would hold for n = 5.
    const repro = { none: [{ merge: [n] }, { '>': [n, 0] }] };
    assert.match(ruleProblem(repro, groups) ?? 'accepted', /^rule\.none\[1\]\.>\[0\]\.var: 컬렉션 안의 "n"는 이름 그룹이 아니라 현재 항목을 읽음/);
    assert.match(ruleProblem({ all: [{ merge: [n] }, { '>': [{ var: 's.length' }, 0] }] }, groups) ?? 'accepted', /컬렉션 안의 "s\.length"는 이름 그룹이 아니라/);
    const five = [{ line: '값 5', data: { n: 5 } }];
    // Evaluated anyway, the item has no `n`: ERROR, not a comparison with null.
    const j = judgeLines(repro, five, 1);
    assert.deepEqual([j.verdict, j.code], ['ERROR', 'invalid_rule'], j.reason);
    assert.match(j.reason, /컬렉션 항목 5에 "n" 값이 없음/);
    // A path naming no group passes the check and is looked up on each item when evaluated.
    const lacking: Record<string, object> = {
      'current outside reduce': { none: [{ merge: [n] }, { '<': [{ var: 'current' }, 0] }] },
      'an index one list item lacks': { and: [{ '>=': [n, 0] }, { none: [{ merge: [[[1, 2]], [[3]]] }, { '<': [{ var: '1' }, 0] }] }] },
      'a part of reduce data it lacks': { '<': [{ reduce: [{ merge: [n] }, { '+': [{ var: 'current.x' }, 1] }, 0] }, 100] },
    };
    for (const [name, rule] of Object.entries(lacking)) {
      assert.equal(ruleProblem(rule, groups), null, name);
      const k = judgeLines(rule, five, 1);
      assert.deepEqual([k.verdict, k.code], ['ERROR', 'invalid_rule'], `${name}: ${k.reason}`);
      assert.match(k.reason, /컬렉션 항목 .*에 ".+" 값이 없음/, name);
    }
    // Parts every item has are read.
    const second = { and: [{ '>=': [n, 0] }, { all: [{ merge: [[[1, 2]], [[3, 4]]] }, { '>': [{ var: '1' }, 1] }] }] };
    assert.equal(judgeLines(second, five, 1).verdict, 'PASS');
  });
});
