import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadAppProfile, loadTests, SpecError } from '../../src/spec/load.ts';
import { tempRoot } from '../helpers/run.ts';

function load(files: Record<string, string>, tags?: string[]) {
  const root = tempRoot(files);
  return { root, ...loadTests([join(root, 'tests')], { root, appsDir: join(root, 'apps'), tags }) };
}

function errorOf(files: Record<string, string>): string {
  const { errors } = load(files);
  assert.equal(errors.length, 1, 'exactly one load error');
  assert.ok(errors[0]!.error instanceof SpecError);
  return errors[0]!.error.message;
}

describe('spec loading', () => {
  it('names an unknown step kind with file, line and path', () => {
    const msg = errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - tap: 출국장\n  - tapp: 주차\n' });
    assert.match(msg, /x\.e2e\.yaml:5: steps\[1\]: 알 수 없는 스텝 종류 \(키: tapp\)/);
  });

  it('explains a malformed step of a known kind precisely', () => {
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - tap: 3\n' }), /:4: steps\[0\]\.tap: 문자열 또는 셀렉터 객체여야 합니다/);
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - tap: {}\n' }), /steps\[0\]\.tap: 셀렉터에는 intent, text, desc, id 중 하나가 필요합니다/);
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - which: { 로그인: [] }\n' }), /steps\[0\]\.which: which에는 분기가 2개 이상 필요합니다/);
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - repeat: { steps: [ { seeNot: 3 } ] }\n' }), /steps\[0\]\.repeat/);
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nstepz: []\nsteps: [ { back: true } ]\n' }), /알 수 없는 키: stepz/);
  });

  it('reports YAML syntax errors with a line number', () => {
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: tteonam\nsteps:\n  - tap: [\n' }), /x\.e2e\.yaml:\d+: YAML 구문 오류/);
  });

  it('loads subflows relative to the file and rejects cycles and missing flows', () => {
    const ok = load({
      'tests/t.e2e.yaml': 'name: t\napp: tteonam\nsteps:\n  - use: flows/a.flow.yaml\n    with: { tab: 주차 }\n',
      'tests/flows/a.flow.yaml': 'name: a\nsteps:\n  - use: b.flow.yaml\n',
      'tests/flows/b.flow.yaml': 'name: b\nsteps:\n  - tap: "${tab}"\n',
    });
    assert.deepEqual(ok.errors.map((e) => e.error.message), []);
    assert.deepEqual([...ok.tests[0]!.flows.keys()].map((f) => f.split('/').pop()), ['a.flow.yaml', 'b.flow.yaml']);
    assert.deepEqual(ok.tests[0]!.flows.get(join(ok.root, 'tests/flows/b.flow.yaml'))!.steps[0], { tap: '${tab}' }, 'placeholders stay unexpanded');

    const cycle = errorOf({
      'tests/t.e2e.yaml': 'name: t\napp: tteonam\nsteps:\n  - use: flows/a.flow.yaml\n',
      'tests/flows/a.flow.yaml': 'name: a\nsteps:\n  - use: b.flow.yaml\n',
      'tests/flows/b.flow.yaml': 'name: b\nsteps:\n  - use: a.flow.yaml\n',
    });
    assert.match(cycle, /하위 흐름 순환: t\.e2e\.yaml → a\.flow\.yaml → b\.flow\.yaml → a\.flow\.yaml/);
    assert.match(errorOf({ 'tests/t.e2e.yaml': 'name: t\napp: tteonam\nsteps:\n  - use: nope.flow.yaml\n' }), /하위 흐름 파일이 없습니다/);
  });

  it('rejects missing profiles and duplicate ids, and filters by tag', () => {
    assert.match(errorOf({ 'tests/x.e2e.yaml': 'name: x\napp: nosuchapp\nsteps: [ { back: true } ]\n' }), /앱 프로필이 없습니다 \(앱 id 'nosuchapp'\)/);
    const dup = load({
      'tests/a.e2e.yaml': 'id: same\nname: a\napp: tteonam\nsteps: [ { back: true } ]\n',
      'tests/b.e2e.yaml': 'id: same\nname: b\napp: tteonam\nsteps: [ { back: true } ]\n',
    });
    assert.equal(dup.tests.length, 1);
    assert.match(dup.errors[0]!.error.message, /테스트 id 'same'가 .*중복/);
    const tagged = load({
      'tests/a.e2e.yaml': 'name: a\napp: tteonam\ntags: [smoke]\nsteps: [ { back: true } ]\n',
      'tests/b.e2e.yaml': 'name: b\napp: tteonam\nsteps: [ { back: true } ]\n',
    }, ['smoke']);
    assert.deepEqual(tagged.tests.map((t) => t.id), ['a']);
  });

  it('validates app profiles', () => {
    const root = tempRoot({ 'apps/bad.yaml': 'id: bad\nname: Bad\nandroid: { pkg: x }\n' });
    assert.throws(() => loadAppProfile('bad', join(root, 'apps')), /bad\.yaml:3: android: 알 수 없는 키: pkg/);
    assert.equal(loadAppProfile('tteonam', join(root, 'apps')).android?.package, 'kr.tteonam.app');
  });
});
