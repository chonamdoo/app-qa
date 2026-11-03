import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { AgentExecutionError } from '../../src/core/agent.ts';
import type { RecordingBinding, RecordingSegment, RecordingStatus, StartTargetRecording, TargetRecording } from '../../src/core/recording.ts';
import { AttemptRecordingStartError, startAttemptRecording } from '../../src/runner/recording.ts';

const binding: RecordingBinding = { attemptId: 'attempt-video-boundary', runId: 'run-video-boundary', platform: 'desktop-safari', deviceId: 'owned-guest', generation: 3 };

describe('required attempt recording boundaries', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });
  function directory() { const value = mkdtempSync(join(tmpdir(), 'qa-video-boundary-')); directories.push(value); return value; }

  function provider(options: { stop?: 'decode-failed' | 'partial'; maxDurationMs?: number; firstFrame?: boolean } = {}) {
    const controls: { lose(error: Error): void; stopped: boolean; stopCalls: number }[] = [];
    let active = 0;
    const start: StartTargetRecording = async ({ file }): Promise<TargetRecording> => {
      assert.equal(active, 0, 'guest display supports exactly one active recorder');
      active++;
      const lost = Promise.withResolvers<Error>();
      const control = { lose: lost.resolve, stopped: false, stopCalls: 0 };
      controls.push(control);
      const firstFrameAt = new Date().toISOString();
      const state: RecordingStatus = { capture: 'active', encoder: 'active', spool: 'pending', file: 'pending', media: 'pending', diagnostics: [] };
      let stopping: Promise<RecordingSegment> | undefined;
      return {
        readyAt: firstFrameAt, firstFrameAt: options.firstFrame === false ? '' : firstFrameAt, maxDurationMs: options.maxDurationMs ?? null, lost: lost.promise,
        assertHealthy() { if (control.stopped) throw new Error('stopped'); },
        async beforeDispatch() { if (control.stopped) throw new Error('stopped'); },
        async status() { return structuredClone(state); },
        stop() {
          stopping ??= (async () => {
            control.stopCalls++;
            if (options.stop === 'partial') {
              state.capture = 'unknown'; state.encoder = 'unknown'; state.spool = 'unknown';
              throw new AgentExecutionError('recorder_stop_unknown', 'lost stop ACK', 'unknown');
            }
            active--; control.stopped = true;
            state.capture = 'stopped'; state.encoder = 'finalized'; state.spool = 'released'; state.file = 'durable';
            state.media = options.stop === 'decode-failed' ? 'invalid' : 'valid';
            if (options.stop === 'decode-failed') throw new AgentExecutionError('video_unplayable', 'damaged original retained');
            return { file, sha256: 'a'.repeat(64), bytes: 1024, durationSeconds: 0.1, frames: 3, width: 800, height: 600, startedAt: firstFrameAt, endedAt: new Date(Date.parse(firstFrameAt) + 100).toISOString(), source: 'macos-guest-display' };
          })();
          return stopping;
        },
      };
    };
    return { start, controls };
  }

  it('refuses a readiness label without an actual first-frame timestamp and closes its owned recorder', async () => {
    const f = provider({ firstFrame: false });
    await assert.rejects(startAttemptRecording({ binding, runDir: directory(), start: f.start, signal: new AbortController().signal }), { code: 'recorder_not_ready' });
    assert.equal(f.controls[0]!.stopCalls, 1);
  });

  for (const effect of ['not_started', 'unknown'] as const) {
    it(`retains ${effect} recorder startup disposition for attempt cleanup without retransmitting start`, async () => {
      let starts = 0;
      const runDir = directory();
      const start: StartTargetRecording = async () => { starts++; throw new AgentExecutionError('start_ack_missing', 'startup rejected or unconfirmed', effect); };
      await assert.rejects(startAttemptRecording({ binding, runDir, start, signal: new AbortController().signal }), error => {
        assert.ok(error instanceof AttemptRecordingStartError);
        assert.equal(error.receipt.cleanup, effect === 'unknown' ? 'unknown' : 'confirmed');
        assert.equal(error.receipt.state, 'incomplete');
        assert.deepEqual(error.receipt.segments, []);
        return true;
      });
      const saved = JSON.parse(readFileSync(join(runDir, 'video', binding.attemptId, 'manifest.json'), 'utf8'));
      assert.equal(saved.cleanup, effect === 'unknown' ? 'unknown' : 'confirmed');
      assert.equal(starts, 1);
    });
  }

  it('preserves invalid media but confirms capture and spool cleanup independently', async () => {
    const f = provider({ stop: 'decode-failed' });
    const runDir = directory();
    const recording = await startAttemptRecording({ binding, runDir, start: f.start, signal: new AbortController().signal });
    const result = await recording.finalize();
    assert.equal(result.state, 'incomplete');
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.segments.length, 0);
    assert.equal(result.artifacts?.[0]?.status.media, 'invalid');
    assert.equal(result.artifacts?.[0]?.status.capture, 'stopped');
    const saved = JSON.parse(readFileSync(join(runDir, 'video', binding.attemptId, 'manifest.json'), 'utf8'));
    assert.equal(saved.cleanup, 'confirmed');
    assert.equal(f.controls[0]!.stopCalls, 1);
  });

  it('keeps partial stop unknown without resending stop or manufacturing a segment', async () => {
    const f = provider({ stop: 'partial' });
    const recording = await startAttemptRecording({ binding, runDir: directory(), start: f.start, signal: new AbortController().signal });
    const first = recording.finalize();
    assert.equal(recording.finalize(), first);
    const result = await first;
    assert.equal(result.cleanup, 'unknown');
    assert.equal(result.state, 'incomplete');
    assert.equal(result.segments.length, 0);
    assert.equal(f.controls[0]!.stopCalls, 1);
    f.controls[0]!.lose(new Error('late callback'));
    await immediate();
    assert.equal((await recording.finalize()).cleanup, 'unknown');
  });

  it('blocks the next mutation after loss rather than resending the original mutation', async () => {
    const f = provider();
    const recording = await startAttemptRecording({ binding, runDir: directory(), start: f.start, signal: new AbortController().signal });
    let mutations = 0;
    await recording.beforeDispatch(); mutations++; recording.finished();
    f.controls[0]!.lose(new Error('capture stream lost'));
    await immediate();
    await assert.rejects(recording.beforeDispatch(), { code: 'required_recording_lost' });
    assert.equal(mutations, 1);
    assert.equal(recording.signal.aborted, true);
    assert.equal((await recording.finalize()).state, 'incomplete');
  });

  it('fences rotation through finished and records the uncovered source interval without overlapping native recorders', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T06:00:00Z') });
    const f = provider({ maxDurationMs: 300 });
    const recording = await startAttemptRecording({ binding, runDir: directory(), start: f.start, signal: new AbortController().signal });
    await recording.beforeDispatch();
    t.mock.timers.tick(1000);
    await immediate();
    assert.equal(f.controls.length, 1);
    assert.equal(f.controls[0]!.stopCalls, 0);
    recording.finished();
    await recording.beforeDispatch();
    assert.equal(f.controls.length, 2);
    assert.equal(f.controls[0]!.stopCalls, 1);
    f.controls[0]!.lose(new Error('late event from old segment'));
    recording.finished();
    const result = await recording.finalize();
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.state, 'incomplete');
    assert.equal(result.segments.length, 2);
    assert.ok(result.gaps.some(gap => gap.reason === 'rotation_mutation_fenced'));
    assert.equal(result.boundaries?.[0]?.mutationFenced, true);
    assert.equal(result.code, null);
    assert.equal(recording.signal.aborted, false);
  });

  it('retains an unknown replacement recorder start even when the previous segment stopped cleanly', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-01T06:00:00Z') });
    const f = provider({ maxDurationMs: 300 });
    let starts = 0;
    const start: StartTargetRecording = async input => {
      if (++starts > 1) throw new AgentExecutionError('recorder_start_ack_unknown', 'replacement start ACK lost', 'unknown');
      return f.start(input);
    };
    const recording = await startAttemptRecording({ binding, runDir: directory(), start, signal: new AbortController().signal });
    t.mock.timers.tick(1000);
    await immediate();
    const result = await recording.finalize();
    assert.equal(starts, 2);
    assert.equal(result.cleanup, 'unknown');
    assert.equal(result.state, 'incomplete');
    assert.equal(result.segments.length, 1);
    assert.equal(result.artifacts?.length, 2);
    assert.equal(result.artifacts?.[1]?.readyAt, null);
    assert.equal(result.artifacts?.[1]?.status.capture, 'unknown');
    assert.equal(result.gaps.find(gap => gap.reason === 'rotation_pending')?.to, null);
    assert.equal(f.controls[0]!.stopCalls, 1);
  });

  it('does not discard capture loss reported while stop is still in progress', async () => {
    const f = provider();
    const start: StartTargetRecording = async input => {
      const handle = await f.start(input);
      return {
        ...handle,
        stop() {
          f.controls[0]!.lose(new AgentExecutionError('recorder_lost', 'capture failed before stop ACK'));
          return handle.stop();
        },
      };
    };
    const recording = await startAttemptRecording({ binding, runDir: directory(), start, signal: new AbortController().signal });
    const result = await recording.finalize();
    assert.equal(result.cleanup, 'confirmed');
    assert.equal(result.state, 'incomplete');
    assert.equal(result.code, 'recorder_lost');
    assert.equal(result.segments.length, 1);
    assert.equal(recording.signal.aborted, true);
  });
});
