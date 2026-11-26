import { join, relative, sep } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import { ensureDir, writeJsonAtomic } from '../core/fsx.ts';
import { InstanceExecutionError } from '../core/instances.ts';
import { recordingCleanupConfirmed, type AttemptVideoReceipt, type RecordingBinding, type RecordingStatus, type StartTargetRecording, type TargetRecording } from '../core/recording.ts';

export interface AttemptRecording {
  readonly signal: AbortSignal;
  assertHealthy(): void;
  beforeDispatch(): Promise<void>;
  finished(): void;
  finalize(): Promise<AttemptVideoReceipt>;
}

export class AttemptRecordingStartError extends AgentExecutionError {
  readonly receipt: AttemptVideoReceipt;
  constructor(error: unknown, receipt: AttemptVideoReceipt) {
    super(error instanceof AgentExecutionError || error instanceof InstanceExecutionError ? error.code : 'recorder_start_unknown',
      error instanceof Error ? error.message : 'Recorder startup failed',
      receipt.cleanup === 'unknown' ? 'unknown' : 'not_started');
    this.receipt = structuredClone(receipt);
    this.cause = error;
  }
}

export async function startAttemptRecording(input: { binding: RecordingBinding; runDir: string; start: StartTargetRecording; signal: AbortSignal }): Promise<AttemptRecording> {
  const dir = ensureDir(join(input.runDir, 'video', input.binding.attemptId));
  const receipt: AttemptVideoReceipt = { schema: 'qautra/attempt-video/v1', binding: input.binding, state: 'incomplete', cleanup: 'unknown', segments: [], gaps: [], artifacts: [], boundaries: [], actions: [], code: null };
  const lost = new AbortController();
  const signal = AbortSignal.any([input.signal, lost.signal]);
  const active = new Map<TargetRecording, NonNullable<AttemptVideoReceipt['artifacts']>[number]>();
  const retired = new Set<TargetRecording>();
  let current: TargetRecording | null = null;
  let sequence = 0;
  let ended = false;
  let inFlight = false;
  let rotationDue = false;
  let untrackedStart = false;
  let failure: Error | null = null;
  let persistenceFailure: unknown = null;
  let timer: NodeJS.Timeout | null = null;
  let rotation: Promise<void> | null = null;
  let finalization: Promise<AttemptVideoReceipt> | null = null;
  const save = (): void => writeJsonAtomic(join(dir, 'manifest.json'), receipt);
  const localPath = (file: string): string => {
    const name = relative(input.runDir, file);
    if (!name || name === '..' || name.startsWith(`..${sep}`) || name.startsWith(sep)) throw new AgentExecutionError('video_path_outside_attempt', '영상 파일이 attempt 증거 폴더 밖에 있습니다');
    return name;
  };
  const latch = (error: unknown): void => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error('녹화 오류');
    receipt.code = error instanceof AgentExecutionError || error instanceof InstanceExecutionError ? error.code : 'recording_failed';
    receipt.gaps.push({ from: new Date().toISOString(), to: null, reason: receipt.code, basis: 'host-detected' });
    lost.abort(new AgentExecutionError('required_recording_lost', '필수 녹화가 끊겨 다음 변경부터 차단합니다'));
    try { save(); }
    catch (error) { persistenceFailure = error; }
  };
  const finish = async (handle: TargetRecording): Promise<void> => {
    const artifact = active.get(handle)!;
    try {
      const segment = await handle.stop();
      if (!Number.isFinite(Date.parse(segment.startedAt)) || !Number.isFinite(Date.parse(segment.endedAt)) || Date.parse(segment.endedAt) <= Date.parse(segment.startedAt) || !Number.isSafeInteger(segment.frames) || segment.frames < 1 || !Number.isSafeInteger(segment.bytes) || segment.bytes < 1 || !Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0 || Math.abs((Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / 1000 - segment.durationSeconds) > 0.25 || !/^[a-f0-9]{64}$/.test(segment.sha256)) throw new AgentExecutionError('video_metadata_invalid', '영상의 실제 시간·hash·frame·duration이 유효하지 않습니다');
      receipt.segments.push({ ...segment, file: localPath(segment.file) });
    } catch (error) {
      artifact.code = error instanceof AgentExecutionError || error instanceof InstanceExecutionError ? error.code : 'video_finalize_failed';
      latch(error);
      throw error;
    } finally {
      try { artifact.status = await handle.status(); if (artifact.status.segment) artifact.status.segment.file = localPath(artifact.status.segment.file); }
      catch { artifact.status.capture = 'unknown'; artifact.status.encoder = 'unknown'; artifact.status.spool = 'unknown'; }
      if (recordingCleanupConfirmed(artifact.status)) { active.delete(handle); retired.add(handle); }
      save();
    }
  };
  const start = async (): Promise<TargetRecording> => {
    const file = join(dir, `segment-${String(++sequence).padStart(4, '0')}.mp4`);
    const status: RecordingStatus = { capture: 'unknown', encoder: 'unknown', spool: 'unknown', file: 'unknown', media: 'pending', diagnostics: [] };
    const artifact: NonNullable<AttemptVideoReceipt['artifacts']>[number] = { file: localPath(file), readyAt: null, firstFrameAt: null, status, code: null };
    receipt.artifacts!.push(artifact);
    untrackedStart = true; save();
    let handle: TargetRecording;
    try { handle = await input.start({ binding: input.binding, file, signal }); }
    catch (error) {
      artifact.code = error instanceof AgentExecutionError || error instanceof InstanceExecutionError ? error.code : 'recorder_start_unknown';
      if ((error instanceof AgentExecutionError || error instanceof InstanceExecutionError) && error.effect === 'not_started') {
        untrackedStart = false;
        artifact.status = { capture: 'stopped', encoder: 'failed', spool: 'released', file: 'pending', media: 'invalid', diagnostics: [] };
      }
      throw error;
    }
    untrackedStart = false;
    artifact.readyAt = handle.readyAt; artifact.firstFrameAt = handle.firstFrameAt;
    active.set(handle, artifact);
    artifact.status = await handle.status();
    void handle.lost.then(error => { if (!retired.has(handle)) latch(error); });
    if (!Number.isFinite(Date.parse(handle.firstFrameAt)) || !Number.isFinite(Date.parse(handle.readyAt)) || artifact.status.capture !== 'active' || artifact.status.encoder !== 'active') throw new AgentExecutionError('recorder_not_ready', '유효한 첫 frame과 capture·encoder readiness가 필요합니다');
    return handle;
  };
  const schedule = (): void => {
    if (ended || failure || !current?.maxDurationMs) return;
    timer = setTimeout(() => { timer = null; rotationDue = true; if (!inFlight) void rotate(); }, Math.max(1, current.maxDurationMs - Math.min(30_000, current.maxDurationMs / 3)));
    timer.unref();
  };
  const rotate = (): Promise<void> => {
    if (rotation) return rotation;
    if (ended || failure || inFlight || !current || !rotationDue) return Promise.resolve();
    rotation = (async () => {
      const previous = current!;
      current = null;
      const from = new Date().toISOString();
      await finish(previous);
      if (ended || failure) return;
      const previousSegment = receipt.segments.at(-1);
      const previousEnd = previousSegment?.endedAt ?? from;
      const gap: AttemptVideoReceipt['gaps'][number] = { from: previousEnd, to: null, reason: 'rotation_pending', basis: previousSegment?.timing?.basis ?? 'unconfirmed' };
      receipt.gaps.push(gap); save();
      const next = await start();
      if (ended) { await finish(next); return; }
      current = next; rotationDue = false;
      const to = new Date().toISOString();
      receipt.boundaries!.push({ from, to, mutationFenced: true });
      gap.to = next.firstFrameAt;
      gap.reason = Date.parse(next.firstFrameAt) > Date.parse(previousEnd) ? 'rotation_mutation_fenced' : 'rotation_clock_unconfirmed';
      save(); schedule();
    })().catch(error => latch(error)).finally(() => { rotation = null; });
    return rotation;
  };
  const assertHealthy = (): void => {
    if (failure) throw new AgentExecutionError('required_recording_lost', '필수 녹화 상태를 확인하지 못했습니다');
    if (ended || !current || rotation) throw new AgentExecutionError('required_recording_stopped', '필수 recorder가 준비되지 않았습니다');
    signal.throwIfAborted(); current.assertHealthy();
  };
  try {
    save(); current = await start(); current.assertHealthy(); save(); schedule();
  } catch (error) {
    latch(error);
    ended = true;
    clearTimeout(timer ?? undefined);
    for (const handle of active.keys()) { try { await finish(handle); } catch (error) { latch(error); } }
    receipt.cleanup = active.size || untrackedStart ? 'unknown' : 'confirmed';
    save();
    if (persistenceFailure) throw persistenceFailure;
    throw new AttemptRecordingStartError(error, receipt);
  }
  return {
    signal: lost.signal,
    assertHealthy,
    /** beforeDispatch부터 finished까지 rotation을 금지하며 입력 재전송은 하지 않는다. */
    async beforeDispatch(): Promise<void> {
      if (inFlight) throw new AgentExecutionError('recording_action_in_flight', '앞선 변경의 finished 경계가 필요합니다');
      if (rotation) await rotation;
      if (rotationDue) await rotate();
      assertHealthy(); inFlight = true;
      try {
        await current!.beforeDispatch(); assertHealthy();
        receipt.actions!.push({ boundary: receipt.actions!.length + 1, dispatchedAt: new Date().toISOString(), finishedAt: null, firstFrameAt: current!.firstFrameAt, readyAt: current!.readyAt });
        save();
      }
      catch (error) { inFlight = false; latch(error); throw error; }
    },
    finished(): void {
      if (inFlight) {
        const action = receipt.actions!.at(-1);
        if (action && action.finishedAt === null) action.finishedAt = new Date().toISOString();
        save();
      }
      inFlight = false;
      if (rotationDue && !ended) void rotate();
    },
    finalize(): Promise<AttemptVideoReceipt> {
      finalization ??= (async () => {
        ended = true;
        clearTimeout(timer ?? undefined);
        if (rotation) await rotation;
        if (inFlight) latch(new AgentExecutionError('recording_action_unfinished', '변경 완료 경계 없이 영상 최종화가 요청되었습니다'));
        for (const handle of active.keys()) { try { await finish(handle); } catch {} }
        const now = new Date().toISOString();
        for (const gap of receipt.gaps) if (gap.to === null && gap.basis === 'host-detected') gap.to = now;
        receipt.cleanup = active.size || untrackedStart ? 'unknown' : 'confirmed';
        receipt.state = !failure && !active.size && !untrackedStart && receipt.segments.length > 0 && receipt.gaps.length === 0 && receipt.artifacts!.every(artifact => artifact.status.media === 'valid' && artifact.status.file === 'durable') ? 'ready' : 'incomplete';
        save();
        if (persistenceFailure) throw persistenceFailure;
        return structuredClone(receipt);
      })();
      return finalization;
    },
  };
}
