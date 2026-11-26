import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { ProjectFixtureError, projectFixtureCanonical, type ProjectFixtureAdapter, type ProjectFixtureNativeIdentity, type ProjectFixtureNativeBootstrap } from '../../src/core/project-fixture.ts';
import { createNativeFixtureClientAuthority, nativeFixtureClientHandler } from '../../src/runner/native-fixture-client.ts';
import { createProjectFixtureGuard, createProjectFixtureRecoveryObserver } from '../../src/runner/project-fixture.ts';
import { regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { fixture, tap } from '../fixtures/project-fixture.ts';

async function nativeFixture(t: TestContext, platform: 'android' | 'ios' = 'android') {
  const f = await fixture(t);
  const nativeClient: ProjectFixtureNativeIdentity = { platform, deviceId: 'dedicated-device', applicationId: 'qa.example.shop', buildSha256: '1'.repeat(64), sessionId: 'actual-appium-session' };
  f.subject.target = { platform, deviceId: nativeClient.deviceId };
  f.subject.origins = [];
  f.subject.applicationId = nativeClient.applicationId;
  f.evidence.subject = structuredClone(f.subject);
  f.adapter.subjectSha256 = regressionGrantSubjectSha256(f.subject);
  f.save();
  const adapter: ProjectFixtureAdapter = { ...f.adapter, bootstrap: { kind: 'native-private-mailbox', applicationId: nativeClient.applicationId, buildSha256: nativeClient.buildSha256, mailbox: 'qautra-fixture', clientEndpoint: 'https://qa.example.test/client' } };
  writeFileSync(f.adapterFile, JSON.stringify({ schema: 'qautra/project-fixture-policy/v1', adapters: [adapter] }), { mode: 0o600 });
  const appCredential = randomBytes(32).toString('hex');
  const authority = createNativeFixtureClientAuthority({ receiptKey: process.env[f.keyName]!, principal: { clientAuthorityId: 'client-authority-1', principalRef: 'dedicated-qa-principal', accountRef: f.subject.scope.accountRef, tenant: f.subject.scope.tenant, credentialSha256: createHash('sha256').update(appCredential).digest('hex'), platform, deviceId: nativeClient.deviceId, applicationId: nativeClient.applicationId, buildSha256: nativeClient.buildSha256 } });
  f.state.enforcementAdapter = adapter;
  f.state.fault = envelope => { if (envelope.receipt.phase === 'prepare') envelope.bootstrap = authority.bootstrap(f.state.lastRequest!, envelope.receipt, adapter); };
  f.state.afterSigned = envelope => authority.advance(envelope);
  const binding = f.bind();
  const guard = createProjectFixtureGuard({ root: f.root, binding, attemptId: 'attempt-1', ownerId: 'owner-1', nativeClient });
  async function start() {
    await guard.prepare();
    const bootstraps: ProjectFixtureNativeBootstrap[] = [];
    await guard.withNativeBootstrap(async payload => { bootstraps.push(structuredClone(payload)); assert.equal(JSON.stringify(payload).includes(payload.token), false); });
    const bootstrap = bootstraps[0];
    assert.ok(bootstrap);
    const claim = guard.nativeWitnessRequest();
    guard.acceptClientWitness(authority.witness(appCredential, claim));
    return { bootstrap, claim };
  }
  return { ...f, nativeClient, adapter, authority, appCredential, binding, guard, start };
}

for (const platform of ['android', 'ios'] as const) {
  it(`${platform}: binds the original signed client principal, app/build/device/session and single-use current lease`, async t => {
    const f = await nativeFixture(t, platform);
    const { bootstrap, claim } = await f.start();
    assert.equal(bootstrap.clientAuthorityId, 'client-authority-1');
    assert.notEqual(bootstrap.clientAuthorityId, f.nativeClient.sessionId);
    assert.equal(f.guard.assertCurrentProof(tap).comparison, 'same_conditions');
    assert.throws(() => f.guard.assertCurrentProof(tap), ProjectFixtureError);
    assert.throws(() => f.authority.witness(f.appCredential, claim), ProjectFixtureError);
    await f.guard.observe();
    assert.throws(() => f.authority.witness(f.appCredential, claim), ProjectFixtureError);
    f.guard.acceptClientWitness(f.authority.witness(f.appCredential, f.guard.nativeWitnessRequest()));
    assert.equal(f.guard.assertCurrentProof(tap).attemptId, 'attempt-1');
    await f.guard.settle();
    assert.throws(() => f.authority.witness(f.appCredential, claim), ProjectFixtureError);
    assert.equal((await f.guard.cleanup()).cleanup, 'complete');
    assert.throws(() => f.guard.nativeWitnessRequest(), ProjectFixtureError);
    const records = readdirSync(join(f.root, '.qa', 'fixture-requests')).map(name => readFileSync(join(f.root, '.qa', 'fixture-requests', name), 'utf8')).join('');
    assert.equal(records.includes(bootstrap.token), false);
    assert.equal(records.includes(f.appCredential), false);
    const recovered = await createProjectFixtureRecoveryObserver({ root: f.root, seedId: f.guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' }).observe();
    assert.equal(recovered.cleanup, 'complete');
    assert.equal(recovered.effect, 'unknown');
    assert.equal(recovered.comparison, 'unobserved');
  });
}

it('requires signed read-only receipt resynchronization after an observe response is lost, without replaying a mutation', async t => {
  const f = await nativeFixture(t);
  await f.start();
  f.state.responseMode = 'oversize';
  await assert.rejects(f.guard.observe(), ProjectFixtureError);
  const before = [...f.state.phases];
  f.state.responseMode = 'normal';
  await assert.rejects(f.guard.settle(), ProjectFixtureError);
  assert.deepEqual(f.state.phases, before);
  assert.throws(() => f.guard.nativeWitnessRequest(), ProjectFixtureError);
  const observed = await f.guard.observe();
  assert.equal(observed.effect, 'not_started');
  assert.equal(observed.comparison, 'unobserved');
  assert.equal(f.state.lastRequest!.previousReceiptSha256, null);
  f.guard.acceptClientWitness(f.authority.witness(f.appCredential, f.guard.nativeWitnessRequest()));
  assert.equal(f.guard.assertCurrentProof(tap).comparison, 'same_conditions');
  await f.guard.settle();
  assert.equal((await f.guard.cleanup()).cleanup, 'complete');
  assert.deepEqual(f.state.phases.filter(phase => phase !== 'observe'), ['prepare', 'settle', 'cleanup']);
  assert.equal(f.state.prepareCount, 1);
});

it('read-only receipt resynchronization never clears an unknown input effect or grants another native claim', async t => {
  const f = await nativeFixture(t);
  await f.start();
  f.guard.markDispatchUnknown();
  const observed = await f.guard.observe();
  assert.equal(observed.effect, 'unknown');
  assert.equal(observed.comparison, 'unobserved');
  assert.throws(() => f.guard.nativeWitnessRequest(), ProjectFixtureError);
  assert.throws(() => f.guard.assertCurrentProof(tap), ProjectFixtureError);
  assert.equal(f.state.prepareCount, 1);
});

it('refuses controller credentials, other app/build/device/session, stale receipts and retired authorities', async t => {
  const f = await nativeFixture(t);
  await f.guard.prepare();
  await f.guard.withNativeBootstrap(async () => {});
  const claim = f.guard.nativeWitnessRequest();
  assert.throws(() => f.authority.witness(process.env[f.authName]!, claim), ProjectFixtureError);
  for (const field of ['applicationId', 'deviceId', 'sessionId', 'buildSha256'] as const) {
    const changed = structuredClone(claim);
    changed.nativeClient[field] = field === 'buildSha256' ? '2'.repeat(64) : 'other';
    assert.throws(() => f.authority.witness(f.appCredential, changed), ProjectFixtureError);
  }
  assert.throws(() => f.authority.witness(f.appCredential, { ...claim, token: '2'.repeat(64) }), ProjectFixtureError);
  assert.throws(() => f.authority.witness(f.appCredential, { ...claim, receiptSha256: '2'.repeat(64) }), ProjectFixtureError);
  f.authority.retire();
  await f.guard.observe();
  assert.throws(() => f.authority.witness(f.appCredential, f.guard.nativeWitnessRequest()), ProjectFixtureError);
});

it('does not accept a validly signed witness for another original native identity or lease', async t => {
  for (const fault of ['nativeClient', 'lease', 'ownerId', 'attemptId'] as const) {
    const f = await nativeFixture(t);
    await f.guard.prepare();
    await f.guard.withNativeBootstrap(async () => {});
    const envelope = f.authority.witness(f.appCredential, f.guard.nativeWitnessRequest());
    if (fault === 'nativeClient') envelope.witness.nativeClient!.sessionId = 'other-session';
    else if (fault === 'lease') envelope.witness.lease.generation += 1;
    else envelope.witness[fault] = 'other-original';
    envelope.signature = createHmac('sha256', process.env[f.keyName]!).update(projectFixtureCanonical({ witness: envelope.witness })).digest('hex');
    assert.throws(() => f.guard.acceptClientWitness(envelope), ProjectFixtureError);
    assert.throws(() => f.guard.assertCurrentProof(tap), ProjectFixtureError);
  }
});

it('requires explicit integration and exact native identity before prepare; it never removes the web guard', async t => {
  const f = await nativeFixture(t);
  for (const field of ['applicationId', 'deviceId', 'buildSha256'] as const) {
    const nativeClient = { ...f.nativeClient, [field]: field === 'buildSha256' ? '2'.repeat(64) : 'other' };
    assert.throws(() => createProjectFixtureGuard({ root: f.root, binding: f.binding, attemptId: 'new-attempt', ownerId: 'owner-1', nativeClient }), ProjectFixtureError);
  }
  const unbound = createProjectFixtureGuard({ root: f.root, binding: f.binding, attemptId: 'new-attempt', ownerId: 'owner-1' });
  await assert.rejects(unbound.prepare(), ProjectFixtureError);
  await assert.rejects(unbound.observe(), ProjectFixtureError);
  assert.equal(f.state.prepareCount, 0);
  const web = await fixture(t);
  web.subject.applicationId = 'qa.example.unintegrated';
  web.evidence.subject = structuredClone(web.subject);
  web.adapter.subjectSha256 = regressionGrantSubjectSha256(web.subject);
  web.save();
  assert.throws(web.guard, ProjectFixtureError);
  assert.equal(web.state.requests, 0);
});

it('binds measured native identity once before any backend dispatch and cannot retarget the original client', async t => {
  const f = await nativeFixture(t);
  const guard = createProjectFixtureGuard({ root: f.root, binding: f.binding, attemptId: 'deferred-attempt', ownerId: 'owner-1' });
  await assert.rejects(guard.prepare(), ProjectFixtureError);
  for (const field of ['applicationId', 'deviceId', 'buildSha256'] as const) {
    assert.throws(() => guard.bindNativeClient({ ...f.nativeClient, [field]: field === 'buildSha256' ? '2'.repeat(64) : 'other' }), ProjectFixtureError);
  }
  assert.equal(f.state.requests, 0); assert.equal(f.state.prepareCount, 0);
  const measured = { ...f.nativeClient };
  guard.bindNativeClient(measured);
  measured.sessionId = 'caller-replaced-session';
  assert.throws(() => guard.bindNativeClient(f.nativeClient), ProjectFixtureError);
  await guard.prepare();
  let bootstrap: ProjectFixtureNativeBootstrap | undefined;
  await guard.withNativeBootstrap(async value => { bootstrap = value; });
  assert.deepEqual(bootstrap!.nativeClient, f.nativeClient);
  const claim = guard.nativeWitnessRequest();
  guard.acceptClientWitness(f.authority.witness(f.appCredential, claim));
  assert.equal(guard.assertCurrentProof(tap).comparison, 'same_conditions');
  assert.throws(() => guard.bindNativeClient({ ...f.nativeClient, sessionId: 'replacement-after-prepare' }), ProjectFixtureError);
  assert.equal(f.state.prepareCount, 1);
});

it('serves a real authenticated native claim exchange without accepting the controller credential or replay', async t => {
  const f = await nativeFixture(t);
  await f.guard.prepare();
  await f.guard.withNativeBootstrap(async () => {});
  const claim = f.guard.nativeWitnessRequest();
  const server = createServer(nativeFixtureClientHandler(f.authority));
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/client`;
  const clientProbe = randomBytes(32).toString('hex');
  const send = (credential: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify({ schema: 'qautra/native-client-probe/v1', clientProbe, claim }), redirect: 'error' });
  const bare = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.appCredential}` }, body: JSON.stringify(claim), redirect: 'error' });
  assert.equal(bare.status, 403);
  assert.equal((await send(process.env[f.authName]!)).status, 403);
  const response = await send(f.appCredential);
  assert.equal(response.status, 200);
  const wire = await response.json() as { schema: string; payload: string; mac: string };
  assert.equal(wire.schema, 'qautra/native-client-authenticated-response/v1');
  const payload = Buffer.from(wire.payload, 'base64');
  assert.equal(wire.mac, createHmac('sha256', f.appCredential).update('qautra/native-client-response/v1\n').update(payload).digest('hex'));
  const authenticated = JSON.parse(payload.toString('utf8')) as { schema: string; clientProbe: string; claim: unknown; witness: unknown };
  assert.equal(authenticated.schema, 'qautra/native-start-authorization/v1');
  assert.equal(authenticated.clientProbe, clientProbe);
  assert.deepEqual(authenticated.claim, claim);
  f.guard.acceptClientWitness(authenticated.witness);
  assert.equal(f.guard.assertCurrentProof(tap).comparison, 'same_conditions');
  assert.equal((await send(f.appCredential)).status, 403);
  const duplicate = createProjectFixtureGuard({ root: f.root, binding: f.binding, attemptId: 'attempt-1', ownerId: 'owner-1', nativeClient: f.nativeClient });
  await assert.rejects(duplicate.prepare(), ProjectFixtureError);
  assert.equal(f.state.prepareCount, 1);
});
