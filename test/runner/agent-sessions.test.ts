import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AGENT_MUTATIONS, SessionRequestSchema, type AgentActionInput, type AgentActionResult, type AgentCallContext, type AgentError, type AgentObservation, type AgentReply, type AgentScriptView, type AgentSessionView, type Effect, type SessionRequestInput } from '../../src/core/agent.ts';
import { createExecutionAdmission, type ExecutionAdmission } from '../../src/core/admission.ts';
import { createAgentClient } from '../../src/core/agent-client.ts';
import { ROOT } from '../../src/core/config.ts';
import type { EventSink, QaEventBody } from '../../src/core/events.ts';
import type { ActionOutcome, DeviceInfo, Platform, Snapshot } from '../../src/core/types.ts';
import type { RunSummary } from '../../src/report/types.ts';
import { createAgentSessions, type AgentSessionDeps, type AgentSessions } from '../../src/runner/agent-sessions.ts';
import { createAgentScripts, type AgentScripts } from '../../src/runner/agent-scripts.ts';
import { listRuns } from '../../src/server/store.ts';
import { FakeClock, FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { readJsonl, tempRoot } from '../helpers/run.ts';
import { sha256, writeJsonAtomic, writeSecure } from '../../src/core/fsx.ts';
import { acquireFileLock } from '../../src/core/lock.ts';

const APP = 'agent-fixture';
const PLATFORM = 'desktop-chrome';
const HELP_TEXT = '검색창에 상품 이름을 입력하고 검색을 누르세요.';
const index = (patch: [string, string][] = []) => fixtureSnapshot(PLATFORM, 'web-demo', 'index', { patch });
const help = () => fixtureSnapshot(PLATFORM, 'web-demo', 'index-help');
const login = (patch: [string, string][] = []) => fixtureSnapshot(PLATFORM, 'web-demo', 'login-email', { patch });
type Mutation = (typeof AGENT_MUTATIONS)[number];
type LeaseEvent = { kind: 'acquire' | 'ended' | 'unknown'; deviceId: string; runId: string; reason?: string };
interface Harness {
  sessions: AgentSessions;
  drivers: FakeDriver[];
  root: string;
  picks: { platform: Platform; id: string | undefined }[];
  creations: string[];
  leases: LeaseEvent[];
  held: Set<string>;
  admission: ExecutionAdmission;
}

function setup(t: TestContext, opts: {
  screens?: Snapshot[];
  mutations?: readonly Mutation[];
  coordinates?: boolean;
  granted?: boolean;
  selectedDevice?: (device: DeviceInfo) => DeviceInfo | Promise<DeviceInfo>;
  provenRejected?: Error;
  onAcquire?: (root: string, runId: string) => void;
  expectUnconfirmedShutdown?: boolean;
  events?: EventSink;
  redact?: readonly string[];
} = {}): Harness {
  const clock = new FakeClock();
  const drivers = (opts.screens ?? [index()]).map((screen, i) => {
    const driver = new FakeDriver(screen, clock, `synthetic-device-${i + 1}`);
    driver.hittable = () => true;
    driver.elementIdAt = async (point) => `element:${point.x}:${point.y}`;
    return driver;
  });
  const profile = {
    id: APP, name: 'First-party synthetic shop',
    redact: opts.redact ?? [],
    web: { url: 'http://localhost:4173/', platforms: [...new Set(drivers.map((driver) => driver.platform))] },
    ...(opts.granted === false ? {} : { agent: {
      data: 'synthetic-fixture', screenshots: true, deviceIds: drivers.map((driver) => driver.deviceId),
      mutations: opts.mutations ?? [...AGENT_MUTATIONS], coordinates: opts.coordinates ?? false,
    } }),
  };
  const root = tempRoot({ [`apps/${APP}.yaml`]: JSON.stringify(profile) });
  const admission = createExecutionAdmission(join(root, '.qa', 'test-admission'));
  const chainId = `test-chain:${randomUUID()}`;
  const picks: Harness['picks'] = [];
  const creations: string[] = [];
  const leases: LeaseEvent[] = [];
  const held = new Set<string>();
  const deps: AgentSessionDeps = {
    root, appsDir: join(root, 'apps'), runsDir: join(root, '.qa', 'runs'), clock, ocr: null,
    events: opts.events,
    pickDevice: async (platform, id) => {
      picks.push({ platform, id });
      const device: DeviceInfo = { platform, id: id ?? 'personal-device', name: 'Synthetic fixture', osVersion: '1', state: 'booted', kind: platform.startsWith('desktop') ? 'browser' : 'emulator' };
      return opts.selectedDevice?.(device) ?? device;
    },
    createDriver: (platform, id) => {
      creations.push(id);
      const driver = drivers.find((item) => item.deviceId === id && item.platform === platform);
      assert.ok(driver, `Unexpected physical device ${platform}:${id}`);
      return driver;
    },
    acquireSession: (platform, deviceId, runId) => {
      const key = `${platform}:${deviceId}`;
      if (held.has(key)) throw new Error(`Resource already held: ${key}`);
      const reservation = admission.acquire(chainId, `target:${deviceId}`);
      let unknown = false;
      held.add(key);
      leases.push({ kind: 'acquire', deviceId, runId });
      opts.onAcquire?.(root, runId);
      return {
        ended: () => {
          if (unknown) return;
          assert.ok(held.delete(key), `Lease released twice: ${key}`);
          reservation.ended();
          leases.push({ kind: 'ended', deviceId, runId });
        },
        unknown: (reason) => {
          unknown = true;
          reservation.unknown(reason);
          leases.push({ kind: 'unknown', deviceId, runId, reason });
        },
      };
    },
    openFailureProvenRejected: (error) => opts.provenRejected !== undefined && error === opts.provenRejected,
  };
  const sessions = createAgentSessions(deps);
  t.after(async () => {
    if (opts.expectUnconfirmedShutdown) await assert.rejects(sessions.shutdown(), AggregateError);
    else await sessions.shutdown();
  });
  return { sessions, drivers, root, picks, creations, leases, held, admission };
}

function success<T>(reply: AgentReply): T {
  if (!reply.ok) assert.fail(JSON.stringify(reply));
  return reply.result as T;
}
function failure(reply: AgentReply, code?: string, effect?: Effect): AgentError {
  if (reply.ok) assert.fail(`Expected refusal, got ${JSON.stringify(reply)}`);
  if (code !== undefined) assert.equal(reply.error.code, code, reply.error.message);
  if (effect !== undefined) assert.equal(reply.error.effect, effect, reply.error.message);
  return reply.error;
}
async function open(h: Harness, i = 0): Promise<AgentSessionView> {
  const driver = h.drivers[i]!;
  return success(await h.sessions.call({ method: 'session.open', app: APP, platform: driver.platform, deviceId: driver.deviceId }));
}
async function observe(h: Harness, sessionId: string, context?: AgentCallContext): Promise<AgentObservation> {
  const reply = await h.sessions.call({ method: 'session.observe', sessionId }, context);
  const value = success<AgentObservation>(reply);
  assert.equal(reply.meta.sessionId, sessionId);
  assert.equal(reply.meta.revision, value.revision);
  return value;
}
async function status(h: Harness, sessionId: string): Promise<AgentSessionView> {
  return success(await h.sessions.call({ method: 'session.status', sessionId }));
}
function ref(observation: AgentObservation, resourceId: string): string {
  const candidate = observation.candidates.find((item) => item.resourceId === resourceId);
  assert.ok(candidate, `Missing ${resourceId}: ${JSON.stringify(observation.candidates)}`);
  return candidate.ref;
}
function act(h: Harness, observation: AgentObservation, action: AgentActionInput, context?: AgentCallContext, expectNoChange = false): Promise<AgentReply> {
  return h.sessions.call({ method: 'session.act', sessionId: observation.sessionId, revision: observation.revision, action, timeoutMs: 1000, expectNoChange }, context);
}
function runDir(h: Harness, view: AgentSessionView): string {
  return join(h.root, '.qa', 'runs', view.runId);
}
function summary(h: Harness, view: AgentSessionView): RunSummary {
  return JSON.parse(readFileSync(join(runDir(h, view), 'summary.json'), 'utf8')) as RunSummary;
}
function journal(h: Harness, view: AgentSessionView): Record<string, unknown>[] {
  return readJsonl(join(runDir(h, view), 'journal.jsonl'));
}
function textEvidence(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? textEvidence(path) : entry.name.endsWith('.png') ? '' : readFileSync(path, 'utf8');
  }).join('\n');
}
function nativeScreens(): Snapshot[] {
  return [fixtureSnapshot('android', 'web-demo', 'index'), fixtureSnapshot('android', 'web-demo', 'index')];
}

describe('agent sessions through real scoped execution', () => {
  it('publishes direct runs as unfinished until confirmed closure, without inventing business PASS', async (t) => {
    const visible: QaEventBody[] = [];
    const h = setup(t, { events: { emit: (event) => { visible.push(event); } } });
    const view = await open(h);
    const runsDir = join(h.root, '.qa', 'runs');
    const [active] = await listRuns(runsDir);
    assert.equal(active?.tests[0]?.id, view.sessionId);
    assert.equal(active?.finished, false);
    assert.equal(visible.some((event) => event.type === 'run.finished'), false);
    assert.equal(visible.some((event) => event.type === 'run.started' && event.runId === view.runId), true);
    success(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }));
    const [closed] = await listRuns(runsDir);
    assert.equal(closed?.finished, true);
    assert.equal(closed?.counts?.INCONCLUSIVE, 1);
    assert.equal(closed?.counts?.PASS, 0);
    success(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }));
    assert.equal(visible.filter((event) => event.type === 'run.finished' && event.runId === view.runId).length, 1);
  });

  it('keeps issued session identities and observation references usable when text redaction matches UUIDs', async (t) => {
    const h = setup(t, { redact: ['^[0-9a-f-]{36}$'] });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    const driver = h.drivers[0]!;
    driver.onTap = () => help();
    const changed = success<AgentActionResult>(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }));
    assert.equal(changed.effect, 'completed');
    assert.ok(changed.observation.texts.includes(HELP_TEXT));
    assert.ok(driver.screen.nodes.some((node) => node.resourceId === 'help'));
    success(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }));
    assert.equal((await status(h, view.sessionId)).state, 'closed');
  });

  it('journals an authorized model-free mutation before input, but requires a business assertion for PASS', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const driver = h.drivers[0]!;
    const before = await observe(h, view.sessionId);
    assert.equal(before.capabilities.modelRequired, false);
    driver.onTap = (point) => {
      assert.ok(hits(index(), '도움말', point));
      const pending = journal(h, view).filter((entry) => entry.kind === 'tap');
      assert.deepEqual(pending.map((entry) => entry.phase), ['intent']);
      return help();
    };
    const reply = await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') });
    const changed = success<AgentActionResult>(reply);
    assert.equal(changed.effect, 'completed');
    assert.equal(changed.step.verdict, 'PASS');
    assert.ok(changed.observation.texts.includes(HELP_TEXT));
    assert.ok(driver.screen.nodes.some((node) => node.resourceId === 'help'));
    assert.equal(driver.called('tap').length, 1);
    assert.deepEqual(journal(h, view).filter((entry) => entry.kind === 'tap').map((entry) => [entry.phase, entry.status ?? null]), [['intent', null], ['outcome', 'completed']]);
    const unasserted = summary(h, view).tests[0]!;
    assert.equal(unasserted.verdict, 'INCONCLUSIVE');
    assert.equal(unasserted.code, 'business_assertion_missing');
    const asserted = success<AgentActionResult>(await act(h, changed.observation, { kind: 'assertText', text: HELP_TEXT }));
    assert.equal(asserted.effect, 'not_started');
    const final = summary(h, view).tests[0]!;
    assert.equal(final.verdict, 'PASS', final.reason);
    assert.ok(final.steps.some((step) => step.kind === 'assertText' && step.verdict === 'PASS'));
    assert.ok(final.steps.every((step) => step.decisions.every((decision) => decision.source !== 'jev')));
    assert.equal(driver.called('tap').length, 1);
    const screenshot = join(runDir(h, view), asserted.observation.screenshot.path);
    assert.equal(statSync(runDir(h, view)).mode & 0o777, 0o700);
    assert.equal(statSync(screenshot).mode & 0o777, 0o600);
    success(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }));
    assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'ended']);
    assert.equal(h.held.size, 0);
  });

  it('reconnects by explicit status/list without launching, resetting, or abandoning the existing lease', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const driver = h.drivers[0]!;
    const before = await observe(h, view.sessionId);
    const callCount = driver.calls.length;
    const first = await status(h, view.sessionId);
    const listed = success<AgentSessionView[]>(await h.sessions.call({ method: 'session.list' }));
    const second = await status(h, view.sessionId);
    assert.equal(driver.calls.length, callCount);
    assert.deepEqual([first.sessionId, listed[0]!.sessionId, second.sessionId], [view.sessionId, view.sessionId, view.sessionId]);
    assert.equal(second.instanceId, view.instanceId);
    assert.equal(second.runId, view.runId);
    assert.equal(second.revision, before.revision);
    assert.equal(second.state, 'ready');
    assert.equal(driver.called('open').length, 1);
    assert.equal(driver.called('launch').length, 1);
    assert.equal(driver.called('reset').length, 0);
    assert.equal(driver.called('terminate').length, 0);
    assert.deepEqual(h.leases.map((event) => event.kind), ['acquire']);
    assert.equal(h.held.size, 1);
  });

  it('never resolves an implicit device or adopts an explicitly requested personal device outside the grant', async (t) => {
    const h = setup(t);
    const missingDevice = { method: 'session.open', app: APP, platform: PLATFORM } as SessionRequestInput;
    failure(await h.sessions.call(missingDevice), 'invalid_request', 'not_started');
    failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: 'personal-phone' }), 'scope_denied', 'not_started');
    assert.deepEqual(h.picks, []);
    assert.deepEqual(h.creations, []);
    assert.deepEqual(h.leases, []);
    assert.equal(h.drivers[0]!.calls.length, 0);
    assert.deepEqual(success(await h.sessions.call({ method: 'session.list' })), []);
  });

  it('does not adopt a profile without synthetic-data and screenshot approval', async (t) => {
    const h = setup(t, { granted: false });
    failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: h.drivers[0]!.deviceId }), 'scope_denied', 'not_started');
    assert.deepEqual(h.picks, []);
    assert.deepEqual(h.leases, []);
    assert.equal(h.drivers[0]!.called('open').length, 0);
  });

  it('refuses a selector that returned a different device rather than accepting its personal-device fallback', async (t) => {
    const h = setup(t, { selectedDevice: (device) => ({ ...device, id: 'personal-phone' }) });
    failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: h.drivers[0]!.deviceId }), 'device_unavailable', 'not_started');
    assert.deepEqual(h.picks, [{ platform: PLATFORM, id: h.drivers[0]!.deviceId }]);
    assert.deepEqual(h.creations, []);
    assert.deepEqual(h.leases, []);
  });

  it('blocks an ungranted mutation even when its field is harmless and observable', async (t) => {
    const h = setup(t, { mutations: ['tap'] });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    failure(await act(h, before, { kind: 'type', ref: ref(before, 'query'), text: '사과' }), 'scope_denied', 'not_started');
    assert.equal(h.drivers[0]!.called('typeText').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'type').length, 0);
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
    assert.equal(summary(h, view).tests[0]!.verdict, 'ERROR');
    assert.deepEqual(h.leases.map((event) => event.kind), ['acquire']);
  });

  it('keeps navigation inside the configured origin even with an open mutation grant', async (t) => {
    const h = setup(t, { mutations: ['open'] });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    failure(await act(h, before, { kind: 'open', url: 'https://outside.invalid/account' }), 'blocked_by_policy', 'not_started');
    assert.equal(h.drivers[0]!.called('openUrl').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'open').length, 0);
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
  });

  for (const boundary of ['other-session-ref', 'old-ref', 'old-revision'] as const) {
    it(`rejects ${boundary} without physical input or releasing either session`, async (t) => {
      const h = setup(t, { screens: nativeScreens() });
      const first = await open(h);
      const second = await open(h, 1);
      const old = await observe(h, first.sessionId);
      const current = await observe(h, first.sessionId);
      const other = await observe(h, second.sessionId);
      const suppliedRef = boundary === 'other-session-ref' ? ref(other, 'help-open') : boundary === 'old-ref' ? ref(old, 'help-open') : ref(current, 'help-open');
      const revision = boundary === 'old-revision' ? old.revision : current.revision;
      failure(await h.sessions.call({ method: 'session.act', sessionId: first.sessionId, revision, action: { kind: 'tap', ref: suppliedRef } }), boundary === 'old-revision' ? 'stale_revision' : 'stale_ref', 'not_started');
      assert.ok(h.drivers.every((driver) => driver.called('tap').length === 0));
      assert.equal((await status(h, first.sessionId)).state, 'stopped');
      assert.equal((await status(h, second.sessionId)).state, 'ready');
      assert.equal(h.held.size, 2);
      assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'acquire']);
      assert.equal(journal(h, first).filter((entry) => entry.kind === 'tap').length, 0);
    });
  }
  it('exposes a whole bundle owner before its first RPC and keeps cancellation owned until cleanup', async (t) => {
    const h = setup(t, { screens: nativeScreens() });
    const views = [await open(h), await open(h, 1)];
    const scriptId = randomUUID();
    const admission = h.sessions.beginScript(scriptId, views.map((view) => view.sessionId));
    for (const view of views) {
      assert.equal((await status(h, view.sessionId)).activeScriptId, scriptId);
      const stored = JSON.parse(readFileSync(join(runDir(h, view), 'session.json'), 'utf8')) as AgentSessionView;
      assert.equal(stored.activeScriptId, scriptId);
      failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }), 'session_busy', 'not_started');
    }
    await admission;
    const listed = success<AgentSessionView[]>(await h.sessions.call({ method: 'session.list' }));
    assert.ok(listed.every((view) => view.activeScriptId === scriptId));
    h.sessions.stopScript(scriptId, 'Cancelled before the first worker RPC');
    for (const view of views) assert.equal((await status(h, view.sessionId)).activeScriptId, scriptId);
    await h.sessions.endScript(scriptId, 'cancelled');
    for (const view of views) {
      const current = await status(h, view.sessionId);
      assert.equal(current.activeScriptId, null);
      assert.equal(current.state, 'stopped');
      success(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }));
      assert.equal(h.drivers.find((driver) => driver.deviceId === view.deviceId)!.called('tap').length, 0);
    }
    assert.equal(h.held.size, 0);
  });

  it('rolls back the entire bundle when admission evidence cannot be persisted', async (t) => {
    const h = setup(t, { screens: nativeScreens() });
    const views = [await open(h), await open(h, 1)];
    const blockedDir = runDir(h, views[1]!);
    chmodSync(blockedDir, 0o500);
    try {
      await assert.rejects(h.sessions.beginScript(randomUUID(), views.map((view) => view.sessionId)), { code: 'evidence_unavailable', effect: 'not_started' });
      for (const view of views) {
        const current = await status(h, view.sessionId);
        assert.equal(current.activeScriptId, null);
        assert.equal(current.state, 'ready');
      }
    } finally { chmodSync(blockedDir, 0o700); }
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, views.map((view) => view.sessionId));
    for (const view of views) {
      const context = { scriptId, allowedSessionIds: views.map((item) => item.sessionId) };
      await observe(h, view.sessionId, context);
    }
    await h.sessions.endScript(scriptId, 'completed');
    for (const view of views) {
      assert.equal((await status(h, view.sessionId)).activeScriptId, null);
      const stored = JSON.parse(readFileSync(join(runDir(h, view), 'session.json'), 'utf8')) as AgentSessionView;
      assert.equal(stored.activeScriptId, null);
      await observe(h, view.sessionId);
      assert.notEqual(summary(h, view).tests[0]!.verdict, 'PASS');
    }
  });

  for (const method of ['act', 'wait'] as const) {
    for (const scope of [undefined, 'visual'] as const) {
      it(`refuses ${method} absence with ${scope ?? 'omitted'} scope without blocking unrelated assertions`, async (t) => {
        const h = setup(t, { screens: nativeScreens() });
        const first = await open(h);
        const second = await open(h, 1);
        const scriptId = randomUUID();
        const ids = [first.sessionId, second.sessionId];
        await h.sessions.beginScript(scriptId, ids);
        const context = { scriptId, allowedSessionIds: ids };
        const before = await observe(h, first.sessionId, context);
        const refused = method === 'act'
          ? await act(h, before, { kind: 'assertText', text: 'Unobserved visual surface', absent: true, scope }, context)
          : await h.sessions.call({ method: 'session.wait', sessionId: first.sessionId, text: 'Unobserved visual surface', absent: true, scope }, context);
        failure(refused, 'unsupported_observation_scope', 'not_started');
        assert.equal(summary(h, first).tests[0]!.code, 'unsupported_observation_scope');
        assert.equal((await status(h, first.sessionId)).state, 'ready');
        assert.equal((await status(h, second.sessionId)).state, 'ready');
        for (const view of [first, second]) {
          const observed = await observe(h, view.sessionId, context);
          success(await act(h, observed, { kind: 'assertText', text: '도움말' }, context));
        }
        await h.sessions.endScript(scriptId, 'completed');
        assert.equal(summary(h, first).tests[0]!.verdict, 'ERROR');
        assert.equal(summary(h, first).tests[0]!.code, 'unsupported_observation_scope');
        assert.equal(summary(h, second).tests[0]!.verdict, 'PASS');
        assert.ok(h.drivers.every((driver) => driver.called('tap').length === 0));
      });
    }
  }

  it('supports explicitly observed-text absence through both SDK paths without claiming visual coverage', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const client = createAgentClient((request, signal) => h.sessions.call(SessionRequestSchema.parse(request), { signal }));
    const session = client.session(view.sessionId);
    await session.observe();
    const asserted = await session.act({ kind: 'assertText', text: 'Unobserved visual surface', absent: true, scope: 'observed-text' });
    assert.equal(asserted.step.verdict, 'PASS');
    const waited = await session.wait('Unobserved visual surface', { absent: true, scope: 'observed-text' });
    assert.equal(waited.step.verdict, 'PASS');
    assert.equal(waited.observation.coverage.spatial, 'desktop-viewport');
    assert.equal(waited.observation.coverage.text, 'normalized-visible-text');
    assert.equal(waited.observation.coverage.wholePage, false);
    assert.equal(waited.observation.coverage.allRenderedSurfaces, false);
    assert.equal(summary(h, view).tests[0]!.verdict, 'PASS');
  });

  it('keeps depth-capped observed-text absence inconclusive through the direct SDK', async (t) => {
    const h = setup(t, { screens: nativeScreens() });
    const view = await open(h);
    const client = createAgentClient((request) => h.sessions.call(SessionRequestSchema.parse(request)));
    const session = client.session(view.sessionId);
    const observed = await session.observe();
    assert.equal(observed.coverage.spatial, 'device-screen');
    h.drivers[0]!.screen = { ...h.drivers[0]!.screen, depthCapped: true };
    await assert.rejects(session.act({ kind: 'assertText', text: 'Unobserved visual surface', absent: true, scope: 'observed-text' }), { code: 'observation_truncated', effect: 'not_started' });
    assert.notEqual(summary(h, view).tests[0]!.verdict, 'PASS');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
  });


  it('reserves script sessions atomically and refuses cross-session calls even when the script catches them', async (t) => {
    const h = setup(t, { screens: nativeScreens() });
    const first = await open(h);
    const second = await open(h, 1);
    const owner = randomUUID();
    await h.sessions.beginScript(owner, [second.sessionId]);
    const rejectedOwner = randomUUID();
    await assert.rejects(h.sessions.beginScript(rejectedOwner, [first.sessionId, second.sessionId]));
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, [first.sessionId]);
    const context = { scriptId, allowedSessionIds: [first.sessionId] };
    const before = await observe(h, first.sessionId, context);
    failure(await h.sessions.call({ method: 'session.observe', sessionId: second.sessionId }, context), 'scope_denied', 'not_started');
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, context, true), undefined, 'not_started');
    assert.ok(h.drivers.every((driver) => driver.called('tap').length === 0));
    assert.equal((await status(h, first.sessionId)).state, 'stopped');
    assert.equal((await status(h, second.sessionId)).state, 'ready');
    await h.sessions.endScript(scriptId, 'failed');
    await h.sessions.endScript(owner, 'completed');
    await assert.rejects(h.sessions.beginScript(randomUUID(), [first.sessionId]));
    assert.equal(h.held.size, 2);
  });

  for (const replacement of ['before-action', 'during-final-identity'] as const) {
    it(`refuses same-label, same-box DOM replacement ${replacement}`, async (t) => {
      const h = setup(t);
      const driver = h.drivers[0]!;
      let identity = 'original-element';
      driver.elementIdAt = async () => identity;
      const view = await open(h);
      const before = await observe(h, view.sessionId);
      if (replacement === 'before-action') identity = 'replacement-element';
      else {
        driver.elementIdAt = async () => {
          const result = identity;
          identity = 'replacement-element';
          return result;
        };
      }
      failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, undefined, true), 'stale_target', 'not_started');
      assert.equal(driver.screen.rawSource, index().rawSource);
      assert.equal(driver.called('tap').length, 0);
      assert.equal(journal(h, view).filter((entry) => entry.kind === 'tap').length, 0);
      assert.equal((await status(h, view.sessionId)).state, 'stopped');
    });
  }

  for (const race of ['disabled', 'destructive-dialog'] as const) {
    it(`rechecks spontaneous ${race} after identity lookup and before input`, async (t) => {
      const initial = index([['text="도움말"', 'text="확인"']]);
      const h = setup(t, { screens: [initial] });
      const driver = h.drivers[0]!;
      const view = await open(h);
      const before = await observe(h, view.sessionId);
      driver.elementIdAt = async (point) => {
        driver.screen = race === 'disabled'
          ? index([['text="도움말"', 'text="확인"'], ['resource-id="help-open"', 'resource-id="help-open" enabled="false"']])
          : index([['text="도움말"', 'text="확인"'], ['text="상품 3개"', 'text="정말 삭제하시겠습니까? 되돌릴 수 없습니다."']]);
        return `element:${point.x}:${point.y}`;
      };
      failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, undefined, true), race === 'disabled' ? 'stale_target' : 'blocked_by_policy', 'not_started');
      assert.equal(driver.called('tap').length, 0);
      assert.equal(journal(h, view).filter((entry) => entry.kind === 'tap').length, 0);
      assert.equal((await status(h, view.sessionId)).state, 'stopped');
    });
  }

  it('types literal environment syntax without looking up or expanding the host environment', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    const literal = '${HOME}/${APP_QA_UNSET_SYNTHETIC_VALUE}';
    const typed = success<AgentActionResult>(await act(h, before, { kind: 'type', ref: ref(before, 'query'), text: literal }, undefined, true));
    assert.equal(typed.effect, 'completed');
    assert.deepEqual(h.drivers[0]!.called('typeText').map((call) => call.args[1]), [literal]);
    assert.equal(h.drivers[0]!.called('press').length, 0);
    assert.equal((await status(h, view.sessionId)).state, 'ready');
    assert.ok(!textEvidence(runDir(h, view)).includes(literal));
  });

  it('redacts observed and typed secure values from actual replies, evidence, and script-shaped structural keys', async (t) => {
    const observedSecret = 'vault-observed-48f1';
    const typedSecret = 'vault-typed-b15e';
    const h = setup(t, { screens: [login([['value="••••••"', `value="${observedSecret}"`]])] });
    const view = await open(h);
    const beforeReply = await h.sessions.call({ method: 'session.observe', sessionId: view.sessionId });
    const before = success<AgentObservation>(beforeReply);
    assert.ok(!JSON.stringify(beforeReply).includes(observedSecret));
    h.drivers[0]!.typeError = `INPUT_UNVERIFIED: read back ${observedSecret}, expected ${typedSecret}`;
    const reply = await act(h, before, { kind: 'type', ref: ref(before, 'password'), text: typedSecret, secure: false });
    failure(reply, 'input_unverified', 'completed');
    assert.equal(h.drivers[0]!.called('typeText').length, 1);
    assert.deepEqual(h.drivers[0]!.called('typeText')[0]!.args[2], { secure: true, append: false, submit: false });
    const payload = {
      [observedSecret]: { code: typedSecret, status: observedSecret, kind: typedSecret, type: observedSecret, source: typedSecret, file: observedSecret, runId: typedSecret },
      result: [{ [typedSecret]: observedSecret }], stdout: `${observedSecret} ${typedSecret}`,
    };
    const cleaned = h.sessions.sanitize(payload, [view.sessionId]);
    for (const secret of [observedSecret, typedSecret]) {
      assert.ok(!JSON.stringify(reply).includes(secret));
      assert.ok(!JSON.stringify(cleaned).includes(secret));
      assert.ok(!textEvidence(runDir(h, view)).includes(secret));
    }
    assert.ok(Object.keys(cleaned).some((key) => key.includes('•')));
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
  });

  it('latches a business assertion failure so catching it cannot resume mutations', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, [view.sessionId]);
    const context = { scriptId, allowedSessionIds: [view.sessionId] };
    const before = await observe(h, view.sessionId, context);
    failure(await act(h, before, { kind: 'assertText', text: 'This business outcome never happened' }, context), undefined, 'not_started');
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, context, true), undefined, 'not_started');
    await h.sessions.endScript(scriptId, 'completed');
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, undefined, true), 'session_stopped', 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
    assert.notEqual(summary(h, view).tests[0]!.verdict, 'PASS');
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
    await assert.rejects(h.sessions.beginScript(randomUUID(), [view.sessionId]));
  });

  it('never retries an unknown effect, even after observation, caught errors, and a claimed successful script end', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const driver = h.drivers[0]!;
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, [view.sessionId]);
    const context = { scriptId, allowedSessionIds: [view.sessionId] };
    const before = await observe(h, view.sessionId, context);
    driver.tapStatus = 'uncertain';
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, context), undefined, 'unknown');
    const fresh = await observe(h, view.sessionId, context);
    driver.tapStatus = 'completed';
    failure(await act(h, fresh, { kind: 'tap', ref: ref(fresh, 'help-open') }, context, true), 'session_stopped', 'unknown');
    await h.sessions.endScript(scriptId, 'completed');
    failure(await act(h, fresh, { kind: 'tap', ref: ref(fresh, 'help-open') }, undefined, true), 'session_stopped', 'unknown');
    assert.equal(driver.called('tap').length, 1);
    assert.deepEqual(journal(h, view).filter((entry) => entry.kind === 'tap').map((entry) => [entry.phase, entry.status ?? null]), [['intent', null], ['outcome', 'uncertain']]);
    assert.equal((await status(h, view.sessionId)).state, 'unknown');
    assert.equal(summary(h, view).tests[0]!.verdict, 'ERROR');
    assert.equal(h.held.size, 1);
  });

  it('revokes cancellation synchronously before dispatch, including later calls that omit the cancelled signal', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, [view.sessionId]);
    const controller = new AbortController();
    const context = { scriptId, allowedSessionIds: [view.sessionId], signal: controller.signal };
    const before = await observe(h, view.sessionId, context);
    h.drivers[0]!.elementIdAt = async (point) => {
      controller.abort(new Error('Synthetic cancellation'));
      h.sessions.stopScript(scriptId, 'Synthetic cancellation');
      return `element:${point.x}:${point.y}`;
    };
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, context, true), undefined, 'not_started');
    const caughtContext = { scriptId, allowedSessionIds: [view.sessionId] };
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, caughtContext, true), undefined, 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'tap').length, 0);
    await h.sessions.endScript(scriptId, 'cancelled');
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
    assert.equal(h.held.size, 1);
  });

  it('retains in-flight uncertainty and the lease when cancellation races a late completed driver response', async (t) => {
    const h = setup(t);
    const view = await open(h);
    const driver = h.drivers[0]!;
    const scriptId = randomUUID();
    await h.sessions.beginScript(scriptId, [view.sessionId]);
    const context = { scriptId, allowedSessionIds: [view.sessionId] };
    const before = await observe(h, view.sessionId, context);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<ActionOutcome>();
    const originalTap = driver.tap.bind(driver);
    driver.tap = async (point) => {
      await originalTap(point);
      entered.resolve();
      return released.promise;
    };
    const pending = act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, context, true);
    try {
      await Promise.race([entered.promise, pending.then((reply) => assert.fail(`Action ended before physical dispatch: ${JSON.stringify(reply)}`))]);
      h.sessions.stopScript(scriptId, 'Cancelled while physical input was in flight');
      assert.equal((await status(h, view.sessionId)).state, 'unknown');
      failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }, context), 'UNKNOWN_OUTCOME', 'unknown');
      assert.equal(h.held.size, 1);
    } finally {
      released.resolve({ status: 'completed', ms: 5 });
      await pending;
    }
    failure(await pending, undefined, 'unknown');
    await h.sessions.endScript(scriptId, 'cancelled');
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, undefined, true), 'session_stopped', 'unknown');
    assert.equal(driver.called('tap').length, 1);
    assert.equal((await status(h, view.sessionId)).state, 'unknown');
    assert.equal(h.held.size, 1);
  });

  it('never releases or retries an unconfirmed close, including shutdown and a new open attempt', async (t) => {
    const h = setup(t, { expectUnconfirmedShutdown: true });
    const view = await open(h);
    const driver = h.drivers[0]!;
    driver.closeError = new Error('DELETE session response lost');
    failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }), 'UNKNOWN_OUTCOME', 'unknown');
    assert.equal((await status(h, view.sessionId)).state, 'unknown');
    assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'unknown']);
    assert.equal(h.held.size, 1);
    failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }), 'UNKNOWN_OUTCOME', 'unknown');
    failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: driver.deviceId }), undefined, 'not_started');
    assert.equal(driver.called('open').length, 1);
    await assert.rejects(h.sessions.shutdown(), AggregateError);
    assert.equal(driver.called('close').length, 1);
    assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'unknown']);
    assert.equal(h.held.size, 1);
    const recorded = JSON.parse(readFileSync(join(runDir(h, view), 'session.json'), 'utf8')) as AgentSessionView;
    assert.equal(recorded.state, 'unknown');
    assert.equal(summary(h, view).tests[0]!.verdict, 'ERROR');
  });

  for (const proven of [false, true]) {
    it(`${proven ? 'releases a proven pre-open rejection' : 'retains an uncertain open lease'} without launching or reporting business PASS`, async (t) => {
      const openError = new Error(proven ? 'Session creation rejected before dispatch' : 'Session creation response lost');
      const h = setup(t, { provenRejected: proven ? openError : undefined });
      const driver = h.drivers[0]!;
      driver.openError = openError;
      failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: driver.deviceId }), proven ? 'session_start_rejected' : 'UNKNOWN_OUTCOME', proven ? 'not_started' : 'unknown');
      assert.equal(driver.called('open').length, 1);
      assert.equal(driver.called('launch').length, 0);
      assert.equal(h.held.size, proven ? 0 : 1);
      const views = success<AgentSessionView[]>(await h.sessions.call({ method: 'session.list' }));
      assert.equal(views[0]!.state, proven ? 'closed' : 'unknown');
      assert.equal(summary(h, views[0]!).tests[0]!.verdict, 'ERROR');
    });
  }

  it('converts approved screenshot pixels to the observed tap space and checks the actual input point', async (t) => {
    const h = setup(t, { coordinates: true });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    const candidate = before.candidates.find((item) => item.resourceId === 'help-open')!;
    const x = candidate.tapPoint.x * before.screenshot.scaleX;
    const y = candidate.tapPoint.y * before.screenshot.scaleY;
    const result = success<AgentActionResult>(await act(h, before, { kind: 'tapAt', x, y, units: 'screenshot-px' }, undefined, true));
    assert.equal(result.effect, 'completed');
    assert.deepEqual(h.drivers[0]!.called('tap').map((call) => call.args[0]), [candidate.tapPoint]);
    assert.deepEqual(h.drivers[0]!.called('isHittable').at(-1)!.args, [candidate.tapPoint, null]);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'tapAt' && entry.phase === 'intent').length, 1);
    assert.equal(summary(h, view).tests[0]!.code, 'business_assertion_missing');
  });

  it('refuses coordinates when the pixels changed even if labels, boxes, and revision stayed the same', async (t) => {
    const h = setup(t, { coordinates: true });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    const candidate = before.candidates.find((item) => item.resourceId === 'help-open')!;
    const driver = h.drivers[0]!;
    driver.screen = { ...driver.screen, screenshotPng: help().screenshotPng };
    failure(await act(h, before, { kind: 'tapAt', ...candidate.tapPoint, units: 'tap' }, undefined, true), 'stale_frame', 'not_started');
    assert.equal(driver.called('tap').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'tapAt').length, 0);
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
  });

  it('refuses coordinate input without the separate coordinate grant even when tapAt is listed', async (t) => {
    const h = setup(t, { coordinates: false });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    assert.equal(before.capabilities.coordinates, false);
    failure(await act(h, before, { kind: 'tapAt', x: 20, y: 20, units: 'tap' }, undefined, true), undefined, 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'tapAt').length, 0);
  });

  it('does not let an explicit coordinate grant bypass a destructive screen', async (t) => {
    const h = setup(t, { coordinates: true, screens: [index([['text="상품 3개"', 'text="정말 삭제하시겠습니까? 되돌릴 수 없습니다."']])] });
    const view = await open(h);
    const before = await observe(h, view.sessionId);
    const target = before.candidates.find((candidate) => candidate.resourceId === 'help-open')!;
    failure(await act(h, before, { kind: 'tapAt', ...target.tapPoint, units: 'tap' }, undefined, true), 'blocked_by_policy', 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
    assert.equal(journal(h, view).filter((entry) => entry.kind === 'tapAt').length, 0);
    assert.equal((await status(h, view.sessionId)).state, 'stopped');
  });

  it('releases a lease when required persistence fails before the driver is opened', async (t) => {
    let directory: string | undefined;
    const h = setup(t, { onAcquire: (root, runId) => {
      directory = join(root, '.qa', 'runs', runId);
      chmodSync(directory, 0o500);
    } });
    try {
      failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: h.drivers[0]!.deviceId }), 'evidence_unavailable', 'not_started');
      assert.equal(h.drivers[0]!.called('open').length, 0);
      assert.equal(h.drivers[0]!.called('launch').length, 0);
      assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'ended']);
      assert.equal(h.held.size, 0);
      const views = success<AgentSessionView[]>(await h.sessions.call({ method: 'session.list' }));
      assert.equal(views[0]!.state, 'closed');
    } finally { if (directory) chmodSync(directory, 0o700); }
  });

  it('quarantines a confirmed native close when required evidence cannot be finalized', async (t) => {
    const h = setup(t, { expectUnconfirmedShutdown: true });
    const view = await open(h);
    const driver = h.drivers[0]!;
    const original = driver.close.bind(driver);
    driver.close = async () => { await original(); chmodSync(runDir(h, view), 0o500); };
    try {
      failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }), 'evidence_unavailable', 'unknown');
      assert.equal((await status(h, view.sessionId)).state, 'unknown');
      assert.deepEqual(h.leases.map((event) => event.kind), ['acquire', 'unknown']);
      assert.equal(h.leases.at(-1)!.reason, 'evidence_finalization_unconfirmed');
      assert.equal(h.held.size, 1);
      assert.equal(h.admission.status().state, 'unknown');
      failure(await h.sessions.call({ method: 'session.close', sessionId: view.sessionId }), 'UNKNOWN_OUTCOME', 'unknown');
      failure(await h.sessions.call({ method: 'session.open', app: APP, platform: PLATFORM, deviceId: driver.deviceId }), undefined, 'not_started');
      assert.equal(driver.called('close').length, 1);
      assert.equal(driver.called('open').length, 1);
    } finally { chmodSync(runDir(h, view), 0o700); }
  });

});

function worker(t: TestContext, h: Harness): AgentScripts {
  const scripts = createAgentScripts(h.sessions, { root: h.root });
  t.after(async () => { await scripts.shutdown(); });
  return scripts;
}

function runCode(scripts: AgentScripts, sessionIds: string[], source: string, options: {
  scriptId?: string; language?: 'javascript' | 'typescript'; deadlineMs?: number; maxOutputBytes?: number;
} = {}): Promise<AgentReply> {
  return scripts.call({
    method: 'script.run', scriptId: options.scriptId ?? randomUUID(), source, sessionIds,
    language: options.language ?? 'javascript', deadlineMs: options.deadlineMs ?? 5000, maxOutputBytes: options.maxOutputBytes ?? 65_536,
  });
}
function assertSourceDisposed(h: Harness, result: AgentScriptView, source: string): void {
  const directory = join(h.root, '.qa', 'agent-scripts', result.scriptId);
  assert.equal(existsSync(join(directory, 'script.mjs')), false);
  assert.equal(existsSync(join(directory, 'script.mts')), false);
  const stored = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'));
  assert.equal(stored.sourceSha256, sha256(source));
  assert.equal(textEvidence(directory).includes(source), false);
}

function seedScriptSource(h: Harness, options: { language?: 'javascript' | 'typescript'; legacy?: boolean; completed?: boolean } = {}) {
  const scriptId = randomUUID();
  const source = `export default async function () { return 'private-script-marker-9a7'; }`;
  const directory = join(h.root, '.qa', 'agent-scripts', scriptId);
  const sourceFile = options.language === 'typescript' ? 'script.mts' : 'script.mjs';
  writeSecure(join(directory, sourceFile), source);
  const view: AgentScriptView = {
    scriptId, sessionIds: [randomUUID()], state: options.completed ? 'completed' : 'running',
    startedAt: new Date().toISOString(), endedAt: options.completed ? new Date().toISOString() : null,
    stdout: 'original safe diagnostic', stderr: '', result: options.completed ? { original: true } : null, error: null,
    trustBoundary: 'authorized-test-code-not-malicious-code-sandbox',
  };
  const stored = { schema: options.legacy ? 'app-qa/script/v1' : 'app-qa/script/v2', owner: randomUUID(), sourceSha256: sha256(source), view,
    ...(options.legacy ? {} : { sourceFile, sourceDisposedAt: null }) };
  writeJsonAtomic(join(directory, 'status.json'), stored);
  return { directory, source, sourceFile, scriptId, stored };
}


describe('authorized worker lifecycle through TestSession', { skip: process.platform !== 'darwin' }, () => {
  it('preserves complete pipe output at done and never replays a duplicate bundle', { timeout: 15_000 }, async (t) => {
    const h = setup(t);
    const view = await open(h);
    h.drivers[0]!.onTap = () => help();
    const scripts = worker(t, h);
    const scriptId = randomUUID();
    const source = `export default async function (qa) {
      const session = qa.session(qa.sessionIds[0]);
      const before = await session.observe();
      const target = before.candidates.find(candidate => candidate.resourceId === 'help-open');
      if (!target) throw new Error('Missing fixture control');
      await session.tap(target.ref);
      await session.assertText(${JSON.stringify(HELP_TEXT)});
      for (let i = 0; i < 6000; i++) process.stdout.write('row:' + i + ':' + '.'.repeat(64) + '\\n');
    }`;
    const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source, { scriptId, maxOutputBytes: 1_048_576 }));
    assert.equal(result.state, 'completed', JSON.stringify(result));
    const expected = Array.from({ length: 6000 }, (_, i) => `row:${i}:${'.'.repeat(64)}\n`).join('');
    assert.equal(result.stdout, expected);
    assert.equal(summary(h, view).tests[0]!.verdict, 'PASS');
    assert.equal(h.drivers[0]!.called('tap').length, 1);
    assertSourceDisposed(h, result, source);
    failure(await runCode(scripts, [view.sessionId], source, { scriptId }), 'duplicate_script', 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 1);
  });

  it('executes typed TypeScript with literal strings and masks its output and nested keys', { timeout: 10_000 }, async (t) => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    const literal = '${HOME}/${QAUTRA_UNSET_FIXTURE}';
    const types = pathToFileURL(join(ROOT, 'src', 'core', 'agent-client.ts')).href;
    const source = `import type { AgentScriptClient } from ${JSON.stringify(types)};
      export default async function (qa: AgentScriptClient) {
        const text: string = ${JSON.stringify(literal)};
        const session = qa.session(qa.sessionIds[0]!);
        const before = await session.observe();
        const target = before.candidates.find(candidate => candidate.resourceId === 'query');
        if (!target) throw new Error('Missing fixture field');
        await session.type(target.ref, text, { expectNoChange: true });
        console.log(text);
        return { [text]: { value: text } };
      }`;
    const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source, { language: 'typescript' }));
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.deepEqual(h.drivers[0]!.called('typeText').map((call) => call.args[1]), [literal]);
    assert.ok(!JSON.stringify(result).includes(literal));
    assert.ok(!textEvidence(runDir(h, view)).includes(literal));
    assertSourceDisposed(h, result, source);
    assert.equal(textEvidence(join(h.root, '.qa', 'agent-scripts')).includes(literal), false);
    assert.equal(summary(h, view).tests[0]!.verdict, 'INCONCLUSIVE');
  });

  it('revokes later mutation after excessive stdout without returning the unbounded payload', { timeout: 10_000 }, async (t) => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    const source = `export default async function () {
      process.stdout.write('x'.repeat(100000));
      await new Promise(() => {});
    }`;
    const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source, { maxOutputBytes: 1024 }));
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.equal(result.error?.code, 'output_limit');
    assert.equal(result.error?.effect, 'not_started');
    assert.equal(result.stdout, '');
    assertSourceDisposed(h, result, source);
    const before = await observe(h, view.sessionId);
    failure(await act(h, before, { kind: 'tap', ref: ref(before, 'help-open') }, undefined, true), 'session_stopped', 'not_started');
    assert.equal(h.drivers[0]!.called('tap').length, 0);
  });

  it('bounds a CPU-bound bundle without stopping another session', { timeout: 10_000 }, async (t) => {
    const h = setup(t, { screens: nativeScreens() });
    const first = await open(h);
    const second = await open(h, 1);
    const scripts = worker(t, h);
    const source = `export default async function () {
      const end = Date.now() + 3000;
      while (Date.now() < end) {}
    }`;
    const pending = runCode(scripts, [first.sessionId], source, { deadlineMs: 500 });
    assert.equal((await status(h, second.sessionId)).state, 'ready');
    const other = await observe(h, second.sessionId);
    assert.equal(other.sessionId, second.sessionId);
    const result = success<AgentScriptView>(await pending);
    assert.equal(result.state, 'cancelled', JSON.stringify(result));
    assert.equal(result.error?.code, 'deadline_exceeded');
    assertSourceDisposed(h, result, source);
    assert.equal((await status(h, first.sessionId)).state, 'stopped');
    assert.equal((await status(h, second.sessionId)).state, 'ready');
    assert.ok(h.drivers.every((driver) => driver.called('tap').length === 0));
  });

  it('settles completion and retains the completed effect when post-input evidence cannot be written', { timeout: 10_000 }, async (t) => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    h.drivers[0]!.onTap = () => { chmodSync(runDir(h, view), 0o500); return help(); };
    try {
      const source = `export default async function (qa) {
        const session = qa.session(qa.sessionIds[0]);
        const before = await session.observe();
        const target = before.candidates.find(candidate => candidate.resourceId === 'help-open');
        if (!target) throw new Error('Missing fixture control');
        await session.tap(target.ref);
        await session.tap(target.ref);
      }`;
      const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source));
      assert.equal(result.state, 'failed', JSON.stringify(result));
      assert.equal(result.error?.effect, 'completed');
      assert.equal(h.drivers[0]!.called('tap').length, 1);
      assert.equal((await status(h, view.sessionId)).state, 'stopped');
      const persisted = success<AgentScriptView>(await scripts.call({ method: 'script.status', scriptId: result.scriptId }));
      assert.equal(persisted.state, 'failed');
      assert.equal(persisted.error?.effect, 'completed');
      assertSourceDisposed(h, result, source);
    } finally { chmodSync(runDir(h, view), 0o700); }
  });

  it('removes source after a real worker throws following a confidential input', { timeout: 10_000 }, async t => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    const secret = 'worker-private-value-19a';
    const source = `export default async function (qa) {
      const session = qa.session(qa.sessionIds[0]);
      const before = await session.observe();
      const target = before.candidates.find(candidate => candidate.resourceId === 'query');
      if (!target) throw new Error('Missing fixture field');
      const text = ${JSON.stringify(secret)};
      await session.type(target.ref, text, { secure: true, expectNoChange: true });
      throw new Error(text);
    }`;
    const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source));
    assert.equal(result.state, 'failed');
    assert.equal(result.error?.code, 'script_error');
    assert.equal(result.error?.effect, 'completed');
    assert.equal(h.drivers[0]!.called('typeText').length, 1);
    assertSourceDisposed(h, result, source);
    assert.equal(textEvidence(join(h.root, '.qa', 'agent-scripts')).includes(secret), false);
  });

  it('disposes staged source when session reservation fails before a worker starts', async t => {
    const h = setup(t);
    const scripts = worker(t, h);
    const source = `export default async function () { return 'private-startup-value-71a'; }`;
    const result = success<AgentScriptView>(await runCode(scripts, [randomUUID()], source));
    assert.equal(result.state, 'failed');
    assert.equal(result.error?.code, 'worker_start_failed');
    assert.equal(result.error?.effect, 'not_started');
    assertSourceDisposed(h, result, source);
    assert.deepEqual(h.creations, []);
  });

  it('disposes cancelled source without clearing an in-flight mutation or retrying its late response', { timeout: 15_000 }, async t => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    const driver = h.drivers[0]!;
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<ActionOutcome>();
    const tap = driver.tap.bind(driver);
    driver.tap = async point => { await tap(point); entered.resolve(); return released.promise; };
    const scriptId = randomUUID();
    const source = `export default async function (qa) {
      const session = qa.session(qa.sessionIds[0]);
      const before = await session.observe();
      const target = before.candidates.find(candidate => candidate.resourceId === 'help-open');
      if (!target) throw new Error('Missing fixture control');
      await session.tap(target.ref);
    }`;
    const pending = runCode(scripts, [view.sessionId], source, { scriptId });
    try {
      await Promise.race([entered.promise, pending.then(reply => assert.fail(`Worker ended before dispatch: ${JSON.stringify(reply)}`))]);
      const cancelled = scripts.call({ method: 'script.cancel', scriptId });
      assert.equal((await status(h, view.sessionId)).state, 'unknown');
      released.resolve({ status: 'completed', ms: 5 });
      const result = success<AgentScriptView>(await cancelled);
      await pending;
      assert.equal(result.state, 'unknown');
      assert.equal(result.error?.effect, 'unknown');
      assertSourceDisposed(h, result, source);
      assert.equal((await status(h, view.sessionId)).state, 'unknown');
      assert.equal(driver.called('tap').length, 1);
      assert.equal(h.held.size, 1);
    } finally { released.resolve({ status: 'completed', ms: 5 }); await pending; }
  });

  it('surfaces source removal failure and preserves uncertainty after later source-only reconciliation', { timeout: 10_000 }, async t => {
    const h = setup(t);
    const view = await open(h);
    const scripts = worker(t, h);
    const scriptId = randomUUID();
    const directory = join(h.root, '.qa', 'agent-scripts', scriptId);
    h.drivers[0]!.onTap = () => { chmodSync(directory, 0o500); return help(); };
    const source = `export default async function (qa) {
      const session = qa.session(qa.sessionIds[0]);
      const before = await session.observe();
      const target = before.candidates.find(candidate => candidate.resourceId === 'help-open');
      if (!target) throw new Error('Missing fixture control');
      await session.tap(target.ref);
    }`;
    try {
      const result = success<AgentScriptView>(await runCode(scripts, [view.sessionId], source, { scriptId }));
      assert.equal(result.state, 'failed');
      assert.equal(result.error?.code, 'source_disposal_failed');
      assert.equal(result.error?.effect, 'completed');
      assert.equal(existsSync(join(directory, 'script.mjs')), true);
      failure(await runCode(scripts, [view.sessionId], source), 'source_reconciliation_required', 'not_started');
      assert.equal(h.drivers[0]!.called('tap').length, 1);
    } finally { chmodSync(directory, 0o700); }
    await scripts.shutdown();
    const restarted = worker(t, h);
    const original = success<AgentScriptView>(await restarted.call({ method: 'script.status', scriptId }));
    assert.equal(original.state, 'unknown');
    assert.equal(original.error?.effect, 'unknown');
    assertSourceDisposed(h, original, source);
    assert.equal(h.drivers[0]!.called('tap').length, 1);
  });

});

describe('script source-only restart reconciliation', () => {
  for (const language of ['javascript', 'typescript'] as const) it(`removes an abandoned ${language} source without replaying or claiming native completion`, async t => {
    const h = setup(t);
    const seeded = seedScriptSource(h, { language });
    const scripts = worker(t, h);
    const result = success<AgentScriptView>(await scripts.call({ method: 'script.status', scriptId: seeded.scriptId }));
    assert.equal(result.state, 'unknown');
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.error?.effect, 'unknown');
    assertSourceDisposed(h, result, seeded.source);
    const stored = JSON.parse(readFileSync(join(seeded.directory, 'status.json'), 'utf8'));
    assert.deepEqual(stored.view, seeded.stored.view);
    assert.equal(stored.owner, seeded.stored.owner);
    assert.deepEqual(h.creations, []);
    assert.deepEqual(h.leases, []);
  });

  it('leaves source untouched while another manager owns its actual file mutex', async t => {
    const h = setup(t);
    const seeded = seedScriptSource(h);
    const lease = acquireFileLock(join(seeded.directory, 'source.lock'), { purpose: 'live source producer' });
    try {
      const scripts = worker(t, h);
      const result = success<AgentScriptView>(await scripts.call({ method: 'script.status', scriptId: seeded.scriptId }));
      assert.equal(result.state, 'unknown');
      assert.equal(readFileSync(join(seeded.directory, seeded.sourceFile), 'utf8'), seeded.source);
      assert.deepEqual(JSON.parse(readFileSync(join(seeded.directory, 'status.json'), 'utf8')), seeded.stored);
    } finally { lease.release(); }
  });

  it('disposes an unambiguous terminal legacy source without changing its original result or metadata', async t => {
    const h = setup(t);
    const seeded = seedScriptSource(h, { legacy: true, completed: true });
    const scripts = worker(t, h);
    const result = success<AgentScriptView>(await scripts.call({ method: 'script.status', scriptId: seeded.scriptId }));
    assert.deepEqual(result, seeded.stored.view);
    assert.equal(existsSync(join(seeded.directory, seeded.sourceFile)), false);
    assert.deepEqual(JSON.parse(readFileSync(join(seeded.directory, 'status.json'), 'utf8')), seeded.stored);
    assert.deepEqual(h.creations, []);
  });

  for (const unsafe of ['changed digest', 'symbolic link', 'ambiguous legacy language', 'unproven legacy owner'] as const) {
    it(`preserves ${unsafe} and blocks new code instead of deleting or replaying it`, async t => {
      const h = setup(t);
      const legacy = unsafe === 'ambiguous legacy language' || unsafe === 'unproven legacy owner';
      const seeded = seedScriptSource(h, { legacy, completed: unsafe !== 'unproven legacy owner' });
      writeSecure(join(seeded.directory, 'unrelated.txt'), 'unrelated retained evidence');
      if (unsafe === 'changed digest') writeSecure(join(seeded.directory, seeded.sourceFile), 'foreign source generation');
      else if (unsafe === 'symbolic link') {
        const target = join(h.root, 'unrelated-target.txt');
        writeSecure(target, 'unrelated target must remain');
        symlinkSync(target, join(seeded.directory, 'script.mts'));
        const stored = { ...seeded.stored, sourceFile: 'script.mts' };
        writeJsonAtomic(join(seeded.directory, 'status.json'), stored);
      } else if (unsafe === 'ambiguous legacy language') writeSecure(join(seeded.directory, 'script.mts'), seeded.source);
      const before = readFileSync(join(seeded.directory, 'status.json'), 'utf8');
      const scripts = worker(t, h);
      failure(await scripts.call({ method: 'script.status', scriptId: seeded.scriptId }), 'source_disposal_failed', 'unknown');
      failure(await runCode(scripts, [randomUUID()], `export default async function () {}`), 'source_reconciliation_required', 'not_started');
      assert.equal(readFileSync(join(seeded.directory, 'status.json'), 'utf8'), before);
      assert.equal(readFileSync(join(seeded.directory, 'unrelated.txt'), 'utf8'), 'unrelated retained evidence');
      assert.equal(existsSync(join(seeded.directory, seeded.sourceFile)), true);
      if (unsafe === 'symbolic link') {
        assert.equal(lstatSync(join(seeded.directory, 'script.mts')).isSymbolicLink(), true);
        assert.equal(readFileSync(join(h.root, 'unrelated-target.txt'), 'utf8'), 'unrelated target must remain');
      }
      assert.deepEqual(h.creations, []);
      assert.deepEqual(h.leases, []);
    });
  }
});
