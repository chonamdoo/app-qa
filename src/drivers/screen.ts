// Session-free screen access for live views and recordings (no Appium involved).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { adbPath } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import type { Platform } from '../core/types.ts';
import { adb, childEnv, run, xcrun } from './common.ts';

/** PNG of the current screen. Android: `adb exec-out screencap -p`; iOS: `simctl io screenshot` (pixels, @3x). */
export async function grabScreen(platform: Platform, deviceId: string): Promise<Uint8Array> {
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
  remote: string | null;
  exited: Promise<number | null>;
}

const recordings = new Map<string, Recording>();

/** Android: `adb shell screenrecord` (device limit 180 s per file); iOS: `simctl io recordVideo`. */
export async function startRecording(platform: Platform, deviceId: string, file: string): Promise<void> {
  const key = `${platform}:${deviceId}`;
  if (recordings.has(key)) throw new Error(`${deviceId}에서 이미 녹화 중입니다.`);
  ensureDir(dirname(file));
  const remote = platform === 'android' ? `/sdcard/qa-rec-${Date.now()}.mp4` : null;
  const child =
    platform === 'android'
      ? spawn(adbPath(), ['-s', deviceId, 'shell', 'screenrecord', '--bit-rate', '6000000', remote!], { env: childEnv(), stdio: 'ignore' })
      : spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', file], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = Promise.withResolvers<number | null>();
  child.once('exit', (code) => exit.resolve(code));
  const exited = exit.promise;
  recordings.set(key, { child, file, remote, exited });
  if (platform === 'ios') {
    // recordVideo prints "Recording started" once frames flow; wait for it so stop never races start.
    const { promise, resolve } = Promise.withResolvers<void>();
    child.stderr?.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('Recording started')) resolve();
    });
    await Promise.race([promise, exited, delay(5000, undefined, { ref: false })]);
  } else {
    await delay(500);
  }
  if (child.exitCode !== null) {
    recordings.delete(key);
    throw new Error(`녹화를 시작하지 못했습니다 (exit ${child.exitCode}).`);
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
    // SIGINT on the device process finalizes the mp4 (killing the local adb client would truncate it).
    await adb(deviceId, ['shell', 'pkill', '-INT', 'screenrecord'], { allowFail: true });
    await Promise.race([rec.exited, delay(10_000, undefined, { ref: false })]);
    await delay(300);
    await adb(deviceId, ['pull', rec.remote!, file], { timeoutMs: 120_000 });
    await adb(deviceId, ['shell', 'rm', '-f', rec.remote!], { allowFail: true });
  } else {
    rec.child.kill('SIGINT');
    await Promise.race([rec.exited, delay(15_000, undefined, { ref: false })]);
  }
  if (rec.child.exitCode === null) rec.child.kill('SIGKILL');
  return file;
}
