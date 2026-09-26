// Device log capture to a file + time-range slicing (attached to FAIL evidence). Every captured line passes the
// runner's sanitizer before it is written: raw device output never reaches .qa/logs.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline, Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
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
 * Splits a byte stream into lines and emits `sanitize(line)` for each one; a trailing line without a newline is
 * sanitized when the stream ends. UTF-8 characters split across chunks are decoded whole. A throwing `sanitize`
 * fails the stream, so nothing unsanitized is ever passed on.
 */
export function sanitizeLines(sanitize: (line: string) => string): Transform {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const pass = (lines: string[], done: TransformCallback) => {
    if (!lines.length) return done();
    let out: string;
    try {
      out = lines.map((line) => `${sanitize(line)}\n`).join('');
    } catch (err) {
      return done(err as Error);
    }
    done(null, out);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const lines = (partial + decoder.write(chunk)).split('\n');
      partial = lines.pop()!;
      pass(lines, done);
    },
    flush(done) {
      const rest = partial + decoder.end();
      partial = '';
      pass(rest ? [rest] : [], done);
    },
  });
}

/** A running log process; `written` settles once its output is sanitized and written (or the pipeline failed). */
interface Capture {
  child: ChildProcess;
  key: string;
  sanitize: (line: string) => string;
  written: Promise<void>;
}

/** How long `stop` lets a signalled log process close its output before the unread rest is dropped. */
const DRAIN_MS = 2000;

/**
 * One log file per driver session; streams are (re)armed per app process (a relaunch yields a new pid)
 * and all append to the same file, so slices span restarts.
 */
export class LogCapture {
  readonly platform: Platform;
  readonly file: string;
  #capture: Capture | null = null;
  #onExit = () => void this.stop();

  constructor(platform: Platform, deviceId: string) {
    this.platform = platform;
    this.file = join(ensureDir(PATHS.logs), `${platform}-${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}.log`);
  }

  /**
   * Streams the stdout of `file args` into the log file line by line through `sanitize`. A live stream for the same
   * `key` (pid / executable) keeps running and sanitizes the lines still to come with `sanitize`.
   */
  async arm(key: string, file: 'adb' | 'xcrun', args: string[], sanitize: (line: string) => string): Promise<void> {
    const live = this.#capture;
    if (live && live.key === key && live.child.exitCode === null && live.child.signalCode === null) {
      live.sanitize = sanitize;
      return;
    }
    await this.stop();
    const child = spawn(file === 'adb' ? adbPath() : 'xcrun', args, { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child, 'spawn'); // a missing binary rejects here and reaches the startLogs caller
    const written = Promise.withResolvers<void>();
    const capture: Capture = { child, key, sanitize, written: written.promise };
    pipeline(child.stdout!, sanitizeLines((line) => capture.sanitize(line)), createWriteStream(this.file, { flags: 'a', mode: 0o600 }), () => written.resolve());
    this.#capture = capture;
    process.once('exit', this.#onExit);
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

  /** Signals the log process; resolves once its remaining output is sanitized and written (unread output is dropped after `DRAIN_MS`). */
  async stop(): Promise<void> {
    process.removeListener('exit', this.#onExit);
    const capture = this.#capture;
    this.#capture = null;
    if (!capture) return;
    if (capture.child.exitCode === null && capture.child.signalCode === null) capture.child.kill('SIGTERM');
    const drained = await Promise.race([capture.written.then(() => true), delay(DRAIN_MS, false, { ref: false })]);
    if (drained) return;
    capture.child.stdout?.destroy();
    await capture.written;
  }
}
