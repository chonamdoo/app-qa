// `summary.json` data model (v1): written by the runner, read by report generation, `qa report` and the server.
import type { HealthFinding, Platform, Point, Surface, Verdict } from '../core/types.ts';
import type { QaStatus } from './status.ts';

export const SUMMARY_SCHEMA = 'app-qa/summary/v1';

export interface DecisionSummary {
  kind: 'grounding' | 'claim' | 'which' | 'commit' | 'check';
  source: 'selector' | 'fast_path' | 'jev' | 'deterministic' | 'none';
  verdict: string;
  intent: string;
  /** Top probabilities (≤ 4), highest first, when Jev was consulted. */
  top: { key: string; label: string; p: number }[] | null;
  target: { key: string; name: string; role: string; tapPoint: Point } | null;
  model: string | null;
  requestId: string | null;
  latencyMs: number | null;
  reason: string;
  /** Jev answer shown for reference only (smoke); never part of the verdict. */
  reference?: boolean;
}

export interface StepResult {
  /** Execution order within the test × platform, 1-based (also the evidence dir number). */
  seq: number;
  /** Index into the static step list (setup ⧺ steps ⧺ teardown) the step belongs to, 0-based. */
  index: number;
  /** Path + Korean label, e.g. "3.2 탭: 출국장". */
  label: string;
  kind: string;
  phase: 'setup' | 'main' | 'teardown' | 'interrupt';
  verdict: Verdict;
  /** Machine-readable reason: not_found, blocked_by_policy, no_effect, uncalibrated, … (null on PASS). */
  code: string | null;
  reason: string;
  optional: boolean;
  /** Evidence directory relative to the run dir. */
  evidenceDir: string;
  before: string | null;
  after: string | null;
  decisions: DecisionSummary[];
  health: HealthFinding[];
  settle: { changed: boolean; settled: boolean; ms: number } | null;
  durationMs: number;
}

export interface TestResult {
  id: string;
  name: string;
  /** Test file relative to the project root (posix), or null for smoke. */
  file: string | null;
  app: string;
  platform: Platform;
  /** Native app or website; null when the test file could not be loaded (its profile is unknown). */
  surface: Surface | null;
  deviceId: string | null;
  deviceName: string | null;
  verdict: Verdict;
  code: string | null;
  /** web-qa vocabulary derived from `verdict` + `code` (`report/status.ts`); the verdict stays authoritative. */
  qaStatus: QaStatus;
  reason: string;
  durationMs: number;
  covers: string[];
  tags: string[];
  status: 'draft' | 'approved' | 'rejected' | null;
  plan: string | null;
  steps: StepResult[];
  /** Teardown failures, LogBox warnings, OCR unavailability … never change the verdict. */
  warnings: string[];
  health: HealthFinding[];
  /** Relative paths of attached log slice / crash artifacts. */
  logs: string | null;
  crash: string[];
  evidenceDir: string;
}

export interface RunSummary {
  $schema: typeof SUMMARY_SCHEMA;
  kind: 'run' | 'smoke';
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: Platform | 'all';
  devices: { platform: Platform; id: string; name: string }[];
  counts: Record<Verdict, number>;
  qaCounts: Record<QaStatus, number>;
  tests: TestResult[];
  /** Relative to the run dir. */
  reportPath: string;
  junitPath: string | null;
}
