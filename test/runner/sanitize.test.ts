import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { QaEventBody } from '../../src/core/events.ts';
import type { Snapshot } from '../../src/core/types.ts';
import type { RunSummary } from '../../src/report/types.ts';
import { captureScreen, runSmoke } from '../../src/runner/index.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { choice, commitSafe, jevStub, noul } from '../helpers/jev-stub.ts';
import { fakeDeps, PROFILES, readJsonl, runYaml, tempRoot } from '../helpers/run.ts';

const APP = 'kr.tteonam.app';

function spec(steps: string): string {
  return `name: 정제 테스트\napp: tteonam\nplatforms: [android]\nstart: attach\nsteps:\n${steps}`;
}

/** Every text file the run wrote (journal, events, summary, reports, per-step source/elements/verdict/jev). */
function evidenceText(runDir: string): string {
  return readdirSync(runDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith('.png'))
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
    .join('\n');
}

describe('evidence sanitizer: page source', () => {
  it('masks Android password nodes and iOS SecureTextField values structurally, leaving other bytes intact', () => {
    const clean = new EvidenceSanitizer([]);
    const android =
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy><android.widget.EditText text="pa&amp;ss&quot;1" hint="비밀번호" password="true" bounds="[0,0][10,10]"/>' +
      '<android.widget.TextView text="a &gt; b" password="false" bounds="[0,10][10,20]"/></hierarchy>';
    assert.equal(
      clean.source(android),
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy><android.widget.EditText text="•••••••" hint="비밀번호" password="true" bounds="[0,0][10,10]"/>' +
        '<android.widget.TextView text="a &gt; b" password="false" bounds="[0,10][10,20]"/></hierarchy>',
    );
    const ios = '<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" value="hunter2" label="비밀번호" x="1"></XCUIElementTypeSecureTextField>';
    assert.equal(clean.source(ios), '<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" value="•••••••" label="비밀번호" x="1"></XCUIElementTypeSecureTextField>');
  });

  it('masks tracked secrets inside escaped attribute values and applies profile redact patterns', () => {
    const clean = new EvidenceSanitizer(['J\\d+-J\\d+']);
    clean.addSecret('a&b');
    assert.equal(clean.source('<node text="x a&amp;b y" desc="J27-J35 &lt;3"/>'), '<node text="x ••• y" desc="[REDACTED] &lt;3"/>');
  });
});

describe('evidence sanitizer: structural fields', () => {
  it('never rewrites enum / id fields equal to a secret, and masks the same values in free text', () => {
    const clean = new EvidenceSanitizer([]);
    for (const secret of ['action', 'tap', 'android', 'ERROR', 'input', 'e1']) clean.addSecret(secret);
    const event = {
      type: 'action',
      kind: 'tap',
      platform: 'android',
      verdict: 'ERROR',
      text: 'action tap android ERROR',
      decisions: [{ key: 'e1', target: { key: 'e1', role: 'input', name: 'e1 input' } }],
    };
    assert.deepEqual(clean.deep(event), {
      type: 'action',
      kind: 'tap',
      platform: 'android',
      verdict: 'ERROR',
      text: '•••••• ••• ••••••• •••••',
      decisions: [{ key: 'e1', target: { key: 'e1', role: 'input', name: '•• •••••' } }],
    });
  });
});

describe('evidence sanitizer: run evidence', () => {
  const PW = 'QA_SANITIZE_PW';
  const TOKEN = 'QA_SANITIZE_TOKEN';
  /** Secrets that equal structural values: a verdict, an action kind, a platform. */
  const ENUM_SECRETS: Record<string, string> = { QA_SANITIZE_VERDICT: 'ERROR', QA_SANITIZE_KIND: 'tap', QA_SANITIZE_PLATFORM: 'android' };
  before(() => {
    process.env[PW] = 'hunter2-pw';
    process.env[TOKEN] = 'tok-7f3a9c';
    Object.assign(process.env, ENUM_SECRETS);
  });
  after(() => {
    delete process.env[PW];
    delete process.env[TOKEN];
    for (const name of Object.keys(ENUM_SECRETS)) delete process.env[name];
  });

  const PASSWORD_FIELD: [string, string] = ['focused="true" long-clickable="true" password="false"', 'focused="true" long-clickable="true" password="true"'];
  const search = (patch: [string, string][]): Snapshot => fixtureSnapshot('android', 'tteonam', 'search-empty-keyboard', { foreground: APP, keyboardShown: true, patch });
  const shows = (value: string): [string, string] => ['text="" content-desc="편명·도시·항공사"', `text="${value}" content-desc="편명·도시·항공사"`];

  it('an ${ENV} value typed into an observed secure field without `secure: true` never reaches any evidence file', async () => {
    const driver = new FakeDriver(search([PASSWORD_FIELD]));
    // The tree of the next screen exposes the typed value in the password node.
    driver.onAction = (method, d) => {
      if (method === 'typeText') d.screen = search([PASSWORD_FIELD, shows('hunter2-pw')]);
    };
    const steps = `  - type: "\${${PW}}"\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n  - wait: 50\n`;
    const { result, events } = await runYaml({ 'tests/p.e2e.yaml': spec(steps) }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    const [, typed, opts] = driver.called('typeText')[0]!.args as [unknown, string, { secure: boolean }];
    assert.equal(typed, 'hunter2-pw');
    assert.equal(opts.secure, true, 'the observed secure-input role makes the input secure');

    const dir = join(result.runDir, t.steps[2]!.evidenceDir);
    for (const [name, text] of [
      ['journal.jsonl', readFileSync(join(result.runDir, 'journal.jsonl'), 'utf8')],
      ['events.jsonl', readFileSync(join(result.runDir, 'events.jsonl'), 'utf8')],
      ['source.xml', readFileSync(join(dir, 'source.xml'), 'utf8')],
      ['elements.json', readFileSync(join(dir, 'elements.json'), 'utf8')],
      ['SSE stream', JSON.stringify(events)],
      ['all evidence', evidenceText(result.runDir)],
    ] as const) {
      assert.ok(!text.includes('hunter2-pw'), `${name} leaks the secret`);
    }
    assert.match(readFileSync(join(dir, 'source.xml'), 'utf8'), /text="•{10}" content-desc="편명·도시·항공사"/);
    assert.ok(readFileSync(join(result.runDir, 'journal.jsonl'), 'utf8').includes('•'.repeat(10)));
  });

  it('a password value the app shows in its tree (not typed, not from ${ENV}) is masked in source.xml', async () => {
    const driver = new FakeDriver(search([PASSWORD_FIELD, shows('prefilled-s3cr3t')]));
    const { result } = await runYaml({ 'tests/p.e2e.yaml': spec('  - wait: 50\n') }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    const all = evidenceText(result.runDir);
    assert.ok(!all.includes('prefilled-s3cr3t'));
    assert.match(all, /text="•{16}" content-desc="편명·도시·항공사"/);
  });

  it('qa capture writes the fixture XML through the same sanitizer', async () => {
    const root = tempRoot();
    const r = await captureScreen({ app: 'tteonam', platform: 'android', name: 'login' }, fakeDeps(root, new FakeDriver(search([PASSWORD_FIELD, shows('prefilled-s3cr3t')]))));
    const xml = readFileSync(r.xml, 'utf8');
    assert.ok(!xml.includes('prefilled-s3cr3t'));
    assert.match(xml, /text="•{16}" content-desc="편명·도시·항공사"/);
  });

  it('profile `redact` matches are masked in events and evidence without changing the verdict', async () => {
    const profile = PROFILES.tteonam!.replace('redact: []', "redact:\n  - 'J\\d+-J\\d+'");
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    const { result, events } = await runYaml({ 'tests/r.e2e.yaml': spec('  - assertText: { regex: "J\\\\d+-J\\\\d+" }\n') }, driver, { files: { 'apps/tteonam.yaml': profile } });
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    const finished = events.find((e) => e.type === 'step.finished' && e.index === 1);
    assert.ok(finished && finished.type === 'step.finished' && finished.reason.includes('[REDACTED]'), JSON.stringify(finished));
    assert.ok(!JSON.stringify(events).includes('J27-J35'));
    assert.ok(!evidenceText(result.runDir).includes('J27-J35'));
  });

  it('an `open` URL carrying an ${ENV} value is dispatched as is and masked everywhere else', async () => {
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    const steps = `  - open: "tteonam://login?token=\${${TOKEN}}"\n    expectNoChange: true\n`;
    const { result, events } = await runYaml({ 'tests/o.e2e.yaml': spec(steps) }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.equal(driver.called('openUrl')[0]!.args[1], 'tteonam://login?token=tok-7f3a9c');
    const action = events.find((e) => e.type === 'action');
    // The ${ENV} value is masked, and `token=` is a sensitive query parameter whose value the built-in redactor hides.
    assert.ok(action && action.type === 'action' && action.kind === 'open' && action.text === 'tteonam://login?token=[REDACTED]', JSON.stringify(action));
    assert.ok(!JSON.stringify(events).includes('tok-7f3a9c'));
    assert.ok(!evidenceText(result.runDir).includes('tok-7f3a9c'));
  });

  it('step labels in run.started / step.started carry neither a profile `redact` literal nor typed ${ENV} text', async () => {
    const profile = PROFILES.tteonam!.replace('redact: []', "redact:\n  - 'J\\d+-J\\d+'");
    const driver = new FakeDriver(search([]));
    const into = '    into: { intent: 편명·도시·항공사, state: { focused: true } }\n';
    const steps = `  - type: J27-J35\n${into}  - type: "\${${TOKEN}}"\n${into}  - assertText: J27-J35\n    timeout: 300\n`;
    const { result, events } = await runYaml({ 'tests/l.e2e.yaml': spec(steps) }, driver, { files: { 'apps/tteonam.yaml': profile }, jev: commitSafe().setup });
    assert.deepEqual(driver.called('typeText').map((c) => c.args[1]), ['J27-J35', 'tok-7f3a9c']);
    for (const [name, text] of [
      ['events.jsonl', readFileSync(join(result.runDir, 'events.jsonl'), 'utf8')],
      ['SSE stream', JSON.stringify(events)],
    ] as const) {
      assert.ok(!text.includes('J27-J35'), `${name} leaks the redact literal`);
      assert.ok(!text.includes('tok-7f3a9c'), `${name} leaks the typed \${ENV} value`);
    }
    const started = events.flatMap((e) => (e.type === 'step.started' ? [e.label] : []));
    assert.match(started[1]!, /^2 입력\(7자\) → /);
    assert.match(started[2]!, /^3 입력\(변수\) → /);
    assert.match(started[3]!, /^4 텍스트.*\[REDACTED\]/);
    const announced = events.find((e) => e.type === 'run.started');
    assert.ok(announced && announced.type === 'run.started');
    assert.deepEqual(announced.tests[0]!.steps.slice(1, 3), ['입력(7자) → intent=편명·도시·항공사, state=focused=true', '입력(변수) → intent=편명·도시·항공사, state=focused=true']);
  });

  it('a literal typed into an observed password field without `secure` is in no event, SSE message or report, from the first event on', async () => {
    const driver = new FakeDriver(search([PASSWORD_FIELD]));
    driver.onAction = (method, d) => {
      if (method === 'typeText') d.screen = search([PASSWORD_FIELD, shows('hunter2-pw')]);
    };
    const steps = '  - type: hunter2-pw\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n  - wait: 50\n';
    const { result, events } = await runYaml({ 'tests/p.e2e.yaml': spec(steps) }, driver, { jev: commitSafe().setup });
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.equal(driver.called('typeText')[0]!.args[1], 'hunter2-pw');
    const lines = readFileSync(join(result.runDir, 'events.jsonl'), 'utf8').split('\n');
    lines.forEach((line, i) => assert.ok(!line.includes('hunter2-pw'), `events.jsonl line ${i + 1} leaks the typed value: ${line}`));
    events.forEach((e, i) => assert.ok(!JSON.stringify(e).includes('hunter2-pw'), `SSE message ${i + 1} (${e.type}) leaks the typed value`));
    assert.ok(!readFileSync(join(result.runDir, 'report.html'), 'utf8').includes('hunter2-pw'), 'report.html leaks the typed value');
    assert.ok(!evidenceText(result.runDir).includes('hunter2-pw'));
    const announced = events.find((e) => e.type === 'run.started');
    assert.ok(announced && announced.type === 'run.started');
    assert.equal(announced.tests[0]!.steps[1], '입력(10자) → intent=편명·도시·항공사, state=focused=true');
  });

  it('a secret equal to ERROR / tap / android masks free text only: verdicts, counts, kinds and platforms stay intact', async () => {
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    const [verdict, kind, platform] = Object.keys(ENUM_SECRETS);
    const steps = `  - assertNoText: "\${${verdict}} \${${kind}} \${${platform}}"\n  - tap: 출국장\n    allowRisky: true\n    expectNoChange: true\n  - tap: 주차\n`;
    const { result } = await runYaml({ 'tests/e.e2e.yaml': spec(steps) }, driver);
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR', t.reason);
    assert.equal(t.code, 'commit_check_unavailable');
    assert.equal(t.platform, 'android');
    assert.equal(result.counts.ERROR, 1);
    assert.deepEqual(
      t.steps.map((s) => [s.kind, s.verdict]),
      [
        ['start', 'PASS'],
        ['assertNoText', 'PASS'],
        ['tap', 'PASS'],
        ['tap', 'ERROR'],
      ],
    );
    const summary = JSON.parse(readFileSync(join(result.runDir, 'summary.json'), 'utf8')) as RunSummary;
    assert.equal(summary.counts.ERROR, 1);
    assert.equal(summary.tests[0]!.verdict, 'ERROR');
    const lines = readJsonl(join(result.runDir, 'events.jsonl'));
    assert.deepEqual(lines.filter((e) => e.type === 'action').map((e) => e.kind), ['tap']);
    assert.ok(lines.every((e) => !('platform' in e) || e.platform === 'android'));
    assert.equal(lines.find((e) => e.type === 'test.finished')!.verdict, 'ERROR');
    assert.deepEqual((lines.find((e) => e.type === 'run.finished')!.counts as Record<string, number>).ERROR, 1);
    // The same values as free text are still masked.
    assert.ok(t.steps[1]!.reason.includes('••••• ••• •••••••'), t.steps[1]!.reason);
    assert.ok(!JSON.stringify(lines).includes('ERROR tap android'));
  });

  it('an ${ENV} secret containing `|`, typed into a plain field, reaches no Jev request raw or as its row form `¦`', async () => {
    const PIPE = 'QA_SANITIZE_PIPE';
    const secret = 'demo|private-token';
    process.env[PIPE] = secret;
    try {
      const driver = new FakeDriver(search([]));
      driver.onAction = (method, d) => {
        if (method === 'typeText') d.screen = search([shows(secret)]);
      };
      const jev = commitSafe();
      const steps = `  - type: "\${${PIPE}}"\n    into: { intent: 편명·도시·항공사, state: { focused: true } }\n  - claim: 검색어가 입력되어 있다\n`;
      const { result } = await runYaml({ 'tests/j.e2e.yaml': spec(steps) }, driver, { jev: jev.setup });
      assert.deepEqual(driver.called('typeText').map((c) => c.args[1]), [secret]);
      assert.ok(
        jev.requests.some((r) => JSON.stringify(r).includes(`value=\\"${'•'.repeat(secret.length)}\\"`)),
        `the typed field was sent, masked: ${result.tests[0]!.reason}`,
      );
      jev.requests.forEach((r, i) => {
        for (const form of [secret, 'demo¦private-token']) assert.ok(!JSON.stringify(r).includes(form), `Jev request ${i + 1} leaks ${form}`);
      });
    } finally {
      delete process.env[PIPE];
    }
  });

  it('device log capture gets the session sanitizer, live: later ${ENV} secrets and profile `redact` are masked per line', async () => {
    const profile = PROFILES.tteonam!.replace('redact: []', "redact:\n  - 'J\\d+-J\\d+'");
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    const steps = `  - launch: true\n  - assertNoText: "\${${TOKEN}}"\n`;
    const { result } = await runYaml({ 'tests/g.e2e.yaml': spec(steps) }, driver, { files: { 'apps/tteonam.yaml': profile } });
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.ok(driver.logSanitize, 'startLogs received the sanitizer');
    assert.equal(driver.logSanitize('E App: token=tok-7f3a9c flight J27-J35'), `E App: token=${'•'.repeat(10)} flight [REDACTED]`);
  });

  it('what a failed clear or type leaves in an observed secure field is in no record, raw or quoted (secure omitted in the DSL)', async () => {
    const field = '{ intent: 편명·도시·항공사, state: { focused: true } }';
    // clear: the driver reads back what a partial clear left of the password and quotes it in INPUT_UNVERIFIED.
    const clearing = new FakeDriver(search([PASSWORD_FIELD]));
    clearing.clearLeft = 'left-s3cret';
    const cleared = await runYaml({ 'tests/c.e2e.yaml': spec(`  - clear: ${field}\n`) }, clearing, { jev: commitSafe().setup });
    // type: a driver whose INPUT_UNVERIFIED detail quotes the secure field's raw read-back.
    const typing = new FakeDriver(search([PASSWORD_FIELD]));
    typing.typeError = 'INPUT_UNVERIFIED: 기대 "•••••", 실제 "part-s3cret"';
    const typed = await runYaml({ 'tests/t.e2e.yaml': spec(`  - type: abcde\n    into: ${field}\n`) }, typing, { jev: commitSafe().setup });
    for (const [run, raw] of [
      [cleared, 'left-s3cret'],
      [typed, 'part-s3cret'],
    ] as const) {
      const t = run.result.tests[0]!;
      assert.equal(t.verdict, 'FAIL', t.reason);
      assert.equal(t.code, 'input_unverified', t.reason);
      assert.ok(!JSON.stringify(run.events).includes(raw), `SSE stream leaks ${raw}`);
      assert.ok(!evidenceText(run.result.runDir).includes(raw), `evidence leaks ${raw}`);
    }
    assert.match(cleared.result.tests[0]!.reason, /"•{11}"/);
  });

  it('records written around a session (no automation session, smoke announcement) pass the profile sanitizer too', async () => {
    const profile = PROFILES.tteonam!.replace('name: 떠남', 'name: 떠남 cust-4821').replace('redact: []', "redact:\n  - 'cust-\\d+'");
    // runTests: the session cannot open (its error names the customer) for a test whose name names it too.
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    driver.openError = 'cust-4821 세션 거부';
    const yaml = 'name: 고객 cust-4821 예약 확인\napp: tteonam\nplatforms: [android]\nstart: attach\nsteps:\n  - wait: 50\n';
    const run = await runYaml({ 'tests/o.e2e.yaml': yaml }, driver, { files: { 'apps/tteonam.yaml': profile } });
    const t = run.result.tests[0]!;
    assert.equal(t.code, 'session_failed', t.reason);
    assert.equal(t.reason, '자동화 세션을 열 수 없음: [REDACTED] 세션 거부');
    assert.equal(t.name, '고객 [REDACTED] 예약 확인');
    for (const text of [JSON.stringify(run.events), evidenceText(run.result.runDir)]) assert.ok(!text.includes('cust-4821'), 'test.finished / summary.json / report carry the raw match');

    // runSmoke: `run.started` announces the smoke test by the profile name; the session fails the same way.
    const root = tempRoot({ 'apps/tteonam.yaml': profile });
    const smokeDriver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP }));
    smokeDriver.openError = 'cust-4821 세션 거부';
    const events: QaEventBody[] = [];
    const smoke = await runSmoke({ app: 'tteonam', platform: 'android', events: { emit: (e) => events.push(e) } }, fakeDeps(root, smokeDriver));
    const started = events.find((e) => e.type === 'run.started');
    assert.ok(started && started.type === 'run.started');
    assert.equal(started.tests[0]!.name, '스모크: 떠남 [REDACTED]');
    assert.equal(smoke.tests[0]!.code, 'session_failed');
    for (const text of [JSON.stringify(events), evidenceText(smoke.runDir)]) assert.ok(!text.includes('cust-4821'), 'run.started / summary.json / report carry the raw profile name');
  });
});

describe('evidence sanitizer: URL secrets', () => {
  it('masks sensitive query values (the name stays) in events, evidence and Jev bodies, while `open` dispatches the real URL', async () => {
    const page = fixtureSnapshot('desktop-chrome', 'web-demo', 'index', {
      pageUrl: 'http://localhost:4173/?token=PAGETOK1',
      patch: [
        ['url="http://localhost:4173/"', 'url="http://localhost:4173/?token=PAGETOK1"'],
        ['text="상품 3개"', 'text="https://auth.example/cb?code=CBSECRET&amp;state=ok#access_token=CBTOKEN"'],
      ],
    });
    const driver = new FakeDriver(page);
    const jev = jevStub((_id, q) => (q.type === 'noul' ? noul(0.97) : choice(q, 'none', 0.9)));
    const steps = '  - claim: 로그인 콜백 주소가 보인다\n  - open: /cb?code=OPENCODE1&state=ok\n    expectNoChange: true\n';
    const { result, events } = await runYaml({ 'tests/u.e2e.yaml': `name: URL\napp: web-demo\nstart: attach\nsteps:\n${steps}` }, driver, { platform: 'desktop-chrome', jev: jev.setup });
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.deepEqual(driver.called('openUrl').map((c) => c.args[1]), ['http://localhost:4173/cb?code=OPENCODE1&state=ok']);
    const action = events.find((e) => e.type === 'action' && e.kind === 'open');
    assert.ok(action?.type === 'action' && action.text === 'http://localhost:4173/cb?code=[REDACTED]&state=ok', JSON.stringify(action));
    const sent = JSON.stringify(jev.requests);
    assert.ok(sent.includes('cb?code=[REDACTED]&state=ok#access_token=[REDACTED]'), sent);
    for (const [name, text] of [
      ['events', JSON.stringify(events)],
      ['evidence', evidenceText(result.runDir)],
      ['Jev requests', sent],
    ] as const) {
      for (const secret of ['PAGETOK1', 'CBSECRET', 'CBTOKEN', 'OPENCODE1']) assert.ok(!text.includes(secret), `${name} leaks ${secret}`);
    }
  });
});
