import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Candidate } from '../../src/core/types.ts';
import { candidateRow, candidateRows, renderCandidateTable } from '../../src/observe/index.ts';
import { loadModel } from './_fixtures.ts';

const base: Candidate = {
  key: 'e3',
  nodeId: '0.1',
  role: 'button',
  name: '항공편 찾기',
  value: null,
  state: [],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tapPoint: { x: 5, y: 5 },
  actionable: true,
  region: 'bottom',
  source: 'tree',
};

describe('candidateRow', () => {
  it('always renders five columns', () => {
    assert.equal(candidateRow({ ...base, state: ['disabled'] }), 'e3 | button | 항공편 찾기 | disabled | bottom');
    assert.equal(candidateRow(base), 'e3 | button | 항공편 찾기 | - | bottom');
    assert.equal(candidateRow({ ...base, name: '', role: 'image' }), 'e3 | image | (이름 없음) | - | bottom');
  });

  it('shows a value that differs from the name, and escapes column separators', () => {
    assert.equal(
      candidateRow({ ...base, role: 'input', name: 'a|b', value: '대한항공', state: ['focused'] }),
      'e3 | input | a¦b | value="대한항공", focused | bottom',
    );
    assert.equal(candidateRow({ ...base, value: '항공편 찾기' }), 'e3 | button | 항공편 찾기 | - | bottom');
  });

  it('renders one row per candidate in key order', () => {
    const model = loadModel('android/tteonam/my-flight-sheet');
    const rows = candidateRows(model);
    assert.deepEqual(
      rows.map((r) => r.split(' | ')[0]),
      model.candidates.map((c) => c.key),
    );
    assert.ok(rows.some((r) => /^e\d+ \| button \| 내 항공편 지우기 \| - \| bottom$/.test(r)));
    assert.ok(rows.every((r) => r.split(' | ').length === 5));
  });
});

describe('renderCandidateTable', () => {
  it('lists candidates with fast-path uniqueness and the occluded targets', () => {
    const model = loadModel('android/tteonam/my-flight-sheet');
    const table = renderCandidateTable(model);
    const lines = table.trimEnd().split('\n');
    const close = lines.find((l) => l.includes('닫기'))!;
    assert.match(close, /^e\d+\s+button\s+닫기.*1002,1060\s+유일$/);
    const hidden = lines.filter((l) => l.trimEnd().endsWith('가림'));
    assert.equal(hidden.length, 12);
    assert.ok(hidden.some((l) => l.startsWith('-') && l.includes('설정')));
    assert.match(lines.at(-1)!, /^후보 14개 · 가림 12개 · 텍스트 \d+줄$/);
  });

  it('does not mark repeated names as fast-path unique', () => {
    const table = renderCandidateTable(loadModel('ios/expo-go/launch'));
    const rows = table.split('\n').filter((l) => /^e\d+\s+button\s+standalone/.test(l));
    assert.ok(rows.length >= 3);
    for (const r of rows) assert.ok(!r.includes('유일'));
  });
});
