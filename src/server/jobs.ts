// Job queue: validated requests, per-resource serialization (FIFO per device, the one desktop display, and per app for
// plan generation), cancellation via AbortController.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventSink, JobKind } from '../core/events.ts';
import { PLATFORM_INFO, PLATFORMS } from '../core/platform.ts';
import type { Platform } from '../core/types.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';

/** A platform, or `all` = every platform of the app profile. */
const PlatformChoice = z.enum([...PLATFORMS, 'all']);
type PlatformChoice = z.infer<typeof PlatformChoice>;
/** Device id per platform (desktop: the platform id); unknown platform keys are rejected. */
const DeviceIds = z.partialRecord(z.enum(PLATFORMS), z.string().min(1));

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
  /** Documents; empty = app profile `docs`. The server replaces them with the exact files resolved at enqueue. */
  docs: z.array(z.string().min(1)).default([]),
  /**
   * Set by the server with `docs` (a client value is dropped): realpaths each document must still lie inside when the
   * planner reads it.
   */
  docRoots: z.array(z.string().min(1)).optional(),
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
  platform: z.enum(PLATFORMS),
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
  /** Device claims `<platform>:<deviceId|*>`; `*` = any device of that platform (desktop platforms claim their one browser). */
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
  /** Resources held while running: the device claims, `desktop:display` for desktop browsers, `plan:<app>` for plan jobs (one generation per app). */
  claims: string[];
  controller: AbortController | null;
}

const FINISHED_JOBS_KEPT = 500;

/** Claim for one platform: the given device, else the platform's only browser (desktop, id = platform) or any device. */
function claimFor(platform: Platform, deviceId: string | undefined): string {
  return `${platform}:${deviceId ?? (PLATFORM_INFO[platform].host === 'desktop' ? platform : '*')}`;
}

/** This Mac's one screen, pointer and keyboard: every desktop browser drives it, so desktop jobs never run side by side. */
const DESKTOP_DISPLAY = 'desktop:display';

/**
 * Claims of a request: `devices` (shown per job) and every resource held while it runs. `all` = the app profile's
 * platforms; without a profile (runs span apps unknown here, or the profile does not load) it claims every platform, so a
 * job never runs beside another on a device it may use. A desktop platform also claims `desktop:display`.
 */
export function jobClaims(req: JobRequest, profile: AppProfile | null = null): { devices: string[]; resources: string[] } {
  let platforms: { platform: Platform; deviceId: string | undefined }[];
  switch (req.kind) {
    case 'run':
    case 'smoke': {
      const { platform, deviceIds } = req.params;
      const chosen: readonly Platform[] = platform !== 'all' ? [platform] : profile ? profilePlatforms(profile) : PLATFORMS;
      platforms = chosen.map((p) => ({ platform: p, deviceId: deviceIds[p] }));
      break;
    }
    case 'capture':
      platforms = [{ platform: req.params.platform, deviceId: req.params.deviceId }];
      break;
    case 'plan':
    case 'calibrate':
      platforms = [];
      break;
  }
  const devices = platforms.map(({ platform, deviceId }) => claimFor(platform, deviceId));
  const display = platforms.some(({ platform }) => PLATFORM_INFO[platform].host === 'desktop') ? [DESKTOP_DISPLAY] : [];
  return { devices, resources: [...devices, ...display, ...(req.kind === 'plan' ? [`plan:${req.params.app}`] : [])] };
}

/** `<resource>:<id>` claims conflict on the same resource with the same id or a `*`; ids may contain `:` (adb over Wi-Fi). */
function claimsConflict(a: string, b: string): boolean {
  const ca = a.indexOf(':');
  const cb = b.indexOf(':');
  const ia = a.slice(ca + 1);
  const ib = b.slice(cb + 1);
  return a.slice(0, ca) === b.slice(0, cb) && (ia === ib || ia === '*' || ib === '*');
}

/** Title label of a platform choice; with the profile, `all` names its platforms and web profiles name the browser. */
function choiceLabel(choice: PlatformChoice, profile: AppProfile | null): string {
  const platforms = choice !== 'all' ? [choice] : profile ? profilePlatforms(profile) : null;
  if (!platforms) return '모든 플랫폼';
  return platforms.map((p) => (profile?.web ? PLATFORM_INFO[p].webLabel : PLATFORM_INFO[p].label)).join(' + ');
}

function defaultTitle(req: JobRequest, profile: AppProfile | null): string {
  switch (req.kind) {
    case 'run':
      return `테스트 실행 · ${choiceLabel(req.params.platform, null)}${req.params.paths.length ? ` · ${req.params.paths.length}개 경로` : ''}`;
    case 'smoke':
      return `스모크 · ${req.params.app} · ${choiceLabel(req.params.platform, profile)}${req.params.crawl ? ' · 탭 순회' : ''}`;
    case 'plan':
      return `계획 생성${req.params.run ? ' + 실행' : ''} · ${req.params.app}`;
    case 'calibrate':
      return `Jev 보정${req.params.mode ? ` · ${req.params.mode}` : ''}`;
    case 'capture':
      return `화면 캡처 · ${req.params.app} · ${choiceLabel(req.params.platform, profile)} · ${req.params.name}`;
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
  private readonly profileOf: (app: string) => AppProfile | null;

  /** `profileOf` resolves an app profile (null when missing/invalid) for `all` expansion and web-aware titles. */
  constructor(handlers: JobHandlers, events: EventSink, profileOf: (app: string) => AppProfile | null = () => null) {
    this.handlers = handlers;
    this.events = events;
    this.profileOf = profileOf;
  }

  enqueue(request: JobRequest, parentId: string | null = null): JobView {
    const profile = request.kind === 'smoke' || request.kind === 'capture' ? this.profileOf(request.params.app) : null;
    const { devices, resources } = jobClaims(request, profile);
    const job: Job = {
      id: randomUUID(),
      kind: request.kind,
      title: request.title ?? defaultTitle(request, profile),
      state: 'queued',
      params: request.params,
      devices,
      claims: resources,
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
