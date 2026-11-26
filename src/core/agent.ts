import { z } from 'zod';
import { PLATFORMS } from './platform.ts';
import { InstanceRequestSchema, InstanceListSchema, InstanceView, type InstanceRequest } from './instances.ts';
import { PublishedRevisionSchema, RegressionComparisonSchema, RegressionPreflightSchema, RegressionRequestSchema, RegressionRunSchema, RevisionCandidateSchema, ScenarioOriginSchema, type RegressionRequest } from './regression.ts';
import { RegressionGrantDescriptorSchema } from './regression-grant.ts';
import type { Candidate, Platform, Rect, Surface, Verdict } from './types.ts';
import { ExecutionRecoveryViewSchema } from './recovery.ts';

const Id = z.uuid();
const Revision = z.number().int().positive();
const Timeout = z.number().int().min(50).max(120_000);
const Ref = z.string().min(1).max(180);
const Text = z.string().max(65_536);
const TextScope = z.string().min(1).max(100).optional().describe("Only 'observed-text' is supported; absence requires this explicit scope and never certifies visual or whole-page absence");

export const AgentActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tap'), ref: Ref }),
  z.strictObject({ kind: z.literal('longPress'), ref: Ref, holdMs: z.number().int().min(100).max(3000).default(700) }),
  z.strictObject({ kind: z.literal('type'), ref: Ref, text: Text, append: z.boolean().default(false), secure: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('clear'), ref: Ref }),
  z.strictObject({ kind: z.literal('tapAt'), x: z.number().nonnegative(), y: z.number().nonnegative(), units: z.enum(['screenshot-px', 'tap']) }),
  z.strictObject({ kind: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']) }),
  z.strictObject({ kind: z.literal('back') }),
  z.strictObject({ kind: z.literal('press'), key: z.enum(['enter', 'back', 'tab', 'escape', 'delete']) }),
  z.strictObject({ kind: z.literal('open'), url: z.url().max(4096) }),
  z.strictObject({ kind: z.literal('assertText'), text: Text.min(1), absent: z.boolean().default(false), scope: TextScope }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionInput = z.input<typeof AgentActionSchema>;
export const AGENT_MUTATIONS = ['tap', 'longPress', 'type', 'clear', 'tapAt', 'scroll', 'back', 'press', 'open'] as const;

export const SessionRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('session.open'), app: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100), platform: z.enum(PLATFORMS), deviceId: z.string().min(1).max(200) }),
  z.strictObject({ method: z.literal('session.list') }),
  z.strictObject({ method: z.literal('session.status'), sessionId: Id }),
  z.strictObject({ method: z.literal('session.observe'), sessionId: Id }),
  z.strictObject({ method: z.literal('session.screenshot'), sessionId: Id }),
  z.strictObject({ method: z.literal('session.act'), sessionId: Id, revision: Revision, action: AgentActionSchema, timeoutMs: Timeout.default(5000), expectNoChange: z.boolean().default(false) }),
  z.strictObject({ method: z.literal('session.wait'), sessionId: Id, text: Text.min(1), absent: z.boolean().default(false), scope: TextScope, timeoutMs: Timeout.default(5000) }),
  z.strictObject({ method: z.literal('session.close'), sessionId: Id }),
]);
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export type SessionRequestInput = z.input<typeof SessionRequestSchema>;
export const ScriptRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('script.run'), scriptId: Id, source: z.string().min(1).max(262_144), language: z.enum(['javascript', 'typescript']).default('javascript'), sessionIds: z.array(Id).min(1).max(16).refine((ids) => new Set(ids).size === ids.length, 'duplicate session'), deadlineMs: z.number().int().min(100).max(120_000).default(30_000), maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(65_536) }),
  z.strictObject({ method: z.literal('script.status'), scriptId: Id }),
  z.strictObject({ method: z.literal('script.cancel'), scriptId: Id }),
]);
export const ExecutionRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('execution.status'), attemptId: z.string().min(1).max(240).optional() }),
  z.strictObject({ method: z.literal('execution.reconcile') }),
]);
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export const AgentRequestSchema = z.union([SessionRequestSchema, ScriptRequestSchema, InstanceRequestSchema, RegressionRequestSchema, ExecutionRequestSchema]);
export type ScriptRequest = z.infer<typeof ScriptRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentRequestInput = z.input<typeof AgentRequestSchema>;
export type AgentMethod = AgentRequest['method'];
export type Effect = 'not_started' | 'completed' | 'unknown';
export interface AgentMeta {
  requestId: string;
  at: string;
  runId?: string;
  jobId?: string;
  sessionId?: string;
  revision?: number;
  workerId?: string;
  instanceId?: string;
}
export interface AgentError {
  code: string;
  message: string;
  effect: Effect;
  fixtureEffect?: 'not_started' | 'not_committed' | 'committed' | 'unknown';
}
export type AgentReply<T = unknown> = { ok: true; result: T; meta: AgentMeta } | { ok: false; error: AgentError; meta: AgentMeta };
export interface AgentCallContext {
  signal?: AbortSignal;
  scriptId?: string;
  allowedSessionIds?: readonly string[];
  operatorReview?: { principalId: string; channel: 'local-ui' };
}
export interface AgentService {
  call(request: AgentRequestInput, context?: AgentCallContext): Promise<AgentReply>;
  shutdown(): Promise<void>;
}
export interface AgentCapabilities {
  semantic: boolean;
  coordinates: boolean;
  coordinateSpace: 'device-px' | 'points' | 'css-px';
  hostGlobalInput: boolean;
  webview: false;
  recording: false;
  mutationKinds: readonly AgentAction['kind'][];
  modelRequired: false;
  isolation: 'exclusive-host-display' | 'exclusive-device' | 'guest-browser-session' | 'guest-desktop' | 'owned-browser-context';
}
export type AgentSessionState = 'opening' | 'ready' | 'stopped' | 'unknown' | 'closing' | 'closed';
export interface AgentSessionView {
  sessionId: string;
  runId: string;
  workerId: string;
  instanceId: string;
  app: string;
  platform: Platform;
  surface: Surface;
  deviceId: string;
  version: string | null;
  state: AgentSessionState;
  activeScriptId: string | null;
  revision: number;
  createdAt: string;
  capabilities: AgentCapabilities;
  stopReason: string | null;
  machineId?: string | null;
  generation?: number;
  latestFrame?: { revision: number; at: string; screenshot: AgentScreenshot };
  evidenceDir: string;
}
export interface AgentCandidate extends Omit<Candidate, 'key' | 'nodeId'> { ref: string }
export interface AgentScreenshot {
  path: string;
  sha256: string;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  privacy: 'raw-pixels-approved-fixture-only';
}
export interface AgentObservation {
  sessionId: string;
  revision: number;
  at: string;
  screen: Rect;
  candidates: AgentCandidate[];
  texts: string[];
  truncated: boolean;
  /** Describes normalized text coverage, not a visual oracle or complete page/frame traversal. */
  coverage: {
    spatial: 'desktop-viewport' | 'device-screen';
    text: 'normalized-visible-text';
    wholePage: false;
    allRenderedSurfaces: false;
  };
  screenshot: AgentScreenshot;
  capabilities: AgentCapabilities;
}
export interface AgentActionResult {
  observation: AgentObservation;
  effect: Effect;
  step: { seq: number; verdict: Verdict; code: string | null; reason: string; evidenceDir: string };
}
export type ScriptDisposition = 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface AgentScriptView {
  scriptId: string;
  sessionIds: string[];
  state: 'running' | ScriptDisposition;
  startedAt: string;
  endedAt: string | null;
  stdout: string;
  stderr: string;
  result: unknown;
  error: AgentError | null;
  trustBoundary: 'authorized-test-code-not-malicious-code-sandbox';
}

const AgentMetaSchema = z.strictObject({
  requestId: z.string().min(1), at: z.string().min(1), runId: z.string().optional(), jobId: z.string().optional(),
  sessionId: z.string().optional(), revision: z.number().int().nonnegative().optional(),
  workerId: z.string().optional(), instanceId: z.string().optional(),
}) satisfies z.ZodType<AgentMeta>;
const AgentErrorSchema = z.strictObject({
  code: z.string(), message: z.string(), effect: z.enum(['not_started', 'completed', 'unknown']),
  fixtureEffect: z.enum(['not_started', 'not_committed', 'committed', 'unknown']).optional(),
}) satisfies z.ZodType<AgentError>;
export const AgentReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: z.unknown(), meta: AgentMetaSchema }).refine(value => Object.hasOwn(value, 'result')),
  z.strictObject({ ok: z.literal(false), error: AgentErrorSchema, meta: AgentMetaSchema }),
]);
const AgentRectSchema = z.strictObject({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });
const AgentCapabilitiesSchema = z.strictObject({
  semantic: z.boolean(), coordinates: z.boolean(), coordinateSpace: z.enum(['device-px', 'points', 'css-px']),
  hostGlobalInput: z.boolean(), webview: z.literal(false), recording: z.literal(false),
  mutationKinds: z.array(z.enum([...AGENT_MUTATIONS, 'assertText'])), modelRequired: z.literal(false),
  isolation: z.enum(['exclusive-host-display', 'exclusive-device', 'guest-browser-session', 'guest-desktop', 'owned-browser-context']),
}) satisfies z.ZodType<AgentCapabilities>;
const AgentScreenshotSchema = z.strictObject({
  path: z.string().min(1), sha256: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(),
  scaleX: z.number().positive(), scaleY: z.number().positive(), privacy: z.literal('raw-pixels-approved-fixture-only'),
}) satisfies z.ZodType<AgentScreenshot>;
const AgentCandidateSchema = z.strictObject({
  ref: Ref, resourceId: z.string().nullable(), role: z.enum(['button', 'link', 'tab', 'input', 'secure-input', 'switch', 'checkbox', 'heading', 'text', 'image', 'list-item', 'scroll', 'other']),
  name: z.string(), value: z.string().nullable(), state: z.array(z.string()), rect: AgentRectSchema,
  tapPoint: z.strictObject({ x: z.number(), y: z.number() }), actionable: z.boolean(),
  region: z.enum(['top', 'middle', 'bottom']), source: z.enum(['tree', 'ocr']),
}) satisfies z.ZodType<AgentCandidate>;
export const AgentObservationSchema = z.strictObject({
  sessionId: Id, revision: Revision, at: z.string().min(1), screen: AgentRectSchema, candidates: z.array(AgentCandidateSchema),
  texts: z.array(z.string()), truncated: z.boolean(),
  coverage: z.strictObject({ spatial: z.enum(['desktop-viewport', 'device-screen']), text: z.literal('normalized-visible-text'), wholePage: z.literal(false), allRenderedSurfaces: z.literal(false) }),
  screenshot: AgentScreenshotSchema, capabilities: AgentCapabilitiesSchema,
}) satisfies z.ZodType<AgentObservation>;
export const AgentSessionViewSchema = z.strictObject({
  sessionId: Id, runId: z.string().min(1), workerId: z.string().min(1), instanceId: z.string().min(1),
  app: z.string(), platform: z.enum(PLATFORMS), surface: z.enum(['app', 'web']), deviceId: z.string().min(1), version: z.string().nullable(),
  state: z.enum(['opening', 'ready', 'stopped', 'unknown', 'closing', 'closed']), activeScriptId: Id.nullable(),
  revision: z.number().int().nonnegative(), createdAt: z.string().min(1), capabilities: AgentCapabilitiesSchema, stopReason: z.string().nullable(),
  machineId: z.string().nullable().optional(), generation: z.number().int().positive().optional(),
  latestFrame: z.strictObject({ revision: Revision, at: z.string().min(1), screenshot: AgentScreenshotSchema }).optional(), evidenceDir: z.string(),
}) satisfies z.ZodType<AgentSessionView>;
export const AgentActionResultSchema = z.strictObject({
  observation: AgentObservationSchema, effect: z.enum(['not_started', 'completed', 'unknown']),
  step: z.strictObject({ seq: z.number().int().positive(), verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'SKIPPED']), code: z.string().nullable(), reason: z.string(), evidenceDir: z.string() }),
}) satisfies z.ZodType<AgentActionResult>;
export const AgentScriptViewSchema = z.strictObject({
  scriptId: Id, sessionIds: z.array(Id), state: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']),
  startedAt: z.string().min(1), endedAt: z.string().nullable(), stdout: z.string(), stderr: z.string(), result: z.unknown(), error: AgentErrorSchema.nullable(),
  trustBoundary: z.literal('authorized-test-code-not-malicious-code-sandbox'),
}) satisfies z.ZodType<AgentScriptView>;
export const AgentResultSchemas = {
  'session.open': AgentSessionViewSchema, 'session.status': AgentSessionViewSchema, 'session.close': AgentSessionViewSchema,
  'session.list': z.array(AgentSessionViewSchema),
  'session.observe': AgentObservationSchema, 'session.screenshot': AgentObservationSchema,
  'session.act': AgentActionResultSchema, 'session.wait': AgentActionResultSchema,
  'script.run': AgentScriptViewSchema, 'script.status': AgentScriptViewSchema, 'script.cancel': AgentScriptViewSchema,
  'instance.list': InstanceListSchema, 'instance.create': InstanceView, 'instance.status': InstanceView, 'instance.start': InstanceView,
  'instance.prepare': InstanceView, 'instance.stop': InstanceView, 'instance.show': InstanceView, 'instance.hide': InstanceView,
  'execution.status': ExecutionRecoveryViewSchema, 'execution.reconcile': ExecutionRecoveryViewSchema,
  'scenario.preview': RevisionCandidateSchema, 'scenario.publish': PublishedRevisionSchema, 'scenario.get': PublishedRevisionSchema,
  'scenario.list': z.array(PublishedRevisionSchema), 'scenario.origin': ScenarioOriginSchema,
  'regression.grants': z.array(RegressionGrantDescriptorSchema), 'regression.preflight': RegressionPreflightSchema,
  'regression.submit': RegressionRunSchema, 'regression.status': RegressionRunSchema, 'regression.stop': RegressionRunSchema,
  'regression.list': z.array(RegressionRunSchema), 'regression.compare': RegressionComparisonSchema,
} satisfies Record<SessionRequest['method'] | ScriptRequest['method'] | InstanceRequest['method'] | ExecutionRequest['method'] | RegressionRequest['method'], z.ZodType>;
export type AgentResultFor<Method extends AgentMethod> = Method extends keyof typeof AgentResultSchemas
  ? z.output<(typeof AgentResultSchemas)[Method]> : unknown;

export class AgentExecutionError extends Error {
  readonly code: string;
  readonly effect: Effect;

  constructor(code: string, message: string, effect: Effect = 'not_started') {
    super(message);
    this.name = 'AgentExecutionError';
    this.code = code;
    this.effect = effect;
  }
}
