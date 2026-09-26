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

  it('type/clear narrow a shared label to the text field; tap prefers the one actionable match', () => {
    // The native search screen: label + input share "편명·도시·항공사".
    assert.deepEqual(found(search, { target: '편명·도시·항공사', purpose: 'edit' }), { name: '편명·도시·항공사', role: 'input', source: 'fast_path' });
    // iOS Safari: a <section aria-label>, the <label> text and the search field are all named "상품 검색".
    const safari = buildScreenModel(fixtureSnapshot('ios', 'web-demo', 'index'), {});
    assert.equal(resolveDeterministic(safari, { target: '상품 검색' }).kind, 'jev');
    assert.equal(found(safari, { target: '상품 검색', purpose: 'edit' }).role, 'input');
    // Heading + tab "주차": a tap goes to the tab, an observation still cannot choose.
    assert.deepEqual(found(parking, { target: '주차', purpose: 'act' }), { name: '주차', role: 'tab', source: 'fast_path' });
    // Nothing editable among the matches: the match stands, so type into a button still fails as not editable.
    assert.equal(found(parking, { target: '장기', purpose: 'edit' }).role, 'button');
  });

  it('a field without a name is named by its layout label, so type/clear reach it (Android Chrome drops the association)', () => {
    const home = buildScreenModel(fixtureSnapshot('android', 'web-demo', 'index'), {});
    const login = buildScreenModel(fixtureSnapshot('android', 'web-demo', 'login-email'), {});
    // The tree has the label as a TextView and the field with only its placeholder; the field now carries the label.
    assert.deepEqual(
      home.candidates.filter((c) => c.name === '상품 검색').map((c) => c.role).sort(),
      ['input', 'text'],
    );
    assert.equal(resolveDeterministic(home, { target: '상품 검색' }).kind, 'jev');
    assert.equal(found(home, { target: '상품 검색', purpose: 'edit' }).role, 'input');
    // Stacked form: each label names the field right under it, not the next one down.
    const email = resolveDeterministic(login, { target: '이메일', purpose: 'edit' });
    const password = resolveDeterministic(login, { target: '비밀번호', purpose: 'edit' });
    assert.ok(email.kind === 'found' && password.kind === 'found');
    assert.equal(email.candidate.role, 'input');
    assert.equal(password.candidate.role, 'secure-input');
    assert.ok(email.candidate.rect.y < password.candidate.rect.y);
    // A field that already has a name keeps it (the iOS field is named by the page's <label>).
    const safari = buildScreenModel(fixtureSnapshot('ios', 'web-demo', 'login-email'), {});
    assert.ok(safari.candidates.some((c) => c.role === 'secure-input' && c.name === '비밀번호'));
  });
});
