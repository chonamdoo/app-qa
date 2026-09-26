// Appium server lifecycle: reuse a healthy server on QA_APPIUM_PORT, otherwise spawn the project-local one.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv, PATHS } from '../core/config.ts';
import { ensureDir, writeJsonAtomic } from '../core/fsx.ts';
import { AppiumClient } from './client.ts';
import { childEnv } from './exec.ts';

export const APPIUM_MAIN = join(PATHS.root, 'node_modules', 'appium', 'index.js');
export const APPIUM_LOG = join(PATHS.logs, 'appium.log');
const STATE_FILE = join(PATHS.state, 'appium.json');

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

export interface AppiumServer {
  url: string;
  port: number;
  /** Pid of the server we spawned (null when an already-running server was reused and we have no record of it). */
  pid: number | null;
  reused: boolean;
  version: string | null;
}

interface ServerState {
  pid: number;
  port: number;
  startedAt: string;
}

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

function readState(): ServerState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerState;
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

/**
 * Returns a ready Appium server. Reuses a healthy one on the port; otherwise spawns
 * `node node_modules/appium/index.js server` detached (survives this CLI, logs to .qa/logs/appium.log).
 */
export async function ensureAppium(opts: { port?: number; timeoutMs?: number } = {}): Promise<AppiumServer> {
  const port = opts.port ?? appiumPort();
  const url = `http://127.0.0.1:${port}`;
  const existing = await probe(url);
  const state = readState();
  if (existing.ready) {
    return { url, port, pid: state?.port === port && alive(state.pid) ? state.pid : null, reused: true, version: existing.version };
  }
  if (!existsSync(APPIUM_MAIN)) throw new Error('node_modules/appium 이 없습니다. `npm install` 후 `qa setup`을 실행하세요.');
  if (!existsSync(PATHS.appiumHome)) throw new Error('Appium 드라이버가 설치되지 않았습니다. `qa setup`을 먼저 실행하세요.');

  if (LOG_FILTERS_FILE.includes(',')) throw new Error(`프로젝트 경로에 쉼표(,)가 있어 Appium 로그 필터를 전달할 수 없습니다: ${PATHS.root}`);
  writeJsonAtomic(LOG_FILTERS_FILE, APPIUM_LOG_FILTERS);
  ensureDir(PATHS.logs);
  const fd = openSync(APPIUM_LOG, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, appiumServerArgs(port), { cwd: PATHS.root, env: childEnv(), detached: true, stdio: ['ignore', fd, fd] });
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
  writeJsonAtomic(STATE_FILE, { pid, port, startedAt: new Date().toISOString() } satisfies ServerState);

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`Appium 서버가 시작 중 종료되었습니다 (exit ${exited}). 로그: ${APPIUM_LOG}\n${logExcerpt(readLog())}`);
    const s = await probe(url);
    if (s.ready) return { url, port, pid, reused: false, version: s.version };
    await delay(250);
  }
  process.kill(pid, 'SIGTERM');
  throw new Error(`Appium 서버가 ${opts.timeoutMs ?? 60_000}ms 안에 준비되지 않았습니다. 로그: ${APPIUM_LOG}\n${logExcerpt(readLog())}`);
}

/** Stops the server this project spawned (recorded in .qa/appium.json). Returns false when none was running. */
export async function stopAppium(): Promise<boolean> {
  const state = readState();
  if (!state || !alive(state.pid)) {
    rmSync(STATE_FILE, { force: true });
    return false;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(state.pid); i++) await delay(250);
  if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
  rmSync(STATE_FILE, { force: true });
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
