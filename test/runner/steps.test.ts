import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Snapshot } from '../../src/core/types.ts';
import { captureScreen, inspectScreen, runTests } from '../../src/runner/index.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { choice, jevStub } from '../helpers/jev-stub.ts';
import { fakeDeps, runYaml, tempRoot } from '../helpers/run.ts';

const APP = 'kr.tteonam.app';
const screen = (name: string, opts: { keyboardShown?: boolean } = {}): Snapshot => fixtureSnapshot('android', 'tteonam', name, { foreground: APP, ...opts });

function spec(steps: string): string {
  return `name: 스텝 테스트\napp: tteonam\nplatforms: [android]\nstart: attach\nsteps:\n${steps}`;
}

describe('input steps', () => {
  const SECRET = 'QA_RUNNER_TEST_SECRET';
  before(() => {
    process.env[SECRET] = 'hunter2';
  });
  after(() => {
    delete process.env[SECRET];
  });

  it('types into the focused field; secure text never reaches the journal or events', async () => {
    const driver = new FakeDriver(screen('search-empty-keyboard', { keyboardShown: true }));
    const steps = `  - type: 인천\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n  - type: "\${${SECRET}}"\n    secure: true\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n  - hideKeyboard: true\n`;
    const { result, events } = await runYaml({ 'tests/t.e2e.yaml': spec(steps) }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.deepEqual(driver.called('typeText').map((c) => c.args[1]), ['인천', 'hunter2']);
    assert.equal(driver.called('hideKeyboard').length, 1);
    const journal = readFileSync(join(result.runDir, 'journal.jsonl'), 'utf8');
    const stream = JSON.stringify(events);
    for (const text of [journal, stream, readFileSync(join(result.runDir, 'events.jsonl'), 'utf8')]) assert.ok(!text.includes('hunter2'));
    assert.ok(journal.includes('•••••••'));
  });

  it('fails when the read-back does not match (INPUT_UNVERIFIED) and skips hideKeyboard without a keyboard', async () => {
    const driver = new FakeDriver(screen('search-empty-keyboard'));
    driver.typeError = 'INPUT_UNVERIFIED: 기대 "인천", 실제 "인"';
    const typed = await runYaml({ 'tests/t.e2e.yaml': spec('  - hideKeyboard: true\n  - type: 인천\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n') }, driver);
    const t = typed.result.tests[0]!;
    assert.equal(t.code, 'input_unverified');
    assert.equal(driver.called('hideKeyboard').length, 0);
    assert.match(t.steps[1]!.reason, /키보드가 이미 숨겨져 있음/);
  });
});

describe('navigation and device steps', () => {
  it('scroll.until swipes until the text appears, and stops at the end of the content', async () => {
    const driver = new FakeDriver(screen('launch'));
    driver.onAction = (method, d) => {
      if (method === 'swipe') d.screen = screen('tab-parking');
    };
    const found = await runYaml({ 'tests/s.e2e.yaml': spec('  - scroll: { direction: down, until: { text: 장기 P3 } }\n') }, driver);
    assert.equal(found.result.tests[0]!.verdict, 'PASS', found.result.tests[0]!.reason);
    assert.equal(driver.called('swipe').length, 1);
    const [from, to] = driver.called('swipe')[0]!.args as [{ y: number }, { y: number }];
    assert.ok(from.y > to.y, 'scrolling down drags the finger up');

    const stuck = new FakeDriver(screen('launch'));
    const end = await runYaml({ 'tests/s.e2e.yaml': spec('  - scroll: { direction: down, until: { text: 없는문구 }, max: 5 }\n') }, stuck);
    assert.equal(end.result.tests[0]!.code, 'not_found');
    assert.match(end.result.tests[0]!.reason, /스크롤 끝에 도달 \(1회\)/);
    assert.equal(stuck.called('swipe').length, 1);
  });

  it('launch applies explicit permissions and arguments; open checks the URL against the risk policy', async () => {
    const driver = new FakeDriver(screen('launch'));
    driver.onAction = (method, d) => {
      if (method === 'openUrl') d.screen = screen('tab-departures');
    };
    const steps = '  - launch: { reset: relaunch, permissions: { location: allow }, arguments: [--demo] }\n  - open: "tteonam://departures"\n  - location: { lat: 37.46, lon: 126.44 }\n  - press: back\n    expectNoChange: true\n  - capture: 출국장 화면\n  - wait: 200\n';
    const { result } = await runYaml({ 'tests/l.e2e.yaml': spec(steps) }, driver);
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.deepEqual(driver.called('launch')[0]!.args[1], { permissions: { location: 'allow' }, arguments: ['--demo'] });
    assert.deepEqual(driver.calls.filter((c) => ['terminate', 'launch', 'openUrl', 'setLocation', 'press'].includes(c.method)).map((c) => c.method), ['terminate', 'launch', 'openUrl', 'setLocation', 'press']);
    const capture = t.steps.find((s) => s.kind === 'capture')!;
    assert.ok(existsSync(join(result.runDir, capture.evidenceDir, '출국장-화면.png')));

    const risky = new FakeDriver(screen('launch'));
    const blocked = await runYaml({ 'tests/o.e2e.yaml': spec('  - open: "https://example.com/pay"\n') }, risky);
    assert.equal(blocked.result.tests[0]!.code, 'blocked_by_policy');
    assert.equal(risky.called('openUrl').length, 0);
    const tapAt = await runYaml({ 'tests/o.e2e.yaml': spec('  - tapAt: { x: 0.5, y: 0.5 }\n') }, risky);
    assert.equal(tapAt.result.tests[0]!.code, 'blocked_by_policy', 'coordinates have no label: risk unknown');
  });

  it('action events name the DSL action exactly (hideKeyboard, press, location — not back/type/launch)', async () => {
    const driver = new FakeDriver(screen('search-empty-keyboard', { keyboardShown: true }));
    const steps = '  - hideKeyboard: true\n  - press: back\n    expectNoChange: true\n  - location: { lat: 37.46, lon: 126.44 }\n';
    const { result, events } = await runYaml({ 'tests/k.e2e.yaml': spec(steps) }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    const actions = events.flatMap((e) => (e.type === 'action' ? [[e.kind, e.text]] : []));
    assert.deepEqual(actions, [
      ['hideKeyboard', null],
      ['press', 'back'],
      ['location', '37.46,126.44'],
    ]);
  });

  it('which runs the branch Jev picks for the current screen', async () => {
    const jev = jevStub((_id, q) => choice(q, 's1', 0.9));
    const steps = '  - which:\n      "주차 화면": [ { assertText: 빈자리 } ]\n      "출국장 화면": [ { assertText: 빨리 빠지는 순서 } ]\n';
    const { result } = await runYaml({ 'tests/w.e2e.yaml': spec(steps) }, new FakeDriver(screen('tab-departures')), { jev: jev.setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.match(t.steps[1]!.reason, /분기 "출국장 화면"/);
    assert.equal(t.steps.find((s) => s.kind === 'assertText')!.verdict, 'PASS');
  });
});

describe('inspect and capture', () => {
  it('inspectScreen adds risk and fast-path columns to the candidate rows', async () => {
    const root = tempRoot();
    const { table } = await inspectScreen({ app: 'tteonam', platform: 'android' }, fakeDeps(root, new FakeDriver(screen('my-flight-sheet'))));
    const line = table.split('\n').find((l) => l.includes('내 항공편 지우기'))!;
    assert.match(line, /위험: 위험 키워드 "지우기" \| 유일 \|/);
    assert.match(table, /가려진 노드 \d+개/);
  });

  it('captureScreen writes the fixture triplet and the planner inventory', async () => {
    const root = tempRoot();
    const r = await captureScreen({ app: 'tteonam', platform: 'android', name: 'parking' }, fakeDeps(root, new FakeDriver(screen('tab-parking'))));
    for (const f of [r.xml, r.png, r.meta, r.inventory]) assert.ok(existsSync(f), f);
    assert.ok(r.xml.startsWith(join(root, 'fixtures', 'android', 'tteonam')));
    const inv = JSON.parse(readFileSync(r.inventory, 'utf8')) as { name: string; candidates: { name: string }[] };
    assert.equal(inv.name, 'parking');
    assert.ok(inv.candidates.some((c) => c.name === '장기'));
  });
});

describe('devices and surfaces', () => {
  it('holds the device lock for the run and reports a locked device as ERROR without touching it', async () => {
    const root = tempRoot({ 'tests/a.e2e.yaml': spec('  - assertText: 출국장\n') });
    const driver = new FakeDriver(screen('launch'));
    const log: string[] = [];
    const deps = { ...fakeDeps(root, driver), acquireLock: (id: string) => (log.push(`lock ${id}`), { release: () => void log.push(`release ${id}`) }) };
    const ok = await runTests({ paths: [join(root, 'tests')], platform: 'android' }, deps);
    assert.equal(ok.tests[0]!.verdict, 'PASS');
    assert.deepEqual(log, ['lock fake-device-1', 'release fake-device-1']);

    const busy = new FakeDriver(screen('launch'));
    const locked = await runTests(
      { paths: [join(root, 'tests')], platform: 'android' },
      { ...fakeDeps(root, busy), acquireLock: () => { throw new Error('pid 4242 사용 중'); } },
    );
    assert.equal(locked.tests[0]!.verdict, 'ERROR');
    assert.equal(locked.tests[0]!.code, 'device_locked');
    assert.equal(busy.calls.length, 0);
  });

  it('a screen with neither tree nor OCR targets is INCONCLUSIVE unsupported_surface', async () => {
    const canvas: Snapshot = { ...screen('launch'), nodes: [] };
    const { result } = await runYaml({ 'tests/c.e2e.yaml': spec('  - tap: 시작하기\n    timeout: 300\n') }, new FakeDriver(canvas));
    assert.equal(result.tests[0]!.verdict, 'INCONCLUSIVE');
    assert.equal(result.tests[0]!.code, 'unsupported_surface');
  });
});

describe('OCR fallback', () => {
  it('runs OCR once when a target is not found in the tree and resolves against OCR lines', async () => {
    let calls = 0;
    const ocr = async () => {
      calls++;
      return [{ text: '지도 보기', confidence: 0.98, rect: { x: 100, y: 1200, width: 240, height: 60 } }];
    };
    const { result } = await runYaml({ 'tests/o.e2e.yaml': spec('  - see: 지도 보기\n    timeout: 300\n') }, new FakeDriver(screen('launch')), { ocr });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.equal(calls, 1, 'OCR only after not_found (the launch tree is not sparse)');
  });
});
