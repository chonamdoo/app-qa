// Session-free screen access for live views and recordings (no Appium involved).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { adb, adbShell, childEnv, run, shq, xcrun } from '../appium/exec.ts';
import { adbPath } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Platform } from '../core/types.ts';

/** Desktop browsers have no session-free screen: their pixels come only from a driver snapshot. `what` carries its particle. */
function refuseDesktop(platform: Platform, what: string): void {
  if (PLATFORM_INFO[platform].host === 'desktop') throw new Error(`${PLATFORM_INFO[platform].label}에서는 세션 없이 ${what} 지원하지 않습니다. 테스트 실행 중 스냅샷의 스크린샷을 사용하세요.`);
}

/** PNG of the current screen. Android: `adb exec-out screencap -p`; iOS: `simctl io screenshot` (pixels, @3x). */
export async function grabScreen(platform: Platform, deviceId: string): Promise<Uint8Array> {
  refuseDesktop(platform, '실시간 화면 캡처를');
  if (platform === 'android') {
    const png = (await run(adbPath(), ['-s', deviceId, 'exec-out', 'screencap', '-p'], { timeoutMs: 15_000 })).stdout;
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error(`screencap이 PNG를 반환하지 않았습니다 (${png.length} bytes)`);
    return png;
  }
  // simctl cannot write to stdout ("-" becomes a file name, /dev/stdout is refused).
  const dir = mkdtempSync(join(tmpdir(), 'qa-shot-'));
  try {
    const file = join(dir, 'screen.png');
    await xcrun(['simctl', 'io', deviceId, 'screenshot', '--type=png', file], { timeoutMs: 15_000 });
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recording {
  child: ChildProcess;
  file: string;
  /** Android: the mp4 on the device and the device pid of the `screenrecord` this process started. */
  remote: string | null;
  devicePid: string | null;
  exited: Promise<number | null>;
}

const recordings = new Map<string, Recording>();

/** Resolves with the first stdout line of `child` (null when it exits or `timeoutMs` passes first). */
async function firstLine(child: ChildProcess, exited: Promise<number | null>, timeoutMs: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl >= 0) resolve(buf.slice(0, nl).trim());
  });
  return Promise.race([promise, exited.then(() => null), delay(timeoutMs, null, { ref: false })]);
}

/** Android: `adb shell screenrecord` (device limit 180 s per file); iOS: `simctl io recordVideo`. */
export async function startRecording(platform: Platform, deviceId: string, file: string): Promise<void> {
  refuseDesktop(platform, '화면 녹화를');
  const key = `${platform}:${deviceId}`;
  if (recordings.has(key)) throw new Error(`${deviceId}에서 이미 녹화 중입니다.`);
  ensureDir(dirname(file));
  const remote = platform === 'android' ? `/sdcard/qa-rec-${Date.now()}.mp4` : null;
  // Android: the device shell prints its own pid and then becomes screenrecord (exec keeps the pid), so stop can
  // signal exactly this recording and never another tool's screenrecord.
  const child =
    platform === 'android'
      ? spawn(adbPath(), ['-s', deviceId, 'shell', `echo $$; exec screenrecord --bit-rate 6000000 ${shq(remote!)}`], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', file], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = Promise.withResolvers<number | null>();
  child.once('exit', (code) => exit.resolve(code));
  const exited = exit.promise;
  const rec: Recording = { child, file, remote, devicePid: null, exited };
  recordings.set(key, rec);
  if (platform === 'ios') {
    // recordVideo prints "Recording started" once frames flow; wait for it so stop never races start.
    const { promise, resolve } = Promise.withResolvers<void>();
    child.stderr?.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('Recording started')) resolve();
    });
    await Promise.race([promise, exited, delay(5000, undefined, { ref: false })]);
  } else {
    const pid = await firstLine(child, exited, 5000);
    if (pid !== null && /^\d+$/.test(pid)) rec.devicePid = pid;
    else if (child.exitCode === null) child.kill('SIGKILL');
    await delay(500);
  }
  if (child.exitCode !== null || child.signalCode !== null || (platform === 'android' && rec.devicePid === null)) {
    recordings.delete(key);
    throw new Error(`녹화를 시작하지 못했습니다 (exit ${child.exitCode ?? child.signalCode}).`);
  }
}

/** Stops the device's recording and returns the local mp4 path. */
export async function stopRecording(platform: Platform, deviceId: string, file: string): Promise<string> {
  const key = `${platform}:${deviceId}`;
  const rec = recordings.get(key);
  if (!rec) throw new Error(`${deviceId}에서 진행 중인 녹화가 없습니다.`);
  recordings.delete(key);
  if (rec.file !== file) throw new Error(`녹화 파일 경로가 시작 시(${rec.file})와 다릅니다: ${file}`);
  if (platform === 'android') {
    // SIGINT on our device process finalizes the mp4 (killing the local adb client would truncate it). While the
    // adb session is alive the pid is still our screenrecord; once it has exited there is nothing to stop.
    if (rec.child.exitCode === null) await adbShell(deviceId, ['kill', '-INT', rec.devicePid!], { allowFail: true });
    await Promise.race([rec.exited, delay(10_000, undefined, { ref: false })]);
    await delay(300);
    await adb(deviceId, ['pull', rec.remote!, file], { timeoutMs: 120_000 });
    await adbShell(deviceId, ['rm', '-f', rec.remote!], { allowFail: true });
  } else {
    rec.child.kill('SIGINT');
    await Promise.race([rec.exited, delay(15_000, undefined, { ref: false })]);
  }
  if (rec.child.exitCode === null) rec.child.kill('SIGKILL');
  return file;
}
