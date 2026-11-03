import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRequestSchema, AgentReplySchema, AgentResultSchemas, type AgentMethod, type AgentRequest, type AgentResultFor, type AgentActionInput, type AgentActionResult, type AgentError, type AgentMeta, type AgentObservation, type AgentRequestInput, type AgentScriptView, type AgentSessionView } from './agent.ts';
import { PATHS } from './config.ts';

export type AgentTransport = (request: AgentRequestInput, signal?: AbortSignal) => Promise<unknown>;
export class AgentClientError extends Error {
  readonly code: string;
  readonly effect: AgentError['effect'];
  readonly meta: AgentMeta | undefined;
  readonly fixtureEffect: AgentError['fixtureEffect'];

  constructor(error: AgentError, meta?: AgentMeta) {
    super(error.message);
    this.name = 'AgentClientError';
    this.code = error.code;
    this.effect = error.effect;
    this.meta = meta;
    this.fixtureEffect = error.fixtureEffect;
  }
}
const failure = (code: string, message: string, effect: AgentError['effect'] = 'not_started'): AgentClientError => new AgentClientError({ code, message, effect });
export interface AgentActOptions { timeoutMs?: number; expectNoChange?: boolean }
export interface AgentTypeOptions extends AgentActOptions { append?: boolean; secure?: boolean }
/** Absence requires scope: 'observed-text'; other scopes are refused by the session executor. */
export interface AgentWaitOptions { timeoutMs?: number; absent?: boolean; scope?: string }
export interface AgentSessionClient {
  readonly sessionId: string;
  readonly revision: number | null;
  observe(signal?: AbortSignal): Promise<AgentObservation>;
  screenshot(signal?: AbortSignal): Promise<AgentObservation>;
  status(signal?: AbortSignal): Promise<AgentSessionView>;
  act(action: AgentActionInput, options?: AgentActOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  tap(refOrExactLabel: string, options?: AgentActOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  type(refOrExactLabel: string, text: string, options?: AgentTypeOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  clear(refOrExactLabel: string, options?: AgentActOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  tapAt(x: number, y: number, units?: 'screenshot-px' | 'tap', options?: AgentActOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  wait(text: string, options?: AgentWaitOptions, signal?: AbortSignal): Promise<AgentActionResult>;
  assertText(text: string, signal?: AbortSignal): Promise<AgentActionResult>;
  close(signal?: AbortSignal): Promise<AgentSessionView>;
}
export interface AgentRunScriptOptions {
  source: string;
  sessionIds: string[];
  language?: 'javascript' | 'typescript';
  deadlineMs?: number;
  maxOutputBytes?: number;
  scriptId?: string;
}
export interface AgentClient {
  request<R extends AgentRequestInput>(request: R, signal?: AbortSignal): Promise<AgentResultFor<R['method']>>;
  session(sessionId: string): AgentSessionClient;
  runScript(options: AgentRunScriptOptions, signal?: AbortSignal): Promise<AgentScriptView>;
  scriptStatus(scriptId: string, signal?: AbortSignal): Promise<AgentScriptView>;
  cancelScript(scriptId: string, signal?: AbortSignal): Promise<AgentScriptView>;
}
export interface AgentScriptClient extends AgentClient {
  readonly sessionIds: readonly string[];
}

/**
 * Whether a schema-valid result is about the session, script, instance, revision or run the request named. Exhaustive,
 * so a new method fails to compile until its identity rule is decided.
 */
export function answersRequest(request: AgentRequest, result: unknown): boolean {
  const as = <M extends AgentMethod>(_method: M) => result as AgentResultFor<M>;
  switch (request.method) {
    case 'session.open': { const view = as(request.method); return view.app === request.app && view.platform === request.platform && view.deviceId === request.deviceId; }
    case 'session.act': case 'session.wait': return as(request.method).observation.sessionId === request.sessionId;
    case 'session.status': case 'session.close': case 'session.observe': case 'session.screenshot': return as(request.method).sessionId === request.sessionId;
    case 'script.run': case 'script.status': case 'script.cancel': return as(request.method).scriptId === request.scriptId;
    case 'instance.status': case 'instance.start': case 'instance.prepare': case 'instance.stop': case 'instance.show': case 'instance.hide':
      return as(request.method).id === request.instanceId;
    case 'instance.create': return as(request.method).profileId === request.profileId;
    case 'scenario.get': return as(request.method).revisionId === request.revisionId;
    case 'scenario.origin': { const origin = as(request.method); return origin.revisionId === request.revisionId && origin.testId === request.testId; }
    case 'scenario.publish': { const { review } = as(request.method); return review.candidateId === request.candidateId && review.digest === request.digest; }
    case 'regression.submit': case 'regression.status': case 'regression.stop': return as(request.method).requestId === request.requestId;
    case 'regression.compare': { const comparison = as(request.method); return comparison.before === request.before && comparison.after === request.after; }
    // Lists, previews and engine-wide recovery views name no single identity the reply could contradict.
    case 'session.list': case 'instance.list': case 'scenario.list': case 'scenario.preview': case 'regression.grants': case 'regression.preflight':
    case 'regression.list': case 'execution.status': case 'execution.reconcile':
      return true;
    default: {
      const unhandled: never = request;
      return unhandled;
    }
  }
}

export function createAgentClient(transport: AgentTransport): AgentClient {
  const request: AgentClient['request'] = async <R extends AgentRequestInput>(input: R, signal?: AbortSignal): Promise<AgentResultFor<R['method']>> => {
    const parsed = AgentRequestSchema.safeParse(input);
    if (!parsed.success) throw failure('invalid_request', 'Agent request does not match the shared schema');
    if (signal?.aborted) throw failure('cancelled', 'Agent request cancelled before dispatch');
    let wire: unknown;
    try { wire = await transport(parsed.data, signal); }
    catch (error) {
      if (error instanceof AgentClientError) throw error;
      throw failure(signal?.aborted ? 'cancelled' : 'transport_error', 'Agent transport failed; request was not retried', 'unknown');
    }
    const envelope = AgentReplySchema.safeParse(wire);
    if (!envelope.success) throw failure('invalid_response', 'Agent response does not match the shared envelope', 'unknown');
    const reply = envelope.data;
    if (!reply.ok) throw new AgentClientError(reply.error, reply.meta);
    const method = parsed.data.method;
    let result = reply.result;
    if (Object.hasOwn(AgentResultSchemas, method)) {
      const checked = AgentResultSchemas[method as keyof typeof AgentResultSchemas].safeParse(result);
      if (!checked.success) throw failure('invalid_response', 'Agent result does not match the requested method', 'unknown');
      result = checked.data;
    }
    if (!answersRequest(parsed.data, result)) throw failure('invalid_response', 'Agent result belongs to a different request identity', 'unknown');
    return result as AgentResultFor<R['method']>;
  };
  return {
    request,
    session(sessionId) {
      let latest: AgentObservation | null = null;
      const remember = (observation: AgentObservation): AgentObservation => {
        if (observation.sessionId !== sessionId) throw failure('invalid_response', 'Observation belongs to another session', 'unknown');
        latest = observation;
        return observation;
      };
      const observed = (): AgentObservation => {
        if (!latest) throw failure('observation_required', 'Observe this explicit session before acting');
        return latest;
      };
      const target = (value: string, editable: boolean): string => {
        const observation = observed();
        const ref = observation.candidates.find((c) => c.ref === value);
        if (ref) return ref.ref;
        const matches = observation.candidates.filter((c) => c.name === value);
        const narrowed = matches.filter((c) => editable ? c.role === 'input' || c.role === 'secure-input' : c.actionable);
        const candidates = narrowed.length ? narrowed : matches;
        if (candidates.length !== 1) throw failure(candidates.length ? 'ambiguous_target' : 'stale_ref', candidates.length ? 'Exact label is not unique in this observation' : 'Reference or exact label is absent from this observation');
        return candidates[0]!.ref;
      };
      const act: AgentSessionClient['act'] = async (action, options = {}, signal) => {
        const observation = observed();
        if ('ref' in action && !observation.candidates.some((c) => c.ref === action.ref)) throw failure('stale_ref', 'Reference is not from this session observation');
        const result = await request({ method: 'session.act', sessionId, revision: observation.revision, action, ...options }, signal);
        remember(result.observation);
        return result;
      };
      return {
        sessionId,
        get revision() { return latest?.revision ?? null; },
        observe: async (signal) => remember(await request({ method: 'session.observe', sessionId }, signal)),
        screenshot: async (signal) => remember(await request({ method: 'session.screenshot', sessionId }, signal)),
        status: (signal) => request({ method: 'session.status', sessionId }, signal),
        act,
        tap: async (value, options, signal) => act({ kind: 'tap', ref: target(value, false) }, options, signal),
        type: async (value, text, options = {}, signal) => {
          const { append, secure, ...actOptions } = options;
          return act({ kind: 'type', ref: target(value, true), text, append, secure }, actOptions, signal);
        },
        clear: async (value, options, signal) => act({ kind: 'clear', ref: target(value, true) }, options, signal),
        tapAt: (x, y, units = 'screenshot-px', options, signal) => act({ kind: 'tapAt', x, y, units }, options, signal),
        wait: async (text, options = {}, signal) => {
          const result = await request({ method: 'session.wait', sessionId, text, ...options }, signal);
          remember(result.observation);
          return result;
        },
        assertText: (text, signal) => act({ kind: 'assertText', text }, undefined, signal),
        close: async (signal) => {
          const result = await request({ method: 'session.close', sessionId }, signal);
          latest = null;
          return result;
        },
      };
    },
    runScript: ({ scriptId = randomUUID(), ...options }, signal) => request({ method: 'script.run', scriptId, ...options }, signal),
    scriptStatus: (scriptId, signal) => request({ method: 'script.status', scriptId }, signal),
    cancelScript: (scriptId, signal) => request({ method: 'script.cancel', scriptId }, signal),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw failure('invalid_response', 'Engine returned no response body', 'unknown');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw failure('invalid_response', 'Engine response exceeded 4 MiB', 'unknown');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw failure('invalid_response', 'Engine response is not valid JSON', 'unknown'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export interface EngineRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}
export interface EngineClient {
  request<T = unknown>(path: string, options?: EngineRequestOptions): Promise<T>;
}
export class EngineHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Engine returned HTTP ${status}; the request was not retried`);
    this.name = 'EngineHttpError';
    this.status = status;
  }
}

interface EngineDiscovery { port: number; token: string; pid: number }

function parseDiscovery(value: unknown): EngineDiscovery | null {
  if (!value || typeof value !== 'object') return null;
  const { port, token, pid } = value as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  return { port, token, pid };
}

function parseHealthIdentity(value: unknown): { pid: unknown; root: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { ok, pid, root } = value as Record<string, unknown>;
  return ok === true && typeof root === 'string' ? { pid, root } : null;
}

async function connectEngineTransport(options: { root?: string }) {
  const root = await realpath(options.root ?? PATHS.root);
  const file = await open(join(root, '.qa', 'server.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const stat = await file.stat();
    const ownedPrivateFile = stat.isFile() && (stat.mode & 0o777) === 0o600 && (!process.getuid || stat.uid === process.getuid()) && stat.size <= 16_384;
    if (!ownedPrivateFile) throw failure('invalid_discovery', 'Engine discovery must be an owned 0600 regular file');
    raw = JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
  const discovery = parseDiscovery(raw);
  if (!discovery) throw failure('malformed_discovery', 'Engine discovery is invalid; start qa serve explicitly');
  const base = `http://127.0.0.1:${discovery.port}`;
  const headers = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' };
  const health = await fetch(`${base}/api/health`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  const identity = parseHealthIdentity(await boundedJson(health));
  if (!health.ok || !identity) throw failure('engine_unhealthy', 'Authenticated engine health check failed');
  if (identity.pid !== discovery.pid) throw failure('engine_identity_mismatch', 'Authenticated engine process does not match this project discovery');
  if (await realpath(identity.root) !== root) throw failure('engine_root_mismatch', 'Authenticated engine serves a different project root');
  return async (path: string, options: EngineRequestOptions = {}) => {
    if (!path.startsWith('/api/') || path.includes('#') || path.includes('\\')) throw failure('invalid_request', 'Engine requests require a project API path');
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'error', signal: options.signal });
    return { response, body: await boundedJson(response) };
  };
}

export async function connectEngineClient(options: { root?: string } = {}): Promise<EngineClient> {
  const transport = await connectEngineTransport(options);
  return {
    async request<T>(path: string, options: EngineRequestOptions = {}): Promise<T> {
      try {
        const { response, body } = await transport(path, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
        if (!response.ok) throw new EngineHttpError(response.status);
        return body as T;
      } catch (error) {
        if (error instanceof AgentClientError || error instanceof EngineHttpError) throw error;
        throw failure(options.signal?.aborted ? 'cancelled' : 'transport_error', 'Engine connection failed; request was not retried', 'unknown');
      }
    },
  };
}

/** Allowance on top of the request's own `timeoutMs`/`deadlineMs` before the whole HTTP call (headers and body) is abandoned. */
const AGENT_CALL_MARGIN_MS = 60_000;

function declaredBoundMs(request: AgentRequestInput): number {
  if ('timeoutMs' in request && typeof request.timeoutMs === 'number') return request.timeoutMs;
  if ('deadlineMs' in request && typeof request.deadlineMs === 'number') return request.deadlineMs;
  return 0;
}

export async function connectAgentClient(options: { root?: string; deadlineMarginMs?: number } = {}): Promise<AgentClient> {
  const transport = await connectEngineTransport(options);
  const margin = options.deadlineMarginMs ?? AGENT_CALL_MARGIN_MS;
  return createAgentClient(async (request, signal) => {
    const deadline = AbortSignal.timeout(declaredBoundMs(request) + margin);
    try {
      const { response, body: reply } = await transport('/api/agent', { method: 'POST', body: request, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) throw failure('transport_error', `Engine returned an unsuccessful agent response (${response.status})`, 'unknown');
      return reply;
    } catch (error) {
      if (error instanceof AgentClientError) throw error;
      if (signal?.aborted) throw failure('cancelled', 'Agent request cancelled; effect must be reconciled', 'unknown');
      if (deadline.aborted) throw failure('deadline_exceeded', 'Agent request exceeded its deadline; effect must be reconciled and the request was not retried', 'unknown');
      throw failure('transport_error', 'Engine connection failed; request was not retried', 'unknown');
    }
  });
}
