import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cmdAgent, type AgentCommandIO } from '../../src/cli/commands/agent.ts';
import { createAgentClient } from '../../src/core/agent-client.ts';
import type { AgentRequestInput, AgentScriptView } from '../../src/core/agent.ts';

test('CLI reads JavaScript/TypeScript file contents locally and sends literal source, never a server file path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-agent-cli-'));
  const sessionId = randomUUID();
  const scriptId = randomUUID();
  const requests: AgentRequestInput[] = [];
  let stdout = '';
  let stderr = '';
  const io: AgentCommandIO = {
    connect: async () => createAgentClient(async (request) => {
      requests.push(request);
      const result: AgentScriptView = { scriptId, sessionIds: [sessionId], state: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stdout: '', stderr: '', result: 7, error: null, trustBoundary: 'authorized-test-code-not-malicious-code-sandbox' };
      return { ok: true, result, meta: { requestId: randomUUID(), at: new Date().toISOString() } };
    }),
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
  };
  try {
    for (const extension of ['js', 'ts']) {
      const file = join(dir, `script.${extension}`);
      const source = extension === 'ts' ? 'const literal: string = "${SECRET}"; return literal;' : 'const literal = "${SECRET}"; return literal;';
      writeFileSync(file, source);
      assert.equal(await cmdAgent(['run-script', file, '--sessionIds', sessionId, '--script-id', scriptId], io), 0);
      const request = requests.at(-1);
      assert.ok(request?.method === 'script.run');
      assert.equal(request.source, source);
      assert.equal(request.language, extension === 'ts' ? 'typescript' : 'javascript');
      assert.equal('path' in request, false);
      assert.equal(JSON.stringify(request).includes(dir), false);
    }
    assert.equal(stderr, '');
    assert.equal(stdout.trim().split('\n').length, 2);
    const printed: unknown = JSON.parse(stdout.trim().split('\n')[0]!);
    assert.ok(printed && typeof printed === 'object' && 'result' in printed);
    assert.equal(printed.result, 7);
    const calls = requests.length;
    assert.equal(await cmdAgent(['run-script', join(dir, 'missing.js'), '--sessionIds', sessionId], io), 2);
    assert.equal(requests.length, calls);
    writeFileSync(join(dir, 'oversized.js'), 'x'.repeat(262_145));
    assert.equal(await cmdAgent(['run-script', join(dir, 'oversized.js'), '--sessionIds', sessionId], io), 2);
    assert.equal(requests.length, calls);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test('CLI refuses a FIFO script source promptly without waiting for a writer or sending a request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-agent-cli-fifo-'));
  try {
    const fifo = join(dir, 'blocked.ts');
    execFileSync('mkfifo', [fifo]);
    const program = `
      import { cmdAgent } from ${JSON.stringify(new URL('../../src/cli/commands/agent.ts', import.meta.url).href)};
      import { createAgentClient } from ${JSON.stringify(new URL('../../src/core/agent-client.ts', import.meta.url).href)};
      let requests = 0;
      const io = { connect: async () => createAgentClient(async () => { requests++; throw new Error('No request expected'); }), stdout: () => {}, stderr: () => {} };
      const code = await cmdAgent(['run-script', process.argv[1], '--sessionIds', ${JSON.stringify(randomUUID())}], io);
      console.log(JSON.stringify({ code, requests }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', program, fifo], { timeout: 5000, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.trim()), { code: 2, requests: 0 });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test('CLI stale revision is surfaced once without observing or refreshing a supplied reference', async () => {
  const sessionId = randomUUID();
  const ref = randomUUID();
  const calls: AgentRequestInput[] = [];
  let error = '';
  const io: AgentCommandIO = {
    connect: async () => createAgentClient(async (request) => {
      calls.push(request);
      return { ok: false, error: { code: 'stale_revision', message: 'Observe explicitly before choosing another action', effect: 'not_started' }, meta: { requestId: randomUUID(), at: new Date().toISOString() } };
    }),
    stdout: () => { throw new Error('Domain failure must not produce success output'); },
    stderr: (text) => { error += text; },
  };
  assert.equal(await cmdAgent(['tap', ref, '--session', sessionId], io), 2);
  assert.equal(await cmdAgent(['type', 'Name', '--session', sessionId], io), 2);
  assert.equal(calls.length, 0);
  error = '';
  assert.equal(await cmdAgent(['type', ref, '${LITERAL}', '--session', sessionId, '--revision', '3'], io), 1);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.ok(request?.method === 'session.act' && request.action.kind === 'type');
  assert.equal(request.revision, 3);
  assert.equal(request.action.ref, ref);
  assert.equal(request.action.text, '${LITERAL}');
  const printed: unknown = JSON.parse(error);
  assert.ok(printed && typeof printed === 'object' && 'error' in printed);
  const domain = printed.error;
  assert.ok(domain && typeof domain === 'object' && 'code' in domain);
  assert.equal(domain.code, 'stale_revision');
});

test('CLI help is attach-free, and all actual session commands require an explicit identity', async () => {
  let attached = 0;
  const io: AgentCommandIO = { connect: async () => { attached++; return createAgentClient(async () => { throw new Error('No execution expected'); }); }, stdout: () => {}, stderr: () => {} };
  assert.equal(await cmdAgent(['--help'], io), 0);
  assert.equal(attached, 0);
  assert.equal(await cmdAgent(['status'], io), 2);
  assert.equal(attached, 1);
});
