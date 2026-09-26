// Job queue: validated requests, per-resource serialization (FIFO per device, and per app for plan generation),
// cancellation via AbortController.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventSink, JobKind } from '../core/events.ts';
import type { Platform } from '../core/types.ts';

const PlatformChoice = z.enum(['android', 'ios', 'all']);
const DeviceIds = z.strictObject({ android: z.string().min(1).optional(), ios: z.string().min(1).optional() });

export const RunParams = z.strictObject({
  /** Test files/dirs; empty = runner default. */
  paths: z.array(z.string().min(1)).default([]),
  platform: PlatformChoice.default('all'),
  deviceIds: DeviceIds.default({}),
  tags: z.array(z.string().min(1)).optional(),
  junit: z.boolean().optional(),
});
export type RunParams = z.infer<typeof RunParams>;

export const SmokeParams = z.strictObject({
  app: z.string().min(1),
  platform: PlatformChoice.default('all'),
  deviceIds: DeviceIds.default({}),
  crawl: z.literal('tabs').optional(),
});
export type SmokeParams = z.infer<typeof SmokeParams>;

export const PlanParams = z.strictObject({
  app: z.string().min(1),
  /** Document paths (uploads or local files); empty = app profile `docs`. */
  docs: z.array(z.string().min(1)).default([]),
  /** Scenario typed in the UI (virtual document `inline.md`). */
  text: z.string().min(1).optional(),
  llm: z.enum(['claude-cli', 'codex-cli']).optional(),
  model: z.string().min(1).optional(),
  approve: z.boolean().optional(),
  /** When set, a successful plan enqueues a follow-up run of the generated tests. */
  run: z.strictObject({ platform: PlatformChoice.default('all'), deviceIds: DeviceIds.default({}), junit: z.boolean().optional() }).optional(),
});
export type PlanParams = z.infer<typeof PlanParams>;

export const CalibrateParams = z.strictObject({
  mode: z.enum(['live', 'record', 'replay']).optional(),
  golden: z.string().min(1).optional(),
});
export type CalibrateParams = z.infer<typeof CalibrateParams>;

export const CaptureParams = z.strictObject({
  app: z.string().min(1),
  platform: z.enum(['android', 'ios']),
  deviceId: z.string().min(1).optional(),
  name: z.string().regex(/^[\w.-]+$/),
});
export type CaptureParams = z.infer<typeof CaptureParams>;

const Title = z.string().min(1).max(200).optional();

export const JobRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), title: Title, params: RunParams }),
  z.strictObject({ kind: z.literal('smoke'), title: Title, params: SmokeParams }),
  z.strictObject({ kind: z.literal('plan'), title: Title, params: PlanParams }),
  z.strictObject({ kind: z.literal('calibrate'), title: Title, params: CalibrateParams.default({}) }),
  z.strictObject({ kind: z.literal('capture'), title: Title, params: CaptureParams }),
]);
export type JobRequest = z.infer<typeof JobRequest>;

export interface JobContext {
  jobId: string;
  events: EventSink;
  signal: AbortSignal;
}

export interface JobOutcome {
  ok: boolean;
  /** Korean one-line summary shown in the queue and the completion notification. */
  message: string;
  /** Report / plan path the UI can open. */
  resultPath: string | null;
  /** Generated test files (plan jobs) — used for the follow-up run. */
  paths?: string[];
}

/** DI boundary: the server calls these; `qa serve` binds them to runner/planner/jev. */
export interface JobHandlers {
  run(params: RunParams, ctx: JobContext): Promise<JobOutcome>;
  smoke(params: SmokeParams, ctx: JobContext): Promise<JobOutcome>;
  plan(params: PlanParams, ctx: JobContext): Promise<JobOutcome>;
  calibrate(params: CalibrateParams, ctx: JobContext): Promise<JobOutcome>;
  capture(params: CaptureParams, ctx: JobContext): Promise<JobOutcome>;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  kind: JobKind;
  title: string;
  state: JobState;
  params: JobRequest['params'];
  /** Device claims `<platform>:<deviceId|*>`; `*` = any device of that platform. */
  devices: string[];
  parentId: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  resultPath: string | null;
}

interface Job extends JobView {
  request: JobRequest;
  /** Resources held while running: the device claims plus `plan:<app>` for plan jobs (one generation per app). */
  claims: string[];
  controller: AbortController | null;
}

const PLATFORM_LABEL: Record<'android' | 'ios' | 'all', string> = { android: 'Android', ios: 'iOS', all: 'Android + iOS' };
const FINISHED_JOBS_KEPT = 500;

export function deviceClaims(req: JobRequest): string[] {
  switch (req.kind) {
    case 'run':
    case 'smoke': {
      const { platform, deviceIds } = req.params;
      const platforms: Platform[] = platform === 'all' ? ['android', 'ios'] : [platform];
      return platforms.map((p) => `${p}:${deviceIds[p] ?? '*'}`);
    }
    case 'capture':
      return [`${req.params.platform}:${req.params.deviceId ?? '*'}`];
    case 'plan':
    case 'calibrate':
      return [];
  }
}

function claimsConflict(a: string, b: string): boolean {
  const [pa, ia] = a.split(':', 2);
  const [pb, ib] = b.split(':', 2);
  return pa === pb && (ia === ib || ia === '*' || ib === '*');
}

function defaultTitle(req: JobRequest): string {
  switch (req.kind) {
    case 'run':
      return `테스트 실행 · ${PLATFORM_LABEL[req.params.platform]}${req.params.paths.length ? ` · ${req.params.paths.length}개 경로` : ''}`;
    case 'smoke':
      return `스모크 · ${req.params.app} · ${PLATFORM_LABEL[req.params.platform]}${req.params.crawl ? ' · 탭 순회' : ''}`;
    case 'plan':
      return `계획 생성${req.params.run ? ' + 실행' : ''} · ${req.params.app}`;
    case 'calibrate':
      return `Jev 보정${req.params.mode ? ` · ${req.params.mode}` : ''}`;
    case 'capture':
      return `화면 캡처 · ${req.params.app} · ${req.params.name}`;
  }
}

function dispatch(handlers: JobHandlers, req: JobRequest, ctx: JobContext): Promise<JobOutcome> {
  switch (req.kind) {
    case 'run':
      return handlers.run(req.params, ctx);
    case 'smoke':
      return handlers.smoke(req.params, ctx);
    case 'plan':
      return handlers.plan(req.params, ctx);
    case 'calibrate':
      return handlers.calibrate(req.params, ctx);
    case 'capture':
      return handlers.capture(req.params, ctx);
  }
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Promise<void>>();

  private readonly handlers: JobHandlers;
  private readonly events: EventSink;

  constructor(handlers: JobHandlers, events: EventSink) {
    this.handlers = handlers;
    this.events = events;
  }

  enqueue(request: JobRequest, parentId: string | null = null): JobView {
    const job: Job = {
      id: randomUUID(),
      kind: request.kind,
      title: request.title ?? defaultTitle(request),
      state: 'queued',
      params: request.params,
      devices: deviceClaims(request),
      claims: [...deviceClaims(request), ...(request.kind === 'plan' ? [`plan:${request.params.app}`] : [])],
      parentId,
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      message: null,
      resultPath: null,
      request,
      controller: null,
    };
    this.jobs.set(job.id, job);
    this.events.emit({ type: 'job.queued', jobId: job.id, kind: job.kind, title: job.title });
    this.prune();
    this.pump();
    return this.view(job);
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((job) => this.view(job));
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job && this.view(job);
  }

  /** Queued → cancelled immediately; running → signal aborted, state settles when the handler returns. */
  cancel(id: string): JobView | 'not_found' | 'finished' {
    const job = this.jobs.get(id);
    if (!job) return 'not_found';
    if (job.state === 'queued') {
      this.finish(job, 'cancelled', '취소됨', null);
      this.pump();
    } else if (job.state === 'running') {
      job.cancelRequested = true;
      job.controller!.abort(new Error('사용자가 작업을 취소했습니다'));
    } else {
      return 'finished';
    }
    return this.view(job);
  }

  /** Cancels everything and waits for running handlers to return. */
  async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) if (job.state === 'queued' || job.state === 'running') this.cancel(job.id);
    await Promise.allSettled(this.running.values());
  }

  /** Resolves when no job is queued or running (tests, graceful stop). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled(this.running.values());
  }

  private view(job: Job): JobView {
    const { request: _request, claims: _claims, controller: _controller, ...view } = job;
    return { ...view, devices: [...view.devices] };
  }

  private pump(): void {
    const claimed: string[] = [];
    for (const job of this.jobs.values()) if (job.state === 'running') claimed.push(...job.claims);
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued') continue;
      const blocked = job.claims.some((claim) => claimed.some((other) => claimsConflict(claim, other)));
      // Blocked jobs still claim their resources so later jobs cannot overtake them (FIFO per resource).
      claimed.push(...job.claims);
      if (!blocked) this.start(job);
    }
  }

  private start(job: Job): void {
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    job.controller = new AbortController();
    this.events.emit({ type: 'job.started', jobId: job.id, kind: job.kind });
    const done = this.execute(job).finally(() => {
      this.running.delete(job.id);
      this.pump();
    });
    this.running.set(job.id, done);
  }

  private async execute(job: Job): Promise<void> {
    const signal = job.controller!.signal;
    let outcome: JobOutcome;
    try {
      outcome = await dispatch(this.handlers, job.request, { jobId: job.id, events: this.events, signal });
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err), resultPath: null };
    }
    if (signal.aborted && !outcome.ok) {
      this.finish(job, 'cancelled', `취소됨 — ${outcome.message}`, outcome.resultPath);
      return;
    }
    this.finish(job, outcome.ok ? 'succeeded' : 'failed', outcome.message, outcome.resultPath);
    if (outcome.ok && job.request.kind === 'plan' && job.request.params.run) {
      if (outcome.paths?.length) {
        const { platform, deviceIds, junit } = job.request.params.run;
        this.enqueue({ kind: 'run', params: { paths: outcome.paths, platform, deviceIds, junit } }, job.id);
      } else {
        this.events.emit({ type: 'log', level: 'warn', source: 'server', message: `계획 ${job.title}: 생성된 테스트가 없어 실행을 건너뜁니다` });
      }
    }
  }

  private finish(job: Job, state: Exclude<JobState, 'queued' | 'running'>, message: string, resultPath: string | null): void {
    job.state = state;
    job.finishedAt = new Date().toISOString();
    job.message = message;
    job.resultPath = resultPath;
    job.controller = null;
    this.events.emit({ type: 'job.finished', jobId: job.id, kind: job.kind, ok: state === 'succeeded', message, resultPath });
  }

  private prune(): void {
    let excess = this.jobs.size - FINISHED_JOBS_KEPT;
    for (const [id, job] of this.jobs) {
      if (excess <= 0) break;
      if (job.state === 'queued' || job.state === 'running') continue;
      this.jobs.delete(id);
      excess--;
    }
  }
}
