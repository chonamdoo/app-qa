// Appium server lifecycle: reuse a healthy server on QA_APPIUM_PORT, otherwise spawn the project-local one.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv, PATHS } from '../core/config.ts';
import { ensureDir, writeJson } from '../core/fsx.ts';
import { childEnv } from '../drivers/common.ts';
import { AppiumClient } from './client.ts';

export const APPIUM_MAIN = join(PATHS.root, 'node_modules', 'appium', 'index.js');
export const APPIUM_LOG = join(PATHS.logs, 'appium.log');
const STATE_FILE = join(PATHS.state, 'appium.json');

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

  ensureDir(PATHS.logs);
  const fd = openSync(APPIUM_LOG, 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [APPIUM_MAIN, 'server', '--address', '127.0.0.1', '--port', String(port), '--log-no-colors', '--log-timestamp', '--local-timezone'],
      { cwd: PATHS.root, env: childEnv(), detached: true, stdio: ['ignore', fd, fd] },
    );
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
  writeJson(STATE_FILE, { pid, port, startedAt: new Date().toISOString() } satisfies ServerState);

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`Appium 서버가 시작 중 종료되었습니다 (exit ${exited}). 로그: ${APPIUM_LOG}\n${logTail()}`);
    const s = await probe(url);
    if (s.ready) return { url, port, pid, reused: false, version: s.version };
    await delay(250);
  }
  process.kill(pid, 'SIGTERM');
  throw new Error(`Appium 서버가 ${opts.timeoutMs ?? 60_000}ms 안에 준비되지 않았습니다. 로그: ${APPIUM_LOG}\n${logTail()}`);
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

function logTail(lines = 20): string {
  try {
    return readFileSync(APPIUM_LOG, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
