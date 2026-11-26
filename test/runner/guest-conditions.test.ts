import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { GuestBrowserEvidence } from '../../src/core/guest-runtime.ts';
import { AttemptConditionsReceiptSchema, type AttemptConditionsReceipt, type RegressionAttempt } from '../../src/core/regression.ts';
import { projectFixtureSha256 } from '../../src/core/project-fixture.ts';
import { regressionGrantCanonical, regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { createAttemptConditions, validAttemptConditions } from '../../src/runner/conditions.ts';

type Input = Parameters<typeof createAttemptConditions>[0];

function fixture(platform: 'desktop-chrome' | 'desktop-safari' = 'desktop-safari'): Input & {
  guest: NonNullable<Input['guest']>;
  worker: NonNullable<Input['worker']>;
  initial: NonNullable<Input['initial']>;
  final: NonNullable<Input['final']>;
} {
  const attemptId = randomUUID();
  const machineId = '00000000-0000-4000-8000-000000000001';
  const contextId = '00000000-0000-4000-8000-000000000002';
  const recorderId = randomUUID();
  const target = { platform, deviceId: `guest:${contextId}` };
  const subject = {
    appId: 'shop', target, origins: ['https://qa.example.test'], policyVersion: 'policy-1',
    scope: {
      environment: 'staging', tenant: 'tenant-a', accountRef: 'qa-account', credentialRef: 'env:QA_AUTH',
      fixture: { id: 'fixture-1', entityIds: ['order-1'], initialStateSha256: 'a'.repeat(64) },
      operations: [
        { kind: 'setup' as const, effect: 'fixture-write' as const, entityIds: ['order-1'], sinkIds: [] },
        { kind: 'cleanup' as const, effect: 'fixture-write' as const, entityIds: ['order-1'], sinkIds: [] },
      ],
      effects: ['fixture-write' as const], sinks: [],
    },
  };
  const ownerId = `attempt:${attemptId}`;
  const identity = { machineId, contextId, recorderId, generation: 4, epoch: 81, guestPid: 123, attemptId, runId: 'run-1' };
  const source = { kind: 'macos-guest' as const, id: recorderId, root: '/project', bindingSha256: 'b'.repeat(64) };
  const binding = {
    schema: 'qautra/guest-attempt-binding/v1' as const, identity,
    context: {
      root: '/project', runDir: '/project/run', runId: identity.runId, attemptId,
      revisionId: 'c'.repeat(64), testId: 'order', ownerId, fixtureSeedId: 'seed',
      grantId: 'grant', grantSha256: 'd'.repeat(64), subjectSha256: regressionGrantSubjectSha256(subject), target,
    },
    execution: { ownerId, generation: 'admission-1', resources: [`target:${target.deviceId}`] },
    evidenceFile: '/project/run/video.mov',
    native: {
      directory: `/project/.qa/instances/guest-attempts/${recorderId}`,
      machineId, recorderId, nativeGeneration: randomUUID(),
    },
    workerId: `guest:${machineId}:123:81`, machinesRoot: '/project/.qa/instances/machines',
    rootId: randomUUID(), bootTokenSha256: 'e'.repeat(64),
    artifacts: { diskIdentity: '1:2', auxiliaryIdentity: '1:3', hardwareHash: 'f'.repeat(64), machineHash: '1'.repeat(64) },
  };
  const binary = {
    path: '/guest/Applications/Browser', sha256: '2'.repeat(64), bytes: 1024,
    coverage: 'main-executable-only' as const, device: '1', inode: '12', modifiedAt: '1800000000.1',
  };
  const chrome = platform === 'desktop-chrome';
  const profile = chrome ? '/guest/owned/profile' : null;
  const browser: GuestBrowserEvidence = {
    source: structuredClone(source), nativeGeneration: binding.native.nativeGeneration, workerId: binding.workerId,
    runtime: {
      schema: 'qautra/guest-browser-runtime/v1', identity: structuredClone(identity),
      observedAt: '2026-11-03T00:00:02.000Z', sessionId: 'session-1', platform,
      browserVersion: '26.0', browserBuild: '21622.1', driverVersion: 'driver-26',
      browser: { pid: 221, executable: binary },
      driver: { pid: 220, executable: { ...binary, path: '/guest/bin/driver', sha256: '3'.repeat(64), inode: '13' } },
      association: chrome ? 'owned-chrome-profile' : 'exclusive-guest-safari-session',
      os: { platform: 'darwin', release: '25.0.0', version: '26.0', build: '25A1', arch: 'arm64', languages: ['ko-KR'], timezone: 'Asia/Seoul' },
      page: { width: 1280, height: 800, dpr: 2, language: 'ko-KR', languages: ['ko-KR'], timezone: 'Asia/Seoul', userAgent: 'boundary test data', cookieEnabled: true, online: true },
      window: { x: 0, y: 0, width: 1280, height: 900 },
      capabilities: {
        browserName: chrome ? 'chrome' : 'safari', browserVersion: '26.0', acceptInsecureCerts: false,
        ...(chrome ? {
          chrome: { userDataDir: profile! },
          'goog:chromeOptions': { debuggerAddress: '127.0.0.1:12345' },
          'goog:processID': 221,
        } : {}),
      },
      requestedCapabilities: {
        alwaysMatch: {
          browserName: chrome ? 'chrome' : 'safari',
          ...(chrome ? { 'goog:chromeOptions': { args: [`--user-data-dir=${profile}`], debuggerAddress: 'localhost:12345' } } : {}),
        },
        firstMatch: [{}],
      },
      settings: {
        args: chrome ? ['--automation', `--user-data-dir=${profile}`] : ['--automation'],
        preferenceSource: chrome ? 'chrome-profile-file' : 'safari-preference-overrides',
        preferences: { WebKitJavaScriptEnabled: null },
      },
      ephemeral: { sessionId: 'session', profilePath: profile, browserPid: 'process', driverPid: 'process' },
    },
  };
  const initial: NonNullable<Input['initial']> = {
    receiptSha256: '4'.repeat(64), phase: 'prepare', observedAt: '2026-11-03T00:00:00.000Z',
    clientObservedAt: '2026-11-03T00:00:01.000Z', expiresAt: '2026-11-03T00:01:00.000Z',
    subjectSha256: regressionGrantSubjectSha256(subject), scopeSha256: createHash('sha256').update(regressionGrantCanonical(subject.scope)).digest('hex'),
    adapterSha256: '5'.repeat(64), attemptId, ownerId,
    lease: { id: 'lease', generation: 1, fence: 1, expiresAt: '2026-11-03T00:02:00.000Z' },
    state: {
      fixtureId: 'fixture-1', entityIds: ['order-1'],
      baselineStateSha256: 'a'.repeat(64), currentStateSha256: 'a'.repeat(64),
      conditions: { frontendSha256: '6'.repeat(64), apiSha256: '7'.repeat(64), configSha256: '8'.repeat(64) },
    },
    ledger: { sequence: 1, sha256: '9'.repeat(64), pendingEffectIds: [], throughFence: 1, disposition: 'active', fenceStatus: 'active', restoration: 'not_requested' },
    effect: 'committed', cleanup: 'not_started', comparison: 'same_conditions',
  };
  return {
    attemptId, revisionId: binding.context.revisionId, testId: 'order', target, runId: 'run-1',
    initial,
    final: {
      ...structuredClone(initial), phase: 'cleanup', observedAt: '2026-11-03T00:00:03.000Z', cleanup: 'complete',
      ledger: { ...initial.ledger, sequence: 3, disposition: 'drained', fenceStatus: 'revoked', restoration: 'restored' },
    },
    browser: null,
    worker: { runtime: 'macos-guest', instanceId: contextId, machineId, workerId: binding.workerId, generation: 4 },
    runtime: { node: 'v24', files: [{ path: 'runner.ts', sha256: 'a'.repeat(64) }], digest: 'b'.repeat(64) },
    subject, guest: { source, binding, browser },
  };
}

function attempt(receipt: AttemptConditionsReceipt): RegressionAttempt {
  return {
    attemptId: receipt.attemptId, revisionId: receipt.revisionId, testId: receipt.testId, target: receipt.target,
    authorization: {
      appId: receipt.subject.appId, target: receipt.target, grantId: 'grant',
      subjectSha256: regressionGrantSubjectSha256(receipt.subject),
    },
    state: 'finished', business: 'PASS', evidence: 'ready', cleanup: 'confirmed',
    requiredChecks: ['check-1'], completedChecks: ['check-1'], runId: receipt.runId,
    code: null, message: null, conditions: receipt,
  };
}

describe('guest observed-material condition receipts', () => {
  for (const platform of ['desktop-chrome', 'desktop-safari'] as const) {
    it(`derives ${platform} binaries from retained guest evidence`, () => {
      const input = fixture(platform);
      const raw = structuredClone(input.guest);
      const receipt = createAttemptConditions(input);
      assert.equal(receipt.status, 'verified');
      assert.equal(receipt.normalization, 'macos-guest-ephemeral/v1');
      assert.equal(receipt.browser, null);
      assert.deepEqual(receipt.guest, raw);
      assert.equal(receipt.material!.browserBinary.path, '/guest/Applications/Browser');
      assert.equal(receipt.material!.driverBinary.sha256, '3'.repeat(64));
      assert.equal(validAttemptConditions(receipt, attempt(receipt)), true);
    });
  }

  const mismatches: [string, (input: ReturnType<typeof fixture>) => void][] = [
    ['source', input => { input.guest.browser!.source.bindingSha256 = '0'.repeat(64); }],
    ['registered root', input => { input.guest.source.root = '/another-project'; }],
    ['observation root', input => { input.guest.browser!.source.root = '/another-project'; }],
    ['native generation', input => { input.guest.browser!.nativeGeneration = randomUUID(); }],
    ['observation worker', input => { input.guest.browser!.workerId = 'replacement'; }],
    ['attempt', input => { input.guest.browser!.runtime.identity.attemptId = randomUUID(); }],
    ['run', input => { input.guest.browser!.runtime.identity.runId = 'replacement'; }],
    ['context', input => { input.guest.browser!.runtime.identity.contextId = randomUUID(); }],
    ['generation', input => { input.guest.browser!.runtime.identity.generation++; }],
    ['machine', input => { input.guest.browser!.runtime.identity.machineId = randomUUID(); }],
    ['binding revision', input => { input.guest.binding.context.revisionId = '0'.repeat(64); }],
    ['binding test', input => { input.guest.binding.context.testId = 'replacement'; }],
    ['binding subject', input => { input.guest.binding.context.subjectSha256 = '0'.repeat(64); }],
    ['binding target', input => { input.guest.binding.context.target.deviceId = 'replacement'; }],
    ['worker context', input => { input.worker.instanceId = randomUUID(); }],
    ['coherent replacement context', input => { const id = randomUUID(); input.guest.binding.identity.contextId = id; input.guest.browser!.runtime.identity.contextId = id; input.worker.instanceId = id; }],
    ['worker generation', input => { input.worker.generation++; }],
    ['native machine', input => { input.guest.binding.native.machineId = randomUUID(); }],
    ['native recorder', input => { input.guest.binding.native.recorderId = randomUUID(); }],
  ];
  for (const [name, change] of mismatches) it(`leaves mismatched ${name} unverified`, () => {
    const input = fixture();
    change(input);
    const receipt = createAttemptConditions(input);
    assert.equal(receipt.status, 'unverified');
    assert.equal(receipt.material, null);
  });

  it('does not accept a different original grant during archive validation', () => {
    const receipt = createAttemptConditions(fixture());
    const originalAttempt = attempt(receipt);
    originalAttempt.authorization.grantId = 'another-grant';
    assert.equal(validAttemptConditions(receipt, originalAttempt), false);
  });

  const changes: [string, (evidence: GuestBrowserEvidence) => void][] = [
    ['browser hash', value => { value.runtime.browser.executable.sha256 = '0'.repeat(64); }],
    ['driver hash', value => { value.runtime.driver.executable.sha256 = '0'.repeat(64); }],
    ['browser build', value => { value.runtime.browserBuild += '-changed'; }],
    ['OS build', value => { value.runtime.os.build += '-changed'; }],
    ['language', value => { value.runtime.page.languages = ['en-US']; }],
    ['timezone', value => { value.runtime.os.timezone = 'UTC'; }],
    ['DPR', value => { value.runtime.page.dpr = 1; }],
    ['viewport', value => { value.runtime.page.width = 1440; }],
    ['window', value => { value.runtime.window.x = 20; }],
    ['flag', value => { value.runtime.settings.args.push('--different'); }],
    ['null versus false preference', value => { value.runtime.settings.preferences.WebKitJavaScriptEnabled = false; }],
    ['unknown capability', value => { value.runtime.capabilities['vendor:material'] = { enabled: true }; }],
    ['unknown requested capability', value => { value.runtime.requestedCapabilities['vendor:material'] = true; }],
    ['unrelated profile-containing argument', value => { value.runtime.settings.args.push('--other=/guest/owned/profile'); }],
  ];
  for (const [name, change] of changes) it(`preserves changed ${name} as material`, () => {
    const input = fixture('desktop-chrome');
    const before = createAttemptConditions(input);
    change(input.guest.browser!);
    const after = createAttemptConditions(input);
    assert.equal(after.status, 'verified');
    assert.notEqual(before.materialSha256, after.materialSha256);
  });

  it('normalizes validated reboot/process/proof provenance while retaining original context and VM identity', () => {
    const input = fixture('desktop-chrome');
    const before = createAttemptConditions(input);
    const { binding, browser } = input.guest;
    assert.ok(browser);
    binding.identity.epoch++;
    binding.identity.guestPid++;
    binding.identity.generation++;
    binding.identity.recorderId = randomUUID();
    binding.native.recorderId = binding.identity.recorderId;
    binding.native.nativeGeneration = randomUUID();
    binding.workerId = `guest:${binding.identity.machineId}:${binding.identity.guestPid}:${binding.identity.epoch}`;
    input.guest.source.id = binding.identity.recorderId;
    browser.source = structuredClone(input.guest.source);
    browser.nativeGeneration = binding.native.nativeGeneration;
    browser.workerId = binding.workerId;
    browser.runtime.identity = structuredClone(binding.identity);
    browser.runtime.sessionId = 'new-session';
    browser.runtime.observedAt = '2026-11-03T00:00:02.500Z';
    browser.runtime.browser.pid++;
    browser.runtime.capabilities['goog:processID'] = browser.runtime.browser.pid;
    browser.runtime.driver.pid++;
    browser.runtime.browser.executable.inode = '999';
    browser.runtime.browser.executable.modifiedAt = '1800000999.9';
    browser.runtime.driver.executable.inode = '998';
    browser.runtime.driver.executable.modifiedAt = '1800000999.8';
    input.worker.generation = binding.identity.generation;
    input.worker.workerId = binding.workerId;
    const after = createAttemptConditions(input);
    assert.equal(after.status, 'verified');
    assert.equal(after.materialSha256, before.materialSha256);
    assert.notEqual(after.receiptSha256, before.receiptSha256);
    assert.equal(after.material!.worker.machineId, before.material!.worker.machineId);
  });

  it('normalizes only exact owned-profile arguments and known capability fields', () => {
    const input = fixture('desktop-chrome');
    const before = createAttemptConditions(input);
    const runtime = input.guest.browser!.runtime;
    runtime.ephemeral.profilePath = '/guest/new-owned/profile';
    runtime.settings.args[1] = '--user-data-dir=/guest/new-owned/profile';
    runtime.capabilities.chrome = { userDataDir: '/guest/new-owned/profile' };
    runtime.capabilities['goog:chromeOptions'] = { debuggerAddress: '127.0.0.1:54321' };
    runtime.capabilities['goog:processID'] = 999;
    runtime.browser.pid = 999;
    runtime.requestedCapabilities.alwaysMatch = {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--user-data-dir=/guest/new-owned/profile'],
        debuggerAddress: 'localhost:54321',
      },
    };
    const after = createAttemptConditions(input);
    assert.equal(after.status, 'verified');
    assert.equal(after.materialSha256, before.materialSha256);
    runtime.settings.args[1] = '--user-data-dir=/guest/new-owned/profile/suffix';
    assert.equal(createAttemptConditions(input).status, 'unverified');
  });

  it('normalizes owned fields inside the W3C requested capabilities envelope without discarding unknown settings', () => {
    const input = fixture('desktop-chrome');
    const runtime = input.guest.browser!.runtime;
    runtime.requestedCapabilities = { capabilities: runtime.requestedCapabilities };
    const before = createAttemptConditions(input);
    assert.equal(before.status, 'verified');
    runtime.requestedCapabilities.capabilities = {
      alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--user-data-dir=/guest/owned/profile'], debuggerAddress: 'localhost:54321' } },
      firstMatch: [{}],
    };
    assert.equal(createAttemptConditions(input).materialSha256, before.materialSha256);
    runtime.requestedCapabilities.capabilities = {
      alwaysMatch: { browserName: 'chrome', 'vendor:retained-setting': false, 'goog:chromeOptions': { args: ['--user-data-dir=/guest/owned/profile'], debuggerAddress: 'localhost:54321' } },
      firstMatch: [{}],
    };
    assert.notEqual(createAttemptConditions(input).materialSha256, before.materialSha256);
  });

  const malformed: [string, (runtime: GuestBrowserEvidence['runtime']) => void][] = [
    ['remote debugger', runtime => { runtime.capabilities['goog:chromeOptions'] = { debuggerAddress: 'example.test:1234' }; }],
    ['invalid port', runtime => { runtime.capabilities['goog:chromeOptions'] = { debuggerAddress: 'localhost:99999' }; }],
    ['invalid PID', runtime => { runtime.capabilities['goog:processID'] = '123'; }],
    ['unrelated PID', runtime => { runtime.capabilities['goog:processID'] = 999; }],
    ['wrong profile', runtime => { runtime.capabilities.chrome = { userDataDir: '/personal/profile' }; }],
    ['duplicate profile', runtime => { runtime.settings.args.push('--user-data-dir=/guest/owned/profile'); }],
    ['requested options container', runtime => { runtime.requestedCapabilities.alwaysMatch = { 'goog:chromeOptions': [] }; }],
    ['requested alwaysMatch container', runtime => { runtime.requestedCapabilities.alwaysMatch = []; }],
    ['requested firstMatch container', runtime => { runtime.requestedCapabilities.firstMatch = {}; }],
    ['requested candidate container', runtime => { runtime.requestedCapabilities.firstMatch = [null]; }],
    ['requested remote debugger', runtime => { runtime.requestedCapabilities.firstMatch = [{ 'goog:chromeOptions': { debuggerAddress: 'example.test:1234' } }]; }],
    ['requested wrong profile argument', runtime => { runtime.requestedCapabilities.alwaysMatch = { 'goog:chromeOptions': { args: ['--user-data-dir=/personal/profile'] } }; }],
  ];
  for (const [name, change] of malformed) it(`leaves malformed ${name} unverified`, () => {
    const input = fixture('desktop-chrome');
    change(input.guest.browser!.runtime);
    assert.equal(createAttemptConditions(input).status, 'unverified');
  });

  for (const missing of ['companion', 'browser', 'client', 'cleanup'] as const) it(`does not synthesize missing ${missing} proof`, () => {
    const input: Input = fixture();
    if (missing === 'companion') delete input.guest;
    if (missing === 'browser') input.guest!.browser = null;
    if (missing === 'client') delete input.initial!.clientObservedAt;
    if (missing === 'cleanup') input.final = null;
    assert.equal(createAttemptConditions(input).status, 'unverified');
  });

  it('does not silently change normalization during archive verification', () => {
    const receipt = createAttemptConditions(fixture());
    receipt.normalization = 'owned-chrome-ephemeral/v1';
    const { receiptSha256: _previous, ...body } = receipt;
    receipt.receiptSha256 = projectFixtureSha256(body);
    assert.equal(validAttemptConditions(receipt, attempt(receipt)), false);
  });

  it('retains raw null Safari overrides rather than inventing effective defaults', () => {
    const receipt = createAttemptConditions(fixture());
    assert.equal(receipt.guest!.browser!.runtime.settings.preferences.WebKitJavaScriptEnabled, null);
    const settings = receipt.material!.browser.settings as { preferences: Record<string, unknown> };
    assert.equal(settings.preferences.WebKitJavaScriptEnabled, null);
    const bytes = JSON.stringify(receipt);
    assert.equal(validAttemptConditions(AttemptConditionsReceiptSchema.parse(JSON.parse(bytes)), attempt(receipt)), true);
    assert.equal(JSON.stringify(receipt), bytes);
  });
});
