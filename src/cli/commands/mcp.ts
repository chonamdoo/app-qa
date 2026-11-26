import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AgentClientError, connectAgentClient, type AgentClient } from '../../core/agent-client.ts';
import { AgentRequestSchema, ScriptRequestSchema, SessionRequestSchema, type AgentMethod } from '../../core/agent.ts';
import { InstanceRequestSchema } from '../../core/instances.ts';
import { RegressionRequestSchema } from '../../core/regression.ts';

const VERSIONS = ['2025-11-25', '2025-06-18'] as const;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE = 32;
type RpcId = string | number;
type RpcObject = Record<string, unknown>;
const requestSchemas = [...SessionRequestSchema.options, ...ScriptRequestSchema.options, ...InstanceRequestSchema.options, ...RegressionRequestSchema.options];
type McpMethod = (typeof requestSchemas)[number]['shape']['method']['value'];
const descriptions: Record<McpMethod, string> = {
  'session.open': 'Open an explicitly configured app, platform and device; project policy remains authoritative.',
  'session.list': 'List engine-owned sessions without choosing an implicit current session.',
  'session.status': 'Read one explicit session state and capabilities.',
  'session.observe': 'Observe one session and obtain fresh revision-bound candidate references.',
  'session.screenshot': 'Obtain a fresh observation and approved-fixture screenshot metadata; raw pixels are not included.',
  'session.act': 'Act on an explicit observation revision. Text is literal. Never retry an unknown effect or refresh stale references.',
  'session.wait': 'Wait for deterministic literal text evidence in an explicit session.',
  'session.close': 'Close an explicit session; unconfirmed close retains resource ownership.',
  'script.run': 'Execute bounded authorized JavaScript/erasable TypeScript source over explicit sessions; not a malicious-code sandbox or business PASS.',
  'script.status': 'Read retained script state, bounded output and effect error.',
  'script.cancel': 'Revoke one script authority; cancellation is not rollback.',
  'instance.list': 'List owned Chrome contexts and prepared real Safari workers. Runtime availability is not a verified first frame or business PASS.',
  'instance.create': 'Local QA operator action only. A model cannot create browser or VM authority.',
  'instance.status': 'Read installation, guest connection, readiness and ownership state without launching a browser.',
  'instance.start': 'Local QA operator action only. Chrome is VM-free; real Safari requires a prepared macOS worker.',
  'instance.prepare': 'Local QA operator preparation only; never proof of a business result.',
  'instance.stop': 'Local QA operator resource action only. Unknown effects require reconciliation.',
  'instance.show': 'Local QA operator window action only; automated QA must not change host focus.',
  'instance.hide': 'Local QA operator window action only; hiding a window is not cleanup.',
  'scenario.preview': 'Build a frozen review candidate from project-local scenario files. Validation problems block publication; preview never executes tests.',
  'scenario.publish': 'Local QA operator review only. Publication binds the reviewed digest/checks, grants no target authority and is not runtime PASS.',
  'scenario.list': 'List immutable published scenario revisions, without discovering or executing mutable drafts.',
  'scenario.get': 'Read and verify one immutable published scenario revision.',
  'scenario.origin': 'Local QA reader only. Read the original captured source, never a current mutable file or model disclosure authority.',
  'regression.grants': 'List redacted owner-provisioned grant descriptors. Metadata is not live principal or fixture proof and grants no new authority.',
  'regression.preflight': 'Inspect frozen definitions, declared scope, target adapters and local-user execution capacity without running QA. Actual baseline, client authority and first video frame are checked after ownership is acquired.',
  'regression.submit': 'Queue a frozen regression with an explicit stable request UUID, revisions and actual targets. Reuse the same UUID to reconcile a lost reply; never substitute a new request.',
  'regression.status': 'Read durable run, attempt, business, evidence and cleanup states. Unknown effects are not retried.',
  'regression.list': 'List durable regression records, including unknown and unfinished attempts.',
  'regression.stop': 'Request stop for the existing request UUID. Cancellation is not rollback; await evidence finalization and confirmed cleanup.',
  'regression.compare': 'Compare retained immutable attempts without replaying actions or replacing previous results.',
};
const operatorOnly = new Set<AgentMethod>(['scenario.publish', 'scenario.origin', 'instance.create', 'instance.start', 'instance.prepare', 'instance.stop', 'instance.show', 'instance.hide']);
const tools = requestSchemas.filter(schema => !operatorOnly.has(schema.shape.method.value)).map((schema) => {
  const method = schema.shape.method.value;
  const { method: _method, ...shape } = schema.shape;
  return { name: `qa_${method.replace('.', '_')}`, description: descriptions[method], inputSchema: z.toJSONSchema(z.strictObject(shape)), method };
});
const object = (value: unknown): value is RpcObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcId = (value: unknown): value is RpcId => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

export async function runMcpStdio(options: { client: AgentClient; input: AsyncIterable<Buffer | string>; output: Writable; signal?: AbortSignal }): Promise<void> {
  let phase: 'new' | 'initializing' | 'ready' = 'new';
  let ended = false;
  let pending = Buffer.alloc(0);
  let outputBytes = 0;
  let writing = Promise.resolve();
  const active = new Map<RpcId, AbortController>();
  const abortAll = () => { for (const controller of active.values()) controller.abort(); };
  options.signal?.addEventListener('abort', abortAll);
  options.output.on('error', abortAll);
  const send = (message: RpcObject): Promise<void> => {
    if (ended || options.output.destroyed) return Promise.resolve();
    const line = `${JSON.stringify(message)}\n`;
    const size = Buffer.byteLength(line);
    if (size > MAX_REPLY_BYTES || outputBytes + size > 8 * MAX_REPLY_BYTES) {
      ended = true;
      abortAll();
      return Promise.resolve();
    }
    outputBytes += size;
    writing = writing.then(() => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      options.output.write(line, (error) => {
        outputBytes -= size;
        if (error) reject(error);
        else resolve();
      });
      return promise;
    }).catch(() => { ended = true; abortAll(); });
    return writing;
  };
  const protocolError = (id: RpcId | null, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id: RpcId, value: unknown) => send({ jsonrpc: '2.0', id, result: value });
  const toolCall = async (id: RpcId, params: RpcObject, controller: AbortController): Promise<void> => {
    try {
      const tool = tools.find((entry) => entry.name === params.name);
      if (!tool) { await protocolError(id, -32602, 'Unknown tool'); return; }
      const args = params.arguments ?? {};
      if (!object(args)) { await protocolError(id, -32602, 'Tool arguments must be an object'); return; }
      const parsed = AgentRequestSchema.safeParse({ ...args, method: tool.method });
      if (!parsed.success || Object.hasOwn(args, 'method')) {
        await result(id, { isError: true, content: [{ type: 'text', text: 'Tool arguments do not match the shared agent schema' }], structuredContent: { ok: false, error: { code: 'invalid_request', message: 'Tool arguments do not match the shared agent schema', effect: 'not_started' } } });
        return;
      }
      const value = await options.client.request(parsed.data, controller.signal);
      const structuredContent = { ok: true, result: value };
      const content = JSON.stringify(structuredContent);
      if (Buffer.byteLength(content) > MAX_REPLY_BYTES / 2 - 4096) throw new AgentClientError({ code: 'output_limit', message: 'Tool response exceeds the stdio output limit; read retained session/script state', effect: 'unknown' });
      await result(id, { isError: false, content: [{ type: 'text', text: content }], structuredContent });
    } catch (error) {
      const domain = error instanceof AgentClientError ? { code: error.code, message: error.message, effect: error.effect, fixtureEffect: error.fixtureEffect } : { code: 'transport_error', message: 'Engine request failed; reconcile state before retrying', effect: 'unknown' };
      const structuredContent = { ok: false, error: domain, ...(error instanceof AgentClientError && error.meta ? { meta: error.meta } : {}) };
      await result(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
    } finally { active.delete(id); }
  };
  const dispatch = async (line: Buffer): Promise<void> => {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown; }
    catch { await protocolError(null, -32700, 'Parse error'); return; }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && !rpcId(message.id)) || (message.params !== undefined && !object(message.params))) {
      await protocolError(object(message) && rpcId(message.id) ? message.id : null, -32600, 'Invalid Request');
      return;
    }
    const params = object(message.params) ? message.params : {};
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      else if (message.method === 'notifications/cancelled' && rpcId(params.requestId)) active.get(params.requestId)?.abort();
      return;
    }
    const id = message.id as RpcId;
    if (active.has(id)) { await protocolError(id, -32600, 'Request ID is already active'); return; }
    if (message.method === 'initialize') {
      if (phase !== 'new') { await protocolError(id, -32600, 'Already initialized'); return; }
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        await protocolError(id, -32602, 'Invalid initialize parameters'); return;
      }
      const protocolVersion = VERSIONS.find((version) => version === params.protocolVersion) ?? VERSIONS[0];
      phase = 'initializing';
      await result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'qautra', version: '0.1.0' } });
      return;
    }
    if (message.method === 'ping') { await result(id, {}); return; }
    if (phase !== 'ready') { await protocolError(id, -32600, 'Initialize and send notifications/initialized first'); return; }
    if (message.method === 'tools/list') {
      if (params.cursor !== undefined) { await protocolError(id, -32602, 'Unknown tools cursor'); return; }
      await result(id, { tools: tools.map(({ method: _method, ...tool }) => tool) });
      return;
    }
    if (message.method !== 'tools/call') { await protocolError(id, -32601, 'Method not found'); return; }
    if (typeof params.name !== 'string') { await protocolError(id, -32602, 'Tool name is required'); return; }
    if (active.size >= MAX_ACTIVE) { await protocolError(id, -32000, 'Too many active calls'); return; }
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    active.set(id, controller);
    void toolCall(id, params, controller);
  };
  try {
    for await (const raw of options.input) {
      if (ended) break;
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
      let offset = 0;
      while (offset < chunk.length && !ended) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const fragment = chunk.subarray(offset, end);
        if (pending.length + fragment.length > MAX_FRAME_BYTES) {
          await protocolError(null, -32600, 'Message exceeds 1 MiB');
          ended = true;
          break;
        }
        pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
        if (newline !== -1) {
          await dispatch(pending);
          pending = Buffer.alloc(0);
        }
        offset = end + 1;
      }
      if (ended) break;
    }
    if (pending.length && !ended) await protocolError(null, -32700, 'Incomplete newline-delimited JSON-RPC frame');
  } finally {
    ended = true;
    abortAll();
    options.signal?.removeEventListener('abort', abortAll);
    await writing;
    options.output.off('error', abortAll);
  }
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const controller = new AbortController();
  const cancel = () => { controller.abort(); process.stdin.destroy(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: { root: { type: 'string' } } });
    const client = await connectAgentClient({ root: values.root });
    await runMcpStdio({ client, input: process.stdin, output: process.stdout, signal: controller.signal });
    return 0;
  } catch {
    process.stderr.write('qa mcp: cannot attach to the authenticated engine or read stdio; start qa serve explicitly\n');
    return 2;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
