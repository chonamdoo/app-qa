import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { RegressionGrant, RegressionGrantEvidence, RegressionGrantOperation } from '../../src/core/regression-grant.ts';
import { PROJECT_FIXTURE_PROTOCOL, ProjectFixtureRequestSchema, projectFixtureCanonical, projectFixtureSha256, type ProjectFixtureAdapter, type ProjectFixtureEnvelope, type ProjectFixtureGuard, type ProjectFixtureRequest } from '../../src/core/project-fixture.ts';
import { bindRegressionGrant, regressionGrantCanonical, regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { createProjectFixtureGuard } from '../../src/runner/project-fixture.ts';
const baselineEntities = { orders: [{ id: 'order-1', status: 'draft', quantity: 1 }] };
const changedEntities = { orders: [{ id: 'order-1', status: 'committed', quantity: 2 }] };
const INITIAL = projectFixtureSha256(baselineEntities);
const CHANGED = projectFixtureSha256(changedEntities);
const tap: RegressionGrantOperation = { kind: 'tap', effect: 'fixture-write', entityIds: ['order-1'], sinkIds: [] };
const iso = (value: number) => new Date(value).toISOString();

async function fixture(t: TestContext, options: { retain?: boolean; leaseTtlMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-live-fixture-')));
  chmodSync(root, 0o700);
  t.after(() => { if (!options.retain) rmSync(root, { recursive: true, force: true }); });
  const suffix = randomBytes(6).toString('hex').toUpperCase();
  const authName = `QA_FIXTURE_AUTH_${suffix}`;
  const keyName = `QA_FIXTURE_RECEIPT_${suffix}`;
  const auth = randomBytes(32).toString('hex');
  const key = randomBytes(32).toString('hex');
  process.env[authName] = auth;
  process.env[keyName] = key;
  t.after(() => { delete process.env[authName]; delete process.env[keyName]; });
  let subject: RegressionGrant['subject'];
  let adapter: ProjectFixtureAdapter & { bootstrap: Extract<ProjectFixtureAdapter['bootstrap'], { kind: 'web-cookie' }> };
  let latest: ProjectFixtureEnvelope | undefined;
  let lease: ProjectFixtureEnvelope['receipt']['lease'] | undefined;
  let attempt: { attemptId: string; ownerId: string } | undefined;
  const state = {
    entities: structuredClone(changedEntities), fence: 'active' as 'active' | 'revoked',
    restoration: 'not_requested' as 'not_requested' | 'restored' | 'incomplete',
    sequence: 0, pending: new Set<string>(), prepareCount: 0, appliedEffects: 0, blockedEffects: 0,
    requests: 0, redirectRequests: 0, pageRequests: 0, phases: [] as string[],
    responseMode: 'normal' as 'normal' | 'redirect' | 'oversize' | 'plain200' | 'hold',
    denied: false, losePrepareResponse: false, loseCleanupResponse: false,
    incompleteCleanup: false, driftBaseline: false, driftConditions: false,
    fault: undefined as ((envelope: ProjectFixtureEnvelope) => void) | undefined,
    lastRequest: undefined as ProjectFixtureRequest | undefined,
    afterSigned: undefined as ((envelope: ProjectFixtureEnvelope) => void) | undefined,
    enforcementAdapter: undefined as ProjectFixtureAdapter | undefined,
  };
  const deferred: { release: () => void; done: Promise<void> }[] = [];
  const cookieValue = randomBytes(32).toString('hex');
  function signed(envelope: ProjectFixtureEnvelope): ProjectFixtureEnvelope {
    const material = { receipt: envelope.receipt, bootstrapSha256: envelope.bootstrap ? projectFixtureSha256(envelope.bootstrap) : null };
    envelope.signature = createHmac('sha256', key).update(projectFixtureCanonical(material)).digest('hex');
    return envelope;
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/forbidden') { state.redirectRequests += 1; response.writeHead(500).end(); return; }
      if (request.url === '/witness' && request.method === 'GET') {
        if (request.headers.cookie !== `qa_fixture=${cookieValue}` || !latest || state.fence !== 'active') { response.writeHead(403).end(); return; }
        const value = latest.receipt;
        const witness = { schema: 'qautra/project-fixture-client-witness/v1', challenge: value.challenge, attemptId: value.attemptId, ownerId: value.ownerId, subjectSha256: value.subjectSha256, adapterSha256: value.adapterSha256, scopeSha256: value.scopeSha256, receiptSha256: projectFixtureSha256({ receipt: value, bootstrapSha256: latest.bootstrap ? projectFixtureSha256(latest.bootstrap) : null }), lease: value.lease, clientAuthorityId: value.enforcement.clientAuthorityId, principalRef: value.enforcement.principalRef, accountRef: value.enforcement.accountRef, tenant: value.enforcement.tenant, conditions: value.state.conditions, observedAt: iso(Date.now()), expiresAt: value.expiresAt };
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ witness, signature: createHmac('sha256', key).update(projectFixtureCanonical({ witness })).digest('hex') }));
        return;
      }
      if (request.url === '/effect' && request.method === 'POST') {
        if (request.headers.cookie !== `qa_fixture=${cookieValue}` || state.fence !== 'active') { response.writeHead(403).end(); return; }
        const id = `effect-${state.sequence}-${deferred.length}`;
        const gate = Promise.withResolvers<void>();
        const done = Promise.withResolvers<void>();
        state.pending.add(id);
        deferred.push({ release: () => gate.resolve(), done: done.promise });
        void gate.promise.then(() => {
          if (state.fence === 'active') { state.entities = structuredClone(changedEntities); state.appliedEffects += 1; }
          else state.blockedEffects += 1;
          state.pending.delete(id);
          done.resolve();
        });
        response.writeHead(202).end();
        return;
      }
      if (request.url === '/' && request.method === 'GET') {
        state.pageRequests += 1;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="ko"><head><title>Owned QAutra recovery fixture</title></head><body><h1>QA fixture</h1><label for="note">Note</label><input id="note" oninput="document.getElementById('typed').textContent=this.value"><p id="typed"></p><button id="commit" onclick="fetch('/commit',{method:'POST'}).then(r=>{if(!r.ok)throw Error('denied');return r.json()}).then(()=>{document.getElementById('status').textContent='Committed'})">Commit test order</button><p id="status">Ready</p></body></html>`);
        return;
      }
      if (request.url === '/commit' && request.method === 'POST') {
        const operation = subject.scope.operations.filter(operation => operation.kind === 'tap');
        if (request.headers.cookie !== `qa_fixture=${cookieValue}` || state.fence !== 'active' || !attempt || !lease || Date.parse(lease.expiresAt) <= Date.now() || operation.length !== 1 || operation[0]!.effect !== 'fixture-write' || !operation[0]!.entityIds.includes('order-1')) { response.writeHead(403).end(); return; }
        state.entities = structuredClone(changedEntities); state.appliedEffects += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"committed":"order-1"}');
        return;
      }
      if (request.url !== '/guard' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      state.requests += 1;
      if (request.headers.authorization !== `Bearer ${auth}`) { response.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"credential_denied"}'); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value = ProjectFixtureRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      state.lastRequest = value;
      state.phases.push(value.phase);
      const scopeAllowed = !state.denied && regressionGrantCanonical(value.subject) === regressionGrantCanonical(subject) && value.subjectSha256 === regressionGrantSubjectSha256(subject) && value.scopeSha256 === createHash('sha256').update(regressionGrantCanonical(subject.scope)).digest('hex') && value.adapterSha256 === projectFixtureSha256(state.enforcementAdapter ?? adapter) && (!attempt || (attempt.attemptId === value.attemptId && attempt.ownerId === value.ownerId));
      const chainAllowed = !latest || value.previousReceiptSha256 === projectFixtureSha256({ receipt: latest.receipt, bootstrapSha256: latest.bootstrap ? projectFixtureSha256(latest.bootstrap) : null }) || (value.phase === 'observe' && value.previousReceiptSha256 === null);
      const allowed = scopeAllowed && chainAllowed;
      if (!lease) lease = { id: 'lease-1', generation: 1, fence: 11, expiresAt: iso(Math.min(Date.now() + (options.leaseTtlMs ?? 1_800_000), Date.parse(value.grantExpiresAt))) };
      if (allowed && value.phase === 'prepare') { attempt = { attemptId: value.attemptId, ownerId: value.ownerId }; state.prepareCount += 1; state.entities = structuredClone(state.driftBaseline ? changedEntities : baselineEntities); }
      if (allowed && value.phase === 'renew') lease = { ...lease, expiresAt: iso(Math.min(Date.now() + (options.leaseTtlMs ?? 1_800_000), Date.parse(value.grantExpiresAt))) };
      if (allowed && ['settle', 'cleanup'].includes(value.phase)) state.fence = 'revoked';
      if (allowed && value.phase === 'cleanup') {
        if (!state.incompleteCleanup && state.pending.size === 0) state.entities = structuredClone(baselineEntities);
        state.restoration = projectFixtureSha256(state.entities) === INITIAL && !state.incompleteCleanup && state.pending.size === 0 ? 'restored' : 'incomplete';
      }
      state.sequence += 1;
      const envelope: ProjectFixtureEnvelope = {
        receipt: {
          schema: PROJECT_FIXTURE_PROTOCOL, phase: value.phase, requestKey: value.requestKey, challenge: value.challenge, attemptId: value.attemptId, ownerId: value.ownerId, subjectSha256: value.subjectSha256, scopeSha256: value.scopeSha256, adapterSha256: value.adapterSha256, grantSha256: value.grantSha256, previousReceiptSha256: value.previousReceiptSha256,
          issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30_000), decision: allowed ? 'allowed' : 'denied', effect: !allowed ? 'not_committed' : value.phase === 'observe' ? 'not_started' : 'committed',
          enforcement: { protocol: PROJECT_FIXTURE_PROTOCOL, auditSha256: adapter.enforcement.auditSha256, credentialRef: subject.scope.credentialRef, principalRef: 'dedicated-qa-principal', accountRef: subject.scope.accountRef, tenant: subject.scope.tenant, clientAuthorityId: 'client-authority-1' },
          lease,
          state: { fixtureId: subject.scope.fixture.id, entityIds: [...subject.scope.fixture.entityIds], baselineStateSha256: INITIAL, currentStateSha256: projectFixtureSha256(state.entities), conditions: { ...adapter.conditions, ...(state.driftConditions ? { apiSha256: CHANGED } : {}) } },
          ledger: { sequence: state.sequence, sha256: projectFixtureSha256({ sequence: state.sequence, pending: [...state.pending], entities: state.entities, fence: state.fence, restoration: state.restoration }), pendingEffectIds: [...state.pending], throughFence: lease.fence, disposition: state.fence === 'active' ? 'active' : state.pending.size === 0 ? 'drained' : 'isolated', fenceStatus: state.fence, restoration: state.restoration },
        },
        bootstrap: allowed && value.phase === 'prepare' ? { kind: 'web-cookie', origin: adapter.bootstrap.origin, cookie: { name: 'qa_fixture', value: cookieValue, path: '/', httpOnly: true, secure: false, sameSite: 'Strict' }, clientAuthorityId: 'client-authority-1', lease, attemptId: value.attemptId, ownerId: value.ownerId, subjectSha256: value.subjectSha256, scopeSha256: value.scopeSha256 } : null,
        signature: '0'.repeat(64),
      };
      state.fault?.(envelope);
      signed(envelope);
      state.afterSigned?.(envelope);
      latest = envelope;
      if (state.losePrepareResponse && value.phase === 'prepare') { response.destroy(); return; }
      if (state.loseCleanupResponse && value.phase === 'cleanup') { response.destroy(); return; }
      if (state.responseMode === 'redirect') { response.writeHead(307, { Location: `${adapter.bootstrap.origin}/forbidden` }).end(); return; }
      if (state.responseMode === 'oversize') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('x'.repeat(adapter.limits.maximumResponseBytes + 1)); return; }
      if (state.responseMode === 'plain200') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{\"ok\":true}'); return; }
      if (state.responseMode === 'hold') return;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(envelope));
    } catch { response.writeHead(400).end(); }
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => ready.resolve());
  await ready.promise;
  t.after(async () => {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  subject = {
    appId: 'shop', target: { platform: 'desktop-chrome', deviceId: 'owned-chrome' }, origins: [origin], policyVersion: 'policy-1',
    scope: { environment: 'staging', tenant: 'tenant-a', accountRef: 'qa-account', credentialRef: `env:${authName}`, fixture: { id: 'fixture-1', entityIds: ['order-1'], initialStateSha256: INITIAL }, operations: [{ kind: 'setup', effect: 'fixture-write', entityIds: ['order-1'], sinkIds: [] }, tap, { kind: 'cleanup', effect: 'fixture-write', entityIds: ['order-1'], sinkIds: [] }], effects: ['fixture-write'], sinks: [] },
  };
  const now = Date.now();
  const evidence: RegressionGrantEvidence = { schema: 'qautra/backend-enforcement-probe/v1', subject: structuredClone(subject), checkedAt: iso(now - 500), expiresAt: iso(now + 299_000), enforcement: 'server-enforced-tenant-credential', credential: { ref: subject.scope.credentialRef, accountRef: subject.scope.accountRef, tenant: subject.scope.tenant }, probes: { crossTenant: { tenant: 'tenant-b', observedStatus: 403 }, unownedEntity: { entityId: 'other-order', observedStatus: 403 }, unapprovedSink: { sinkId: 'production-mail', observedStatus: 403 } }, initialState: { fixtureId: 'fixture-1', entityIds: ['order-1'], observedStateSha256: INITIAL } };
  const grant: RegressionGrant = { grantId: 'shop-staging', subject, issuedAt: iso(now - 1000), expiresAt: iso(now + 3_600_000), revokedAt: null, evidence: { file: 'shop.json', sha256: '0'.repeat(64) } };
  const directory = join(root, '.qa', 'policy', 'regression');
  mkdirSync(join(directory, 'evidence'), { recursive: true, mode: 0o700 });
  const policyFile = join(directory, 'policy.json');
  const adapterFile = join(root, '.qa', 'policy', 'project-fixture.json');
  adapter = { id: 'shop-adapter', grantId: grant.grantId, subjectSha256: regressionGrantSubjectSha256(subject), endpoint: `${origin}/guard`, peerAddresses: ['127.0.0.1'], tlsCertificateSha256: null, credentialRef: subject.scope.credentialRef, receiptKeyRef: `env:${keyName}`, enforcement: { protocol: PROJECT_FIXTURE_PROTOCOL, auditRef: 'owner-audit-1', auditSha256: 'c'.repeat(64) }, conditions: { frontendSha256: 'd'.repeat(64), apiSha256: 'e'.repeat(64), configSha256: 'f'.repeat(64) }, limits: { timeoutMs: 1000, maximumRequestBytes: 65_536, maximumResponseBytes: 65_536, proofTtlMs: 60_000, leaseTtlMs: 3_600_000 }, bootstrap: { kind: 'web-cookie', origin, cookieName: 'qa_fixture', entryPath: '/', witnessPath: '/witness' } };
  function save() {
    const bytes = JSON.stringify(evidence);
    grant.evidence.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'evidence', 'shop.json'), bytes, { mode: 0o600 });
    writeFileSync(policyFile, JSON.stringify({ schema: 'qautra/regression-grant-policy/v1', policyVersion: 'policy-1', grants: [grant] }), { mode: 0o600 });
    writeFileSync(adapterFile, JSON.stringify({ schema: 'qautra/project-fixture-policy/v1', adapters: [adapter] }), { mode: 0o600 });
  }
  save();
  function bind() { return bindRegressionGrant({ root, grantId: grant.grantId, appId: subject.appId, target: subject.target, scope: subject.scope, origins: subject.origins, ...(subject.applicationId ? { applicationId: subject.applicationId } : {}) }); }
  function guard() { return createProjectFixtureGuard({ root, binding: bind(), attemptId: 'attempt-1', ownerId: 'owner-1' }); }
  async function clientWitness(guard: ProjectFixtureGuard, cookie: string) {
    const response = await fetch(guard.clientWitnessRequest().url, { headers: { Cookie: cookie }, redirect: 'error' });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function start(guard: ProjectFixtureGuard) {
    await guard.prepare();
    let cookie = '';
    await guard.withBootstrap(async payload => { cookie = `${payload.cookie.name}=${payload.cookie.value}`; assert.equal(JSON.stringify(payload).includes(cookieValue), false); });
    guard.acceptClientWitness(await clientWitness(guard, cookie));
    return cookie;
  }
  async function queueEffect(cookie: string) {
    const response = await fetch(`${origin}/effect`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'error' });
    assert.equal(response.status, 202);
    const entry = deferred.at(-1)!;
    return async () => { entry.release(); await entry.done; };
  }
  function restoreExpiredLease() {
    assert.ok(lease && Date.parse(lease.expiresAt) <= Date.now(), JSON.stringify({ lease, observedAt: iso(Date.now()) }));
    assert.equal(state.pending.size, 0);
    state.fence = 'revoked';
    state.entities = structuredClone(baselineEntities);
    state.restoration = 'restored';
  }
  return { root, origin, subject, grant, evidence, adapter, adapterFile, state, authName, keyName, cookieValue, save, bind, guard, start, clientWitness, queueEffect, restoreExpiredLease, lease: () => lease };
}

export { baselineEntities, changedEntities, INITIAL, CHANGED, tap, iso, fixture };
