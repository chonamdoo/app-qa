import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GuestAttemptBindingSchema } from '../../src/core/guest-recovery.ts';
import { GuestBrowserEvidenceSchema, GUEST_BROWSER_EPHEMERAL_CAPABILITY_PATHS, validateGuestBrowserEvidence, type GuestBrowserEvidence } from '../../src/core/guest-runtime.ts';
import { createGuestMachineBackend } from '../../src/drivers/vm/backend.ts';
import { GuestDesktopDriver } from '../../src/drivers/vm/driver.ts';

function fixture(platform: 'desktop-safari' | 'desktop-chrome' = 'desktop-safari') {
  const machineId = randomUUID(), contextId = randomUUID(), recorderId = randomUUID();
  const identity = { machineId, contextId, recorderId, generation: 4, epoch: 81, guestPid: 123, attemptId: 'original-attempt', runId: 'original-run' };
  const source = { kind: 'macos-guest' as const, id: recorderId, root: '/project', bindingSha256: 'a'.repeat(64) };
  const binding = GuestAttemptBindingSchema.parse({
    schema: 'qautra/guest-attempt-binding/v1', identity,
    context: { root: '/project', runDir: '/project/run', runId: identity.runId, attemptId: identity.attemptId, revisionId: 'original-revision', testId: 'original-test', ownerId: 'attempt:original-attempt', fixtureSeedId: 'seed', grantId: 'grant', grantSha256: 'b'.repeat(64), subjectSha256: 'c'.repeat(64), target: { platform, deviceId: `guest:${contextId}` } },
    execution: { ownerId: 'attempt:original-attempt', generation: 'original-admission', resources: [`target:guest:${contextId}`] },
    evidenceFile: '/project/run/original.mov', native: { directory: '/project/.qa/instances/guest-attempts/' + recorderId, machineId, recorderId, nativeGeneration: randomUUID() },
    workerId: `guest:${machineId}:123:81`, machinesRoot: '/project/.qa/instances/machines', rootId: randomUUID(), bootTokenSha256: 'd'.repeat(64),
    artifacts: { diskIdentity: '1:2', auxiliaryIdentity: '1:3', hardwareHash: 'e'.repeat(64), machineHash: 'f'.repeat(64) },
  });
  const binary = { path: '/Applications/Safari.app/Contents/MacOS/Safari', sha256: '1'.repeat(64), bytes: 1024, coverage: 'main-executable-only' as const, device: '1', inode: '12', modifiedAt: '1800000000.1' };
  const evidence: GuestBrowserEvidence = {
    source, nativeGeneration: binding.native.nativeGeneration, workerId: binding.workerId,
    runtime: { schema: 'qautra/guest-browser-runtime/v1', identity, observedAt: '2026-11-03T00:00:00.000Z', sessionId: 'original-session', platform, browserVersion: '26.0', browserBuild: '21622.1', driverVersion: 'Included with Safari 26.0',
      browser: { pid: 221, executable: binary }, driver: { pid: 220, executable: { ...binary, path: '/usr/bin/safaridriver', inode: '13', sha256: '2'.repeat(64) } },
      association: platform === 'desktop-safari' ? 'exclusive-guest-safari-session' : 'owned-chrome-profile',
      os: { platform: 'darwin', release: '25.0.0', version: '26.0', build: '25A1', arch: 'arm64', languages: ['ko-KR'], timezone: 'Asia/Seoul' },
      page: { width: 1280, height: 800, dpr: 2, language: 'ko-KR', languages: ['ko-KR'], timezone: 'Asia/Seoul', userAgent: 'synthetic boundary fixture, not runtime proof', cookieEnabled: true, online: true },
      window: { x: 0, y: 0, width: 1280, height: 900 }, capabilities: { browserName: platform === 'desktop-safari' ? 'safari' : 'chrome', browserVersion: '26.0', acceptInsecureCerts: false }, requestedCapabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } },
      settings: { args: ['--automation'], preferenceSource: platform === 'desktop-safari' ? 'safari-preference-overrides' : 'chrome-profile-file', preferences: { WebKitJavaScriptEnabled: null } }, ephemeral: { sessionId: 'session', profilePath: platform === 'desktop-safari' ? null : '/guest/context/profile', browserPid: 'process', driverPid: 'process' },
    },
  };
  return { binding, source, evidence };
}

describe('original guest runtime evidence boundary', () => {
  for (const platform of ['desktop-safari', 'desktop-chrome'] as const) {
    it(`retains ${platform} observations without discarding material settings or original provenance`, () => {
      const { evidence, binding, source } = fixture(platform);
      assert.deepEqual(validateGuestBrowserEvidence(evidence, binding, source), evidence);
      const changed = structuredClone(evidence);
      changed.runtime.settings.preferences.WebKitJavaScriptEnabled = false;
      changed.runtime.page.language = 'en-US';
      changed.runtime.browser.executable.sha256 = '3'.repeat(64);
      assert.deepEqual(validateGuestBrowserEvidence(changed, binding, source), changed);
      assert.notDeepEqual(evidence, changed);
      assert.equal(evidence.runtime.settings.preferences.WebKitJavaScriptEnabled, null);
    });
  }

  for (const key of ['machineId', 'contextId', 'recorderId', 'generation', 'epoch', 'guestPid', 'attemptId', 'runId'] as const) {
    it(`refuses a different original ${key}`, () => {
      const { evidence, binding, source } = fixture();
      const original = evidence.runtime.identity[key];
      Object.assign(evidence.runtime.identity, { [key]: typeof original === 'number' ? original + 1 : key.endsWith('Id') && !['attemptId', 'runId'].includes(key) ? randomUUID() : 'replacement' });
      assert.throws(() => validateGuestBrowserEvidence(evidence, binding, source), /guest_runtime_original_attempt_mismatch/);
    });
  }

  for (const change of ['source', 'native', 'worker', 'platform', 'association', 'profile'] as const) {
    it(`refuses ${change} substitution`, () => {
      const { evidence, binding, source } = fixture();
      if (change === 'source') evidence.source = { ...source, bindingSha256: '9'.repeat(64) };
      if (change === 'native') evidence.nativeGeneration = randomUUID();
      if (change === 'worker') evidence.workerId = 'replacement-worker';
      if (change === 'platform') evidence.runtime.platform = 'desktop-chrome';
      if (change === 'association') evidence.runtime.association = 'owned-chrome-profile';
      if (change === 'profile') evidence.runtime.ephemeral.profilePath = '/personal/profile';
      assert.throws(() => validateGuestBrowserEvidence(evidence, binding, source), /guest_runtime_original_attempt_mismatch/);
    });
  }

  it('requires real binary descriptors and bounded, finite page observations', () => {
    const { evidence } = fixture();
    for (const runtime of [
      { ...evidence.runtime, browser: { pid: 221, executable: { path: '/host/chrome' } } },
      { ...evidence.runtime, page: { ...evidence.runtime.page, dpr: Number.NaN } },
      { ...evidence.runtime, page: { ...evidence.runtime.page, width: 0 } },
      { ...evidence.runtime, page: { ...evidence.runtime.page, timezone: '' } },
      { ...evidence.runtime, os: { ...evidence.runtime.os, platform: 'linux' } },
    ]) assert.equal(GuestBrowserEvidenceSchema.safeParse({ ...evidence, runtime }).success, false);
    assert.deepEqual(GUEST_BROWSER_EPHEMERAL_CAPABILITY_PATHS, [['goog:chromeOptions', 'debuggerAddress'], ['chrome', 'userDataDir'], ['goog:processID']]);
  });

  it('does not prepare or open a guest browser merely to observe missing original authority', async () => {
    let preparations = 0;
    const driver = new GuestDesktopDriver('desktop-safari', 'guest:unprepared', { prepare: async () => { preparations += 1; throw new Error('must not prepare'); }, execution: () => null });
    await assert.rejects(driver.observeGuestBrowserEvidence(), /original registered attempt/);
    assert.equal(preparations, 0);
    assert.deepEqual(driver.guestBrowserObservations, []);
  });

  it('refuses unfenced raw control observation before starting any native owner', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-guest-runtime-')));
    const backend = createGuestMachineBackend(root);
    try {
      await assert.rejects(backend.request(randomUUID(), { version: 1, id: randomUUID(), epoch: 1, deadlineAt: Date.now() + 1000, operation: 'browser.evidence', payload: {} }), { code: 'guest_runtime_requires_original_attempt_endpoint' });
      assert.equal(existsSync(join(root, '.qa/instances/machines/runtime/control.sock')), false);
    } finally { await backend.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });
});
