import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  ProjectFixtureClientWitnessSchema, ProjectFixtureEnvelopeSchema, ProjectFixtureError, ProjectFixtureNativeClaimSchema,
  ProjectFixtureRequestSchema, projectFixtureCanonical, projectFixtureSha256,
  type ProjectFixtureAdapter, type ProjectFixtureClientWitness, type ProjectFixtureEnvelope,
  type ProjectFixtureNativeBootstrap, type ProjectFixtureRequest,
} from '../core/project-fixture.ts';

export interface NativeFixturePrincipal {
  clientAuthorityId: string;
  principalRef: string;
  accountRef: string;
  tenant: string;
  credentialSha256: string;
  platform: 'android' | 'ios';
  deviceId: string;
  applicationId: string;
  buildSha256: string;
}

const NativeProbeSchema = z.strictObject({
  schema: z.literal('qautra/native-client-probe/v1'),
  clientProbe: z.string().regex(/^[a-f0-9]{64}$/),
  claim: ProjectFixtureNativeClaimSchema,
});

/** Install inside the protected project enforcer, alongside its existing effect/lease fences. */
export function createNativeFixtureClientAuthority(input: { receiptKey: string; principal: NativeFixturePrincipal }): NativeFixtureClientAuthority {
  const principal = structuredClone(input.principal);
  const key = input.receiptKey;
  if (Buffer.byteLength(key) < 32 || !/^[a-f0-9]{64}$/.test(principal.credentialSha256)) throw new ProjectFixtureError('fixture_credential_missing');
  let bootstrap: ProjectFixtureNativeBootstrap | undefined;
  let current: ProjectFixtureEnvelope | undefined;
  let original: ProjectFixtureRequest | undefined;
  let retired = false;
  const consumed = new Set<string>();
  function sign(value: unknown): string { return createHmac('sha256', key).update(projectFixtureCanonical(value)).digest('hex'); }
  function samePrincipal(receipt: ProjectFixtureEnvelope['receipt']): boolean {
    return receipt.enforcement.clientAuthorityId === principal.clientAuthorityId && receipt.enforcement.principalRef === principal.principalRef && receipt.enforcement.accountRef === principal.accountRef && receipt.enforcement.tenant === principal.tenant;
  }
  return Object.freeze({
    bootstrap(requestValue: ProjectFixtureRequest, receipt: ProjectFixtureEnvelope['receipt'], adapter: ProjectFixtureAdapter): ProjectFixtureNativeBootstrap {
      const request = ProjectFixtureRequestSchema.parse(requestValue);
      const configuration = adapter.bootstrap;
      const native = request.nativeClient;
      if (request.lease !== null || request.previousReceiptSha256 !== null || receipt.phase !== 'prepare' || receipt.previousReceiptSha256 !== null || Date.parse(request.grantExpiresAt) <= Date.now()) throw new ProjectFixtureError('fixture_client_unverified');
      if (bootstrap || retired || request.phase !== 'prepare' || !native || configuration.kind !== 'native-private-mailbox' || !samePrincipal(receipt) || receipt.decision !== 'allowed' || receipt.effect !== 'committed' || receipt.ledger.fenceStatus !== 'active' || receipt.ledger.disposition !== 'active' || receipt.ledger.pendingEffectIds.length !== 0 || request.subject.scope.accountRef !== principal.accountRef || request.subject.scope.tenant !== principal.tenant || request.subject.applicationId !== principal.applicationId || request.subject.origins.length !== 0 || request.subject.target.platform !== principal.platform || request.subject.target.deviceId !== principal.deviceId || native.applicationId !== principal.applicationId || native.deviceId !== principal.deviceId || native.platform !== principal.platform || native.buildSha256 !== principal.buildSha256 || configuration.applicationId !== principal.applicationId || configuration.buildSha256 !== principal.buildSha256 || projectFixtureSha256(adapter) !== request.adapterSha256 || Date.parse(receipt.lease.expiresAt) <= Date.now()) throw new ProjectFixtureError('fixture_client_unverified');
      for (const field of ['requestKey', 'challenge', 'attemptId', 'ownerId', 'subjectSha256', 'scopeSha256', 'adapterSha256', 'grantSha256'] as const) if (receipt[field] !== request[field]) throw new ProjectFixtureError('fixture_receipt_mismatch');
      original = structuredClone(request);
      bootstrap = { kind: 'native-private-mailbox', clientEndpoint: configuration.clientEndpoint, mailbox: configuration.mailbox, token: randomBytes(32).toString('hex'), nativeClient: structuredClone(native), clientAuthorityId: principal.clientAuthorityId, lease: structuredClone(receipt.lease), attemptId: request.attemptId, ownerId: request.ownerId, subjectSha256: request.subjectSha256, scopeSha256: request.scopeSha256 };
      return structuredClone(bootstrap);
    },
    advance(value: ProjectFixtureEnvelope): void {
      const envelope = ProjectFixtureEnvelopeSchema.parse(value);
      const receipt = envelope.receipt;
      const expected = sign({ receipt, bootstrapSha256: envelope.bootstrap ? projectFixtureSha256(envelope.bootstrap) : null });
      if (current && (receipt.phase === 'prepare' || envelope.bootstrap !== null)) throw new ProjectFixtureError('fixture_receipt_mismatch');
      if (!bootstrap || !original || envelope.signature !== expected || !samePrincipal(receipt) || receipt.attemptId !== original.attemptId || receipt.ownerId !== original.ownerId || receipt.subjectSha256 !== original.subjectSha256 || receipt.scopeSha256 !== original.scopeSha256 || receipt.adapterSha256 !== original.adapterSha256 || receipt.lease.id !== bootstrap.lease.id || receipt.lease.generation !== bootstrap.lease.generation || receipt.lease.fence !== bootstrap.lease.fence || (current && receipt.ledger.sequence <= current.receipt.ledger.sequence) || (!current && projectFixtureCanonical(envelope.bootstrap) !== projectFixtureCanonical(bootstrap))) throw new ProjectFixtureError('fixture_receipt_mismatch');
      if (current && !(receipt.phase === 'observe' && receipt.previousReceiptSha256 === null) && receipt.previousReceiptSha256 !== projectFixtureSha256({ receipt: current.receipt, bootstrapSha256: current.bootstrap ? projectFixtureSha256(current.bootstrap) : null })) throw new ProjectFixtureError('fixture_receipt_mismatch');
      if (receipt.ledger.fenceStatus !== 'active' || receipt.ledger.disposition !== 'active' || ['settle', 'cleanup'].includes(receipt.phase) || receipt.decision !== 'allowed' || receipt.effect === 'unknown') retired = true;
      current = structuredClone(envelope);
    },
    witness(credential: string, claimValue: unknown): ProjectFixtureClientWitness {
      const claim = ProjectFixtureNativeClaimSchema.parse(claimValue);
      const digest = createHash('sha256').update(credential).digest();
      const expected = Buffer.from(principal.credentialSha256, 'hex');
      const receipt = current?.receipt;
      if (!timingSafeEqual(digest, expected) || retired || !original || Date.parse(original.grantExpiresAt) <= Date.now() || !bootstrap || !current || !receipt || receipt.decision !== 'allowed' || receipt.ledger.fenceStatus !== 'active' || receipt.ledger.disposition !== 'active' || ['settle', 'cleanup'].includes(receipt.phase) || claim.nativeClient.sessionId === principal.principalRef || claim.nativeClient.sessionId === principal.clientAuthorityId || claim.token !== bootstrap.token || projectFixtureCanonical(claim.nativeClient) !== projectFixtureCanonical(bootstrap.nativeClient) || claim.challenge !== receipt.challenge || claim.receiptSha256 !== projectFixtureSha256({ receipt, bootstrapSha256: current.bootstrap ? projectFixtureSha256(current.bootstrap) : null }) || consumed.has(claim.receiptSha256) || Date.parse(receipt.expiresAt) <= Date.now() || Date.parse(receipt.lease.expiresAt) <= Date.now() || receipt.ledger.pendingEffectIds.length !== 0 || receipt.ledger.throughFence < receipt.lease.fence) throw new ProjectFixtureError('fixture_client_unverified');
      consumed.add(claim.receiptSha256);
      const witness = { schema: 'qautra/project-fixture-client-witness/v1' as const, challenge: receipt.challenge, attemptId: receipt.attemptId, ownerId: receipt.ownerId, subjectSha256: receipt.subjectSha256, adapterSha256: receipt.adapterSha256, scopeSha256: receipt.scopeSha256, receiptSha256: claim.receiptSha256, lease: structuredClone(receipt.lease), clientAuthorityId: principal.clientAuthorityId, principalRef: principal.principalRef, accountRef: principal.accountRef, tenant: principal.tenant, conditions: structuredClone(receipt.state.conditions), nativeClient: structuredClone(claim.nativeClient), observedAt: new Date().toISOString(), expiresAt: receipt.expiresAt };
      return ProjectFixtureClientWitnessSchema.parse({ witness, signature: sign({ witness }) });
    },
    retire(): void { retired = true; },
  });
}

export interface NativeFixtureClientAuthority {
  bootstrap(request: ProjectFixtureRequest, receipt: ProjectFixtureEnvelope['receipt'], adapter: ProjectFixtureAdapter): ProjectFixtureNativeBootstrap;
  advance(envelope: ProjectFixtureEnvelope): void;
  witness(credential: string, claim: unknown): ProjectFixtureClientWitness;
  retire(): void;
}

/** Mount only at the protected HTTPS clientEndpoint; the app's own credential is distinct from controller authority. */
export function nativeFixtureClientHandler(authority: NativeFixtureClientAuthority) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json' || !request.headers.authorization?.startsWith('Bearer ')) throw new Error();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      const probe = NativeProbeSchema.parse(value);
      const credential = request.headers.authorization.slice(7);
      const result = authority.witness(credential, probe.claim);
      const payload = Buffer.from(JSON.stringify({ schema: 'qautra/native-start-authorization/v1', clientProbe: probe.clientProbe, claim: probe.claim, witness: result }), 'utf8');
      const mac = createHmac('sha256', credential).update('qautra/native-client-response/v1\n').update(payload).digest('hex');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ schema: 'qautra/native-client-authenticated-response/v1', payload: payload.toString('base64'), mac }));
    } catch { response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"fixture_client_unverified"}'); }
  };
}
