import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { declaredEnvNames } from '../../src/plan/context.ts';
import { checkOutput, checkTest, type CheckContext } from '../../src/plan/index.ts';
import { loadAppProfile } from '../../src/spec/load.ts';
import { tempDir } from './helpers.ts';

const ctx: CheckContext = {
  app: 'tteonam',
  profile: loadAppProfile('tteonam'),
  envNames: new Set(['APP_PASSWORD']),
  requirementIds: new Set(['doc#a', 'doc#b']),
  screens: [],
};

const valid = { id: 'departures-terms', name: '출국장 탭에 금지 용어가 없다', covers: ['doc#a'], steps: [{ tap: '출국장' }, { assertNoText: '출국 게이트' }] };
const errorsOf = (t: unknown) => checkTest(t, 0, ctx).errors;

describe('generated test validation', () => {
  test('a valid test passes and gets the app id; model-set app/source are replaced', () => {
    const r = checkTest({ ...valid, app: 'other', source: { plan: 'x', status: 'approved' } }, 0, ctx);
    assert.deepEqual(r.errors, []);
    assert.equal(r.spec.app, 'tteonam');
    assert.equal(r.spec.source, undefined);
    assert.deepEqual(r.covers, ['doc#a']);
  });

  test('covers must be present and reference known requirements', () => {
    assert.match(errorsOf({ ...valid, covers: [] }).join('\n'), /covers에 요구사항 id가 하나 이상 필요/);
    assert.match(errorsOf({ ...valid, covers: ['doc#a', 'doc#zzz'] }).join('\n'), /알 수 없는 요구사항 id "doc#zzz"/);
  });

  test('every requirement must be covered or untestable; untestable ids must exist', () => {
    const out = checkOutput({ tests: [valid], untestable: [{ requirement: 'doc#nope', reason: '없음' }] }, ctx);
    assert.deepEqual(out.errors, ['untestable[0]: 알 수 없는 요구사항 id "doc#nope"', '요구사항 doc#b: 유효한 테스트의 covers에도 untestable에도 없습니다']);
    const ok = checkOutput({ tests: [valid], untestable: [{ requirement: 'doc#b', reason: 'needs_approval: 삭제 필요' }] }, ctx);
    assert.deepEqual(ok.errors, []);
    // A requirement covered only by an invalid test is still uncovered.
    const bad = checkOutput({ tests: [{ ...valid, covers: ['doc#a', 'doc#b'], steps: [{ tapAt: { x: 0.5, y: 0.5 } }] }], untestable: [] }, ctx);
    assert.equal(bad.errors.length, 2);
    assert.match(checkOutput('nope', ctx).errors[0]!, /JSON 객체여야/);
  });

  test('allowRisky is rejected anywhere, including nested interrupts', () => {
    assert.match(errorsOf({ ...valid, steps: [{ tap: '출국장', allowRisky: true }] }).join('\n'), /allowRisky/);
    assert.match(errorsOf({ ...valid, when: [{ see: '광고', do: [{ tap: '닫기', allowRisky: true }] }] }).join('\n'), /allowRisky/);
  });

  test('risky and unlabeled targets are rejected, in nested branches too', () => {
    assert.match(errorsOf({ ...valid, steps: [{ tap: '내 항공편 지우기' }] }).join('\n'), /steps\[0\]: 위험 동작 대상 "내 항공편 지우기"/);
    assert.match(errorsOf({ ...valid, steps: [{ longPress: { text: 'Delete' } }] }).join('\n'), /위험 동작 대상 "Delete"/);
    assert.match(errorsOf({ ...valid, steps: [{ which: { 홈: [{ tap: '결제하기' }], 검색: [{ back: true }] } }] }).join('\n'), /which\["홈"\]\[0\]: 위험 동작 대상 "결제하기"/);
    assert.match(errorsOf({ ...valid, steps: [{ repeat: { times: 2, steps: [{ tap: { text: { regex: '삭제' } } }] } }] }).join('\n'), /위험 동작 대상 "삭제"/);
    assert.match(errorsOf({ ...valid, steps: [{ type: 'hi', into: '메시지 보내기', submit: true }] }).join('\n'), /위험 동작 대상 "메시지 보내기"/);
    // Confirm labels are risky once the test itself mentions a destructive dialog.
    assert.match(errorsOf({ ...valid, steps: [{ assertText: '정말 삭제하시겠어요?' }, { tap: '확인' }] }).join('\n'), /위험 동작 대상 "확인"/);
    assert.deepEqual(errorsOf({ ...valid, steps: [{ tap: '확인' }] }), []);
    const idOnly = errorsOf({ ...valid, steps: [{ tap: { id: 'kr.tteonam.app:id/delete' } }] }).join('\n');
    assert.match(idOnly, /라벨 없는 대상/);
    assert.match(idOnly, /id 셀렉터/);
  });

  test('unknown and disallowed step kinds are named', () => {
    assert.match(errorsOf({ ...valid, steps: [{ swipeLeft: true }] }).join('\n'), /steps\[0\]: 알 수 없는 스텝 종류 \(swipeLeft\)/);
    for (const step of [{ tapAt: { x: 0.5, y: 0.5 } }, { open: 'tteonam://x' }, { use: 'login.flow.yaml' }, { location: { lat: 37.46, lon: 126.44 } }, { swipe: { from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } } }]) {
      assert.match(errorsOf({ ...valid, steps: [step] }).join('\n'), /허용되지 않는 스텝/, JSON.stringify(step));
    }
    assert.match(errorsOf({ ...valid, steps: [{ launch: { reset: 'clear' } }] }).join('\n'), /launch.reset clear/);
    assert.match(errorsOf({ ...valid, steps: [{ launch: { permissions: { location: 'allow' } } }] }).join('\n'), /launch.permissions/);
    assert.match(errorsOf({ ...valid, reset: 'reinstall' }).join('\n'), /reset: reinstall/);
    // Shape errors inside a known kind are reported with the step path.
    assert.match(errorsOf({ ...valid, steps: [{ scroll: { direction: 'sideways' } }] }).join('\n'), /steps\[0\]\.scroll\.direction/);
  });

  test('${VAR} must be declared in .env.example (tool settings excluded) or remembered', () => {
    const envFile = join(tempDir(), '.env.example');
    writeFileSync(envFile, 'TYPESAFE_API_KEY=\nQA_LLM=claude-cli\nANDROID_HOME=~/sdk\nAPP_PASSWORD=\n# APP_USER=\n');
    assert.deepEqual([...declaredEnvNames(envFile)], ['APP_PASSWORD', 'APP_USER']);
    assert.deepEqual(errorsOf({ ...valid, steps: [{ type: '${APP_PASSWORD}', into: '비밀번호' }] }), []);
    assert.match(errorsOf({ ...valid, steps: [{ type: '${SECRET}', into: '비밀번호' }] }).join('\n'), /\$\{SECRET\}/);
    assert.deepEqual(errorsOf({ ...valid, steps: [{ remember: { name: 'flight', from: { regex: '(?<value>[A-Z]{2}\\d+)' } } }, { assertText: '${flight}' }] }), []);
  });

  test('regexes must compile and checkEach vars must be named groups', () => {
    assert.match(errorsOf({ ...valid, steps: [{ assertText: { regex: '([' } }] }).join('\n'), /정규식이 올바르지 않습니다/);
    const rule = (v: string) => ({ checkEach: { pattern: '^(?<min>\\d+)분$', rule: { '>=': [{ var: v }, 0] } } });
    assert.deepEqual(errorsOf({ ...valid, steps: [rule('min')] }), []);
    assert.match(errorsOf({ ...valid, steps: [rule('minutes')] }).join('\n'), /var "minutes"가 pattern의 이름 그룹에 없습니다/);
  });

  test('literals missing from the screen inventory are warnings, not errors', () => {
    const withScreens: CheckContext = {
      ...ctx,
      screens: [{ platform: 'android', name: 'home', source: 'fixture', candidates: [{ role: 'tab', name: '출국장', state: [], actionable: true }], texts: ['대기 8분'] }],
    };
    const r = checkTest({ ...valid, steps: [{ tap: '출국장' }, { assertText: '8분' }, { assertText: '대기 없음' }, { see: { text: '출국장' } }] }, 0, withScreens);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, ['화면 인벤토리에 없는 문구 "대기 없음" — 실제 화면 문구인지 확인 필요']);
  });
});
