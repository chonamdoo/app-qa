// Appium server lifecycle: reuse a server on QA_APPIUM_PORT only when .qa/appium-<port>.json proves this project started it
// with the current log configuration; otherwise spawn the project-local one.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadEnv, PATHS } from '../core/config.ts';
import { ensureDir, sha256, writeJsonAtomic } from '../core/fsx.ts';
import { acquireFileLock, FileLockedError } from '../core/lock.ts';
import { START_SLACK_MS, systemProbe } from '../core/process.ts';
import { AppiumClient } from './client.ts';
import { childEnv, run } from './exec.ts';

export const APPIUM_MAIN = join(PATHS.root, 'node_modules', 'appium', 'index.js');
export const APPIUM_LOG = join(PATHS.logs, 'appium.log');
/** One record per port: a server started on another port never overwrites the proof for this one. */
const stateFileFor = (port: number): string => join(PATHS.state, `appium-${port}.json`);

/** Appium splits array CLI values on commas, so the filter rules travel as a JSON file path, not inline JSON. */
const LOG_FILTERS_FILE = join(PATHS.state, 'appium-log-filters.json');

/**
 * Second line of defence behind the log level: Appium's secure-value filters rewrite any logged JSON field that can
 * carry typed text — `text`/`value` (element value, `/keys`, find locators) and `content` (`mobile: setClipboard`).
 * The value may be cut off by Appium's body truncation, so the closing quote/bracket is optional.
 */
export const APPIUM_LOG_FILTERS = [
  { pattern: String.raw`"(text|value|content)"\s*:\s*(?:"(?:[^"\\]|\\.)*"?|\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*"?)*\]?)`, replacer: '"$1":"**SECURE**"' },
];

/**
 * `appium server` arguments. Appium 3.8 logs every request body at `info` (`--> POST … {body}`, base-driver
 * express-logging) and proxied bodies / command args at `debug` (its default), so the level is `warn`.
 * `--log-filters` names the file `ensureAppium` writes from `APPIUM_LOG_FILTERS`.
 */
export function appiumServerArgs(port: number): string[] {
  return [
    APPIUM_MAIN,
    'server',
    '--address',
    '127.0.0.1',
    '--port',
    String(port),
    '--log-level',
    'warn',
    '--log-filters',
    LOG_FILTERS_FILE,
    '--log-no-colors',
    '--log-timestamp',
    '--local-timezone',
  ];
}

/** The launch configuration a server is recorded with: its argv and the sha256 of the log filters written for it. */
export function appiumLaunchConfig(port: number): { argv: string[]; logFilters: string } {
  return { argv: appiumServerArgs(port), logFilters: sha256(JSON.stringify(APPIUM_LOG_FILTERS)) };
}

export interface AppiumServer {
  url: string;
  port: number;
  /** Pid of the server: spawned now, or proven by `.qa/appium-<port>.json` to be the one this project started. */
  pid: number;
  reused: boolean;
  version: string | null;
}

/** `.qa/appium-<port>.json`: the server this project spawned on that port. */
const ServerState = z.object({
  pid: z.number().int().positive(),
  port: z.number().int(),
  /** Spawn time; a live pid whose process started at another time is a reused pid, not our server. */
  startedAt: z.iso.datetime(),
  argv: z.array(z.string()),
  logFilters: z.string(),
});
type ServerState = z.infer<typeof ServerState>;

export function appiumPort(): number {
  loadEnv();
  const raw = process.env.QA_APPIUM_PORT;
  const port = raw ? Number(raw) : 4723;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`QA_APPIUM_PORT 값이 올바르지 않습니다: ${raw}`);
  return port;
}

async function probe(url: string): Promise<{ ready: boolean; version: string | null }> {
  try {
    const s = await new AppiumClient(url).status(2000);
    return { ready: s.ready === true, version: s.build?.version ?? null };
  } catch {
    return { ready: false, version: null };
  }
}

/** The record in `file`; null when it is missing, unreadable, or not in the current format. */
function readState(file: string): ServerState | null {
  try {
    return ServerState.safeParse(JSON.parse(readFileSync(file, 'utf8'))).data ?? null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why `state.pid` is not the recorded server process (dead, or a pid reused by another process); null when it is. */
function processProblem(state: ServerState): string | null {
  const p = systemProbe(state.pid);
  if (!p.alive) return `기록된 서버 프로세스(pid ${state.pid})가 종료되었습니다`;
  if (p.startedAtMs === null || Math.abs(p.startedAtMs - Date.parse(state.startedAt)) > START_SLACK_MS) {
    return `pid ${state.pid} 프로세스는 기록된 서버가 아닙니다 (시작 시각 불일치)`;
  }
  return null;
}

/**
 * Why the server answering on `port` must not be reused; null only when `state` proves this project started it with
 * the current launch configuration (argv incl. log level and filters file, filter rules) and the recorded process —
 * alive, same start time — is the only listener on the port.
 */
async function reuseProblem(state: ServerState | null, port: number): Promise<string | null> {
  if (!state) return `이 프로젝트가 시작한 서버라는 기록(.qa/appium-${port}.json)이 없거나 형식이 올바르지 않습니다`;
  if (state.port !== port) return `기록된 서버의 포트(${state.port})가 다릅니다`;
  const expected = appiumLaunchConfig(port);
  if (!isDeepStrictEqual(state.argv, expected.argv) || state.logFilters !== expected.logFilters) {
    return '현재 로그 설정(--log-level warn, 로그 필터)과 다른 설정으로 시작된 서버입니다';
  }
  const problem = processProblem(state);
  if (problem) return problem;
  let listeners: number[];
  try {
    const { stdout } = await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { allowFail: true, timeoutMs: 15_000 });
    listeners = stdout.toString('utf8').split('\n').filter(Boolean).map(Number);
  } catch (err) {
    return `${port}번 포트를 연 프로세스를 확인하지 못했습니다 (${(err as Error).message})`;
  }
  if (listeners.length === 0 || listeners.some((pid) => pid !== state.pid)) {
    return `${port}번 포트를 연 프로세스(pid ${listeners.join(', ') || '없음'})가 기록된 서버(pid ${state.pid})가 아닙니다`;
  }
  return null;
}

/** Startups in flight in this process, by port + state file: concurrent device slots share one spawn. */
const starting = new Map<string, Promise<AppiumServer>>();

/**
 * Returns a ready Appium server. A server already answering on the port is reused only when `reuseProblem` finds
 * nothing — it is never killed; otherwise this spawns `node node_modules/appium/index.js server` detached (survives
 * this CLI, logs to .qa/logs/appium.log) and records it in `stateFile` (default `.qa/appium-<port>.json`).
 * Concurrent callers (device slots of one run, or two `qa` processes) never race to spawn: calls in this process share
 * one startup, and across processes `.qa/locks/appium-<port>.lock` admits one starter while the others wait for it.
 */
export function ensureAppium(opts: { port?: number; timeoutMs?: number; stateFile?: string } = {}): Promise<AppiumServer> {
  const port = opts.port ?? appiumPort();
  const key = `${port}|${opts.stateFile ?? stateFileFor(port)}`;
  let pending = starting.get(key);
  if (!pending) {
    pending = startupLocked(opts).finally(() => starting.delete(key));
    starting.set(key, pending);
  }
  return pending;
}

async function startupLocked(opts: { port?: number; timeoutMs?: number; stateFile?: string }): Promise<AppiumServer> {
  const port = opts.port ?? appiumPort();
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const file = join(PATHS.locks, `appium-${port}.lock`);
  for (;;) {
    let lock;
    try {
      lock = acquireFileLock(file, { purpose: `Appium 서버(포트 ${port}) 시작` });
    } catch (err) {
      if (!(err instanceof FileLockedError) || Date.now() >= deadline) throw err;
      await delay(250);
      continue;
    }
    try {
      return await startOrReuse(opts, port, deadline);
    } finally {
      lock.release();
    }
  }
}

async function startOrReuse(opts: { stateFile?: string }, port: number, deadline: number): Promise<AppiumServer> {
  const stateFile = opts.stateFile ?? stateFileFor(port);
  const url = `http://127.0.0.1:${port}`;
  const existing = await probe(url);
  if (existing.ready) {
    const state = readState(stateFile);
    const problem = await reuseProblem(state, port);
    if (problem || !state) {
      throw new Error(
        `포트 ${port}에서 실행 중인 Appium 서버를 재사용하지 않습니다: ${problem}. 요청 본문(입력한 텍스트)을 로그에 남기는 서버일 수 있습니다. ` +
          `그 서버를 직접 종료한 뒤 다시 실행하거나(확인: lsof -nP -iTCP:${port} -sTCP:LISTEN), QA_APPIUM_PORT로 비어 있는 포트를 지정하세요.`,
      );
    }
    return { url, port, pid: state.pid, reused: true, version: existing.version };
  }
  if (!existsSync(APPIUM_MAIN)) throw new Error('node_modules/appium 이 없습니다. `npm install` 후 `qa setup`을 실행하세요.');
  if (!existsSync(PATHS.appiumHome)) throw new Error('Appium 드라이버가 설치되지 않았습니다. `qa setup`을 먼저 실행하세요.');

  if (LOG_FILTERS_FILE.includes(',')) throw new Error(`프로젝트 경로에 쉼표(,)가 있어 Appium 로그 필터를 전달할 수 없습니다: ${PATHS.root}`);
  writeJsonAtomic(LOG_FILTERS_FILE, APPIUM_LOG_FILTERS);
  ensureDir(PATHS.logs);
  const fd = openSync(APPIUM_LOG, 'a', 0o600);
  const config = appiumLaunchConfig(port);
  let child;
  try {
    child = spawn(process.execPath, config.argv, { cwd: PATHS.root, env: childEnv(), detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error('Appium 서버 프로세스를 시작하지 못했습니다.');
  let exited: number | null | undefined;
  child.once('exit', (code) => {
    exited = code;
  });
  child.unref();
  writeJsonAtomic(stateFile, { pid, port, startedAt: new Date().toISOString(), ...config } satisfies ServerState);

  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`Appium 서버가 시작 중 종료되었습니다 (exit ${exited}). 로그: ${APPIUM_LOG}\n${logExcerpt(readLog())}`);
    const s = await probe(url);
    if (s.ready) return { url, port, pid, reused: false, version: s.version };
    await delay(250);
  }
  process.kill(pid, 'SIGTERM');
  throw new Error(`Appium 서버가 제한 시간 안에 준비되지 않았습니다. 로그: ${APPIUM_LOG}\n${logExcerpt(readLog())}`);
}

/** Stops the server this project spawned on QA_APPIUM_PORT (recorded in .qa/appium-<port>.json); a pid now held by another process is never signalled. Returns false when none was running. */
export async function stopAppium(): Promise<boolean> {
  const stateFile = stateFileFor(appiumPort());
  const state = readState(stateFile);
  if (!state || processProblem(state)) {
    rmSync(stateFile, { force: true });
    return false;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(state.pid); i++) await delay(250);
  if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
  rmSync(stateFile, { force: true });
  return true;
}

function readLog(): string {
  try {
    return readFileSync(APPIUM_LOG, 'utf8');
  } catch {
    return '';
  }
}

// Lines that can carry a request/response body: HTTP request/response lines, proxied bodies, command args, capability
// dumps, and anything holding a JSON object/array or a pretty-printed JSON field (older runs may have logged at debug).
const BODY_LINE = /-->|<--|\bCalling \S+\(\) with args\b|\bProxying \[|\bGot response with\b|\bwith body\b|\brequest bod|\bW3C capabilities\b|[{[]\s*"|\[\s*\[|^\s*"[^"]*"\s*:/i;

/** The last `lines` log lines fit for an error message: every line that could hold a request/response body is dropped. */
export function logExcerpt(text: string, lines = 20): string {
  return text
    .split('\n')
    .filter((line) => !BODY_LINE.test(line))
    .slice(-lines)
    .join('\n');
}
