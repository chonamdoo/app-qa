import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { QaEvent } from '../../src/core/events.ts';
import type { JobContext, JobOutcome, PlanParams, RunParams } from '../../src/server/jobs.ts';
import { createServer, type QaServer, type ServerHandlers } from '../../src/server/server.ts';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let root: string;
let server: QaServer;
let port: number;
/** Run-handler behaviour per test; defaults to an immediate PASS. */
let runImpl: (params: RunParams, ctx: JobContext) => Promise<JobOutcome>;
/** Params every plan job handler received, in order. */
const planCalls: PlanParams[] = [];

/** Raw HTTP (no URL normalization, so `..` reaches the server as sent). */
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; auth?: boolean } = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const headers = { ...(opts.auth === false ? {} : { authorization: `Bearer ${server.token}` }), ...opts.headers };
  const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(opts.body);
  return promise;
}

/** Resolves on the first bus event matching `predicate` (tests rely on node:test timeouts rather than timers). */
function waitForEvent(predicate: (e: QaEvent) => boolean): Promise<QaEvent> {
  const { promise, resolve } = Promise.withResolvers<QaEvent>();
  const stop = server.bus.subscribe((e) => {
    if (!predicate(e)) return;
    stop();
    resolve(e);
  });
  return promise;
}

/** Opens `/api/events`; `onFrame` gets each SSE block's fields; returns the request so the test can close it. */
function openStream(lastEventId: string, onFrame: (frame: { event: string | null; id: number | null; data: string | null }) => void) {
  const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { authorization: `Bearer ${server.token}`, 'last-event-id': lastEventId } }, (res) => {
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    let buffer = '';
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        onFrame({ event: /^event: (.*)$/m.exec(block)?.[1] ?? null, id: id === undefined ? null : Number(id), data: /^data: (.*)$/m.exec(block)?.[1] ?? null });
      }
    });
  });
  req.end();
  return req;
}

async function postJob(body: unknown): Promise<{ id: string; state: string }> {
  const reply = await call('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(reply.status, 201, reply.body.toString());
  return JSON.parse(reply.body.toString()) as { id: string; state: string };
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'qa-server-'));
  mkdirSync(join(root, 'runs', 'run-1', 'step-01'), { recursive: true });
  writeFileSync(join(root, 'runs', 'run-1', 'step-01', 'before.png'), 'png-bytes');
  writeFileSync(join(root, 'secret.txt'), 'outside');
  symlinkSync(join(root, 'secret.txt'), join(root, 'runs', 'run-1', 'escape.txt'));
  const ok = async (): Promise<JobOutcome> => ({ ok: true, message: 'ok', resultPath: null });
  const handlers: ServerHandlers = {
    run: (params, ctx) => runImpl(params, ctx),
    smoke: ok,
    plan: async (params) => {
      planCalls.push(params);
      return ok();
    },
    calibrate: ok,
    capture: ok,
    devices: async () => [],
    screen: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    apps: async () => [],
    startRecording: async () => {},
    stopRecording: async (_p, _d, file) => file,
  };
  server = createServer({
    handlers,
    token: 'test-token',
    ringSize: 16,
    paths: { root, runs: join(root, 'runs'), apps: join(root, 'apps'), generated: join(root, 'generated'), uploads: join(root, 'uploads'), recordings: join(root, 'rec') },
  });
  port = await server.listen(0);
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('auth', { timeout: 10_000 }, () => {
  test('every route rejects missing or wrong bearer tokens', async () => {
    for (const path of ['/api/health', '/api/jobs', '/api/events', '/api/runs/run-1/files/step-01/before.png', '/api/nope']) {
      assert.equal((await call(path, { auth: false })).status, 401, path);
      assert.equal((await call(path, { auth: false, headers: { authorization: 'Bearer wrong-token' } })).status, 401, path);
    }
    assert.equal((await call('/api/health')).status, 200);
  });
});

describe('events', { timeout: 10_000 }, () => {
  test('SSE replays buffered events after Last-Event-ID, then streams live ones', async () => {
    const seqs: number[] = [];
    const stop = server.bus.subscribe((e) => {
      if (e.type === 'log' && e.source === 'sse-test') seqs.push(e.seq);
    });
    for (const message of ['m1', 'm2', 'm3']) server.bus.emit({ type: 'log', level: 'info', source: 'sse-test', message });
    stop();

    const received: string[] = [];
    const done = Promise.withResolvers<void>();
    const req = openStream(String(seqs[0]), ({ id, data }) => {
      if (!data) return;
      const event = JSON.parse(data) as QaEvent;
      assert.equal(id, event.seq);
      if (event.type !== 'log' || event.source !== 'sse-test') return;
      received.push(event.message);
      if (received.length === 2) server.bus.emit({ type: 'log', level: 'info', source: 'sse-test', message: 'live' });
      if (received.length === 3) done.resolve();
    });
    await done.promise;
    req.destroy();
    assert.deepEqual(received, ['m2', 'm3', 'live']);
  });

  test('an id from another server instance (ahead of this one) gets a reset, then a full replay', async () => {
    const frames: (string | null)[] = [];
    const done = Promise.withResolvers<void>();
    const req = openStream('999999', ({ event, data }) => {
      frames.push(event ?? (data ? 'data' : null));
      if (data) done.resolve();
    });
    await done.promise;
    req.destroy();
    assert.deepEqual(frames.filter((f) => f !== null).slice(0, 2), ['reset', 'data']);
  });
});

describe('jobs', { timeout: 10_000 }, () => {
  test('jobs on the same device run one after another; other devices run concurrently', async () => {
    const gates = new Map<string, PromiseWithResolvers<JobOutcome>>();
    const started: string[] = [];
    runImpl = (params) => {
      const device = params.deviceIds.android ?? params.deviceIds.ios!;
      const label = `${device}#${started.filter((s) => s.startsWith(device)).length + 1}`;
      started.push(label);
      const gate = Promise.withResolvers<JobOutcome>();
      gates.set(label, gate);
      return gate.promise;
    };
    const a1 = await postJob({ kind: 'run', params: { platform: 'android', deviceIds: { android: 'emu-1' } } });
    const a2 = await postJob({ kind: 'run', params: { platform: 'android', deviceIds: { android: 'emu-1' } } });
    const i1 = await postJob({ kind: 'run', params: { platform: 'ios', deviceIds: { ios: 'sim-1' } } });
    assert.equal(a1.state, 'running');
    assert.equal(a2.state, 'queued');
    assert.equal(i1.state, 'running');
    assert.deepEqual(started, ['emu-1#1', 'sim-1#1']);

    const a2Started = waitForEvent((e) => e.type === 'job.started' && e.jobId === a2.id);
    gates.get('emu-1#1')!.resolve({ ok: true, message: 'PASS 1', resultPath: null });
    await a2Started;
    assert.deepEqual(started, ['emu-1#1', 'sim-1#1', 'emu-1#2']);

    const finished = Promise.all([a2.id, i1.id].map((id) => waitForEvent((e) => e.type === 'job.finished' && e.jobId === id)));
    gates.get('emu-1#2')!.resolve({ ok: true, message: 'PASS 1', resultPath: null });
    gates.get('sim-1#1')!.resolve({ ok: false, message: 'FAIL 1', resultPath: null });
    await finished;
    const states = JSON.parse((await call('/api/jobs')).body.toString()) as { jobs: { id: string; state: string }[] };
    const byId = new Map(states.jobs.map((j) => [j.id, j.state]));
    assert.deepEqual([byId.get(a1.id), byId.get(a2.id), byId.get(i1.id)], ['succeeded', 'succeeded', 'failed']);
  });

  test('a job without a device id blocks every device of that platform', async () => {
    const gates: PromiseWithResolvers<JobOutcome>[] = [];
    runImpl = () => {
      const gate = Promise.withResolvers<JobOutcome>();
      gates.push(gate);
      return gate.promise;
    };
    const any = await postJob({ kind: 'run', params: { platform: 'android' } });
    const specific = await postJob({ kind: 'run', params: { platform: 'android', deviceIds: { android: 'emu-9' } } });
    assert.equal(any.state, 'running');
    assert.equal(specific.state, 'queued');
    const specificStarted = waitForEvent((e) => e.type === 'job.started' && e.jobId === specific.id);
    gates[0]!.resolve({ ok: true, message: 'ok', resultPath: null });
    await specificStarted;
    const specificFinished = waitForEvent((e) => e.type === 'job.finished' && e.jobId === specific.id);
    gates[1]!.resolve({ ok: true, message: 'ok', resultPath: null });
    await specificFinished;
  });

  test('cancel aborts the running handler signal and the job ends cancelled', async () => {
    let seen: AbortSignal | undefined;
    runImpl = (_params, ctx) => {
      seen = ctx.signal;
      const { promise, reject } = Promise.withResolvers<JobOutcome>();
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      return promise;
    };
    const job = await postJob({ kind: 'run', params: { platform: 'android', deviceIds: { android: 'emu-2' } } });
    assert.equal(seen?.aborted, false);
    const finished = waitForEvent((e) => e.type === 'job.finished' && e.jobId === job.id);
    const reply = await call(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    assert.equal(reply.status, 202);
    const event = await finished;
    assert.equal(seen?.aborted, true);
    assert.equal(event.type === 'job.finished' && event.ok, false);
    const state = JSON.parse((await call(`/api/jobs/${job.id}`)).body.toString()) as { state: string };
    assert.equal(state.state, 'cancelled');
    assert.equal((await call(`/api/jobs/${job.id}/cancel`, { method: 'POST' })).status, 409);
  });

  test('invalid job requests are rejected with 400', async () => {
    const reply = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'run', params: { platform: 'windows' } }) });
    assert.equal(reply.status, 400);
  });

  test('a JSON body that is not an object is a 400, not a 500', async () => {
    for (const body of ['null', '[]', '"on"', '1']) {
      assert.equal((await call('/api/devices/android/emu-1/recording', { method: 'POST', body })).status, 400, body);
      assert.equal((await call('/api/jobs', { method: 'POST', body })).status, 400, body);
    }
  });

  test('plan job documents must stay inside the project, uploads, or the app profile docs', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'qa-outside-'));
    try {
      writeFileSync(join(outside, 'spec.md'), '# outside');
      writeFileSync(join(outside, 'profile.md'), '# profile');
      mkdirSync(join(root, 'apps'), { recursive: true });
      writeFileSync(join(root, 'apps', 'demo.yaml'), JSON.stringify({ id: 'demo', name: 'Demo', docs: [join(outside, 'profile.md')] }));
      mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
      writeFileSync(join(root, 'docs', 'spec.md'), '# inside');
      writeFileSync(join(root, 'docs', 'sub', 'a.md'), '# inside');
      symlinkSync(join(outside, 'spec.md'), join(root, 'docs', 'linked.md'));
      symlinkSync(outside, join(root, 'docs', 'linked-dir'));
      for (const doc of [
        join(outside, 'spec.md'),
        '../spec.md',
        'docs/linked.md',
        'docs/linked-dir/spec.md',
        `${outside}/*.md`,
        'docs/linked*.md',
        '~/.ssh/id_rsa',
      ]) {
        const reply = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'plan', params: { app: 'demo', docs: [doc] } }) });
        assert.equal(reply.status, 400, `${doc} → ${reply.status}`);
        assert.match(reply.body.toString(), /허용된 위치 밖/, doc);
      }
      assert.equal(planCalls.length, 0);

      const done = waitForEvent((e) => e.type === 'job.finished' && e.kind === 'plan');
      await postJob({ kind: 'plan', params: { app: 'demo', docs: ['docs/spec.md', 'docs/sub/*.md', join(root, 'uploads', 'new.md'), join(outside, 'profile.md')] } });
      await done;
      assert.deepEqual(planCalls.at(-1)?.docs, [join(root, 'docs', 'spec.md'), join(root, 'docs', 'sub', '*.md'), join(root, 'uploads', 'new.md'), join(outside, 'profile.md')]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('files', { timeout: 10_000 }, () => {
  test('serves evidence inside the run directory', async () => {
    const reply = await call('/api/runs/run-1/files/step-01/before.png');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'image/png');
    assert.equal(reply.body.toString(), 'png-bytes');
  });

  test('rejects traversal out of the run directory', async () => {
    for (const path of [
      '/api/runs/run-1/files/../../secret.txt',
      '/api/runs/run-1/files/step-01/../../../secret.txt',
      '/api/runs/run-1/files/..%2f..%2fsecret.txt',
      '/api/runs/run-1/files/%2e%2e/%2e%2e/secret.txt',
      '/api/runs/run-1/files/escape.txt',
      '/api/runs/..%2f..%2f/files/secret.txt',
    ]) {
      const reply = await call(path);
      assert.ok(reply.status === 400 || reply.status === 404, `${path} → ${reply.status}`);
      assert.ok(!reply.body.toString().includes('outside'), path);
    }
    assert.equal((await call('/api/runs/run-1/files/../../secret.txt')).status, 400);
  });

  test('a file that cannot be opened fails that request only; the server keeps serving', { skip: process.getuid?.() === 0 }, async () => {
    const file = join(root, 'runs', 'run-1', 'locked.txt');
    writeFileSync(file, 'locked');
    chmodSync(file, 0);
    const outcome = await call('/api/runs/run-1/files/locked.txt').then(
      (reply) => reply.status,
      () => 'closed',
    );
    assert.ok(outcome === 500 || outcome === 'closed', String(outcome));
    assert.equal((await call('/api/runs/run-1/files/step-01/before.png')).status, 200);
  });

  test('events.jsonl that is not a regular file is a 404; the server keeps serving', async () => {
    mkdirSync(join(root, 'runs', 'run-dir', 'events.jsonl'), { recursive: true });
    assert.equal((await call('/api/runs/run-dir/events')).status, 404);
    assert.equal((await call('/api/health')).status, 200);
  });

  test('events.jsonl that grows during the response is sent exactly up to the stat size', async () => {
    const file = join(root, 'runs', 'run-grow', 'events.jsonl');
    mkdirSync(join(root, 'runs', 'run-grow'));
    const line = `${JSON.stringify({ seq: 1, ts: '2026-09-26T00:00:00.000Z', type: 'log', level: 'info', source: 'grow', message: 'x'.repeat(200) })}\n`;
    const initial = Buffer.from(line.repeat(Math.ceil((16 * 1024 * 1024) / line.length)));
    writeFileSync(file, initial);
    // Raw socket with `Connection: close`: every byte the server writes is observed, not just `content-length` of them.
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    const ended = Promise.withResolvers<void>();
    socket.on('data', (chunk: Buffer) => {
      // Server and client share this event loop, so the append lands while the server is still mid-file.
      if (chunks.length === 0) appendFileSync(file, line.repeat(4096));
      chunks.push(chunk);
    });
    socket.on('end', () => ended.resolve());
    socket.on('error', ended.reject);
    socket.write(`GET /api/runs/run-grow/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${server.token}\r\nConnection: close\r\n\r\n`);
    await ended.promise;
    const raw = Buffer.concat(chunks);
    const split = raw.indexOf('\r\n\r\n');
    const head = raw.subarray(0, split).toString();
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.equal(Number(/^content-length: (\d+)$/im.exec(head)?.[1]), initial.length);
    const body = raw.subarray(split + 4);
    assert.equal(body.length, initial.length);
    assert.ok(body.equals(initial));
  });
});

describe('uploads', { timeout: 10_000 }, () => {
  test('stores the document as a 0600 file under uploads with a sanitized unique name', async () => {
    const reply = await call('/api/docs', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('../기획서 v1.md'), 'content-type': 'application/octet-stream' },
      body: '# 떠남\n- 출국장 혼잡도',
    });
    assert.equal(reply.status, 201, reply.body.toString());
    const { path, name } = JSON.parse(reply.body.toString()) as { path: string; name: string };
    assert.equal(name, '기획서 v1.md');
    assert.ok(path.startsWith(join(root, 'uploads') + '/'));
    assert.ok(path.endsWith('-기획서 v1.md'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8'), '# 떠남\n- 출국장 혼잡도');
  });

  test('rejects unsupported document types', async () => {
    const reply = await call('/api/docs', { method: 'POST', headers: { 'x-filename': 'tool.sh' }, body: 'echo hi' });
    assert.equal(reply.status, 415);
  });
});
