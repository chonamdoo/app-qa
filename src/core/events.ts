// Event stream contract: the runner, planner and job queue emit these; the UI client (and events.jsonl) consume them.
import type { HealthFinding, Platform, Point, Verdict } from './types.ts';

interface Base {
  /** ISO timestamp with ms. */
  ts: string;
  /** Monotonic per-process sequence number. */
  seq: number;
}

interface StepRef {
  runId: string;
  testId: string;
  platform: Platform;
  /** 0-based index into the flattened step list of the test (interrupt `do` steps get fractional labels in `label`). */
  index: number;
}

export type QaEventBody =
  | { type: 'job.queued'; jobId: string; kind: JobKind; title: string }
  | { type: 'job.started'; jobId: string; kind: JobKind }
  | { type: 'job.finished'; jobId: string; kind: JobKind; ok: boolean; message: string; resultPath: string | null }
  | { type: 'run.started'; runId: string; runDir: string; tests: { id: string; name: string; platforms: Platform[]; steps: string[] }[]; devices: { platform: Platform; id: string; name: string }[] }
  | ({ type: 'test.started'; name: string } & Omit<StepRef, 'index'>)
  | ({ type: 'step.started'; label: string } & StepRef)
  | ({ type: 'observe'; screenshot: string | null; candidates: number; sparse: boolean; overflow: boolean; ocr: boolean } & StepRef)
  | ({
      type: 'decision';
      kind: 'grounding' | 'claim' | 'which' | 'commit' | 'check';
      intent: string;
      verdict: string;
      source: 'selector' | 'fast_path' | 'jev' | 'deterministic' | 'none';
      probabilities: Record<string, number> | null;
      target: { key: string; name: string; role: string; tapPoint: Point } | null;
      model: string | null;
      requestId: string | null;
      latencyMs: number | null;
      reason: string;
    } & StepRef)
  | ({ type: 'policy'; risky: boolean; blocked: boolean; reasons: string[] } & StepRef)
  | ({
      type: 'action';
      kind: ActionKind;
      point: Point | null;
      to: Point | null;
      /** Masked for secure fields. */
      text: string | null;
      status: 'completed' | 'uncertain' | 'rejected';
      ms: number;
    } & StepRef)
  | ({ type: 'settle'; changed: boolean; settled: boolean; ms: number; screenshot: string | null } & StepRef)
  | ({ type: 'health'; findings: HealthFinding[] } & StepRef)
  | ({ type: 'step.finished'; verdict: Verdict; reason: string; evidenceDir: string } & StepRef)
  | ({ type: 'test.finished'; verdict: Verdict; reason: string; durationMs: number } & Omit<StepRef, 'index'>)
  | { type: 'run.finished'; runId: string; counts: Record<Verdict, number>; reportPath: string; junitPath: string | null }
  | { type: 'plan.started'; planId: string; app: string; docs: string[] }
  | { type: 'plan.progress'; planId: string; phase: 'ingest' | 'segment' | 'generate' | 'validate' | 'review' | 'write'; message: string }
  | { type: 'plan.finished'; planId: string; planPath: string; requirements: number; tests: number; untestable: number; ok: boolean; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; source: string; message: string };

/** Exactly the DSL action performed; never substituted by a neighbouring kind. */
export type ActionKind =
  | 'tap'
  | 'longPress'
  | 'type'
  | 'clear'
  | 'press'
  | 'hideKeyboard'
  | 'swipe'
  | 'scroll'
  | 'back'
  | 'open'
  | 'location'
  | 'launch'
  | 'terminate'
  | 'reset';

export type JobKind = 'run' | 'smoke' | 'plan' | 'calibrate' | 'capture';

export type QaEvent = QaEventBody & Base;

export interface EventSink {
  emit(event: QaEventBody): void;
}

/** Fan-out sink with a monotonic sequence; subscribers must not throw. */
export class EventBus implements EventSink {
  private seq = 0;
  private readonly listeners = new Set<(e: QaEvent) => void>();

  emit(event: QaEventBody): void {
    const full = { ...event, ts: new Date().toISOString(), seq: ++this.seq } as QaEvent;
    for (const listener of this.listeners) listener(full);
  }

  subscribe(listener: (e: QaEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
