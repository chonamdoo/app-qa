// Device log capture to a file + time-range slicing (attached to FAIL evidence).
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from '../appium/exec.ts';
import { adbPath, PATHS } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import type { Platform } from '../core/types.ts';

/** `logcat -v threadtime -v UTC -v year` → "2026-09-25 23:45:43.620 +0000  518  518 I tag: msg". */
const ANDROID_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) \+0000\b/;
/** `log stream --style compact` → "2026-09-26 08:45:43.620 E  app[123:456] msg" (host local time). */
const IOS_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\b/;

/** Epoch ms of a log line's timestamp, or null for continuation/header lines. */
export function logLineTime(platform: Platform, line: string): number | null {
  const m = (platform === 'android' ? ANDROID_TS : IOS_TS).exec(line);
  if (!m) return null;
  return Date.parse(platform === 'android' ? `${m[1]}T${m[2]}Z` : `${m[1]}T${m[2]}`);
}

/** Lines stamped within [from, to]; untimestamped lines follow the line before them. */
export function sliceLog(platform: Platform, text: string, fromMs: number, toMs: number): string {
  const out: string[] = [];
  let inRange = false;
  for (const line of text.split('\n')) {
    const t = logLineTime(platform, line);
    if (t !== null) inRange = t >= fromMs && t <= toMs;
    if (inRange && line) out.push(line);
  }
  return out.join('\n');
}

export function androidLogArgs(serial: string, filter: { pid: string } | { uid: string }, sinceMs: number): string[] {
  return [
    '-s',
    serial,
    'logcat',
    '-v',
    'threadtime',
    '-v',
    'UTC',
    '-v',
    'year',
    '-T',
    (sinceMs / 1000).toFixed(3),
    'pid' in filter ? `--pid=${filter.pid}` : `--uid=${filter.uid}`,
  ];
}

/** Default `log stream` level (default/error/fault): RN console output lands there; info/debug is megabytes of network noise. */
export function iosLogArgs(udid: string, executable: string): string[] {
  return ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--predicate', `process == "${executable.replace(/["\\]/g, '\\$&')}"`];
}

/**
 * One log file per driver session; streams are (re)armed per app process (a relaunch yields a new pid)
 * and all append to the same file, so slices span restarts.
 */
export class LogCapture {
  readonly platform: Platform;
  readonly file: string;
  #child: ChildProcess | null = null;
  #key: string | null = null;
  #onExit = () => this.stop();

  constructor(platform: Platform, deviceId: string) {
    this.platform = platform;
    this.file = join(ensureDir(PATHS.logs), `${platform}-${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}.log`);
  }

  /** Starts streaming `file args` unless a live stream for the same `key` (pid / executable) is already running. */
  arm(key: string, file: 'adb' | 'xcrun', args: string[]): void {
    if (this.#key === key && this.#child && this.#child.exitCode === null) return;
    this.stop();
    const fd = openSync(this.file, 'a', 0o600);
    try {
      this.#child = spawn(file === 'adb' ? adbPath() : 'xcrun', args, { env: childEnv(), stdio: ['ignore', fd, 'ignore'] });
    } finally {
      closeSync(fd);
    }
    this.#key = key;
    process.once('exit', this.#onExit);
  }

  get armed(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  slice(fromIso: string, toIso: string): string {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
    return sliceLog(this.platform, text, Date.parse(fromIso), Date.parse(toIso));
  }

  stop(): void {
    process.removeListener('exit', this.#onExit);
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGTERM');
    this.#child = null;
    this.#key = null;
  }
}
