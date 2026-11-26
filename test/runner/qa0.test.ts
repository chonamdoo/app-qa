import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cmdRun } from '../../src/cli/commands/run.ts';
import { PATHS } from '../../src/core/config.ts';
import { DirExistsError } from '../../src/core/fsx.ts';
import type { Platform, Snapshot } from '../../src/core/types.ts';
import { loadJevConfig } from '../../src/jev/config.ts';
import { SUMMARY_SCHEMA, type RunSummary } from '../../src/report/types.ts';
import type { JevSetup } from '../../src/runner/engine.ts';
import { runTests, type RunnerDeps } from '../../src/runner/index.ts';
import { loadAppProfile, loadTests } from '../../src/spec/load.ts';
import { stepKind, type StepKind } from '../../src/spec/schema.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { fakeDeps, tempRoot } from '../helpers/run.ts';

const AGENTFLOW_ANDROID_PKG = 'com.agentflow.mobile';
const AGENTFLOW_IOS_BUNDLE = 'app.agentflow.ios';
const FIXED_SMOKE_SUITE_REL = 'tests/smoke/agentflow-launch.e2e.yaml';
const FIXED_SMOKE_SPEC_PATH = join(PATHS.root, FIXED_SMOKE_SUITE_REL);

const MUTATING_OR_JEV_STEPS: ReadonlySet<StepKind> = new Set([
  'tap',
  'longPress',
  'tapAt',
  'type',
  'clear',
  'press',
  'claim',
  'which',
  'use',
]);

function keylessJev(): JevSetup {
  let problem: string | null = null;
  try {
    loadJevConfig({});
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  return { client: null, calibration: null, problem };
}

function agentflowScreen(platform: 'android' | 'ios', patch?: [string, string][]): Snapshot {
  const foreground = platform === 'android' ? AGENTFLOW_ANDROID_PKG : AGENTFLOW_IOS_BUNDLE;
  return fixtureSnapshot(platform, 'tteonam', 'launch', { foreground, patch });
}

function simpleAndroidTest(assertText = '출국장'): string {
  return [
    'id: qa0-check',
    'name: QA-0 고정 문구 확인',
    'app: tteonam',
    'platforms: [android]',
    'start: attach',
    'steps:',
    `  - assertText: ${assertText}`,
    '',
  ].join('\n');
}

function runProcess(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('run-id', () => {
  it('uses explicit --run-id for run directory and RunSummary', async (t) => {
    t.mock.method(console, 'log', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const runId = 'dq-req1-android-1';

    const code = await cmdRun(
      [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', runId],
      fakeDeps(root, driver, keylessJev()),
    );
    assert.equal(code, 0);

    const summaryPath = join(root, '.qa', 'runs', runId, 'summary.json');
    assert.ok(existsSync(summaryPath));
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
    assert.equal(summary.runId, runId);
    assert.equal(summary.counts.PASS, 1);
  });

  it('exits 2 when --run-id directory already exists before touching any device', async (t) => {
    t.mock.method(console, 'error', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const runId = 'dq-existing-android-1';
    mkdirSync(join(root, '.qa', 'runs', runId), { recursive: true });

    let deviceTouches = 0;
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const deps: Partial<RunnerDeps> = {
      ...fakeDeps(root, driver, keylessJev()),
      pickDevice: async (platform: Platform) => {
        deviceTouches++;
        return { platform, id: 'emulator-5554', name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' };
      },
      acquireLock: () => {
        deviceTouches++;
        return { release: () => undefined };
      },
      createDriver: () => {
        deviceTouches++;
        return driver;
      },
    };

    const code = await cmdRun(
      [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', runId],
      deps,
    );
    assert.equal(code, 2);
    assert.equal(deviceTouches, 0);
    assert.equal(driver.calls.length, 0);
  });

  it('rejects invalid --run-id values with exit code 2 before touching any device', async (t) => {
    t.mock.method(console, 'error', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    let deviceTouches = 0;
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const deps: Partial<RunnerDeps> = {
      ...fakeDeps(root, driver, keylessJev()),
      pickDevice: async (platform: Platform) => {
        deviceTouches++;
        return { platform, id: 'emulator-5554', name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' };
      },
    };

    for (const badId of ['', '.', '..', '../escape', 'a/b', 'has space', '.hidden']) {
      const code = await cmdRun(
        [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', badId],
        deps,
      );
      assert.equal(code, 2, `expected exit 2 for run-id ${JSON.stringify(badId)}`);
    }
    assert.equal(deviceTouches, 0);
  });

  it('concurrent in-process invocations with the same --run-id touch the device once', async () => {
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const runId = 'dq-race-inproc-android-1';
    let deviceTouches = 0;

    const makeDeps = (): Partial<RunnerDeps> => {
      const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
      return {
        ...fakeDeps(root, driver, keylessJev()),
        pickDevice: async (platform: Platform) => {
          deviceTouches++;
          await new Promise((r) => setTimeout(r, 15));
          return { platform, id: 'emulator-5554', name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' };
        },
      };
    };

    const settled = await Promise.allSettled([
      runTests({ paths: [join(root, 'tests/check.e2e.yaml')], platform: 'android', runId }, makeDeps()),
      runTests({ paths: [join(root, 'tests/check.e2e.yaml')], platform: 'android', runId }, makeDeps()),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof DirExistsError);
    assert.equal(deviceTouches, 1);
  });

  it('concurrent CLI processes with the same --run-id touch the device once and the loser exits 2', async () => {
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const touchLog = join(root, 'device-touches.log');
    const runId = 'dq-race-multiproc-android-1';
    const workerScript = join(root, 'run-worker.mjs');

    writeFileSync(
      workerScript,
      `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRun } from ${JSON.stringify(pathToFileURL(join(PATHS.root, 'src/cli/commands/run.ts')).href)};
import { FakeDriver, fixtureSnapshot } from ${JSON.stringify(pathToFileURL(join(PATHS.root, 'test/helpers/fake-driver.ts')).href)};
const root = process.env.QA_TEST_ROOT;
const touchLog = process.env.QA_TOUCH_LOG;
const runId = process.env.QA_RUN_ID;
const resultJson = process.env.QA_RESULT_JSON;
const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
const code = await cmdRun(
  [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', runId, '--result-json', resultJson],
  {
    createDriver: () => driver,
    pickDevice: async (platform) => {
      appendFileSync(touchLog, process.pid + '\\n');
      return { platform, id: 'emulator-5554', name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' };
    },
    acquireLock: () => ({ release: () => undefined }),
    jev: () => ({ client: null, calibration: null, problem: 'no key' }),
    ocr: null,
    clock: driver.clock,
    root,
    runsDir: join(root, '.qa', 'runs'),
    appsDir: join(root, 'apps'),
    inventoryDir: join(root, '.qa', 'inventory'),
    fixturesDir: join(root, 'fixtures'),
  },
);
process.exitCode = code;
`,
    );

    const out1 = join(root, 'out-1.json');
    const out2 = join(root, 'out-2.json');
    const [p1, p2] = await Promise.all([
      runProcess([workerScript], { ...process.env, QA_TEST_ROOT: root, QA_TOUCH_LOG: touchLog, QA_RUN_ID: runId, QA_RESULT_JSON: out1 }),
      runProcess([workerScript], { ...process.env, QA_TEST_ROOT: root, QA_TOUCH_LOG: touchLog, QA_RUN_ID: runId, QA_RESULT_JSON: out2 }),
    ]);

    const touches = readFileSync(touchLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(touches.length, 1, `expected device to be touched once, got ${touches.length}`);
    const codes = [p1.code, p2.code].sort((a, b) => (a ?? -1) - (b ?? -1));
    assert.deepEqual(codes, [0, 2], `stderr1=${p1.stderr}\nstderr2=${p2.stderr}`);
    const writtenOuts = [out1, out2].filter((p) => existsSync(p));
    assert.equal(writtenOuts.length, 1);
  });
});

describe('result-json', () => {
  it('writes RunSummary JSON matching summary.json on PASS', async (t) => {
    t.mock.method(console, 'log', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const runId = 'dq-json-pass-1';
    const resultJson = join(root, 'nested', 'result.json');

    const code = await cmdRun(
      [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', runId, '--result-json', resultJson],
      fakeDeps(root, driver, keylessJev()),
    );
    assert.equal(code, 0);
    assert.ok(existsSync(resultJson));
    assert.equal(statSync(resultJson).mode & 0o777, 0o600);

    const rawResult = readFileSync(resultJson, 'utf8');
    const rawSummary = readFileSync(join(root, '.qa', 'runs', runId, 'summary.json'), 'utf8');
    assert.equal(rawResult, rawSummary);

    const parsed = JSON.parse(rawResult) as RunSummary;
    assert.equal(parsed.$schema, SUMMARY_SCHEMA);
    assert.equal(parsed.kind, 'run');
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.platform, 'android');
    assert.equal(parsed.counts.PASS, 1);
    assert.equal(parsed.qaCounts.PASS, 1);
    assert.equal(parsed.tests.length, 1);
    assert.equal(parsed.tests[0]!.id, 'qa0-check');
    assert.equal(parsed.tests[0]!.verdict, 'PASS');
    assert.equal(parsed.reportPath, 'report.html');
    assert.equal(parsed.junitPath, null);
  });

  it('writes RunSummary JSON on FAIL and on BLOCKED (no_device) with exit code 1', async (t) => {
    t.mock.method(console, 'log', () => {});
    const root = tempRoot({ 'tests/missing.e2e.yaml': simpleAndroidTest('존재하지않는기대문구') });
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const failJson = join(root, 'fail-summary.json');

    const failCode = await cmdRun(
      [join(root, 'tests/missing.e2e.yaml'), '--platform', 'android', '--run-id', 'dq-json-fail-1', '--result-json', failJson],
      fakeDeps(root, driver, keylessJev()),
    );
    assert.equal(failCode, 1);
    const failSummary = JSON.parse(readFileSync(failJson, 'utf8')) as RunSummary;
    assert.equal(failSummary.$schema, SUMMARY_SCHEMA);
    assert.equal(failSummary.runId, 'dq-json-fail-1');
    assert.equal(failSummary.counts.FAIL, 1);
    assert.equal(failSummary.qaCounts.FAIL, 1);

    const blockedJson = join(root, 'blocked-summary.json');
    const blockedCode = await cmdRun(
      [join(root, 'tests/missing.e2e.yaml'), '--platform', 'android', '--run-id', 'dq-json-blocked-1', '--result-json', blockedJson],
      {
        ...fakeDeps(root, driver, keylessJev()),
        pickDevice: async () => {
          throw new Error('연결된 기기 없음');
        },
      },
    );
    assert.equal(blockedCode, 1);
    const blockedSummary = JSON.parse(readFileSync(blockedJson, 'utf8')) as RunSummary;
    assert.equal(blockedSummary.counts.ERROR, 1);
    assert.equal(blockedSummary.qaCounts.BLOCKED, 1);
    assert.equal(blockedSummary.tests[0]!.code, 'no_device');
  });

  it('does not write or overwrite --result-json when --run-id already exists (exit 2)', async (t) => {
    t.mock.method(console, 'error', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const runId = 'dq-json-no-overwrite-1';
    mkdirSync(join(root, '.qa', 'runs', runId), { recursive: true });
    const resultJson = join(root, 'existing.json');
    writeFileSync(resultJson, '{"sentinel":true}\n');

    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const code = await cmdRun(
      [join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--run-id', runId, '--result-json', resultJson],
      fakeDeps(root, driver, keylessJev()),
    );
    assert.equal(code, 2);
    assert.equal(readFileSync(resultJson, 'utf8'), '{"sentinel":true}\n');
  });

  it('rejects empty or directory --result-json with exit code 2 before touching any device', async (t) => {
    t.mock.method(console, 'error', () => {});
    const root = tempRoot({ 'tests/check.e2e.yaml': simpleAndroidTest() });
    const existingDir = join(root, 'a-directory');
    mkdirSync(existingDir, { recursive: true });
    let deviceTouches = 0;
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const deps: Partial<RunnerDeps> = {
      ...fakeDeps(root, driver, keylessJev()),
      pickDevice: async (platform: Platform) => {
        deviceTouches++;
        return { platform, id: 'emulator-5554', name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' };
      },
    };

    assert.equal(
      await cmdRun([join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--result-json', ''], deps),
      2,
    );
    assert.equal(
      await cmdRun([join(root, 'tests/check.e2e.yaml'), '--platform', 'android', '--result-json', existingDir], deps),
      2,
    );
    assert.equal(deviceTouches, 0);
  });
});

describe('smoke-suite', () => {
  it('defines AgentFlow P0 fixed smoke suite with launch + fixed text only and zero tap/input steps', () => {
    const profile = loadAppProfile('agentflow', PATHS.apps);
    assert.equal(profile.android?.package, AGENTFLOW_ANDROID_PKG);
    assert.equal(profile.ios?.bundleId, AGENTFLOW_IOS_BUNDLE);

    const loaded = loadTests([FIXED_SMOKE_SPEC_PATH], { root: PATHS.root, appsDir: PATHS.apps });
    assert.equal(loaded.errors.length, 0, loaded.errors.map((e) => e.error.message).join('\n'));
    assert.equal(loaded.tests.length, 1);

    const suite = loaded.tests[0]!;
    assert.equal(suite.spec.app, 'agentflow');
    assert.equal(suite.spec.start, 'launch');
    assert.deepEqual(suite.spec.platforms, ['android', 'ios']);
    assert.equal(suite.spec.setup, undefined);
    assert.equal(suite.spec.when, undefined);
    assert.ok(suite.spec.steps.length >= 1);

    for (const step of suite.spec.steps) {
      const kind = stepKind(step);
      assert.equal(MUTATING_OR_JEV_STEPS.has(kind), false, `smoke suite must not include mutating/Jev step: ${kind}`);
      assert.equal(kind, 'assertText', `P0 smoke suite step must be fixed-text verification, got ${kind}`);
    }
  });

  it('runs the fixed smoke suite on Android and iOS with zero paid API keys and zero key files', async () => {
    const root = tempRoot();
    const drivers: Record<'android' | 'ios', FakeDriver> = {
      android: new FakeDriver(agentflowScreen('android')),
      ios: new FakeDriver(agentflowScreen('ios')),
    };
    const resultJson = join(root, 'smoke-result.json');
    const runId = 'dq-smoke-suite-p0-1';

    const result = await runTests(
      { paths: [FIXED_SMOKE_SPEC_PATH], platform: 'all', runId, resultJson },
      {
        ...fakeDeps(root, drivers.android, keylessJev()),
        root: PATHS.root,
        appsDir: PATHS.apps,
        runsDir: join(root, '.qa', 'runs'),
        createDriver: (platform) => drivers[platform as 'android' | 'ios'],
        pickDevice: async (platform) => ({
          platform,
          id: platform === 'android' ? 'emulator-5554' : 'SIM-UDID-1',
          name: platform === 'android' ? 'Pixel AVD' : 'iPhone Simulator',
          osVersion: platform === 'android' ? '17' : '27',
          state: 'booted',
          kind: platform === 'android' ? 'emulator' : 'simulator',
        }),
      },
    );

    assert.equal(result.counts.PASS, 2, result.tests.map((t) => `${t.platform}:${t.verdict}:${t.reason}`).join('\n'));
    assert.equal(result.qaCounts.PASS, 2);
    assert.equal(drivers.android.called('launch').length, 1);
    assert.equal(drivers.ios.called('launch').length, 1);
    assert.equal(drivers.android.called('tap').length, 0);
    assert.equal(drivers.ios.called('tap').length, 0);

    const summary = JSON.parse(readFileSync(resultJson, 'utf8')) as RunSummary;
    assert.equal(summary.runId, runId);
    assert.equal(summary.counts.PASS, 2);
    assert.deepEqual(summary.tests.map((t) => t.platform).sort(), ['android', 'ios']);
  });

  it('fails when expected first-screen fixed text is missing and blocks when device is unavailable', async () => {
    const root = tempRoot();
    const brokenScreen = agentflowScreen('android', [['홈', '깨진화면']]);
    const driver = new FakeDriver(brokenScreen);

    const failed = await runTests(
      { paths: [FIXED_SMOKE_SPEC_PATH], platform: 'android', runId: 'dq-smoke-broken-1' },
      {
        ...fakeDeps(root, driver, keylessJev()),
        root: PATHS.root,
        appsDir: PATHS.apps,
        runsDir: join(root, '.qa', 'runs'),
      },
    );
    assert.equal(failed.tests[0]!.verdict, 'FAIL');
    assert.equal(failed.tests[0]!.qaStatus, 'FAIL');

    const blocked = await runTests(
      { paths: [FIXED_SMOKE_SPEC_PATH], platform: 'android', runId: 'dq-smoke-nodevice-1' },
      {
        ...fakeDeps(root, driver, keylessJev()),
        root: PATHS.root,
        appsDir: PATHS.apps,
        runsDir: join(root, '.qa', 'runs'),
        pickDevice: async () => {
          throw new Error('부팅된 기기 없음');
        },
      },
    );
    assert.equal(blocked.tests[0]!.verdict, 'ERROR');
    assert.equal(blocked.tests[0]!.code, 'no_device');
    assert.equal(blocked.tests[0]!.qaStatus, 'BLOCKED');
  });

  it('adding a tap step to the fixed smoke suite fails without Jev key (Jev commit gate intact)', async () => {
    const fixedYaml = readFileSync(FIXED_SMOKE_SPEC_PATH, 'utf8');
    const withTapYaml = `${fixedYaml.trimEnd()}\n  - tap: 출국장\n`;
    const root = tempRoot({
      'apps/agentflow.yaml': readFileSync(join(PATHS.apps, 'agentflow.yaml'), 'utf8'),
      'tests/smoke-with-tap.e2e.yaml': withTapYaml,
    });
    const driver = new FakeDriver(agentflowScreen('android'));

    const result = await runTests(
      { paths: [join(root, 'tests/smoke-with-tap.e2e.yaml')], platform: 'android', runId: 'dq-smoke-tap-gate-1' },
      fakeDeps(root, driver, keylessJev()),
    );

    const testResult = result.tests[0]!;
    assert.notEqual(testResult.verdict, 'PASS');
    assert.equal(testResult.verdict, 'ERROR');
    assert.equal(testResult.code, 'commit_check_unavailable');
    assert.equal(testResult.qaStatus, 'BLOCKED');
    assert.equal(driver.called('tap').length, 0);
  });
});
