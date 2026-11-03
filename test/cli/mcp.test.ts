import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { runMcpStdio } from '../../src/cli/commands/mcp.ts';
import { AgentClientError, createAgentClient, type AgentClient } from '../../src/core/agent-client.ts';
import type { AgentReply } from '../../src/core/agent.ts';

interface RpcReply {
  jsonrpc: string;
  id: string | number | null;
  error?: { code: number; message: string };
  result?: { protocolVersion?: string; capabilities?: unknown; tools?: { name: string; inputSchema: { type?: string } }[]; isError?: boolean; structuredContent?: { ok: boolean; result?: unknown; error?: { code: string; effect: string } }; content?: { type: string; text: string }[] };
}
function stdio(client: AgentClient) {
  const input = new PassThrough();
  const inbox: RpcReply[] = [];
  const waiters = new Map<RpcReply['id'], PromiseWithResolvers<RpcReply>>();
  const output = new Writable({ write(chunk: Buffer, _encoding, done) {
    try {
      const reply = JSON.parse(chunk.toString('utf8')) as RpcReply;
      assert.equal(reply.jsonrpc, '2.0');
      const waiter = waiters.get(reply.id);
      if (waiter) { waiters.delete(reply.id); waiter.resolve(reply); }
      else inbox.push(reply);
      done();
    } catch (error) { done(error as Error); }
  } });
  const running = runMcpStdio({ client, input, output });
  const send = (value: unknown) => { input.write(`${JSON.stringify(value)}\n`); };
  const response = (id: RpcReply['id']): Promise<RpcReply> => {
    const index = inbox.findIndex((entry) => entry.id === id);
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]!);
    const waiter = Promise.withResolvers<RpcReply>();
    waiters.set(id, waiter);
    return waiter.promise;
  };
  return {
    input, output, send, response, inbox, running,
    async initialize(version = '2025-06-18') {
      send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'behavior-test', version: '1' } } });
      const reply = await response('init');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return reply;
    },
    async close() { input.end(); await running; output.destroy(); },
  };
}
const success = (result: unknown): AgentReply => ({ ok: true, result, meta: { requestId: randomUUID(), at: new Date().toISOString() } });

test('MCP negotiates initialize, requires initialized notification and advertises only real tools', { timeout: 10_000 }, async () => {
  const rpc = stdio(createAgentClient(async () => { throw new Error('No tool should execute'); }));
  try {
    rpc.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal((await rpc.response(1)).error?.code, -32600);
    const initialized = await rpc.initialize();
    assert.equal(initialized.result?.protocolVersion, '2025-06-18');
    assert.deepEqual(initialized.result?.capabilities, { tools: {} });
    rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await rpc.response(2)).result?.tools;
    assert.ok(tools?.every((tool) => tool.inputSchema.type === 'object'));
    assert.ok(tools?.some((tool) => tool.name === 'qa_session_act'));
    assert.ok(tools?.some((tool) => tool.name === 'qa_script_cancel'));
    rpc.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal((await rpc.response(3)).error?.code, -32601);
    rpc.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 'invented' } });
    assert.equal((await rpc.response(4)).error?.code, -32602);
  } finally { await rpc.close(); }
  const unsupported = stdio(createAgentClient(async () => success(null)));
  try { assert.equal((await unsupported.initialize('2099-01-01')).result?.protocolVersion, '2025-11-25'); }
  finally { await unsupported.close(); }
});

test('MCP cannot advertise or dispatch private local-QA original-source reads', { timeout: 10_000 }, async () => {
  const rpc = stdio(createAgentClient(async () => { throw new Error('Private source must never reach model dispatch'); }));
  try {
    await rpc.initialize();
    rpc.send({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
    const tools = (await rpc.response('list')).result?.tools;
    assert.ok(tools);
    assert.equal(tools.some(tool => tool.name === 'qa_scenario_origin'), false);
    rpc.send({ jsonrpc: '2.0', id: 'read', method: 'tools/call', params: { name: 'qa_scenario_origin', arguments: { revisionId: 'a'.repeat(64), testId: 'TC-007' } } });
    assert.equal((await rpc.response('read')).error?.code, -32602);
  } finally { await rpc.close(); }
});

test('MCP separates protocol errors from domain isError and preserves structured unknown effect', { timeout: 10_000 }, async () => {
  let calls = 0;
  const rpc = stdio(createAgentClient(async () => { calls++; return { ok: false, error: { code: 'UNKNOWN_OUTCOME', message: 'No replay', effect: 'unknown' }, meta: { requestId: randomUUID(), at: new Date().toISOString() } }; }));
  try {
    await rpc.initialize();
    rpc.input.write('{broken}\n');
    assert.equal((await rpc.response(null)).error?.code, -32700);
    rpc.send({ jsonrpc: '2.0', id: 'unknown', method: 'tools/call', params: { name: 'not-a-tool' } });
    assert.equal((await rpc.response('unknown')).error?.code, -32602);
    rpc.send({ jsonrpc: '2.0', id: 'invalid', method: 'tools/call', params: { name: 'qa_session_list', arguments: { allowRisky: true } } });
    const invalid = await rpc.response('invalid');
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.result?.isError, true);
    assert.equal(invalid.result?.structuredContent?.error?.effect, 'not_started');
    assert.equal(calls, 0);
    rpc.send({ jsonrpc: '2.0', id: 'domain', method: 'tools/call', params: { name: 'qa_session_status', arguments: { sessionId: randomUUID() } } });
    const domain = await rpc.response('domain');
    assert.equal(domain.error, undefined);
    assert.equal(domain.result?.isError, true);
    assert.equal(domain.result?.structuredContent?.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(domain.result?.structuredContent?.error?.effect, 'unknown');
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(domain.result!.content![0]!.text), domain.result?.structuredContent);
  } finally { await rpc.close(); }
});

test('MCP delivers a concurrent reply before cancellation of an active call', { timeout: 10_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const id = randomUUID();
  const client = createAgentClient(async (request, signal) => {
    if (request.method === 'script.run') {
      const pending = Promise.withResolvers<AgentReply>();
      signal?.addEventListener('abort', () => { cancelled.resolve(); pending.reject(new AgentClientError({ code: 'cancelled', message: 'Cancelled; reconcile retained state', effect: 'unknown' })); }, { once: true });
      started.resolve();
      return pending.promise;
    }
    return success([]);
  });
  const rpc = stdio(client);
  try {
    await rpc.initialize();
    rpc.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'qa_script_run', arguments: { source: 'return null', sessionIds: [id], scriptId: randomUUID() } } });
    await started.promise;
    rpc.send({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'qa_session_list' } });
    const fast = await rpc.response(42);
    assert.equal(fast.result?.isError, false);
    rpc.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'user cancelled' } });
    await cancelled.promise;
    assert.equal((await rpc.response('slow')).result?.structuredContent?.error?.effect, 'unknown');
    assert.equal(rpc.inbox.length, 0);
  } finally { await rpc.close(); }
});

test('MCP EOF cancels the active transport call without emitting a late reply', { timeout: 10_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const client = createAgentClient(async (_request, signal) => {
    const pending = Promise.withResolvers<AgentReply>();
    signal?.addEventListener('abort', () => { cancelled.resolve(); pending.reject(new AgentClientError({ code: 'cancelled', message: 'EOF', effect: 'unknown' })); }, { once: true });
    started.resolve();
    return pending.promise;
  });
  const rpc = stdio(client);
  await rpc.initialize();
  rpc.send({ jsonrpc: '2.0', id: 'active', method: 'tools/call', params: { name: 'qa_session_observe', arguments: { sessionId: randomUUID() } } });
  await started.promise;
  await rpc.close();
  await cancelled.promise;
  assert.equal(rpc.inbox.length, 0);
});

test('MCP bounds newline framing and handles UTF-8 split across input chunks', { timeout: 10_000 }, async () => {
  const rpc = stdio(createAgentClient(async () => { throw new Error('Unexpected engine dispatch'); }));
  try {
    await rpc.initialize();
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: '한글', method: 'not-a-protocol-method' })}\n`);
    const split = frame.indexOf(Buffer.from('한')) + 1;
    rpc.input.write(frame.subarray(0, split));
    rpc.input.write(frame.subarray(split));
    assert.equal((await rpc.response('한글')).error?.code, -32601);
    rpc.input.write(Buffer.alloc(1024 * 1024 + 1, 32));
    assert.equal((await rpc.response(null)).error?.code, -32600);
    await rpc.running;
  } finally { await rpc.close(); }
});
