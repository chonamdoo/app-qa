import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectAgentClient } from '../../src/core/agent-client.ts';
import type { AgentReply, AgentService } from '../../src/core/agent.ts';
import { createServer, type ServerHandlers } from '../../src/server/server.ts';

async function engine(agent: AgentService) {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-http-'));
  const unused = async (): Promise<never> => { throw new Error('Unexpected legacy operation'); };
  const handlers: ServerHandlers = { agent, run: unused, smoke: unused, plan: unused, capture: unused, inspect: unused, calibrate: unused, devices: unused, apps: unused, screen: unused, startRecording: unused, stopRecording: unused };
  const server = createServer({ handlers, paths: { root } });
  const port = await server.listen();
  mkdirSync(join(root, '.qa'));
  writeFileSync(join(root, '.qa', 'server.json'), JSON.stringify({ port, token: server.token, pid: process.pid }), { mode: 0o600 });
  return { root, port, server, async close() { await server.close(); rmSync(root, { force: true, recursive: true }); } };
}
const success = (result: unknown): AgentReply => ({ ok: true, result, meta: { requestId: randomUUID(), at: new Date().toISOString() } });

test('authenticated HTTP discovery attaches only and SDK surfaces domain errors without retrying', async () => {
  const id = randomUUID();
  let calls = 0;
  const fixture = await engine({ call: async () => { calls++; return { ok: false, error: { code: 'session_stopped', message: 'Mutation revoked', effect: 'unknown' }, meta: { requestId: randomUUID(), at: new Date().toISOString(), sessionId: id } }; }, shutdown: async () => {} });
  try {
    const client = await connectAgentClient({ root: fixture.root });
    await assert.rejects(client.session(id).status(), { code: 'session_stopped', effect: 'unknown' });
    assert.equal(calls, 1);
    const missing = join(fixture.root, 'other');
    mkdirSync(missing);
    await assert.rejects(connectAgentClient({ root: missing }), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(missing), []);
    chmodSync(join(fixture.root, '.qa', 'server.json'), 0o644);
    await assert.rejects(connectAgentClient({ root: fixture.root }), { code: 'invalid_discovery' });
    assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('agent HTTP rejects unauthenticated, cross-origin, oversized and schema-invalid calls before execution', async () => {
  let calls = 0;
  const fixture = await engine({ call: async () => { calls++; return success([]); }, shutdown: async () => {} });
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${fixture.port}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  try {
    assert.equal((await post('{"method":"session.list"}')).status, 401);
    const headers = { authorization: `Bearer ${fixture.server.token}` };
    assert.equal((await post('{"method":"session.list"}', { ...headers, origin: 'https://attacker.test' })).status, 403);
    assert.equal((await post('{"method":"session.list","allowRisky":true}', headers)).status, 400);
    assert.equal((await post('{"method":"session.act","context":{"scriptId":"spoof"}}', headers)).status, 400);
    assert.equal((await post('{"method":"script.run","path":"/server/secrets.js"}', headers)).status, 400);
    assert.equal((await post('x'.repeat(1024 * 1024 + 1), headers)).status, 413);
    assert.equal(calls, 0);
    const reply = await post('{"method":"session.list"}', headers);
    assert.equal(reply.status, 200);
    assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('HTTP disconnect cancels just the active call; explicit server shutdown revokes service admission', async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let shutdown = 0;
  let sessionOpen = true;
  const fixture = await engine({
    call: async (_request, context) => {
      started.resolve();
      const done = Promise.withResolvers<AgentReply>();
      context?.signal?.addEventListener('abort', () => { cancelled.resolve(); done.resolve(success({ sessionOpen })); }, { once: true });
      return done.promise;
    },
    shutdown: async () => { shutdown++; sessionOpen = false; },
  });
  try {
    const client = await connectAgentClient({ root: fixture.root });
    const controller = new AbortController();
    const call = client.request({ method: 'session.list' }, controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(call, { code: 'cancelled', effect: 'unknown' });
    await cancelled.promise;
    assert.equal(sessionOpen, true);
    assert.equal(shutdown, 0);
    const closing = fixture.server.close();
    assert.equal(shutdown, 1);
    await closing;
    await fixture.server.close();
    assert.equal(shutdown, 1);
  } finally { await fixture.close(); }
});

test('HTTP never exposes thrown service internals or unauthenticated discovery identity', async () => {
  const fixture = await engine({ call: async () => { throw new Error('secret-file:/private/token stack payload'); }, shutdown: async () => {} });
  try {
    const health = await fetch(`http://127.0.0.1:${fixture.port}/api/health`);
    assert.equal(health.status, 401);
    assert.equal((await health.text()).includes(fixture.root), false);
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/agent`, { method: 'POST', headers: { authorization: `Bearer ${fixture.server.token}` }, body: '{"method":"session.list"}' });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('secret-file'), false);
    assert.equal(existsSync(join(fixture.root, '.qa', 'server.json')), true);
  } finally { await fixture.close(); }
});

test('a reply whose body stalls after headers hits the per-call deadline as unknown effect and is not retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stall-'));
  let agentCalls = 0;
  const server = createHttpServer((req, res) => {
    req.resume();
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid, root }));
      return;
    }
    agentCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  mkdirSync(join(root, '.qa'));
  writeFileSync(join(root, '.qa', 'server.json'), JSON.stringify({ port: address.port, token: 'stalled-engine-token', pid: process.pid }), { mode: 0o600 });
  try {
    const client = await connectAgentClient({ root, deadlineMarginMs: 200 });
    const started = Date.now();
    await assert.rejects(client.request({ method: 'session.close', sessionId: randomUUID() }), { code: 'deadline_exceeded', effect: 'unknown' });
    assert.ok(Date.now() - started < 5000);
    assert.equal(agentCalls, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(root, { force: true, recursive: true });
  }
});
