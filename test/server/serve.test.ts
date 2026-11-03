import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readReviewToken, startEngine } from '../../src/cli/commands/serve.ts';
import type { AgentCallContext } from '../../src/core/agent.ts';
import type { JobOutcome } from '../../src/server/jobs.ts';
import type { ServerHandlers } from '../../src/server/server.ts';

const ok = async (): Promise<JobOutcome> => ({ ok: true, message: 'ok', resultPath: null });
const handlers: ServerHandlers = {
  agent: { call: async () => { throw new Error('Unexpected agent request'); }, shutdown: async () => {} },
  run: ok,
  smoke: ok,
  plan: ok,
  calibrate: ok,
  capture: ok,
  inspect: ok,
  devices: async () => [],
  screen: async () => new Uint8Array(),
  apps: async () => [],
  startRecording: async () => {},
  stopRecording: async (_p, _d, file) => file,
};

test('server.json is swapped in atomically as a fresh 0600 file and removed on close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-serve-'));
  const infoFile = join(dir, 'server.json');
  try {
    writeFileSync(infoFile, '{"pid":1}');
    chmodSync(infoFile, 0o644);
    const previous = statSync(infoFile).ino;
    const engine = await startEngine({ port: 0, infoFile, handlers });
    try {
      const stat = statSync(infoFile);
      // A new inode means readers saw the old file or the complete new one — never an in-place rewrite at 0644.
      assert.notEqual(stat.ino, previous);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ['server.json']);
      const info: unknown = JSON.parse(readFileSync(infoFile, 'utf8'));
      assert.ok(typeof info === 'object' && info !== null && 'token' in info && 'port' in info && 'pid' in info);
      assert.deepEqual(Object.keys(info).sort(), ['pid', 'port', 'startedAt', 'token']);
      assert.equal(info.port, engine.port);
      assert.equal(info.pid, process.pid);
      const health = await fetch(`http://127.0.0.1:${engine.port}/api/health`, { headers: { authorization: `Bearer ${String(info.token)}` } });
      assert.equal(health.status, 200);
    } finally {
      await engine.close();
    }
    assert.equal(existsSync(infoFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator review authority exists only through the launching channel and never in server.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-serve-review-'));
  const contexts: (AgentCallContext | undefined)[] = [];
  const capturing: ServerHandlers = { ...handlers, agent: { call: async (_request, context) => { contexts.push(context); return { ok: true, result: [], meta: { requestId: '00000000-0000-4000-8000-000000000000', at: new Date().toISOString() } }; }, shutdown: async () => {} } };
  const reviewToken = randomBytes(32).toString('base64url');
  const post = (port: number, token: string, review?: string) => fetch(`http://127.0.0.1:${port}/api/agent`, {
    method: 'POST', body: '{"method":"session.list"}',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(review === undefined ? {} : { 'x-qautra-review-token': review }) },
  });
  const bearerOf = (file: string): string => {
    const info: unknown = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(typeof info === 'object' && info !== null && 'token' in info && typeof info.token === 'string');
    return info.token;
  };
  try {
    const withChannel = await startEngine({ port: 0, infoFile: join(dir, 'app.json'), handlers: capturing, reviewToken });
    try {
      assert.equal(readFileSync(join(dir, 'app.json'), 'utf8').includes(reviewToken), false);
      const bearer = bearerOf(join(dir, 'app.json'));
      assert.equal((await post(withChannel.port, bearer, 'forged-review-token')).status, 403);
      assert.equal((await post(withChannel.port, bearer)).status, 200);
      assert.equal(contexts.at(-1)?.operatorReview, undefined);
      assert.equal((await post(withChannel.port, bearer, reviewToken)).status, 200);
      assert.equal(contexts.at(-1)?.operatorReview?.channel, 'local-ui');
    } finally { await withChannel.close(); }
    const calls = contexts.length;
    const cliOnly = await startEngine({ port: 0, infoFile: join(dir, 'cli.json'), handlers: capturing });
    try {
      const bearer = bearerOf(join(dir, 'cli.json'));
      assert.equal((await post(cliOnly.port, bearer, reviewToken)).status, 403);
      assert.equal((await post(cliOnly.port, bearer, bearer)).status, 403);
      assert.equal(contexts.length, calls);
    } finally { await cliOnly.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review token is read once from the launching pipe and refused when malformed, missing or late', async () => {
  const token = randomBytes(32).toString('base64url');
  const pipe = new PassThrough();
  const read = readReviewToken(pipe);
  pipe.write(`${token.slice(0, 10)}`);
  pipe.write(`${token.slice(10)}\nignored`);
  assert.equal(await read, token);

  const malformed = new PassThrough();
  const rejected = readReviewToken(malformed);
  malformed.write('short\n');
  await assert.rejects(rejected);

  const closed = new PassThrough();
  const ended = readReviewToken(closed);
  closed.end();
  await assert.rejects(ended);

  await assert.rejects(readReviewToken(new PassThrough(), 20));
});

