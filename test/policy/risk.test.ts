import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { labelRisk } from '../../src/policy/risk.ts';

describe('labelRisk', () => {
  it('flags Korean keywords as substrings and English keywords on word boundaries', () => {
    assert.equal(labelRisk('내 항공편 지우기').risky, true);
    assert.equal(labelRisk('회원 탈퇴하기').risky, true);
    assert.equal(labelRisk('출국장').risky, false);
    assert.equal(labelRisk('Remove').risky, true);
    assert.equal(labelRisk('Sign out').risky, true);
    assert.equal(labelRisk('signout').risky, true);
    assert.equal(labelRisk('Payment history').risky, false, '"pay" inside a word is not a keyword');
    assert.equal(labelRisk('Removed items').risky, false);
  });

  it('treats an unlabeled target as risky and unknown', () => {
    const risk = labelRisk(null);
    assert.equal(risk.risky, true);
    assert.equal(risk.unknown, true);
    assert.equal(risk.boundary, 'unknown');
    assert.equal(labelRisk('   ').unknown, true);
  });

  it('applies profile allow (exact label) and deny (substring)', () => {
    assert.equal(labelRisk('공유 주차장 안내', { allow: ['공유 주차장 안내'] }).risky, false);
    assert.equal(labelRisk('공유 주차장 안내 보기', { allow: ['공유 주차장 안내'] }).risky, true, 'allow is exact');
    assert.equal(labelRisk('예약 취소하기', { deny: ['예약 취소'] }).risky, true);
  });

  it('makes confirm labels risky only inside a destructive dialog, even when allow-listed', () => {
    assert.equal(labelRisk('확인', undefined, ['정말 삭제하시겠습니까?']).risky, true);
    assert.equal(labelRisk('OK', { allow: ['OK'] }, ['This cannot be undone.']).risky, true);
    assert.equal(labelRisk('확인', undefined, ['설정이 저장되었습니다']).risky, false);
  });

  it('separates fixture business effects from system actions and explicit denials', () => {
    assert.equal(labelRisk('Delete fixture order').boundary, 'business');
    assert.equal(labelRisk('OK', undefined, ['This cannot be undone.']).boundary, 'business');
    for (const label of ['전화 걸기', '권한 허용', 'Call']) {
      const risk = labelRisk(label, { allow: [label] });
      assert.equal(risk.risky, true);
      assert.equal(risk.boundary, 'host-system');
    }
    const denied = labelRisk('Delete fixture order', { allow: ['Delete fixture order'], deny: ['fixture order'] });
    assert.equal(denied.risky, true);
    assert.equal(denied.boundary, 'deny');
  });
});
