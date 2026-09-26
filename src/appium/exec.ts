// Host process helpers (adb, xcrun, appium CLI). Never routed through a host shell.
// Bottom layer of the drivers module: `src/drivers/*` builds on `src/appium/*`, never the reverse.
import { execFile } from 'node:child_process';
import { adbPath, androidHome, PATHS } from '../core/config.ts';

export class CommandError extends Error {
  readonly file: string;
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  /** ENOENT etc. when the binary could not be started at all. */
  readonly spawnCode: string | null;
  constructor(file: string, args: string[], exitCode: number | null, stderr: string, spawnCode: string | null, detail: string) {
    super(`${file.split('/').pop()} ${args.join(' ')}: ${detail}`);
    this.name = 'CommandError';
    this.file = file;
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.spawnCode = spawnCode;
  }
}

/** Environment for every child: Android SDK and project-local Appium home injected (PATH not required). */
export function childEnv(): NodeJS.ProcessEnv {
  const home = androidHome();
  return { ...process.env, ANDROID_HOME: home, ANDROID_SDK_ROOT: home, APPIUM_HOME: PATHS.appiumHome };
}

export interface RunOptions {
  timeoutMs?: number;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFail?: boolean;
  /** Written to the child's stdin (stdin is closed either way). */
  input?: Uint8Array;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = execFile(
    file,
    args,
    { encoding: 'buffer', env: childEnv(), timeout: opts.timeoutMs ?? 60_000, maxBuffer: 512 * 1024 * 1024 },
    (err, stdout, stderrBuf) => {
      const stderr = stderrBuf.toString('utf8');
      if (!err) return resolve({ stdout, stderr, code: 0 });
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
      if (typeof e.code === 'string') return reject(new CommandError(file, args, null, stderr, e.code, e.code));
      if (e.killed || e.signal) return reject(new CommandError(file, args, null, stderr, null, `killed (${e.signal ?? 'timeout'})`));
      const code = typeof e.code === 'number' ? e.code : 1;
      if (opts.allowFail) return resolve({ stdout, stderr, code });
      reject(new CommandError(file, args, code, stderr, null, `exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    },
  );
  child.stdin?.end(opts.input);
  return promise;
}

/** adb against one serial (or the server when `serial` is null); stdout as UTF-8. */
export async function adb(serial: string | null, args: string[], opts?: RunOptions): Promise<string> {
  const full = serial ? ['-s', serial, ...args] : args;
  return (await run(adbPath(), full, opts)).stdout.toString('utf8');
}

/** Single-quotes an argument for the device shell (`adb shell` joins argv into one shell string). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `adb shell` with every argument single-quoted, so the device shell never splits or expands one. */
export function adbShell(serial: string, argv: string[], opts?: RunOptions): Promise<string> {
  return adb(serial, ['shell', argv.map(shq).join(' ')], opts);
}

export async function xcrun(args: string[], opts?: RunOptions): Promise<string> {
  return (await run('xcrun', args, opts)).stdout.toString('utf8');
}
