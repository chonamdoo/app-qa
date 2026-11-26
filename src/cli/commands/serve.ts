import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv, PATHS } from '../../core/config.ts';
import { EventBus, type EventSink } from '../../core/events.ts';
import { writeJsonAtomic } from '../../core/fsx.ts';
import { PLATFORM_INFO } from '../../core/platform.ts';
import type { DeviceInfo, Platform, Verdict } from '../../core/types.ts';
import { createAgentService, type AgentExecutionService, type CaptureResult, type InspectResult, type RunnerDeps } from '../../runner/index.ts';
import type { JobContext, JobOutcome, SmokeParams } from '../../server/jobs.ts';
import { createServer, HttpError, type ServerHandlers } from '../../server/server.ts';
import { ProductStore } from '../../server/product-store.ts';
import { loadAppProfile } from '../../spec/load.ts';
import { profilePlatforms } from '../../spec/schema.ts';
import { ingestSourceLedger } from '../../plan/ingest.ts';
import { ClaudeProductAuthoringAdapter } from '../../plan/product-authoring.ts';
import { renderPortableEvidenceHtml } from '../../report/html.ts';

/** §10 RunResult fields the queue reports. */
interface RunResultLike {
  runId: string;
  counts: Record<Verdict, number>;
  reportPath: string;
}

interface RunnerModule {
  runTests(opts: { paths: string[]; platform: Platform | 'all'; deviceIds?: Partial<Record<Platform, string>>; tags?: string[]; junit?: boolean; events?: EventSink; signal?: AbortSignal }, deps?: Partial<RunnerDeps>): Promise<RunResultLike>;
  runSmoke(opts: { app: string; platform: Platform; deviceId?: string; crawl?: 'tabs'; events?: EventSink; signal?: AbortSignal }, deps?: Partial<RunnerDeps>): Promise<RunResultLike>;
  captureScreen(opts: { app: string; platform: Platform; deviceId?: string; name: string; events?: EventSink; signal?: AbortSignal }, deps?: Partial<RunnerDeps>): Promise<CaptureResult>;
  inspectScreen(opts: { app: string; platform: Platform; deviceId?: string; events?: EventSink; signal?: AbortSignal }, deps?: Partial<RunnerDeps>): Promise<InspectResult>;
}

interface PlannerModule {
  generatePlan(opts: { app: string; docs: string[]; text?: string; llm?: 'claude-cli' | 'codex-cli'; model?: string; approve?: boolean; events?: EventSink; signal?: AbortSignal }): Promise<{
    planPath: string;
    plan: { requirements: unknown[]; tests: unknown[]; untestable: unknown[] };
    testFiles: string[];
  }>;
}

interface DriversModule {
  listDevices(platform?: Platform): Promise<DeviceInfo[]>;
  listApps(platform: Platform, deviceId: string): Promise<unknown[]>;
}

interface ScreenModule {
  grabScreen(platform: Platform, deviceId: string): Promise<Uint8Array>;
  startRecording(platform: Platform, deviceId: string, file: string): Promise<void>;
  stopRecording(platform: Platform, deviceId: string, file: string): Promise<string>;
}

interface CalibrateModule {
  cmdCalibrate(argv: string[]): Promise<number>;
}

const VERDICT_ORDER: Verdict[] = ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'SKIPPED'];

/**
 * Imports a sibling module on demand. Deliberately dynamic: runner/planner/drivers are separate slices that may not exist
 * (or may be broken) while the engine runs, and `qa serve` must still start; a missing module becomes a 503 / failed job.
 */
async function load<T>(specifier: string, label: string, exportsNeeded: string[]): Promise<T> {
  const file = fileURLToPath(new URL(specifier, import.meta.url));
  const shown = relative(PATHS.root, file);
  if (!existsSync(file)) throw new HttpError(503, `${label} 모듈(${shown})이 아직 없습니다 — ${label} 구현이 끝난 뒤 다시 시도하세요`);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(503, `${label} 모듈(${shown})을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  const missing = exportsNeeded.filter((name) => typeof mod[name] !== 'function');
  if (missing.length) throw new HttpError(503, `${label} 모듈(${shown})에 ${missing.join(', ')} 함수가 없습니다`);
  return mod as T;
}

function runOutcome(results: RunResultLike[]): JobOutcome {
  const counts: Record<Verdict, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 };
  for (const result of results) for (const verdict of VERDICT_ORDER) counts[verdict] += result.counts[verdict] ?? 0;
  const executed = VERDICT_ORDER.reduce((sum, v) => sum + counts[v], 0);
  const summary = VERDICT_ORDER.filter((v) => counts[v] > 0)
    .map((v) => `${v} ${counts[v]}`)
    .join(' · ');
  return {
    // Fail-closed: anything but PASS/SKIPPED (or nothing executed) is not a successful job.
    ok: executed > 0 && counts.FAIL + counts.ERROR + counts.INCONCLUSIVE === 0,
    message: summary || '실행된 테스트가 없습니다',
    resultPath: results.at(-1)?.reportPath ?? null,
  };
}

async function smokeJob(runSmoke: RunnerModule['runSmoke'], platforms: readonly Platform[], params: SmokeParams, { events, signal }: JobContext): Promise<JobOutcome> {
  const results: RunResultLike[] = [];
  for (const platform of platforms) {
    signal.throwIfAborted();
    results.push(await runSmoke({ app: params.app, platform, deviceId: params.deviceIds[platform], crawl: params.crawl, events, signal }));
  }
  return runOutcome(results);
}

function realHandlers(agent: AgentExecutionService): ServerHandlers {
  const runner = () => load<RunnerModule>('../../runner/index.ts', '러너', ['runTests', 'runSmoke', 'captureScreen', 'inspectScreen']);
  const drivers = () => load<DriversModule>('../../drivers/index.ts', '드라이버', ['listDevices', 'listApps']);
  const screen = () => load<ScreenModule>('../../drivers/screen.ts', '화면 캡처', ['grabScreen', 'startRecording', 'stopRecording']);
  return {
    agent,
    async run(params, { events, signal }) {
      const { runTests } = await runner();
      return runOutcome([await runTests({ ...params, events, signal }, agent.runnerDeps)]);
    },
    async smoke(params, ctx) {
      const { runSmoke } = await runner();
      return smokeJob(opts => runSmoke(opts, agent.runnerDeps), params.platform === 'all' ? profilePlatforms(loadAppProfile(params.app)) : [params.platform], params, ctx);
    },
    async plan(params, { events, signal }) {
      const { generatePlan } = await load<PlannerModule>('../../plan/index.ts', '플래너', ['generatePlan']);
      const { run: _run, ...opts } = params;
      const { planPath, plan, testFiles } = await generatePlan({ ...opts, events, signal });
      return {
        ok: true,
        message: `요구사항 ${plan.requirements.length} · 테스트 ${plan.tests.length} · 테스트 불가 ${plan.untestable.length}`,
        resultPath: planPath,
        paths: testFiles,
      };
    },
    async calibrate(params) {
      const { cmdCalibrate } = await load<CalibrateModule>('./calibrate.ts', 'Jev 보정', ['cmdCalibrate']);
      const argv = [...(params.mode ? ['--mode', params.mode] : []), ...(params.golden ? ['--golden', params.golden] : [])];
      const code = await cmdCalibrate(argv);
      const messages: Record<number, string> = { 0: '모든 판단 유형 보정 완료', 1: '보정 기준 미달 (실패 기록 저장됨)' };
      return { ok: code === 0, message: messages[code] ?? `보정 오류 (종료 코드 ${code})`, resultPath: null };
    },
    async capture(params, { events, signal }) {
      const { captureScreen } = await runner();
      const files = await captureScreen({ ...params, events, signal }, agent.runnerDeps);
      return { ok: true, message: `화면 캡처 저장: ${params.name}`, resultPath: null, output: { kind: 'capture', files } };
    },
    async inspect(params, { events, signal }) {
      const { inspectScreen } = await runner();
      const { table, model } = await inspectScreen({ ...params, events, signal }, agent.runnerDeps);
      return { ok: true, message: `화면 조회 완료: ${params.app}`, resultPath: null,
        output: { kind: 'inspect', table, candidates: model.candidates, texts: model.texts, occluded: model.occludedNodeIds.length } };
    },
    devices: () => agent.devices(),
    apps: async (platform, deviceId) => {
      if (PLATFORM_INFO[platform].host === 'desktop') throw new HttpError(400, '브라우저 웹 대상은 등록한 앱 프로필로 선택하세요. 호스트 앱 목록으로 대체하지 않습니다.');
      return (await drivers()).listApps(platform, deviceId);
    },
    screen: async (platform, deviceId) => PLATFORM_INFO[platform].host === 'desktop' ? agent.frame(platform, deviceId) : (await screen()).grabScreen(platform, deviceId),
    startRecording: async (platform, deviceId, file) => {
      if (PLATFORM_INFO[platform].host === 'desktop') throw new HttpError(400, '브라우저 녹화는 승인된 실행의 증거 수집 경로를 사용하세요. 호스트 화면을 녹화하지 않습니다.');
      return (await screen()).startRecording(platform, deviceId, file);
    },
    stopRecording: async (platform, deviceId, file) => {
      if (PLATFORM_INFO[platform].host === 'desktop') throw new HttpError(400, '브라우저 녹화는 해당 실행에서 종료·확정해야 합니다. 호스트 화면을 녹화하지 않습니다.');
      return (await screen()).stopRecording(platform, deviceId, file);
    },
  };
}

const REVIEW_TOKEN = /^[A-Za-z0-9_-]{43,256}$/;

/**
 * Reads the operator review secret that the launching app writes as the first line of the engine's stdin pipe.
 * The secret never reaches `.qa/server.json`, the environment or the log, so bearer-only callers cannot learn it.
 */
export function readReviewToken(input: Readable, timeoutMs = 5000): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buffered = '';
  const finish = (outcome: { token: string } | { error: string }) => {
    clearTimeout(timer);
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onEnd);
    input.pause();
    if ('token' in outcome) resolve(outcome.token);
    else reject(new Error(outcome.error));
  };
  const onData = (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const newline = buffered.indexOf('\n');
    if (newline === -1) {
      if (buffered.length > 256) finish({ error: '로컬 검토 권한 값이 올바르지 않습니다' });
      return;
    }
    const token = buffered.slice(0, newline);
    finish(REVIEW_TOKEN.test(token) ? { token } : { error: '로컬 검토 권한 값이 올바르지 않습니다' });
  };
  const onEnd = () => finish({ error: '로컬 검토 권한을 받기 전에 입력이 닫혔습니다' });
  const timer = setTimeout(() => finish({ error: '로컬 검토 권한을 제한 시간 안에 받지 못했습니다' }), timeoutMs);
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', onEnd);
  input.resume();
  return promise;
}

/**
 * Starts the engine server and publishes its connection info (port, bearer token): the 0600 temp file is renamed into
 * place, so the token is never readable by others nor torn. The operator review secret is never published; without
 * `reviewToken` the engine refuses every operator-only action. `close()` stops the server and removes the file while it is ours.
 */
export async function startEngine(opts: { port: number; infoFile: string; handlers: ServerHandlers; bus?: EventBus; reviewToken?: string }): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer({ handlers: opts.handlers, bus: opts.bus, reviewToken: opts.reviewToken, ingestSource: ingestSourceLedger, authoringAdapter: new ClaudeProductAuthoringAdapter(), evidenceHtml: renderPortableEvidenceHtml });
  let port: number;
  try {
    port = await server.listen(opts.port);
    writeJsonAtomic(opts.infoFile, { port, token: server.token, pid: process.pid, startedAt: server.startedAt });
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    port,
    async close() {
      await server.close();
      try {
        const info: unknown = JSON.parse(readFileSync(opts.infoFile, 'utf8'));
        if (typeof info === 'object' && info !== null && 'pid' in info && info.pid === process.pid) rmSync(opts.infoFile);
      } catch {
        // Already removed or replaced by another instance.
      }
    },
  };
}

export async function cmdServe(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '0' },
      /** Exit when stdin closes — the macOS app holds the pipe, so a crashed app never leaves an orphan engine. */
      'exit-with-stdin': { type: 'boolean', default: false },
      /** The launching app writes the operator review secret as the first stdin line; without it operator actions are refused. */
      'review-token-stdin': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`qa serve: 잘못된 포트 ${values.port}`);
    return 2;
  }
  let reviewToken: string | undefined;
  if (values['review-token-stdin']) {
    try {
      reviewToken = await readReviewToken(process.stdin);
    } catch (error) {
      console.error(`qa serve: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  loadEnv();
  const infoFile = join(PATHS.state, 'server.json');
  const bus = new EventBus();
  const product = new ProductStore({ root: PATHS.root, apps: PATHS.apps, uploads: join(PATHS.state, 'uploads'), generated: join(PATHS.tests, 'generated') });
  const agent = createAgentService({
    instanceProfiles: async () => (await product.read()).environments.flatMap(environment =>
      environment.platform === 'desktop-chrome' || environment.platform === 'desktop-safari'
        ? [{ id: environment.id, name: environment.name, platform: environment.platform }] : []),
  }, bus);
  const engine = await startEngine({ port, infoFile, bus, handlers: realHandlers(agent), reviewToken });
  console.log(`qa serve: http://127.0.0.1:${engine.port} (접속 정보 ${relative(PATHS.root, infoFile)})`);

  const { promise: stopped, resolve: stop } = Promise.withResolvers<string>();
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  if (values['exit-with-stdin']) {
    process.stdin.once('end', () => stop('stdin closed'));
    process.stdin.once('close', () => stop('stdin closed'));
    process.stdin.resume();
  }
  const reason = await stopped;
  console.log(`qa serve: 종료 (${reason})`);
  process.stdin.pause();
  await engine.close();
  return 0;
}
