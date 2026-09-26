import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepLabel, TestSpec } from '../../src/spec/schema.ts';

test('step labels (run events, reports, plan view) never carry typed text, nested steps included', () => {
  const { steps } = TestSpec.parse({
    id: 'login',
    name: '로그인',
    app: 'bank',
    steps: [
      { type: 'top-secret-1', into: { text: '아이디', id: 'user' } },
      { repeat: { while: { see: '더보기' }, steps: [{ type: 'private-value', into: '비밀번호' }] } },
      { which: { 로그인: [{ type: 'branch-secret', into: '비밀번호', submit: true }], 홈: [{ back: true }] } },
      { type: '${PIN}', into: 'PIN' },
      { tap: '확인' },
    ],
  });
  const labels = steps.map(stepLabel);
  for (const typed of ['top-secret-1', 'private-value', 'branch-secret', '${PIN}']) assert.ok(!labels.join('\n').includes(typed), `${typed} in ${labels.join(' / ')}`);
  assert.deepEqual(labels, ['입력(12자) → text=아이디, id=user', '반복: 조건 see=더보기', '분기: 로그인 | 홈', '입력(변수) → PIN', '탭: 확인']);
});
