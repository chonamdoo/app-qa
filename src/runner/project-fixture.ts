import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, writeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { z } from 'zod';
import { RegressionGrantBindingSchema, RegressionGrantError, type RegressionGrantBinding, type RegressionGrantOperation } from '../core/regression-grant.ts';
import {
  PROJECT_FIXTURE_PROTOCOL, ProjectFixtureAuditRecordSchema, ProjectFixtureClientWitnessSchema, ProjectFixtureEnvelopeSchema,
  ProjectFixtureError, ProjectFixtureNativeIdentitySchema, ProjectFixturePolicySchema, ProjectFixtureRecoveryAuthoritySchema, ProjectFixtureRequestSchema,
  projectFixtureCanonical, projectFixtureSha256,
  type ProjectFixtureAdapter, type ProjectFixtureClientWitness, type ProjectFixtureNativeIdentity, type ProjectFixtureNativeBootstrap,
  type ProjectFixtureEnvelope, type ProjectFixtureGuard, type ProjectFixtureRecoveryObserver,
  type ProjectFixturePhase, type ProjectFixtureProof, type ProjectFixtureRequest,
} from '../core/project-fixture.ts';
import { assertRegressionGrant, readTrustedRegressionFile, regressionGrantCanonical, regressionGrantSubjectSha256 } from '../policy/regression-grant.ts';

const IntentFields = ProjectFixtureRequestSchema.pick({ requestKey: true, phase: true, attemptId: true, ownerId: true, subjectSha256: true, adapterSha256: true, previousReceiptSha256: true });
const FixtureIntentSchema = z.discriminatedUnion('schema', [
  IntentFields.extend({ schema: z.literal('qautra/project-fixture-request-intent/v1') }),
  IntentFields.extend({ schema: z.literal('qautra/project-fixture-request-intent/v2'), grantSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type FixtureGuardInput = { root: string; binding: RegressionGrantBinding; attemptId: string; ownerId: string; nativeClient?: ProjectFixtureNativeIdentity };
interface FixtureRecoverySeed {
  binding: RegressionGrantBinding;
  adapter: ProjectFixtureAdapter;
  receipt: ProjectFixtureEnvelope['receipt'] | undefined;
  receiptKeySha256: string;
  credentialSha256: string;
  anchor: string;
  pins: readonly { file: string; sha256: string }[];
  nativeClient?: ProjectFixtureNativeIdentity;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectFixtureError('fixture_response_invalid');
  return parsed.data;
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ProjectFixtureError('fixture_response_invalid'); }
}
function adapterMatchesSubject(adapter: ProjectFixtureAdapter, binding: RegressionGrantBinding): boolean {
  if (adapter.subjectSha256 !== regressionGrantSubjectSha256(binding.subject) || adapter.credentialRef !== binding.subject.scope.credentialRef) return false;
  const configuration = adapter.bootstrap;
  if (configuration.kind === 'web-cookie') return !binding.subject.applicationId && binding.subject.origins.includes(configuration.origin);
  return binding.subject.origins.length === 0 && binding.subject.applicationId === configuration.applicationId && ['android', 'ios'].includes(binding.subject.target.platform);
}
function adapterFor(root: string, binding: RegressionGrantBinding): ProjectFixtureAdapter {
  try {
    const bytes = readTrustedRegressionFile(root, join(root, '.qa', 'policy', 'project-fixture.json'), 256 * 1024, 'grant_policy_missing');
    const policy = ProjectFixturePolicySchema.safeParse(json(bytes));
    if (!policy.success) throw new ProjectFixtureError('fixture_adapter_invalid');
    const adapter = policy.data.adapters.find(item => item.grantId === binding.grantId);
    if (!adapter) throw new ProjectFixtureError('fixture_adapter_missing');
    if (!adapterMatchesSubject(adapter, binding)) throw new ProjectFixtureError(adapter.bootstrap.kind === 'web-cookie' && binding.subject.applicationId ? 'fixture_native_bootstrap_unsupported' : 'fixture_scope_denied');
    return adapter;
  } catch (error) {
    if (error instanceof ProjectFixtureError) throw error;
    if (error instanceof RegressionGrantError && error.code === 'grant_policy_missing') throw new ProjectFixtureError('fixture_adapter_missing');
    throw new ProjectFixtureError('fixture_adapter_invalid');
  }
}
function secret(ref: string): string {
  const value = process.env[ref.slice(4)];
  if (!value || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096 || /[^\x21-\x7e]/.test(value)) throw new ProjectFixtureError('fixture_credential_missing');
  return value;
}

export function inspectProjectFixtureAuthority(input: { root: string; binding: RegressionGrantBinding }): void {
  const parsed = RegressionGrantBindingSchema.safeParse(input.binding);
  if (!parsed.success || resolve(input.root) !== parsed.data.root) throw new ProjectFixtureError('fixture_input_invalid');
  const binding = parsed.data;
  const adapter = adapterFor(binding.root, binding);
  lifecycleOperation(binding, 'setup');
  lifecycleOperation(binding, 'cleanup');
  for (const kind of ['observe', 'capture-screen', 'record-video']) {
    const matches = binding.subject.scope.operations.filter(operation => operation.kind === kind);
    if (matches.length !== 1 || matches[0]!.effect !== 'read') throw new ProjectFixtureError('fixture_scope_denied');
  }
  secret(adapter.credentialRef);
  secret(adapter.receiptKeyRef);
}
function authentic(value: unknown, signature: string, key: string): boolean {
  const expected = createHmac('sha256', key).update(projectFixtureCanonical(value)).digest();
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
function normalizePeer(address: string): string {
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return value;
}
async function peerFor(adapter: ProjectFixtureAdapter, signal: AbortSignal): Promise<string> {
  const host = new URL(adapter.endpoint).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return host;
  const pending = Promise.withResolvers<LookupAddress[]>();
  const aborted = () => pending.reject(new ProjectFixtureError('fixture_transport_failed'));
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  else void lookup(host, { all: true, verbatim: true }).then(pending.resolve, () => pending.reject(new ProjectFixtureError('fixture_transport_failed')));
  let addresses: LookupAddress[];
  try { addresses = await pending.promise; } finally { signal.removeEventListener('abort', aborted); }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(address => !adapter.peerAddresses.map(normalizePeer).includes(normalizePeer(address.address)))) throw new ProjectFixtureError('fixture_peer_mismatch');
  return addresses[0]!.address;
}
async function transport(adapter: ProjectFixtureAdapter, body: Buffer, onDispatch: () => void, signal?: AbortSignal): Promise<unknown> {
  if (body.length > adapter.limits.maximumRequestBytes) throw new ProjectFixtureError('fixture_input_invalid');
  const deadline = AbortSignal.timeout(adapter.limits.timeoutMs);
  const boundedSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const peer = await peerFor(adapter, boundedSignal);
  if (boundedSignal.aborted) throw new ProjectFixtureError('fixture_transport_failed');
  const bearer = secret(adapter.credentialRef);
  const url = new URL(adapter.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pending = Promise.withResolvers<unknown>();
  const fail = (code: 'fixture_transport_failed' | 'fixture_peer_mismatch' | 'fixture_response_invalid') => pending.reject(new ProjectFixtureError(code));
  const options: RequestOptions = {
      protocol: url.protocol, hostname: peer, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname,
      method: 'POST', agent: false, signal: boundedSignal, maxHeaderSize: 8192,
      servername: isIP(host) ? undefined : host,
      checkServerIdentity: (_name, certificate) => {
        const invalid = checkServerIdentity(host, certificate);
        if (invalid) return invalid;
        if (!certificate.raw || createHash('sha256').update(certificate.raw).digest('hex') !== adapter.tlsCertificateSha256) return new Error('fixture_peer_mismatch');
        return undefined;
      },
      headers: { Host: url.host, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length, 'Accept-Encoding': 'identity' },
  };
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, response => {
      if (response.statusCode !== 200 || response.headers.location !== undefined || response.headers['content-encoding'] !== undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) { fail('fixture_response_invalid'); response.destroy(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > adapter.limits.maximumResponseBytes) { fail('fixture_response_invalid'); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', () => fail('fixture_transport_failed'));
      response.on('aborted', () => fail('fixture_transport_failed'));
      response.on('end', () => {
        if (!response.complete) { fail('fixture_transport_failed'); return; }
        try { pending.resolve(json(Buffer.concat(chunks, size))); } catch { fail('fixture_response_invalid'); }
      });
    });
    request.on('error', () => fail('fixture_transport_failed'));
    request.on('socket', socket => {
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (!socket.remoteAddress || normalizePeer(socket.remoteAddress) !== normalizePeer(peer)) { fail('fixture_peer_mismatch'); request.destroy(); return; }
        onDispatch();
        request.end(body);
      });
    });
  return pending.promise;
}

function persistRecord(root: string, identity: string, record: unknown, anchor = join(root, '.qa', 'policy', 'project-fixture.json')): void {
  const directory = join(root, '.qa', 'fixture-requests');
  try {
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined) {
      const parentFd = openSync(join(root, '.qa'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    }
    readTrustedRegressionFile(root, anchor, 512 * 1024, 'grant_policy_missing');
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const directoryStat = fstatSync(directoryFd);
      if (directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o077) !== 0) throw new ProjectFixtureError('fixture_state_invalid');
      const fd = openSync(join(directory, `${identity}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const bytes = Buffer.from(projectFixtureCanonical(record));
        let count = 0;
        while (count < bytes.length) count += writeSync(fd, bytes, count, bytes.length - count);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      fsyncSync(directoryFd);
      readTrustedRegressionFile(root, join(directory, `${identity}.json`), 512 * 1024, 'grant_policy_missing');
    } finally { closeSync(directoryFd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectFixtureError('fixture_request_unresolved', 'unknown');
    throw new ProjectFixtureError('fixture_state_invalid');
  }
}
function lifecycleOperation(binding: RegressionGrantBinding, kind: 'setup' | 'cleanup'): RegressionGrantOperation {
  const operation = binding.subject.scope.operations.find(item => item.kind === kind && item.effect === 'fixture-write' && regressionGrantCanonical(item.entityIds) === regressionGrantCanonical(binding.subject.scope.fixture.entityIds) && item.sinkIds.length === 0);
  if (!operation) throw new ProjectFixtureError('fixture_scope_denied');
  return operation;
}

/**
 * The owner-provisioned backend must enforce this protocol; signatures do not certify an arbitrary server's honesty.
 * Before each dispatch, observe, obtain a witness through the owned client, accept it, then consume assertCurrentProof.
 * Bootstrap requires the declared driver capabilities; settlement, backend cleanup, driver cleanup and evidence remain separate.
 */
export function createProjectFixtureGuard(input: FixtureGuardInput): ProjectFixtureGuard {
  return createFixtureSession(input);
}

function createFixtureSession(input: FixtureGuardInput, recovery?: FixtureRecoverySeed): ProjectFixtureGuard {
  const parsedBinding = RegressionGrantBindingSchema.safeParse(input.binding);
  const identity = z.strictObject({ attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/), ownerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/) }).safeParse({ attemptId: input.attemptId, ownerId: input.ownerId });
  if (!parsedBinding.success || !identity.success || typeof input.root !== 'string' || resolve(input.root) !== parsedBinding.data.root) throw new ProjectFixtureError('fixture_input_invalid');
  const root = resolve(input.root);
  let binding = parsedBinding.data;
  const adapter = recovery?.adapter ?? adapterFor(root, binding);
  const adapterSha256 = projectFixtureSha256(adapter);
  const subjectSha256 = regressionGrantSubjectSha256(binding.subject);
  const scopeSha256 = createHash('sha256').update(regressionGrantCanonical(binding.subject.scope)).digest('hex');
  const setup = lifecycleOperation(binding, 'setup');
  lifecycleOperation(binding, 'cleanup');
  let nativeClient = input.nativeClient ? parse(ProjectFixtureNativeIdentitySchema, input.nativeClient) : recovery?.nativeClient;
  const matchesNativeClient = (value: ProjectFixtureNativeIdentity) => adapter.bootstrap.kind === 'native-private-mailbox'
    && value.platform === binding.subject.target.platform && value.deviceId === binding.subject.target.deviceId
    && value.applicationId === adapter.bootstrap.applicationId && value.buildSha256 === adapter.bootstrap.buildSha256;
  if (nativeClient && adapter.bootstrap.kind === 'native-private-mailbox' && !matchesNativeClient(nativeClient)) throw new ProjectFixtureError('fixture_client_unverified');
  if (adapter.bootstrap.kind === 'web-cookie' && nativeClient) throw new ProjectFixtureError('fixture_scope_denied');
  let proof: ProjectFixtureProof | undefined;
  let initialProof: ProjectFixtureProof | undefined;
  let receipt: ProjectFixtureEnvelope['receipt'] | undefined = recovery?.receipt;
  let witness: ProjectFixtureClientWitness['witness'] | undefined;
  let bootstrap: NonNullable<ProjectFixtureEnvelope['bootstrap']> | undefined;
  let nativeBootstrap: ProjectFixtureNativeBootstrap | undefined;
  let busy = false;
  let terminal = recovery !== undefined;
  let uncertain = recovery !== undefined;
  let receiptChainUncertain = recovery !== undefined;
  let conditionsChanged = false;
  const dispatched = new Set<string>();
  const consumedProofs = new Set<string>();
  const recordedWitnesses = new Set<string>();
  const prepareKey = projectFixtureSha256({ attemptId: input.attemptId, ownerId: input.ownerId, subjectSha256, phase: 'prepare' });
  try {
    const history = json(readTrustedRegressionFile(root, join(root, '.qa', 'fixture-requests', `${prepareKey}.json`), 4096, 'grant_evidence_missing'));
    const parsed = FixtureIntentSchema.safeParse(history);
    if (!parsed.success || parsed.data.phase !== 'prepare' || parsed.data.requestKey !== prepareKey || parsed.data.attemptId !== input.attemptId || parsed.data.ownerId !== input.ownerId || parsed.data.subjectSha256 !== subjectSha256 || parsed.data.adapterSha256 !== adapterSha256 || parsed.data.previousReceiptSha256 !== null) throw new ProjectFixtureError('fixture_state_invalid');
    uncertain = true;
    terminal = true;
  } catch (error) {
    if (recovery || !(error instanceof RegressionGrantError && error.code === 'grant_evidence_missing')) throw new ProjectFixtureError('fixture_state_invalid', recovery ? 'unknown' : 'not_started');
  }

  function currentAdapter(): void {
    if (recovery) {
      if (createHash('sha256').update(secret(adapter.receiptKeyRef)).digest('hex') !== recovery.receiptKeySha256 || createHash('sha256').update(secret(adapter.credentialRef)).digest('hex') !== recovery.credentialSha256) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      for (const pin of recovery.pins) {
        const bytes = readTrustedRegressionFile(root, pin.file, 512 * 1024, 'grant_evidence_missing');
        if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      }
      return;
    }
    if (projectFixtureSha256(adapterFor(root, binding)) !== adapterSha256) throw new ProjectFixtureError('fixture_adapter_changed');
  }
  function validateEnvelope(envelope: ProjectFixtureEnvelope, request: ProjectFixtureRequest, receiptKey: string): void {
    if (!authentic({ receipt: envelope.receipt, bootstrapSha256: envelope.bootstrap ? projectFixtureSha256(envelope.bootstrap) : null }, envelope.signature, receiptKey)) throw new ProjectFixtureError('fixture_response_invalid');
    const value = envelope.receipt;
    for (const field of ['phase', 'requestKey', 'challenge', 'attemptId', 'ownerId', 'subjectSha256', 'scopeSha256', 'adapterSha256', 'grantSha256', 'previousReceiptSha256'] as const) if (value[field] !== request[field]) throw new ProjectFixtureError('fixture_receipt_mismatch');
    const now = Date.now();
    const requiresActiveLease = request.phase === 'prepare' || request.phase === 'renew' || (request.phase === 'observe' && !terminal);
    if (Date.parse(value.issuedAt) < requestStartedAt || Date.parse(value.issuedAt) > now || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > adapter.limits.proofTtlMs || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) || (requiresActiveLease && (Date.parse(value.lease.expiresAt) <= now || Date.parse(value.lease.expiresAt) > Date.parse(request.grantExpiresAt) || Date.parse(value.lease.expiresAt) - now > adapter.limits.leaseTtlMs))) throw new ProjectFixtureError('fixture_proof_stale');
    const scope = binding.subject.scope;
    if (value.enforcement.protocol !== adapter.enforcement.protocol || value.enforcement.auditSha256 !== adapter.enforcement.auditSha256 || value.enforcement.credentialRef !== scope.credentialRef || value.enforcement.accountRef !== scope.accountRef || value.enforcement.tenant !== scope.tenant) throw new ProjectFixtureError('fixture_ownership_unverified');
    if (value.state.fixtureId !== scope.fixture.id || regressionGrantCanonical(value.state.entityIds) !== regressionGrantCanonical(scope.fixture.entityIds) || value.state.baselineStateSha256 !== scope.fixture.initialStateSha256) throw new ProjectFixtureError('fixture_baseline_drift');
    // Recovery cannot grant execution rights; an ACK-lost renewal can change only this lease's deadline.
    if (request.lease && (value.lease.id !== request.lease.id || value.lease.generation !== request.lease.generation || value.lease.fence !== request.lease.fence || (!recovery && request.phase !== 'renew' && value.lease.expiresAt !== request.lease.expiresAt))) throw new ProjectFixtureError('fixture_receipt_mismatch');
    if (receipt && (value.enforcement.clientAuthorityId !== receipt.enforcement.clientAuthorityId || value.enforcement.principalRef !== receipt.enforcement.principalRef || value.ledger.sequence <= receipt.ledger.sequence)) throw new ProjectFixtureError('fixture_receipt_mismatch');
    if (value.ledger.throughFence < value.lease.fence) throw new ProjectFixtureError('fixture_ownership_unverified');
    if (value.decision === 'denied' && (value.effect !== 'not_committed' || envelope.bootstrap !== null)) throw new ProjectFixtureError('fixture_response_invalid');
    if (envelope.bootstrap) {
      const payload = envelope.bootstrap;
      const configuration = adapter.bootstrap;
      if (request.phase !== 'prepare' || payload.kind !== configuration.kind || payload.clientAuthorityId !== value.enforcement.clientAuthorityId || projectFixtureCanonical(payload.lease) !== projectFixtureCanonical(value.lease) || payload.attemptId !== request.attemptId || payload.ownerId !== request.ownerId || payload.subjectSha256 !== subjectSha256 || payload.scopeSha256 !== scopeSha256) throw new ProjectFixtureError('fixture_receipt_mismatch');
      if (payload.kind === 'web-cookie') {
        if (configuration.kind !== 'web-cookie' || payload.origin !== configuration.origin || payload.cookie.name !== configuration.cookieName || payload.cookie.secure !== (new URL(configuration.origin).protocol === 'https:')) throw new ProjectFixtureError('fixture_receipt_mismatch');
      } else if (configuration.kind !== 'native-private-mailbox' || payload.clientEndpoint !== configuration.clientEndpoint || payload.mailbox !== configuration.mailbox || projectFixtureCanonical(payload.nativeClient) !== projectFixtureCanonical(nativeClient)) throw new ProjectFixtureError('fixture_receipt_mismatch');
    }
  }
  let requestStartedAt = 0;
  async function run(phase: ProjectFixturePhase, signal?: AbortSignal, renewedBinding?: RegressionGrantBinding): Promise<ProjectFixtureProof> {
    if (recovery && phase !== 'observe') throw new ProjectFixtureError('fixture_scope_denied', 'unknown');
    if (busy) throw new ProjectFixtureError('fixture_state_invalid', uncertain ? 'unknown' : 'not_started');
    if (signal?.aborted) throw new ProjectFixtureError('fixture_transport_failed');
    currentAdapter();
    if (adapter.bootstrap.kind === 'native-private-mailbox' && !nativeClient) throw new ProjectFixtureError('fixture_client_unverified');
    const mutating = phase !== 'observe';
    if (phase === 'prepare' ? receipt !== undefined || terminal : receipt === undefined && !(uncertain && phase === 'observe')) throw new ProjectFixtureError('fixture_state_invalid', uncertain ? 'unknown' : 'not_started');
    if (terminal && !['observe', 'settle', 'cleanup'].includes(phase)) throw new ProjectFixtureError('fixture_state_invalid', uncertain ? 'unknown' : 'not_started');
    if (mutating && receiptChainUncertain) throw new ProjectFixtureError('fixture_client_unverified', uncertain ? 'unknown' : 'not_started');
    if (phase === 'renew' && (uncertain || !renewedBinding || regressionGrantCanonical(renewedBinding.subject) !== regressionGrantCanonical(binding.subject) || renewedBinding.grantId !== binding.grantId || renewedBinding.root !== root || Date.parse(binding.expiresAt) <= Date.now() || !proof || Date.parse(proof.expiresAt) <= Date.now())) throw new ProjectFixtureError('fixture_scope_denied');
    const authority = renewedBinding ?? binding;
    if (phase !== 'settle' && phase !== 'cleanup' && !(phase === 'observe' && terminal)) assertRegressionGrant({ root, binding: authority, operation: setup });
    const receiptKey = secret(adapter.receiptKeyRef);
    secret(adapter.credentialRef);
    const requestKey = projectFixtureSha256({ attemptId: input.attemptId, ownerId: input.ownerId, subjectSha256, phase, ...(phase === 'renew' ? { grantSha256: authority.grantSha256 } : {}), ...(phase === 'observe' ? { nonce: randomBytes(32).toString('hex') } : {}) });
    if (mutating && dispatched.has(requestKey)) throw new ProjectFixtureError('fixture_request_reused', uncertain ? 'unknown' : 'not_started');
    const request = parse(ProjectFixtureRequestSchema, { schema: PROJECT_FIXTURE_PROTOCOL, phase, requestKey, challenge: randomBytes(32).toString('hex'), attemptId: input.attemptId, ownerId: input.ownerId, subject: authority.subject, subjectSha256, scopeSha256, adapterSha256, grantSha256: authority.grantSha256, grantExpiresAt: authority.expiresAt, previousReceiptSha256: phase === 'observe' && (uncertain || receiptChainUncertain) ? null : proof?.receiptSha256 ?? null, lease: receipt?.lease ?? null, ...(nativeClient ? { nativeClient } : {}) });
    const body = Buffer.from(projectFixtureCanonical(request));
    if (body.length > adapter.limits.maximumRequestBytes) throw new ProjectFixtureError('fixture_input_invalid');
    if (phase === 'prepare' || phase === 'renew') {
      const material = { schema: 'qautra/project-fixture-recovery-authority/v1' as const, phase, attemptId: input.attemptId, ownerId: input.ownerId, binding: authority, adapter, ...(nativeClient ? { nativeClient } : {}) };
      const archive = { ...material, signature: createHmac('sha256', receiptKey).update(projectFixtureCanonical(material)).digest('hex') } satisfies z.infer<typeof ProjectFixtureRecoveryAuthoritySchema>;
      const identity = `${prepareKey}-${authority.grantSha256}-${phase}-authority`;
      try { persistRecord(root, identity, archive); }
      catch (error) {
        if (!(error instanceof ProjectFixtureError && error.code === 'fixture_request_unresolved') || projectFixtureCanonical(json(readTrustedRegressionFile(root, join(root, '.qa', 'fixture-requests', `${identity}.json`), 512 * 1024, 'grant_evidence_missing'))) !== projectFixtureCanonical(archive)) throw error;
      }
    }
    if (phase === 'settle' || phase === 'cleanup') terminal = true;
    if (mutating) {
      try { persistRecord(root, requestKey, { schema: 'qautra/project-fixture-request-intent/v2', requestKey, phase, attemptId: input.attemptId, ownerId: input.ownerId, subjectSha256, adapterSha256, grantSha256: authority.grantSha256, previousReceiptSha256: request.previousReceiptSha256 }); }
      catch (error) { if (error instanceof ProjectFixtureError && error.effect === 'unknown') { uncertain = true; terminal = true; } throw error; }
      dispatched.add(requestKey);
    }
    busy = true;
    witness = undefined;
    requestStartedAt = Date.now();
    let sent = false;
    try {
      const envelope = parse(ProjectFixtureEnvelopeSchema, await transport(adapter, body, () => { sent = true; if (!mutating) receiptChainUncertain = true; }, signal));
      if (recovery) currentAdapter();
      validateEnvelope(envelope, request, receiptKey);
      const bootstrapSha256 = envelope.bootstrap ? projectFixtureSha256(envelope.bootstrap) : null;
      persistRecord(root, `${prepareKey}-${String(envelope.receipt.ledger.sequence).padStart(16, '0')}-${requestKey}-${request.challenge}`, { schema: 'qautra/project-fixture-audit-receipt/v1', receipt: envelope.receipt, bootstrapSha256, signature: envelope.signature } satisfies z.infer<typeof ProjectFixtureAuditRecordSchema>, recovery?.anchor);
      const value = envelope.receipt;
      if (value.decision === 'denied') throw new ProjectFixtureError('fixture_scope_denied', 'not_committed');
      if (value.effect === 'unknown') throw new ProjectFixtureError('fixture_request_unresolved', 'unknown');
      if ((mutating && value.effect !== 'committed') || (!mutating && value.effect !== 'not_started')) throw new ProjectFixtureError('fixture_response_invalid');
      const conditionsMatch = projectFixtureCanonical(value.state.conditions) === projectFixtureCanonical(adapter.conditions);
      if (!conditionsMatch) { conditionsChanged = true; terminal = true; }
      const baselineMatch = value.state.currentStateSha256 === binding.subject.scope.fixture.initialStateSha256;
      const drained = value.ledger.pendingEffectIds.length === 0 && value.ledger.fenceStatus === 'revoked' && value.ledger.disposition === 'drained' && value.ledger.throughFence >= value.lease.fence;
      const restored = drained && value.ledger.restoration === 'restored' && baselineMatch;
      const complete = phase === 'settle' ? drained : restored;
      const cleanupObserved = phase === 'cleanup' || (phase === 'observe' && terminal);
      const nextProof: ProjectFixtureProof = {
        receiptSha256: projectFixtureSha256({ receipt: value, bootstrapSha256 }), phase,
        observedAt: value.issuedAt, expiresAt: value.expiresAt, subjectSha256, scopeSha256, adapterSha256,
        attemptId: input.attemptId, ownerId: input.ownerId, lease: value.lease, state: value.state, ledger: value.ledger,
        effect: uncertain ? 'unknown' : value.effect,
        cleanup: cleanupObserved ? (restored ? 'complete' : value.ledger.disposition === 'isolated' ? 'quarantined' : 'incomplete') : 'not_started',
        comparison: recovery ? 'unobserved' : conditionsChanged ? 'changed_conditions' : phase === 'cleanup' && initialProof?.clientObservedAt && !uncertain ? 'same_conditions' : 'unobserved',
      };
      proof = structuredClone(nextProof);
      receipt = value;
      receiptChainUncertain = false;
      if (renewedBinding) binding = structuredClone(renewedBinding);
      if (phase === 'prepare') {
        if (!baselineMatch) throw new ProjectFixtureError('fixture_baseline_drift', value.effect);
        if (!envelope.bootstrap || value.ledger.fenceStatus !== 'active' || value.ledger.disposition !== 'active' || value.ledger.pendingEffectIds.length > 0) throw new ProjectFixtureError('fixture_ownership_unverified', value.effect);
        bootstrap = envelope.bootstrap;
      }
      if (!conditionsMatch) throw new ProjectFixtureError('fixture_conditions_drift', value.effect);
      if (phase === 'prepare') initialProof = structuredClone(nextProof);
      if (phase === 'settle' && !complete) throw new ProjectFixtureError('fixture_effects_pending', uncertain ? 'unknown' : value.effect);
      if (phase === 'cleanup' && !complete) throw new ProjectFixtureError('fixture_cleanup_incomplete', uncertain ? 'unknown' : value.effect);
      return structuredClone(nextProof);
    } catch (error) {
      if (error instanceof ProjectFixtureError && ['fixture_scope_denied', 'fixture_baseline_drift', 'fixture_conditions_drift', 'fixture_effects_pending', 'fixture_cleanup_incomplete', 'fixture_ownership_unverified'].includes(error.code) && error.effect !== 'not_started') { terminal = true; throw error; }
      if (!mutating && sent && receiptChainUncertain && proof) proof = { ...proof, comparison: 'unobserved' };
      if (mutating && sent) { uncertain = true; terminal = true; if (proof) proof = { ...proof, effect: 'unknown', cleanup: 'incomplete', comparison: 'unobserved' }; }
      throw new ProjectFixtureError(error instanceof ProjectFixtureError ? error.code : 'fixture_transport_failed', uncertain ? 'unknown' : 'not_started');
    } finally { busy = false; }
  }
  return {
    recoverySeedId: prepareKey,
    bindNativeClient(value) {
      currentAdapter();
      if (recovery || nativeClient || adapter.bootstrap.kind !== 'native-private-mailbox' || busy || proof || receipt || terminal || uncertain || receiptChainUncertain || dispatched.size) throw new ProjectFixtureError('fixture_client_unverified');
      const candidate = parse(ProjectFixtureNativeIdentitySchema, value);
      if (!matchesNativeClient(candidate)) throw new ProjectFixtureError('fixture_client_unverified');
      nativeClient = candidate;
    },
    prepare: signal => run('prepare', signal),
    observe: signal => run('observe', signal),
    settle: signal => run('settle', signal),
    cleanup: signal => run('cleanup', signal),
    renew: (value, signal) => {
      const next = RegressionGrantBindingSchema.safeParse(value);
      if (!next.success) return Promise.reject(new ProjectFixtureError('fixture_input_invalid'));
      return run('renew', signal, next.data);
    },
    async withBootstrap(apply) {
      currentAdapter();
      assertRegressionGrant({ root, binding, operation: setup });
      if (!bootstrap || bootstrap.kind !== 'web-cookie' || !proof || !receipt || terminal || receiptChainUncertain || Date.parse(proof.expiresAt) <= Date.now() || projectFixtureCanonical(bootstrap.lease) !== projectFixtureCanonical(receipt.lease)) throw new ProjectFixtureError('fixture_client_unverified');
      const payload = bootstrap;
      bootstrap = undefined;
      Object.defineProperty(payload, 'toJSON', { value: () => ({ kind: 'web-cookie', redacted: true }), enumerable: false });
      try { await apply(payload); }
      catch {
        terminal = true;
        uncertain = true;
        proof = { ...proof, effect: 'unknown', cleanup: 'incomplete', comparison: 'unobserved' };
        throw new ProjectFixtureError('fixture_client_unverified', 'unknown');
      }
    },
    async withNativeBootstrap(apply) {
      currentAdapter();
      assertRegressionGrant({ root, binding, operation: setup });
      if (!bootstrap || bootstrap.kind !== 'native-private-mailbox' || !proof || !receipt || terminal || receiptChainUncertain || Date.parse(proof.expiresAt) <= Date.now() || projectFixtureCanonical(bootstrap.lease) !== projectFixtureCanonical(receipt.lease)) throw new ProjectFixtureError('fixture_client_unverified');
      const payload = bootstrap;
      bootstrap = undefined;
      Object.defineProperty(payload, 'toJSON', { value: () => ({ kind: payload.kind, redacted: true }), enumerable: false });
      try { await apply(payload); nativeBootstrap = payload; }
      catch { terminal = true; uncertain = true; proof = { ...proof, effect: 'unknown', cleanup: 'incomplete', comparison: 'unobserved' }; throw new ProjectFixtureError('fixture_client_unverified', 'unknown'); }
    },
    nativeWitnessRequest() {
      currentAdapter();
      if (!nativeBootstrap || !nativeClient || !receipt || !proof || terminal || receiptChainUncertain || Date.parse(receipt.lease.expiresAt) <= Date.now()) throw new ProjectFixtureError('fixture_client_unverified');
      return { schema: 'qautra/project-fixture-native-claim/v1', token: nativeBootstrap.token, nativeClient: structuredClone(nativeClient), challenge: receipt.challenge, receiptSha256: proof.receiptSha256 };
    },
    clientWitnessRequest() {
      currentAdapter();
      if (adapter.bootstrap.kind !== 'web-cookie') throw new ProjectFixtureError('fixture_native_bootstrap_unsupported');
      return { url: new URL(adapter.bootstrap.witnessPath, adapter.bootstrap.origin).href, entryURL: new URL(adapter.bootstrap.entryPath, adapter.bootstrap.origin).href, requiredCapabilities: ['project-fixture-cookie', 'project-fixture-client-witness', 'project-fixture-fence'] };
    },
    acceptClientWitness(value) {
      currentAdapter();
      witness = undefined;
      if (proof) proof = { ...proof, comparison: conditionsChanged ? 'changed_conditions' : 'unobserved' };
      if (receiptChainUncertain) throw new ProjectFixtureError('fixture_client_unverified', uncertain ? 'unknown' : 'not_started');
      const parsed = parse(ProjectFixtureClientWitnessSchema, value);
      const candidate = parsed.witness;
      if (!authentic({ witness: candidate }, parsed.signature, secret(adapter.receiptKeyRef)) || !receipt || !proof || terminal || candidate.challenge !== receipt.challenge || candidate.attemptId !== input.attemptId || candidate.ownerId !== input.ownerId || candidate.subjectSha256 !== subjectSha256 || candidate.adapterSha256 !== adapterSha256 || candidate.scopeSha256 !== scopeSha256 || candidate.receiptSha256 !== proof.receiptSha256 || projectFixtureCanonical(candidate.lease) !== projectFixtureCanonical(receipt.lease) || candidate.clientAuthorityId !== receipt.enforcement.clientAuthorityId || candidate.principalRef !== receipt.enforcement.principalRef || candidate.accountRef !== binding.subject.scope.accountRef || candidate.tenant !== binding.subject.scope.tenant) throw new ProjectFixtureError('fixture_client_unverified');
      if (projectFixtureCanonical(candidate.nativeClient) !== projectFixtureCanonical(nativeClient)) throw new ProjectFixtureError('fixture_client_unverified');
      if (projectFixtureCanonical(candidate.conditions) !== projectFixtureCanonical(receipt.state.conditions)) {
        conditionsChanged = true;
        terminal = true;
        proof = { ...proof, comparison: 'changed_conditions' };
        throw new ProjectFixtureError('fixture_conditions_drift');
      }
      const now = Date.now();
      if (Date.parse(candidate.observedAt) < Date.parse(receipt.issuedAt) || Date.parse(candidate.observedAt) > now || Date.parse(candidate.expiresAt) <= now || Date.parse(candidate.expiresAt) > Date.parse(receipt.expiresAt)) throw new ProjectFixtureError('fixture_proof_stale');
      const witnessSha256 = projectFixtureSha256(parsed);
      if (!recordedWitnesses.has(witnessSha256)) {
        persistRecord(root, `${witnessSha256}-witness`, { schema: 'qautra/project-fixture-client-audit/v1', ...parsed });
        recordedWitnesses.add(witnessSha256);
      }
      witness = candidate;
      if (initialProof && !uncertain && projectFixtureCanonical(receipt.state.conditions) === projectFixtureCanonical(adapter.conditions)) {
        proof = { ...proof, clientObservedAt: candidate.observedAt, comparison: 'same_conditions' };
        if (proof.phase === 'prepare') initialProof = structuredClone(proof);
      }
    },
    assertCurrentProof(operation) {
      currentAdapter();
      assertRegressionGrant({ root, binding, operation });
      const now = Date.now();
      if (busy || terminal || uncertain || receiptChainUncertain || !proof || !receipt || !witness) throw new ProjectFixtureError('fixture_client_unverified', uncertain ? 'unknown' : 'not_started');
      if (Date.parse(proof.expiresAt) <= now || Date.parse(receipt.lease.expiresAt) <= now || Date.parse(witness.expiresAt) <= now) throw new ProjectFixtureError('fixture_proof_stale');
      if (proof.ledger.fenceStatus !== 'active' || proof.ledger.disposition !== 'active' || proof.ledger.pendingEffectIds.length > 0) throw new ProjectFixtureError('fixture_effects_pending');
      if (proof.comparison !== 'same_conditions') throw new ProjectFixtureError('fixture_conditions_drift');
      if (consumedProofs.has(proof.receiptSha256)) throw new ProjectFixtureError('fixture_proof_stale');
      consumedProofs.add(proof.receiptSha256);
      return structuredClone(proof);
    },
    markDispatchUnknown() {
      const alreadyUnknown = uncertain;
      uncertain = true;
      terminal = true;
      witness = undefined;
      if (proof) proof = { ...proof, effect: 'unknown', cleanup: 'incomplete', comparison: 'unobserved' };
      if (!alreadyUnknown) {
        try { persistRecord(root, `${prepareKey}-unknown`, { schema: 'qautra/project-fixture-dispatch-unknown/v1', attemptId: input.attemptId, ownerId: input.ownerId, subjectSha256, adapterSha256, receiptSha256: proof?.receiptSha256 ?? null }); }
        catch { throw new ProjectFixtureError('fixture_state_invalid', 'unknown'); }
      }
    },
    currentProof: () => proof ? structuredClone(proof) : undefined,
    initialProof: () => initialProof ? structuredClone(initialProof) : undefined,
  };
}

export function createProjectFixtureRecoveryObserver(input: { root: string; seedId: string; attemptId: string; ownerId: string }): ProjectFixtureRecoveryObserver {
  const identity = z.strictObject({
    root: z.string().min(1).max(4096), seedId: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/), ownerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/),
  }).safeParse(input);
  if (!identity.success) throw new ProjectFixtureError('fixture_input_invalid');
  try {
    const root = resolve(input.root);
    const directory = join(root, '.qa', 'fixture-requests');
    const pins = new Map<string, { sha256: string; value: unknown }>();
    let bytesRead = 0;
    function stored(file: string): unknown {
      const cached = pins.get(file);
      if (cached) return cached.value;
      const bytes = readTrustedRegressionFile(root, file, 512 * 1024, 'grant_evidence_missing');
      bytesRead += bytes.length;
      if (bytesRead > 64 * 1024 * 1024 || pins.size >= 20_000) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      const value = json(bytes);
      pins.set(file, { sha256: createHash('sha256').update(bytes).digest('hex'), value });
      return value;
    }
    const intent = parse(FixtureIntentSchema, stored(join(directory, `${input.seedId}.json`)));
    if (intent.schema !== 'qautra/project-fixture-request-intent/v2' || intent.phase !== 'prepare' || intent.requestKey !== input.seedId || intent.attemptId !== input.attemptId || intent.ownerId !== input.ownerId || intent.previousReceiptSha256 !== null) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
    const originalGrantSha256 = intent.grantSha256;
    const anchor = join(directory, `${input.seedId}-${intent.grantSha256}-prepare-authority.json`);
    const original = parse(ProjectFixtureRecoveryAuthoritySchema, stored(anchor));
    const binding = original.binding;
    const adapter = original.adapter;
    const subjectSha256 = regressionGrantSubjectSha256(binding.subject);
    const scopeSha256 = createHash('sha256').update(regressionGrantCanonical(binding.subject.scope)).digest('hex');
    const adapterSha256 = projectFixtureSha256(adapter);
    const expectedSeed = projectFixtureSha256({ attemptId: input.attemptId, ownerId: input.ownerId, subjectSha256, phase: 'prepare' });
    if (expectedSeed !== input.seedId || original.phase !== 'prepare' || original.binding.grantSha256 !== intent.grantSha256 || original.attemptId !== input.attemptId || original.ownerId !== input.ownerId || binding.root !== root || intent.subjectSha256 !== subjectSha256 || intent.adapterSha256 !== adapterSha256 || !adapterMatchesSubject(adapter, binding) || adapter.grantId !== binding.grantId) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
    const key = secret(adapter.receiptKeyRef);
    const credential = secret(adapter.credentialRef);
    const authorities = new Map<string, RegressionGrantBinding>();
    function authority(file: string, grantSha256: string, phase: 'prepare' | 'renew'): void {
      const value = parse(ProjectFixtureRecoveryAuthoritySchema, stored(file));
      const { signature, ...material } = value;
      if (!authentic(material, signature, key) || value.phase !== phase || value.attemptId !== input.attemptId || value.ownerId !== input.ownerId || value.binding.root !== root || value.binding.grantId !== binding.grantId || value.binding.grantSha256 !== grantSha256 || regressionGrantCanonical(value.binding.subject) !== regressionGrantCanonical(binding.subject) || projectFixtureSha256(value.adapter) !== adapterSha256 || (phase === 'prepare' && grantSha256 !== originalGrantSha256)) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      if (projectFixtureCanonical(value.nativeClient) !== projectFixtureCanonical(original.nativeClient)) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      const previous = authorities.get(grantSha256);
      if (previous && projectFixtureCanonical(previous) !== projectFixtureCanonical(value.binding)) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      authorities.set(grantSha256, value.binding);
    }
    authority(anchor, intent.grantSha256, 'prepare');
    const archivePattern = new RegExp(`^${input.seedId}-([a-f0-9]{64})-(prepare|renew)-authority\\.json$`);
    const receiptPattern = new RegExp(`^${input.seedId}-([0-9]{16})-([a-f0-9]{64})-([a-f0-9]{64})\\.json$`);
    const records: z.infer<typeof ProjectFixtureAuditRecordSchema>[] = [];
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
    const listing = opendirSync(directory);
    try {
      let count = 0;
      for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
        if (++count > 200_000) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
        const archived = archivePattern.exec(entry.name);
        const recorded = receiptPattern.exec(entry.name);
        if (!archived && !recorded) continue;
        if (!entry.isFile()) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
        const file = join(directory, entry.name);
        if (archived) authority(file, archived[1]!, archived[2] as 'prepare' | 'renew');
        else if (recorded) {
          const value = parse(ProjectFixtureAuditRecordSchema, stored(file));
          if (String(value.receipt.ledger.sequence).padStart(16, '0') !== recorded[1] || value.receipt.requestKey !== recorded[2] || value.receipt.challenge !== recorded[3]) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
          records.push(value);
        }
      }
    } finally { listing.closeSync(); }
    const after = lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode || after.isSymbolicLink()) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
    records.sort((left, right) => left.receipt.ledger.sequence - right.receipt.ledger.sequence);
    const knownHashes = new Set<string>();
    let latest: ProjectFixtureEnvelope['receipt'] | undefined;
    for (const record of records) {
      const value = record.receipt;
      const source = authorities.get(value.grantSha256);
      if (!source || !authentic({ receipt: value, bootstrapSha256: record.bootstrapSha256 }, record.signature, key) || value.attemptId !== input.attemptId || value.ownerId !== input.ownerId || value.subjectSha256 !== subjectSha256 || value.scopeSha256 !== scopeSha256 || value.adapterSha256 !== adapterSha256 || value.enforcement.protocol !== adapter.enforcement.protocol || value.enforcement.auditSha256 !== adapter.enforcement.auditSha256 || value.enforcement.credentialRef !== binding.subject.scope.credentialRef || value.enforcement.accountRef !== binding.subject.scope.accountRef || value.enforcement.tenant !== binding.subject.scope.tenant || value.state.fixtureId !== binding.subject.scope.fixture.id || regressionGrantCanonical(value.state.entityIds) !== regressionGrantCanonical(binding.subject.scope.fixture.entityIds) || value.state.baselineStateSha256 !== binding.subject.scope.fixture.initialStateSha256 || value.ledger.throughFence < value.lease.fence || Date.parse(value.issuedAt) > Date.now() || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > adapter.limits.proofTtlMs || (value.previousReceiptSha256 !== null && !knownHashes.has(value.previousReceiptSha256)) || (record.bootstrapSha256 !== null && value.phase !== 'prepare')) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      if (latest && (value.ledger.sequence <= latest.ledger.sequence || value.lease.id !== latest.lease.id || value.lease.generation !== latest.lease.generation || value.lease.fence !== latest.lease.fence || value.enforcement.clientAuthorityId !== latest.enforcement.clientAuthorityId || value.enforcement.principalRef !== latest.enforcement.principalRef || (!['renew', 'observe'].includes(value.phase) && value.lease.expiresAt !== latest.lease.expiresAt))) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
      if (value.phase !== 'observe') {
        const dispatch = parse(FixtureIntentSchema, stored(join(directory, `${value.requestKey}.json`)));
        if (dispatch.schema !== 'qautra/project-fixture-request-intent/v2' || dispatch.grantSha256 !== value.grantSha256 || dispatch.requestKey !== value.requestKey || dispatch.phase !== value.phase || dispatch.attemptId !== input.attemptId || dispatch.ownerId !== input.ownerId || dispatch.subjectSha256 !== subjectSha256 || dispatch.adapterSha256 !== adapterSha256 || dispatch.previousReceiptSha256 !== value.previousReceiptSha256) throw new ProjectFixtureError('fixture_recovery_unavailable', 'unknown');
        if (value.phase === 'renew') authority(join(directory, `${input.seedId}-${value.grantSha256}-renew-authority.json`), value.grantSha256, 'renew');
      }
      knownHashes.add(projectFixtureSha256({ receipt: value, bootstrapSha256: record.bootstrapSha256 }));
      latest = value;
    }
    const seed: FixtureRecoverySeed = {
      binding: latest ? authorities.get(latest.grantSha256)! : binding, adapter, receipt: latest, anchor,
      receiptKeySha256: createHash('sha256').update(key).digest('hex'), credentialSha256: createHash('sha256').update(credential).digest('hex'),
      pins: [...pins].map(([file, value]) => ({ file, sha256: value.sha256 })),
      ...(original.nativeClient ? { nativeClient: original.nativeClient } : {}),
    };
    const guard = createFixtureSession({ root, binding: seed.binding, attemptId: input.attemptId, ownerId: input.ownerId }, seed);
    return Object.freeze({ async observe(signal?: AbortSignal) {
      try { return await guard.observe(signal); }
      catch (error) { throw new ProjectFixtureError(error instanceof ProjectFixtureError ? error.code : 'fixture_recovery_unavailable', 'unknown'); }
    } });
  } catch (error) {
    throw new ProjectFixtureError(error instanceof ProjectFixtureError ? error.code : 'fixture_recovery_unavailable', 'unknown');
  }
}
