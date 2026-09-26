import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScreenModel } from '../../src/core/types.ts';
import { buildScreenModel } from '../../src/observe/index.ts';
import { notFoundDiagnostics, resolveDeterministic, type TargetQuery } from '../../src/runner/resolve.ts';
import { fixtureSnapshot } from '../helpers/fake-driver.ts';

const parking: ScreenModel = buildScreenModel(fixtureSnapshot('android', 'tteonam', 'tab-parking'), {});
const search: ScreenModel = buildScreenModel(fixtureSnapshot('android', 'tteonam', 'search-results'), {});

function found(model: ScreenModel, q: TargetQuery): { name: string; role: string; source: string } {
  const r = resolveDeterministic(model, q);
  assert.equal(r.kind, 'found', 'reason' in r ? r.reason : '');
  if (r.kind !== 'found') throw new Error('unreachable');
  return { name: r.candidate.name, role: r.candidate.role, source: r.source };
}

describe('deterministic resolution', () => {
  it('hands a non-unique label (heading + tab "주차") to Jev instead of guessing', () => {
    const r = resolveDeterministic(parking, { target: '주차' });
    assert.equal(r.kind, 'jev');
  });

  it('nth picks in reading order among equal labels', () => {
    assert.equal(found(parking, { target: '주차', nth: 1 }).role, 'heading');
    assert.equal(found(parking, { target: '주차', nth: 2 }).role, 'tab');
    assert.equal(resolveDeterministic(parking, { target: '주차', nth: 3 }).kind, 'not_found');
  });

  it('near picks the equal label closest to the anchor', () => {
    assert.equal(found(parking, { target: '주차', near: '안내' }).role, 'tab');
    assert.equal(found(parking, { target: '주차', near: '떠남 로고' }).role, 'heading');
  });

  it('within restricts to the container and diagnoses matches outside it', () => {
    assert.deepEqual(found(parking, { target: '장기', within: '주차장 종류' }), { name: '장기', role: 'button', source: 'fast_path' });
    const q: TargetQuery = { target: { text: 'T1' }, within: '주차장 종류' };
    assert.equal(resolveDeterministic(parking, q).kind, 'not_found');
    const diag = notFoundDiagnostics(parking, q);
    assert.ok(diag.some((d) => d.startsWith('within "주차장 종류" 컨테이너 일치')), diag.join('; '));
    assert.ok(diag.includes('컨테이너 밖에서 일치 1개'), diag.join('; '));
    assert.match(String((resolveDeterministic(parking, { target: '장기', within: '없는 컨테이너' }) as { reason: string }).reason), /within 컨테이너 "없는 컨테이너" 없음/);
  });

  it('selectors match exactly (or by regex), and state narrows equal labels', () => {
    assert.equal(found(parking, { target: { desc: '빈자리' } }).source, 'selector');
    assert.equal(found(parking, { target: { text: { regex: '^예약 P\\d' } } }).name, '예약 P5, 97자리 남음, 혼잡');
    assert.equal(resolveDeterministic(parking, { target: { text: '빈자' } }).kind, 'not_found', 'plain strings are exact, not substrings');
    // Label + input share "편명·도시·항공사"; only the input is focused.
    assert.equal(resolveDeterministic(search, { target: '편명·도시·항공사' }).kind, 'jev');
    assert.equal(found(search, { target: { intent: '편명·도시·항공사', state: { focused: true } } }).role, 'input');
    assert.equal(resolveDeterministic(parking, { target: { intent: '단기', state: { selected: true } } }).kind, 'not_found');
  });

  it('never resolves an occluded element and says it is hidden', () => {
    const q: TargetQuery = { target: { desc: '장기 P1, 0자리 남음, 혼잡' } };
    assert.equal(resolveDeterministic(search, q).kind, 'not_found');
    assert.ok(notFoundDiagnostics(search, q).some((d) => d.startsWith('다른 요소에 가려진 일치 1개')));
  });
});
