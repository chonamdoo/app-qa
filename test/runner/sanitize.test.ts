import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Snapshot } from '../../src/core/types.ts';
import { captureScreen } from '../../src/runner/index.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { fakeDeps, PROFILES, runYaml, tempRoot } from '../helpers/run.ts';

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

describe('evidence sanitizer: run evidence', () => {
  const PW = 'QA_SANITIZE_PW';
  const TOKEN = 'QA_SANITIZE_TOKEN';
  before(() => {
    process.env[PW] = 'hunter2-pw';
    process.env[TOKEN] = 'tok-7f3a9c';
  });
  after(() => {
    delete process.env[PW];
    delete process.env[TOKEN];
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
    const { result, events } = await runYaml({ 'tests/p.e2e.yaml': spec(steps) }, driver);
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
    assert.ok(action && action.type === 'action' && action.kind === 'open' && action.text === `tteonam://login?token=${'•'.repeat(10)}`, JSON.stringify(action));
    assert.ok(!JSON.stringify(events).includes('tok-7f3a9c'));
    assert.ok(!evidenceText(result.runDir).includes('tok-7f3a9c'));
  });
});
