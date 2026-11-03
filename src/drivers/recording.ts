import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { adbShell, childEnv, shq } from '../appium/exec.ts';
import { AgentExecutionError } from '../core/agent.ts';
import { adbPath } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import { recordingCleanupConfirmed, type RecordingSegment, type RecordingStatus, type StartTargetRecording, type TargetRecording } from '../core/recording.ts';
import type { AppTarget, Driver } from '../core/types.ts';
import { IosDriver } from './ios.ts';
import { GuestDesktopDriver } from './vm/driver.ts';
import { DesktopWebDriver } from './desktop.ts';
import { childState, diagnosticOutput, resolveMediaTools, timeout, runRecordingCommand, validateRecordedVideo, writeDiagnostic } from './recording-media.ts';
import { startGuestRecording } from './vm/recording.ts';


export async function prepareTargetRecording(driver: Driver, target: AppTarget): Promise<'before-open' | 'after-open'> {
  if (driver instanceof GuestDesktopDriver) { await driver.prepareTarget(target); return 'before-open'; }
  if (driver instanceof IosDriver) { await driver.prepareRecordingTarget(); return 'after-open'; }
  return driver.platform === 'android' ? 'before-open' : 'after-open';
}

export async function startTargetRecording(driver: Driver, input: Parameters<StartTargetRecording>[0]): Promise<TargetRecording> {
  if (input.binding.platform !== driver.platform || input.binding.deviceId !== driver.deviceId) throw new AgentExecutionError('recording_binding_refused', '녹화 대상과 소유 driver가 다릅니다');
  if (driver instanceof GuestDesktopDriver) return startGuestRecording(driver, input);
  if (driver.platform === 'desktop-chrome') {
    if (!(driver instanceof DesktopWebDriver)) throw new AgentExecutionError('owned_chrome_required', '실제 소유한 Chrome session이 필요합니다');
    return driver.startOwnedChromeRecording(input);
  }
  if (driver.platform === 'ios') {
    if (!(driver instanceof IosDriver)) throw new AgentExecutionError('ios_recording_preparation_required', '선택한 기기의 소유 WDA session과 MJPEG port 준비가 필요합니다');
    return startMobileRecording(input, await driver.ownedRecordingSource());
  }
  return startDeviceRecording(input);
}

export const startDeviceRecording: StartTargetRecording = async input => {
  if (input.binding.platform !== 'android') throw new AgentExecutionError('device_recording_preparation_required', '기기 내부 stream의 소유 session·UDID·port를 확인해야 합니다. Simulator나 호스트 화면으로 대체하지 않습니다');
  return startMobileRecording(input);
};

async function startMobileRecording({ binding, file, signal, sanitize }: Parameters<StartTargetRecording>[0], ios?: { url: string; assertIdentity(): Promise<void> }): Promise<TargetRecording> {
  signal.throwIfAborted();
  const tools = await resolveMediaTools();
  if (ios) await ios.assertIdentity();
  else {
    const serial = await runRecordingCommand(adbPath(), ['-s', binding.deviceId, 'get-serialno'], { timeoutMs: 5000 });
    if (serial.stdout.toString('utf8').trim() !== binding.deviceId) throw new AgentExecutionError('recording_device_changed', 'ADB serial이 선택 기기와 다릅니다');
  }
  ensureDir(dirname(file));
  const reservation = await open(file, 'wx', 0o600); await reservation.close();
  const state: RecordingStatus = { capture: 'active', encoder: 'active', spool: 'released', file: 'pending', media: 'pending', diagnostics: [] };
  const source = ios ? null : childState(spawn(adbPath(), ['-s', binding.deviceId, 'exec-out', 'sh', '-c', shq('echo $$; cat /proc/$$/stat; exec screenrecord --output-format=h264 --bit-rate 6000000 --time-limit 180 -')], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  const encoder = childState(spawn(tools.ffmpeg.path, ['-y', '-nostdin', '-v', 'error', '-xerror', '-fflags', '+genpts', '-use_wallclock_as_timestamps', '1', '-f', ios ? 'mjpeg' : 'h264', '-i', ios?.url ?? 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-progress', 'pipe:1', '-t', ios ? '600' : '180', '-fs', '1073741824', file], { env: childEnv(), stdio: [ios ? 'ignore' : 'pipe', 'pipe', 'pipe'] }));
  const first = Promise.withResolvers<void>();
  void first.promise.catch(() => undefined);
  const lost = Promise.withResolvers<Error>();
  let failure: Error | null = null;
  let stopping = false;
  let stopPromise: Promise<RecordingSegment> | null = null;
  let devicePid: string | null = null;
  let deviceStartTicks: string | null = null;
  let prefix = Buffer.alloc(0);
  let progress = '';
  let finalProgress = false;
  let firstFrameAt = '';
  let lastProgress = performance.now();
  let frameCount = 0;
  const latch = (reason: string): void => {
    if (failure || stopping) return;
    failure = new AgentExecutionError('recorder_lost', reason);
    lost.resolve(failure); first.reject(failure);
  };
  if (source) {
    source.child.stdout!.on('data', (chunk: Buffer) => {
      if (stopping && encoder.ended) return;
      if (devicePid === null) {
        prefix = Buffer.concat([prefix, chunk]);
        const end = prefix.indexOf(10);
        const statEnd = end < 0 ? -1 : prefix.indexOf(10, end + 1);
        if (statEnd < 0) { if (prefix.length > 4096) latch('기기 recorder identity를 확인하지 못했습니다'); return; }
        const line = prefix.subarray(0, end).toString('ascii').trim();
        const stat = prefix.subarray(end + 1, statEnd).toString('ascii');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/);
        const ticks = fields[19];
        if (!/^[1-9]\d{0,9}$/.test(line) || !stat.startsWith(`${line} (`) || !ticks || !/^[1-9]\d*$/.test(ticks)) { latch('기기 recorder PID·시작 세대가 유효하지 않습니다'); return; }
        devicePid = line; deviceStartTicks = ticks; chunk = prefix.subarray(statEnd + 1); prefix = Buffer.alloc(0);
      }
      if (!encoder.child.stdin?.destroyed && chunk.length && !encoder.child.stdin!.write(chunk)) source.child.stdout!.pause();
    });
    encoder.child.stdin!.on('drain', () => source.child.stdout!.resume());
    encoder.child.stdin!.on('error', () => latch('기기 영상 인코더 연결이 끊겼습니다'));
    source.child.stdout!.once('end', () => encoder.child.stdin?.end());
    void source.done.then(() => { if (!stopping) latch('기기 recorder가 예상보다 일찍 종료되었습니다'); });
  }
  encoder.child.stdout!.on('data', (chunk: Buffer) => {
    progress = (progress + chunk.toString('utf8')).slice(-8192);
    for (const match of progress.matchAll(/(?:^|\n)frame=\s*(\d+)\s*\n/g)) {
      const count = Number(match[1]);
      if (count > frameCount) { frameCount = count; lastProgress = performance.now(); if (!firstFrameAt && !stopping && !failure) { firstFrameAt = new Date().toISOString(); first.resolve(); } }
    }
    if (/(?:^|\n)progress=end(?:\n|$)/.test(progress)) finalProgress = true;
  });
  void encoder.done.then(() => { if (!stopping) latch('기기 영상 인코더가 예상보다 일찍 종료되었습니다'); });
  const assertHealthy = (): void => {
    if (failure) throw failure;
    if (stopping || encoder.ended || source?.ended) throw new AgentExecutionError('recorder_stopped', '필수 recorder가 실행 중이 아닙니다');
    if (performance.now() - lastProgress > 6000) { latch('실제 영상 frame 진행이 끊겼습니다'); throw failure; }
  };
  const timer = setInterval(() => { if (!stopping) { try { assertHealthy(); } catch {} } }, 1000).unref();
  const stop = (): Promise<RecordingSegment> => {
    stopPromise ??= (async () => {
      stopping = true; clearInterval(timer);
      try {
        if (source) {
          if (!source.ended) {
            if (!devicePid || !deviceStartTicks) throw new AgentExecutionError('recorder_stop_unknown', '기기 recorder identity와 정지를 확인할 수 없습니다', 'unknown');
            await adbShell(binding.deviceId, ['sh', '-c', `value=$(cat /proc/${devicePid}/stat) || exit 73; fields=\${value##*) }; set -- $fields; shift 19; [ "$1" = "${deviceStartTicks}" ] || exit 74; kill -INT ${devicePid}`]);
          }
          const end = await timeout(source.done, 15_000);
          if (!end || end.error || end.code !== 0) throw new AgentExecutionError('recorder_stop_unknown', '기기 recorder 종료 ACK를 확인하지 못했습니다', 'unknown');
          state.capture = 'stopped'; encoder.child.stdin?.end();
        } else if (!encoder.ended && !encoder.child.kill('SIGINT')) throw new AgentExecutionError('recorder_stop_unknown', '소유 MJPEG recorder 종료를 요청하지 못했습니다', 'unknown');
        const end = await timeout(encoder.done, 15_000);
        if (!end || end.error) { state.encoder = 'unknown'; throw new AgentExecutionError('video_finalize_unknown', '인코더 종료를 확인하지 못했습니다', 'unknown'); }
        if (ios) state.capture = 'stopped';
        state.encoder = finalProgress && (end.code === 0 || !!ios && end.code === 255) ? 'finalized' : 'failed';
        if (state.encoder !== 'finalized') throw new AgentExecutionError('video_finalize_failed', '인코더가 종료됐지만 파일 최종화가 실패했습니다');
        const verified = await validateRecordedVideo(file, tools, sanitize);
        state.file = 'durable'; state.media = 'valid';
        return { ...verified, startedAt: firstFrameAt, endedAt: new Date(Date.parse(firstFrameAt) + verified.durationSeconds * 1000).toISOString(), source: ios ? 'ios-device-screen' : 'android-device-screen', timing: { basis: 'encoder-observed', firstFrameReceivedAt: firstFrameAt, captureStartedAt: null, captureEndedAt: null } };
      } catch (error) {
        if (!encoder.ended) {
          encoder.child.stdin?.end();
          encoder.child.kill('SIGINT');
          const localEnd = await timeout(encoder.done, 15_000);
          if (localEnd && !localEnd.error) { state.encoder = finalProgress ? 'finalized' : 'failed'; if (ios) state.capture = 'stopped'; }
        }
        state.media = 'invalid';
        if (state.capture === 'active') state.capture = 'unknown';
        if (state.encoder === 'active') state.encoder = encoder.ended ? 'failed' : 'unknown';
        const diagnostics = `${file}.diagnostics.json`;
        if (writeDiagnostic(diagnostics, () => ({ status: state, tools, source: source ? diagnosticOutput(source.stderr, sanitize) : null, encoder: diagnosticOutput(encoder.stderr, sanitize) }))) state.diagnostics.push(diagnostics);
        throw error;
      }
    })();
    return stopPromise;
  };
  try {
    const ready = await Promise.race([first.promise.then(() => true), delay(15_000, false, { ref: false })]);
    if (!ready) throw new AgentExecutionError('recorder_not_ready', '실제 decode·encode된 첫 frame을 확인하지 못했습니다');
    signal.throwIfAborted(); assertHealthy();
    return { readyAt: new Date().toISOString(), firstFrameAt, lost: lost.promise, maxDurationMs: ios ? 600_000 : 180_000, assertHealthy, async beforeDispatch() { assertHealthy(); if (ios) await ios.assertIdentity(); signal.throwIfAborted(); assertHealthy(); }, async status() { return structuredClone(state); }, stop };
  } catch (error) {
    try { await stop(); } catch { if (!recordingCleanupConfirmed(state)) throw new AgentExecutionError('recorder_start_cleanup_unknown', '첫 frame 준비 실패 후 recorder 정리를 확인하지 못했습니다', 'unknown'); }
    throw error;
  }
}
