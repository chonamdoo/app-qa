import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CliJobCancelled, runEngineJob } from '../../src/cli/engine.ts';
import { connectEngineClient } from '../../src/core/agent-client.ts';
import type { JobContext, JobOutcome, JobRequest, JobView } from '../../src/server/jobs.ts';
import { createServer, type QaServer, type ServerHandlers } from '../../src/server/server.ts';

interface WireReply {
  status: number;
  body: Buffer;
}
interface Exchange extends WireReply {
  method: string;
  path: string;
}
type Completion = { status: 'resolved'; job: JobView } | { status: 'rejected'; error: unknown };

const request: JobRequest = {
  kind: 'run',
  params: { paths: [], platform: 'android', deviceIds: { android: 'engine-fixture-device' } },
};
const success: JobOutcome = { ok: true, message: 'Handler completed', resultPath: null };
const stopped: JobOutcome = { ok: false, message: 'Handler cleanup completed', resultPath: null };
const isJobRead = (exchange: Pick<Exchange, 'method' | 'path'>): boolean => exchange.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(exchange.path);

function completionOf(work: Promise<JobView>): Promise<Completion> {
  return work.then(
    (job): Completion => ({ status: 'resolved', job }),
    (error: unknown): Completion => ({ status: 'rejected', error }),
  );
}

function beforeCompletion<T>(checkpoint: Promise<T>, completion: Promise<Completion>): Promise<T> {
  return Promise.race([
    checkpoint,
    completion.then(() => { throw new Error('CLI settled before the expected HTTP checkpoint'); }),
  ]);
}

async function engineFixture(
  t: TestContext,
  run: ServerHandlers['run'],
  transform: (exchange: Exchange) => WireReply | Promise<WireReply>,
  release: () => void,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-cli-engine-')));
  const lifetime = new AbortController();
  const requests: Pick<Exchange, 'method' | 'path'>[] = [];
  const failures: unknown[] = [];
  const pending: Promise<Completion>[] = [];
  let server: QaServer | undefined;
  let proxy: Server | undefined;

  t.after(async () => {
    try {
      release();
      lifetime.abort();
      if (proxy?.listening) {
        const closed = new Promise<void>((resolve) => { proxy!.close(() => resolve()); });
        proxy.closeAllConnections();
        await closed;
      }
      await server?.close();
      await Promise.allSettled(pending);
      assert.deepEqual(failures, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const unused = async (): Promise<never> => { throw new Error('Unexpected fixture operation'); };
  const handlers: ServerHandlers = {
    agent: { call: unused, shutdown: async () => {} },
    run,
    smoke: unused,
    plan: unused,
    calibrate: unused,
    capture: unused,
    inspect: unused,
    devices: unused,
    apps: unused,
    screen: unused,
    startRecording: unused,
    stopRecording: unused,
  };
  server = createServer({
    handlers,
    paths: {
      root,
      runs: join(root, 'runs'),
      apps: join(root, 'apps'),
      generated: join(root, 'generated'),
      uploads: join(root, 'uploads'),
      recordings: join(root, 'recordings'),
    },
  });
  const upstreamPort = await server.listen(0);

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    requests.push({ method, path });
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${path}`, {
      method,
      headers: {
        authorization: req.headers.authorization ?? '',
        'content-type': req.headers['content-type'] ?? 'application/json',
      },
      body: body.length ? body : undefined,
      redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
    });
    const reply = await transform({ method, path, status: upstream.status, body: Buffer.from(await upstream.arrayBuffer()) });
    if (!res.destroyed) {
      res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': reply.body.byteLength });
      res.end(reply.body);
    }
  }

  proxy = createHttpServer((req, res) => {
    void forward(req, res).catch((error: unknown) => {
      if (!lifetime.signal.aborted) failures.push(error);
      res.destroy();
    });
  });
  const listeningProxy = proxy;
  await new Promise<void>((resolve, reject) => {
    listeningProxy.once('error', reject);
    listeningProxy.listen(0, '127.0.0.1', () => {
      listeningProxy.off('error', reject);
      resolve();
    });
  });
  const port = (proxy.address() as AddressInfo).port;
  mkdirSync(join(root, '.qa'), { mode: 0o700 });
  writeFileSync(join(root, '.qa', 'server.json'), JSON.stringify({ port, token: server.token, pid: process.pid }), { mode: 0o600 });
  const client = await connectEngineClient({ root });
  return { client, server, requests, pending };
}

function submissionCount(requests: Pick<Exchange, 'method' | 'path'>[]): number {
  return requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/jobs').length;
}

function cancellationCount(requests: Pick<Exchange, 'method' | 'path'>[]): number {
  return requests.filter((entry) => entry.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(entry.path)).length;
}

test('an undecodable submission response leaves one real job to reconcile and never replays it', { timeout: 10_000 }, async (t) => {
  const finish = Promise.withResolvers<JobOutcome>();
  const controller = new AbortController();
  let dispatches = 0;
  const fixture = await engineFixture(t, async () => {
    dispatches++;
    return finish.promise;
  }, (exchange) => {
    if (exchange.method === 'POST' && exchange.path === '/api/jobs') {
      assert.equal(exchange.status, 201);
      return { status: exchange.status, body: Buffer.from('{"id":') };
    }
    return exchange;
  }, () => {
    controller.abort();
    finish.resolve(success);
  });

  const completion = completionOf(runEngineJob(request, { client: fixture.client, signal: controller.signal }));
  fixture.pending.push(completion);
  const result = await completion;
  assert.ok(result.status === 'rejected');
  assert.ok(result.error instanceof Error);
  assert.ok(!(result.error instanceof CliJobCancelled));

  const { jobs } = await fixture.client.request<{ jobs: JobView[] }>('/api/jobs');
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.state, 'running');
  assert.equal(job.cancelRequested, false);
  assert.equal(dispatches, 1);
  assert.equal(submissionCount(fixture.requests), 1);
  assert.equal(cancellationCount(fixture.requests), 0);

  finish.resolve(success);
  await fixture.server.jobs.idle();
  const reconciled = await fixture.client.request<JobView>(`/api/jobs/${job.id}`);
  assert.equal(reconciled.state, 'succeeded');
  assert.equal(dispatches, 1);
  assert.equal(submissionCount(fixture.requests), 1);
});

test('cancelling a running job waits for handler cleanup and an actual terminal HTTP observation', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers<JobContext>();
  const cancellationObserved = Promise.withResolvers<void>();
  const runningRead = Promise.withResolvers<JobView>();
  const terminalRead = Promise.withResolvers<JobView>();
  const releaseRunning = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<JobOutcome>();
  const controller = new AbortController();
  let dispatches = 0;
  const fixture = await engineFixture(t, async (_params, context) => {
    dispatches++;
    context.signal.addEventListener('abort', () => cancellationObserved.resolve(), { once: true });
    started.resolve(context);
    return finish.promise;
  }, async (exchange) => {
    if (isJobRead(exchange)) {
      assert.equal(exchange.status, 200);
      const job = JSON.parse(exchange.body.toString('utf8')) as JobView;
      if (job.cancelRequested && job.state === 'running') {
        runningRead.resolve(job);
        await releaseRunning.promise;
      } else if (job.cancelRequested && job.state === 'cancelled') {
        terminalRead.resolve(job);
        await releaseTerminal.promise;
      }
    }
    return exchange;
  }, () => {
    controller.abort();
    releaseRunning.resolve();
    releaseTerminal.resolve();
    finish.resolve(stopped);
  });

  const completion = completionOf(runEngineJob(request, { client: fixture.client, signal: controller.signal }));
  fixture.pending.push(completion);
  const context = await beforeCompletion(started.promise, completion);
  controller.abort();
  await beforeCompletion(cancellationObserved.promise, completion);
  const running = await beforeCompletion(runningRead.promise, completion);
  assert.equal(running.id, context.jobId);
  assert.equal(running.finishedAt, null);
  const { jobs } = await fixture.client.request<{ jobs: JobView[] }>('/api/jobs');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.state, 'running');
  assert.equal(jobs[0]!.cancelRequested, true);
  assert.equal(jobs[0]!.finishedAt, null);

  releaseRunning.resolve();
  finish.resolve(stopped);
  await fixture.server.jobs.idle();
  const terminal = await beforeCompletion(terminalRead.promise, completion);
  assert.equal(terminal.id, context.jobId);
  assert.equal(terminal.state, 'cancelled');
  assert.notEqual(terminal.finishedAt, null);
  assert.equal(dispatches, 1);
  assert.equal(submissionCount(fixture.requests), 1);
  assert.equal(cancellationCount(fixture.requests), 1);

  releaseTerminal.resolve();
  const result = await completion;
  assert.ok(result.status === 'rejected');
  assert.ok(result.error instanceof CliJobCancelled);
});

test('a post-submit status failure preserves the original running job without retrying or resubmitting', { timeout: 10_000 }, async (t) => {
  const finish = Promise.withResolvers<JobOutcome>();
  const controller = new AbortController();
  let dispatches = 0;
  let failedReads = 0;
  const fixture = await engineFixture(t, async () => {
    dispatches++;
    return finish.promise;
  }, (exchange) => {
    if (isJobRead(exchange)) {
      assert.equal(exchange.status, 200);
      failedReads++;
      return { status: 503, body: Buffer.from(JSON.stringify({ error: 'Fixture status read unavailable' })) };
    }
    return exchange;
  }, () => {
    controller.abort();
    finish.resolve(success);
  });

  const completion = completionOf(runEngineJob(request, { client: fixture.client, signal: controller.signal }));
  fixture.pending.push(completion);
  const result = await completion;
  assert.ok(result.status === 'rejected');
  assert.ok(result.error instanceof Error);
  assert.ok(!(result.error instanceof CliJobCancelled));
  const { jobs } = await fixture.client.request<{ jobs: JobView[] }>('/api/jobs');
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.ok(result.error.message.includes(job.id));
  assert.equal(job.state, 'running');
  assert.equal(job.cancelRequested, false);
  assert.equal(job.finishedAt, null);
  assert.equal(failedReads, 1);
  assert.equal(dispatches, 1);
  assert.equal(submissionCount(fixture.requests), 1);
  assert.equal(cancellationCount(fixture.requests), 0);

  finish.resolve(success);
  await fixture.server.jobs.idle();
  const reconciled = await fixture.client.request<{ jobs: JobView[] }>('/api/jobs');
  assert.equal(reconciled.jobs.length, 1);
  assert.equal(reconciled.jobs[0]!.id, job.id);
  assert.equal(reconciled.jobs[0]!.state, 'succeeded');
  assert.equal(dispatches, 1);
  assert.equal(submissionCount(fixture.requests), 1);
});
