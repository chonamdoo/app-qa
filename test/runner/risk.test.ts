import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { labelRisk } from '../../src/runner/risk.ts';

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
    assert.deepEqual(labelRisk(null), { risky: true, unknown: true, reasons: ['라벨 없는 대상 — 위험 여부를 알 수 없음'] });
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
});
