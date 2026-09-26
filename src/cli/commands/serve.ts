// `qa serve`: engine server for the macOS app. Runner/planner/drivers are imported lazily at use time, so the server
// starts even while those modules are missing and the affected job/route fails with a clear message instead.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv, PATHS } from '../../core/config.ts';
import type { EventSink } from '../../core/events.ts';
import { writeJsonAtomic } from '../../core/fsx.ts';
import type { DeviceInfo, Platform, Verdict } from '../../core/types.ts';
import type { JobOutcome } from '../../server/jobs.ts';
import { createServer, HttpError, type ServerHandlers } from '../../server/server.ts';

/** §10 RunResult fields the queue reports. */
interface RunResultLike {
  runId: string;
  counts: Record<Verdict, number>;
  reportPath: string;
}

interface RunnerModule {
  runTests(opts: { paths: string[]; platform: Platform | 'all'; deviceIds?: Partial<Record<Platform, string>>; tags?: string[]; junit?: boolean; events?: EventSink; signal?: AbortSignal }): Promise<RunResultLike>;
  runSmoke(opts: { app: string; platform: Platform; deviceId?: string; crawl?: 'tabs'; events?: EventSink; signal?: AbortSignal }): Promise<RunResultLike>;
  captureScreen(opts: { app: string; platform: Platform; deviceId?: string; name: string; events?: EventSink; signal?: AbortSignal }): Promise<unknown>;
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

function realHandlers(): ServerHandlers {
  const runner = () => load<RunnerModule>('../../runner/index.ts', '러너', ['runTests', 'runSmoke', 'captureScreen']);
  const drivers = () => load<DriversModule>('../../drivers/index.ts', '드라이버', ['listDevices', 'listApps']);
  const screen = () => load<ScreenModule>('../../drivers/screen.ts', '화면 캡처', ['grabScreen', 'startRecording', 'stopRecording']);
  return {
    async run(params, { events, signal }) {
      const { runTests } = await runner();
      return runOutcome([await runTests({ ...params, events, signal })]);
    },
    async smoke(params, { events, signal }) {
      const { runSmoke } = await runner();
      const platforms: Platform[] = params.platform === 'all' ? ['android', 'ios'] : [params.platform];
      const results: RunResultLike[] = [];
      for (const platform of platforms) {
        signal.throwIfAborted();
        results.push(await runSmoke({ app: params.app, platform, deviceId: params.deviceIds[platform], crawl: params.crawl, events, signal }));
      }
      return runOutcome(results);
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
      await captureScreen({ ...params, events, signal });
      return { ok: true, message: `화면 캡처 저장: ${params.name}`, resultPath: null };
    },
    devices: async () => (await drivers()).listDevices(),
    apps: async (platform, deviceId) => (await drivers()).listApps(platform, deviceId),
    screen: async (platform, deviceId) => (await screen()).grabScreen(platform, deviceId),
    startRecording: async (platform, deviceId, file) => (await screen()).startRecording(platform, deviceId, file),
    stopRecording: async (platform, deviceId, file) => (await screen()).stopRecording(platform, deviceId, file),
  };
}

/**
 * Starts the engine server and publishes its connection info (port, token): the 0600 temp file is renamed into place,
 * so the token is never readable by others nor torn. `close()` stops the server and removes the file while it is ours.
 */
export async function startEngine(opts: { port: number; infoFile: string; handlers: ServerHandlers }): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer({ handlers: opts.handlers });
  const port = await server.listen(opts.port);
  writeJsonAtomic(opts.infoFile, { port, token: server.token, pid: process.pid, startedAt: new Date().toISOString() });
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
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`qa serve: 잘못된 포트 ${values.port}`);
    return 2;
  }
  loadEnv();
  const infoFile = join(PATHS.state, 'server.json');
  const engine = await startEngine({ port, infoFile, handlers: realHandlers() });
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
