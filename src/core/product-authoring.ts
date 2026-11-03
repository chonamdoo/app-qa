import { z } from 'zod';
import { PLATFORMS } from './platform.ts';
import { ProductDocument, ProductRevision, SourceIssue } from './product.ts';

export const AUTHORING_MAX_PAYLOAD = 768 * 1024;
export const AUTHORING_MAX_REPLY = 256 * 1024;
export const AUTHORING_MODEL = 'sonnet';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1).max(20_000);
const Selector = z.union([
  z.strictObject({ id: Text }), z.strictObject({ text: Text }), z.strictObject({ desc: Text }),
]);
export const AuthoringStep = z.union([
  z.strictObject({ assertText: Text }), z.strictObject({ assertNoText: Text }),
  z.strictObject({ see: Selector }), z.strictObject({ tap: Selector }),
  z.strictObject({ type: Text, into: Selector }), z.strictObject({ clear: Selector }),
  z.strictObject({ wait: z.strictObject({ until: Selector }) }),
]);
export const AuthoringProposal = z.strictObject({
  name: z.string().trim().min(1).max(200), steps: z.array(AuthoringStep).min(1).max(200),
  expectations: z.array(z.strictObject({
    documentID: z.uuid(), segmentID: z.string().min(1).max(1000), quote: Text,
    checkIndex: z.number().int().min(0).max(199),
  })).min(1).max(1000), issues: z.array(SourceIssue).max(1000),
});
export type AuthoringProposal = z.infer<typeof AuthoringProposal>;
export const AuthoringSelection = z.strictObject({
  revision: ProductRevision, app: z.string().regex(/^[\w.-]+$/).max(200),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(6), documentIDs: z.array(z.uuid()).min(1).max(30),
});
export const AuthoringPayload = z.strictObject({
  schema: z.literal('qautra/authoring-input/v1'), provider: z.literal('claude-cli'), model: z.literal(AUTHORING_MODEL),
  selection: AuthoringSelection,
  documents: z.array(z.strictObject({ document: ProductDocument, originalBase64: z.string() })).min(1).max(30),
  instruction: z.string(), outputSchema: z.record(z.string(), z.unknown()),
});
export type AuthoringPayload = z.infer<typeof AuthoringPayload>;
export const AuthoringJob = z.strictObject({
  schema: z.literal('qautra/authoring-job/v1'), requestID: z.uuid(), generation: z.uuid(),
  createdAt: z.iso.datetime(), principalId: z.string().min(1),
  status: z.enum(['prepared', 'sending', 'proposed', 'failed', 'cancelled', 'uncertain', 'applying', 'applied']),
  payload: AuthoringPayload, transmittedPayload: z.string().max(AUTHORING_MAX_PAYLOAD), payloadDigest: Digest,
  consent: z.strictObject({ payloadDigest: Digest, generation: z.uuid(), provider: z.literal('claude-cli'), model: z.literal(AUTHORING_MODEL),
    principalId: z.string().min(1), acceptedAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable() }).nullable(),
  proposal: AuthoringProposal.nullable(), problem: z.string().nullable(), scenarioID: z.uuid().nullable(),
});
export type AuthoringJob = z.infer<typeof AuthoringJob>;
export const AuthoringAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('capabilities') }), z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('prepare'), requestID: z.uuid(), selection: AuthoringSelection }),
  z.strictObject({ action: z.literal('start'), requestID: z.uuid(), generation: z.uuid(), payloadDigest: Digest,
    consent: z.literal(true), provider: z.literal('claude-cli'), model: z.literal(AUTHORING_MODEL) }),
  z.strictObject({ action: z.literal('status'), requestID: z.uuid() }),
  z.strictObject({ action: z.literal('cancel'), requestID: z.uuid() }),
  z.strictObject({ action: z.literal('revoke'), requestID: z.uuid() }),
  z.strictObject({ action: z.literal('apply'), requestID: z.uuid(), generation: z.uuid(), payloadDigest: Digest }),
]);
export interface AuthoringCapabilities {
  provider: 'claude-cli'; model: typeof AUTHORING_MODEL; available: boolean; reason: string; version: string | null;
}
export interface ProductAuthoringAdapter {
  capabilities(): Promise<AuthoringCapabilities>;
  interpret(payload: string, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<string>;
}
export interface AuthoringJobSummary {
  requestID: string; generation: string; createdAt: string; status: AuthoringJob['status']; problem: string | null;
}
