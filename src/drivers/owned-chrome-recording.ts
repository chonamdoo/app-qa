import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveMediaTools, runRecordingCommand as run, validateRecordedVideo, writeDiagnostic } from './recording-media.ts';
import { AgentExecutionError } from '../core/agent.ts';
import { ensureDir } from '../core/fsx.ts';
import type { RecordingSegment, RecordingStatus, StartTargetRecording, TargetRecording } from '../core/recording.ts';
import { recordingCleanupConfirmed } from '../core/recording.ts';
import type { Driver } from '../core/types.ts';

interface Frame { file: string; timestamp: number }
export type ChromePageRecordingSource = Pick<Driver, 'platform' | 'deviceId'> & { ownedChromePage(): Promise<string> };

export class OwnedChromeRecordingStartError extends AgentExecutionError {
  readonly recordingStatus: RecordingStatus;
  constructor(cause: unknown, status: RecordingStatus) {
    const known = recordingCleanupConfirmed(status);
    super(known && cause instanceof AgentExecutionError ? cause.code : known ? 'recorder_not_ready' : 'recorder_start_unknown',
      'Chrome recorder 준비 실패; 실제 capture·encoder·진단 상태를 보존했습니다', known ? 'not_started' : 'unknown');
    this.cause = cause;
    this.recordingStatus = structuredClone(status);
  }
}

export async function startOwnedChromeRecording(driver: ChromePageRecordingSource, input: Parameters<StartTargetRecording>[0]): Promise<TargetRecording> {
  const { binding, file, signal } = input;
  if (driver.platform !== 'desktop-chrome' || binding.platform !== driver.platform || binding.deviceId !== driver.deviceId) throw new AgentExecutionError('owned_chrome_required', '녹화 대상은 attempt가 소유한 Chrome 세션이어야 합니다');
  const expiresAt = input.captureExpiresAt === undefined ? null : Date.parse(input.captureExpiresAt);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new AgentExecutionError('capture_permission_invalid', '원 capture 만료 시각이 올바르지 않습니다');
  const expiresMono = expiresAt === null ? null : performance.now() + Math.max(0, expiresAt - Date.now());
  const assertAuthority = (): void => {
    signal.throwIfAborted();
    if (expiresAt !== null && (Date.now() >= expiresAt || performance.now() >= expiresMono!)) throw new AgentExecutionError('capture_permission_expired', '원 capture 권한이 만료되었습니다', 'unknown');
  };
  assertAuthority();
  const tools = await resolveMediaTools().catch((cause: unknown): never => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new AgentExecutionError('chrome_recording_unsupported', `실제 Chrome 녹화에 필요한 ffmpeg와 ffprobe가 준비되지 않았습니다: ${detail}`);
    error.cause = cause;
    throw error;
  });
  const ffmpeg = tools.ffmpeg.path;
  const page = await driver.ownedChromePage();
  ensureDir(dirname(file));
  const reservation = await open(file, 'wx', 0o600);
  await reservation.close();
  const directory = await mkdtemp(join(dirname(file), '.chrome-frames-'));
  await chmod(directory, 0o700);
  const socket = new WebSocket(page);
  const connected = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<Error>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const frames: Frame[] = [];
  const status: RecordingStatus = { capture: 'active', encoder: 'active', spool: 'pending', file: 'pending', media: 'pending', diagnostics: [directory] };
  let accepting = true;
  let lastFrameObserved = performance.now();
  let serial = 0;
  let failure: Error | null = null;
  let stopping = false;
  let readyAt = '';
  let startedAt = '';
  let stopPromise: Promise<RecordingSegment> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let queuedBytes = 0;
  let totalBytes = 0;
  const latch = (error: Error): void => {
    if (failure) return;
    failure = error;
    accepting = false;
    first.reject(error);
    lost.resolve(error);
  };
  void first.promise.catch(() => undefined);
  const command = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const request = Promise.withResolvers<unknown>();
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      request.reject(new Error(`Chrome recorder command timeout: ${method}`));
    }, 5000);
    pending.set(id, { ...request, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); request.reject(error); }
    return request.promise;
  };
  socket.addEventListener('open', () => connected.resolve(), { once: true });
  socket.addEventListener('error', () => {
    const error = new Error('Chrome page recorder connection failed');
    connected.reject(error);
    latch(error);
  });
  socket.addEventListener('close', () => {
    status.spool = 'released';
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Chrome recorder connection closed')); }
    pending.clear();
    if (!stopping) latch(new Error('Chrome page recorder stream was lost'));
  });
  // Paint timestamps cannot date a fresh snapshot of an unchanged page; the segment uses observer timing.
  const observedTimestamp = (): number => (performance.timeOrigin + performance.now()) / 1000;
  const recordFrame = (data: string, timestamp: number, sessionId: number | null): void => {
    assertAuthority();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('Chrome recorder frame is not a complete JPEG');
    queuedBytes += bytes.length;
    totalBytes += bytes.length;
    if (frames.length > 100_000 || queuedBytes > 32 * 1024 * 1024 || totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('Chrome recorder storage bound exceeded');
    queue = queue.then(async () => {
      if (failure) return;
      assertAuthority();
      const previous = frames.at(-1);
      if (previous && timestamp <= previous.timestamp) throw new Error('Chrome recorder observation timestamps are not increasing');
      const frame = join(directory, `frame-${String(frames.length).padStart(8, '0')}.jpg`);
      await writeFile(frame, bytes, { mode: 0o600, flag: 'wx' });
      frames.push({ file: frame, timestamp });
      lastFrameObserved = performance.now();
      if (frames.length === 1) {
        await run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', frame, '-frames:v', '1', '-f', 'null', '-'], { timeoutMs: 5000 });
        if (stopping || failure) return;
        startedAt = new Date(timestamp * 1000).toISOString();
        readyAt = new Date().toISOString();
        first.resolve();
      }
      if (sessionId !== null) await command('Page.screencastFrameAck', { sessionId });
      queuedBytes -= bytes.length;
    }).catch(error => latch(error instanceof Error ? error : new Error(String(error))));
  };
  const captureFrame = async (): Promise<void> => {
    assertAuthority();
    const captured = await command('Page.captureScreenshot', { format: 'jpeg', quality: 85, fromSurface: true });
    const timestamp = observedTimestamp();
    if (!captured || typeof captured !== 'object' || !('data' in captured) || typeof captured.data !== 'string') throw new Error('Chrome recorder snapshot is invalid');
    recordFrame(captured.data, timestamp, null);
    await queue;
    if (failure) throw failure;
  };
  socket.addEventListener('message', event => {
    try {
      const value: unknown = JSON.parse(String(event.data));
      if (!value || typeof value !== 'object') throw new Error('Invalid Chrome recorder message');
      const message = value as { id?: unknown; error?: unknown; result?: unknown; method?: unknown; params?: { data?: unknown; sessionId?: unknown; metadata?: { timestamp?: unknown } } };
      if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(new Error('Chrome recorder command rejected'));
        else request.resolve(message.result);
        return;
      }
      if (message.method === 'Inspector.detached' || message.method === 'Inspector.targetCrashed') throw new Error('Chrome recorder target detached or crashed');
      if (message.method === 'Page.windowOpen' || message.method === 'Page.javascriptDialogOpening' || message.method === 'Page.fileChooserOpened') throw new AgentExecutionError('capture_scope_unsupported', '새 page·native dialog는 현재 page-only 영상 범위 밖입니다');
      if (message.method !== 'Page.screencastFrame') return;
      if (!accepting) return;
      const params = message.params;
      const timestamp = params?.metadata?.timestamp;
      if (typeof params?.data !== 'string' || typeof params.sessionId !== 'number' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) throw new Error('Chrome recorder frame metadata is invalid');
      recordFrame(params.data, observedTimestamp(), params.sessionId);
    } catch (error) { latch(error instanceof Error ? error : new Error(String(error))); }
  });
  const aborted = (): void => latch(new AgentExecutionError('recorder_aborted', 'Chrome 녹화가 취소되었습니다', 'unknown'));
  signal.addEventListener('abort', aborted, { once: true });
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatBusy = false;
  const stop = (): Promise<RecordingSegment> => {
    stopPromise ??= (async (): Promise<RecordingSegment> => {
      stopping = true;
      clearInterval(heartbeat ?? undefined);
      signal.removeEventListener('abort', aborted);
      while (heartbeatBusy) await delay(10);
      if (socket.readyState !== WebSocket.OPEN) { status.capture = 'unknown'; throw new AgentExecutionError('recorder_stop_unknown', 'Chrome 녹화 stream 종료 ACK를 확인할 수 없습니다', 'unknown'); }
      accepting = false;
      await queue;
      try { await command('Page.stopScreencast'); status.capture = 'stopped'; }
      catch (error) { status.capture = 'unknown'; throw error; }
      if (!failure && frames.length) {
        try {
          if (await driver.ownedChromePage() !== page) throw new AgentExecutionError('capture_scope_unsupported', '최종 frame의 page identity가 달라졌습니다');
          await captureFrame();
        } catch (error) { latch(error instanceof Error ? error : new Error(String(error))); }
      }
      const closed = Promise.withResolvers<void>();
      const timer = setTimeout(() => closed.reject(new Error('Chrome recorder socket close unconfirmed')), 5000);
      socket.addEventListener('close', () => { clearTimeout(timer); closed.resolve(); }, { once: true });
      socket.close();
      await closed.promise;
      status.spool = 'released';
      if (failure) throw failure;
      if (!frames.length) throw new AgentExecutionError('video_missing', '실제 Chrome 영상 프레임이 없습니다');
      const endedAt = new Date(frames.at(-1)!.timestamp * 1000 + 1).toISOString();
      const lines = frames.flatMap((frame, index) => {
        const next = frames[index + 1];
        const duration = next ? next.timestamp - frame.timestamp : 0.001;
        return [`file '${frame.file.replace(/'/g, "'\\''")}'`, 'option framerate 1000', `duration ${duration.toFixed(6)}`];
      });
      const manifest = join(directory, 'frames.ffconcat');
      await writeFile(manifest, `ffconcat version 1.0\n${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-y', '-safe', '0', '-f', 'concat', '-i', manifest, '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-c:v', 'libx264', '-preset', 'ultrafast', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { timeoutMs: 180_000 });
      status.encoder = 'finalized';
      const verified = await validateRecordedVideo(file, tools, input.sanitize);
      status.file = 'durable';
      if (verified.frames !== frames.length || Math.abs(verified.durationSeconds - (Date.parse(endedAt) - Date.parse(startedAt)) / 1000) > 0.1) throw new AgentExecutionError('video_frame_mismatch', '실제 수집 frame·시간과 최종 영상이 다릅니다');
      status.media = 'valid';
      await rm(directory, { recursive: true });
      status.diagnostics = [];
      return { ...verified, startedAt, endedAt, source: 'chrome-page', timing: { basis: 'encoder-observed', firstFrameReceivedAt: new Date(frames[0]!.timestamp * 1000).toISOString(), captureStartedAt: null, captureEndedAt: null } };
    })().catch(async error => {
      const reason = error instanceof Error ? error : new Error(String(error));
      accepting = false;
      try { socket.close(); } catch { status.spool = 'unknown'; }
      await queue;
      if (status.capture === 'active') status.capture = 'unknown';
      status.media = 'invalid';
      if (status.encoder === 'active') status.encoder = 'failed';
      writeDiagnostic(join(directory, 'failure.json'), () => ({ code: reason instanceof AgentExecutionError ? reason.code : reason.name, status, tools }));
      latch(reason);
      throw reason;
    });
    return stopPromise;
  };
  try {
    await Promise.race([connected.promise, delay(5000, undefined, { ref: false }).then(() => { throw new Error('Chrome recorder connection timed out'); })]);
    await command('Page.enable', { enableFileChooserOpenedEvent: true });
    assertAuthority();
    await command('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    heartbeat = setInterval(() => {
      if (heartbeatBusy || stopping || failure) return;
      heartbeatBusy = true;
      void (async () => {
        if (await driver.ownedChromePage() !== page) throw new Error('Chrome recorder active page changed');
        await command('Page.getLayoutMetrics');
        if (performance.now() - lastFrameObserved > 1500 && !stopping) await captureFrame();
        if (performance.now() - lastFrameObserved > 6000) throw new AgentExecutionError('capture_freshness_unconfirmed', 'page stream의 실제 frame 진행을 확인할 수 없습니다');
      })().catch(error => latch(error instanceof Error ? error : new Error(String(error)))).finally(() => { heartbeatBusy = false; });
    }, 1000).unref();
    await Promise.race([first.promise, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Chrome recorder first valid frame timed out'); })]);
    if (failure) throw failure;
    signal.throwIfAborted();
    const assertHealthy = (): void => { assertAuthority(); if (failure) throw failure; if (stopping) throw new Error('Chrome recorder stopped'); };
    return {
      readyAt, firstFrameAt: startedAt, lost: lost.promise, maxDurationMs: 600_000, assertHealthy,
      async beforeDispatch() {
        assertHealthy();
        if (await driver.ownedChromePage() !== page) { const error = new AgentExecutionError('capture_scope_unsupported', '다른 page로 전환되어 현재 영상을 사용할 수 없습니다'); latch(error); throw error; }
        await command('Page.getLayoutMetrics');
        if (performance.now() - lastFrameObserved > 6000) { const error = new AgentExecutionError('capture_freshness_unconfirmed', '실제 page frame 진행을 확인할 수 없습니다'); latch(error); throw error; }
        assertHealthy();
      },
      async status() { return structuredClone(status); },
      stop,
    };
  } catch (error) {
    try { await stop(); } catch {}
    throw new OwnedChromeRecordingStartError(error, status);
  }
}
