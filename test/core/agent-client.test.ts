import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AgentClientError, answersRequest, createAgentClient } from '../../src/core/agent-client.ts';
import { AgentRequestSchema, type AgentActionResult, type AgentObservation, type AgentReply, type AgentRequestInput } from '../../src/core/agent.ts';

function observation(sessionId: string, revision: number): AgentObservation {
  return {
    sessionId, revision, at: new Date().toISOString(), screen: { x: 0, y: 0, width: 100, height: 100 }, texts: ['Ready'], truncated: false,
    coverage: { spatial: 'desktop-viewport', text: 'normalized-visible-text', wholePage: false, allRenderedSurfaces: false },
    candidates: [{ ref: `${sessionId}-${revision}`, resourceId: 'field', name: 'Name', role: 'input', value: null, state: [], rect: { x: 0, y: 0, width: 10, height: 10 }, tapPoint: { x: 5, y: 5 }, actionable: true, region: 'top', source: 'tree' }],
    screenshot: { path: 'screen.png', sha256: 'hash', width: 200, height: 200, scaleX: 2, scaleY: 2, privacy: 'raw-pixels-approved-fixture-only' },
    capabilities: { semantic: true, coordinates: true, coordinateSpace: 'css-px', hostGlobalInput: true, webview: false, recording: false, mutationKinds: ['tap', 'type', 'clear', 'tapAt'], modelRequired: false, isolation: 'exclusive-host-display' },
  };
}
const reply = (result: unknown): AgentReply => ({ ok: true, result, meta: { requestId: randomUUID(), at: new Date().toISOString() } });


test('each explicit facade owns its revision and never auto-observes or refreshes stale references', async () => {
  const a = randomUUID();
  const b = randomUUID();
  const revisions = new Map<string, number>([[a, 0], [b, 0]]);
  const calls: AgentRequestInput[] = [];
  const client = createAgentClient(async (request) => {
    calls.push(request);
    if (!('sessionId' in request)) throw new Error('Unexpected request');
    const revision = revisions.get(request.sessionId)!;
    if (request.method === 'session.observe' || request.method === 'session.screenshot') {
      revisions.set(request.sessionId, revision + 1);
      return reply(observation(request.sessionId, revision + 1));
    }
    if (request.method === 'session.act') {
      if (request.revision !== revision) return { ok: false, error: { code: 'stale_revision', message: 'Stale', effect: 'not_started' }, meta: { requestId: randomUUID(), at: new Date().toISOString() } };
      revisions.set(request.sessionId, revision + 1);
      return reply({ observation: observation(request.sessionId, revision + 1), effect: 'completed', step: { seq: 1, verdict: 'PASS', code: null, reason: 'Verified', evidenceDir: 'step-1' } } satisfies AgentActionResult);
    }
    throw new Error('Unexpected request');
  });
  const first = client.session(a);
  const second = client.session(b);
  const independent = client.session(a);
  await assert.rejects(first.tap('Name'), { code: 'observation_required' });
  assert.equal(calls.length, 0);
  const frame = await first.observe();
  await second.observe();
  await assert.rejects(independent.tap('Name'), { code: 'observation_required' });
  await assert.rejects(second.tap(frame.candidates[0]!.ref), { code: 'stale_ref' });
  await first.type('Name', '${NOT_AN_ENV_VAR}', { append: true });
  const typed = calls.find((call) => call.method === 'session.act');
  assert.ok(typed?.method === 'session.act' && typed.action.kind === 'type');
  assert.equal(typed.action.text, '${NOT_AN_ENV_VAR}');
  assert.equal(first.revision, 2);
  assert.equal(second.revision, 1);
  await assert.rejects(first.tap(frame.candidates[0]!.ref), { code: 'stale_ref' });
  await independent.observe();
  const before = calls.length;
  await assert.rejects(first.tap('Name'), { code: 'stale_revision' });
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)?.method, 'session.act');
  assert.equal(first.revision, 2);
});

test('SDK rejects ambiguous exact labels and never expands literal wait/assertion/type text', async () => {
  const id = randomUUID();
  const requests: AgentRequestInput[] = [];
  const frame = observation(id, 1);
  frame.candidates.push({ ...frame.candidates[0]!, ref: 'other-field' });
  const client = createAgentClient(async (request) => {
    requests.push(request);
    if (request.method === 'session.observe') return reply(frame);
    return reply({ observation: frame, effect: 'not_started', step: { seq: 1, verdict: 'PASS', code: 'ok', reason: 'Verified', evidenceDir: 'step-1' } });
  });
  const session = client.session(id);
  await session.observe();
  await assert.rejects(session.clear('Name'), { code: 'ambiguous_target' });
  await session.wait('${LITERAL}');
  await session.assertText('${LITERAL}');
  assert.ok(requests.some((r) => r.method === 'session.wait' && r.text === '${LITERAL}'));
  assert.ok(requests.some((r) => r.method === 'session.act' && r.action.kind === 'assertText' && r.action.text === '${LITERAL}'));
});

test('SDK assigns independent script identities and refuses cancellation before dispatch without retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const ids: string[] = [];
  const client = createAgentClient(async (request) => {
    calls++;
    if (request.method !== 'script.run') throw new Error('Unexpected request');
    ids.push(request.scriptId);
    return reply({ scriptId: request.scriptId, sessionIds: request.sessionIds, state: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stdout: '', stderr: '', result: null, error: null, trustBoundary: 'authorized-test-code-not-malicious-code-sandbox' });
  });
  await client.runScript({ source: 'return 1', sessionIds: [randomUUID()] }, controller.signal);
  await client.runScript({ source: 'return 2', sessionIds: [randomUUID()] }, controller.signal);
  assert.notEqual(ids[0], ids[1]);
  controller.abort();
  await assert.rejects(client.runScript({ source: 'return 3', sessionIds: [randomUUID()] }, controller.signal), { code: 'cancelled', effect: 'not_started' });
  assert.equal(calls, 2);
});

for (const method of ['session.observe', 'session.screenshot', 'session.status', 'session.list', 'session.wait', 'session.act', 'script.status'] as const) {
  test(`SDK rejects malformed ${method} success instead of exposing an unchecked result`, async () => {
    const id = randomUUID();
    const request: AgentRequestInput = method === 'session.list' ? { method }
      : method === 'script.status' ? { method, scriptId: id }
      : method === 'session.wait' ? { method, sessionId: id, text: 'Ready' }
      : method === 'session.act' ? { method, sessionId: id, revision: 1, action: { kind: 'tap', ref: 'field' } }
      : { method, sessionId: id };
    let calls = 0;
    const client = createAgentClient(async () => { calls++; return reply(null); });
    await assert.rejects(client.request(request), error => error instanceof AgentClientError && error.code === 'invalid_response' && error.effect === 'unknown');
    assert.equal(calls, 1);
  });
}

test('SDK validates published regression run replies and rejects a drifted attempt record without retrying', async () => {
  const requestId = randomUUID(), at = new Date().toISOString(), digest = 'a'.repeat(64);
  const target = { platform: 'desktop-chrome' as const, deviceId: 'chrome:owned' };
  const run = {
    schema: 'qautra/regression-run/v1', requestId, fingerprint: digest, name: 'checkout', createdAt: at, updatedAt: at, state: 'finished',
    revisionIds: [digest], targets: [target], authorizations: [{ appId: 'shop', target, grantId: 'grant-1', subjectSha256: digest }], evidence: 'required-video',
    attempts: [{
      attemptId: randomUUID(), revisionId: digest, testId: 'checkout', target, authorization: { appId: 'shop', target, grantId: 'grant-1', subjectSha256: digest },
      state: 'finished', runId: 'run-1', business: 'PASS', evidence: 'ready', cleanup: 'confirmed', requiredChecks: ['checkout:steps[0]'], completedChecks: ['checkout:steps[0]'], code: null, message: null,
    }],
    stopRequested: false, code: null, message: null,
  };
  let calls = 0;
  const valid = createAgentClient(async () => { calls++; return reply(run); });
  assert.equal((await valid.request({ method: 'regression.status', requestId })).attempts[0]!.cleanup, 'confirmed');
  const { cleanup: _dropped, ...drifted } = run.attempts[0]!;
  const invalid = createAgentClient(async () => { calls++; return reply({ ...run, attempts: [drifted] }); });
  await assert.rejects(invalid.request({ method: 'regression.status', requestId }), error => error instanceof AgentClientError && error.code === 'invalid_response' && error.effect === 'unknown');
  assert.equal(calls, 2);
});

test('SDK rejects a schema-valid reply about another run than the one requested', async () => {
  const requestId = randomUUID(), other = randomUUID(), at = new Date().toISOString(), digest = 'a'.repeat(64);
  const target = { platform: 'desktop-chrome' as const, deviceId: 'chrome:owned' };
  const authorization = { appId: 'shop', target, grantId: 'grant-1', subjectSha256: digest };
  const run = {
    schema: 'qautra/regression-run/v1', requestId: other, fingerprint: digest, name: 'other', createdAt: at, updatedAt: at, state: 'finished',
    revisionIds: [digest], targets: [target], authorizations: [authorization], evidence: 'required-video',
    attempts: [{
      attemptId: randomUUID(), revisionId: digest, testId: 'checkout', target, authorization,
      state: 'finished', runId: 'run-1', business: 'PASS', evidence: 'ready', cleanup: 'confirmed', requiredChecks: ['checkout:steps[0]'], completedChecks: ['checkout:steps[0]'], code: null, message: null,
    }],
    stopRequested: false, code: null, message: null,
  };
  let calls = 0;
  const client = createAgentClient(async () => { calls++; return reply(run); });
  for (const method of ['regression.status', 'regression.stop'] as const) {
    await assert.rejects(client.request({ method, requestId }), error => error instanceof AgentClientError && error.code === 'invalid_response' && error.effect === 'unknown');
  }
  assert.equal((await client.request({ method: 'regression.status', requestId: other })).requestId, other);
  assert.equal(calls, 3);
});

test('every identity-bearing method rejects a reply naming a different identity, field by field', () => {
  const [a, b, p] = [randomUUID(), randomUUID(), randomUUID()];
  const [d1, d2] = ['1'.repeat(64), '2'.repeat(64)];
  const cases: [AgentRequestInput, Record<string, unknown>, Record<string, unknown>][] = [
    [{ method: 'session.open', app: 'shop', platform: 'desktop-chrome', deviceId: 'chrome:a' }, { app: 'shop', platform: 'desktop-chrome', deviceId: 'chrome:a' }, { app: 'shop', platform: 'desktop-chrome', deviceId: 'chrome:b' }],
    [{ method: 'session.status', sessionId: a }, { sessionId: a }, { sessionId: b }],
    [{ method: 'session.wait', sessionId: a, text: 'Ready' }, { observation: { sessionId: a } }, { observation: { sessionId: b } }],
    [{ method: 'script.status', scriptId: a }, { scriptId: a }, { scriptId: b }],
    [{ method: 'instance.stop', instanceId: a }, { id: a }, { id: b }],
    [{ method: 'instance.create', requestId: a, profileId: p, name: 'guest' }, { profileId: p }, { profileId: b }],
    [{ method: 'scenario.get', revisionId: d1 }, { revisionId: d1 }, { revisionId: d2 }],
    [{ method: 'scenario.origin', revisionId: d1, testId: 'checkout' }, { revisionId: d1, testId: 'checkout' }, { revisionId: d1, testId: 'refund' }],
    [{ method: 'scenario.publish', candidateId: a, digest: d1, reviewedChecks: ['c'] }, { review: { candidateId: a, digest: d1 } }, { review: { candidateId: a, digest: d2 } }],
    [{ method: 'regression.status', requestId: a }, { requestId: a }, { requestId: b }],
    [{ method: 'regression.compare', before: a, after: b }, { before: a, after: b }, { before: b, after: a }],
  ];
  for (const [input, same, other] of cases) {
    const request = AgentRequestSchema.parse(input);
    assert.equal(answersRequest(request, same), true, `${request.method} accepts its own identity`);
    assert.equal(answersRequest(request, other), false, `${request.method} rejects another identity`);
  }
});

test('an invalid action receipt cannot poison the remembered revision or trigger a retry', async () => {
  const id = randomUUID();
  const calls: string[] = [];
  const client = createAgentClient(async request => {
    calls.push(request.method);
    if (request.method === 'session.observe') return reply(observation(id, 1));
    return reply({ observation: observation(id, 2), effect: 'completed', step: { seq: -1, verdict: 'PASS', code: 'ok', reason: 'Untrusted receipt', evidenceDir: 'step-1' } });
  });
  const session = client.session(id);
  await session.observe();
  await assert.rejects(session.tap('Name'), error => error instanceof AgentClientError && error.code === 'invalid_response' && error.effect === 'unknown');
  assert.equal(session.revision, 1);
  assert.deepEqual(calls, ['session.observe', 'session.act']);
});
