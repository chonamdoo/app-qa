// Report generation from `summary.json`: report.html (always), junit.xml (on request), manifest update.
// `qa report <runId>` regenerates from the stored summary, so a plan/doc change shows up without re-running.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../core/config.ts';
import { writeAtomic } from '../core/fsx.ts';
import { renderHtml } from './html.ts';
import { renderJunit } from './junit.ts';
import { updateManifest } from './manifest.ts';
import { countQaStatuses, qaStatus } from './status.ts';
import { buildTraceability } from './trace.ts';
import { SUMMARY_SCHEMA, type RunSummary, type TestResult } from './types.ts';

const SUMMARY_SCHEMA_V1 = 'app-qa/summary/v1';

/** `summary.json` before websites: no `qaCounts`, no per-result `surface` / `qaStatus` (every result was a native app). */
type SummaryV1 = Omit<RunSummary, '$schema' | 'qaCounts' | 'tests'> & { $schema: typeof SUMMARY_SCHEMA_V1; tests: Omit<TestResult, 'surface' | 'qaStatus'>[] };

/** Writes report.html (+ junit.xml) for a run and records them in the manifest; returns absolute paths. `qa report`
 * rewrites them, so both are replaced atomically. */
export function writeReports(runDir: string, summary: RunSummary, opts: { junit: boolean; root?: string }): { reportPath: string; junitPath: string | null } {
  const traces = buildTraceability(summary, opts.root ?? PATHS.root);
  const reportPath = join(runDir, 'report.html');
  writeAtomic(reportPath, renderHtml(summary, traces, runDir));
  const entries: { kind: 'report' | 'junit'; relativePath: string }[] = [{ kind: 'report', relativePath: 'report.html' }];
  let junitPath: string | null = null;
  if (opts.junit) {
    junitPath = join(runDir, 'junit.xml');
    writeAtomic(junitPath, renderJunit(summary));
    entries.push({ kind: 'junit', relativePath: 'junit.xml' });
  }
  updateManifest(runDir, summary.runId, entries);
  return { reportPath, junitPath };
}

function readSummary(runDir: string): RunSummary {
  const file = join(runDir, 'summary.json');
  if (!existsSync(file)) throw new Error(`summary.json이 없습니다: ${file}`);
  // A file this project wrote (only the `$schema` is checked, as before v2); an unknown id stops here.
  const summary: RunSummary | SummaryV1 = JSON.parse(readFileSync(file, 'utf8'));
  const schema: unknown = summary.$schema;
  if (summary.$schema === SUMMARY_SCHEMA) return summary;
  if (summary.$schema !== SUMMARY_SCHEMA_V1) throw new Error(`지원하지 않는 summary 형식: ${String(schema)} (읽을 수 있는 형식: ${SUMMARY_SCHEMA}, ${SUMMARY_SCHEMA_V1})`);
  // The QA status is derived exactly as the runner derives it for v2.
  const tests = summary.tests.map((t) => ({ ...t, surface: 'app' as const, qaStatus: qaStatus(t) }));
  return { ...summary, $schema: SUMMARY_SCHEMA, qaCounts: countQaStatuses(tests.map((t) => t.qaStatus)), tests };
}

/** Most recent run id (ids sort by start time), or null. */
export function latestRunId(runsDir: string = PATHS.runs): string | null {
  if (!existsSync(runsDir)) return null;
  const ids = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, 'summary.json')))
    .map((d) => d.name)
    .sort();
  return ids.at(-1) ?? null;
}

/** Re-renders a finished run's reports (junit only if the run had one). */
export function regenerateReport(runId: string, opts: { runsDir?: string; root?: string } = {}): { reportPath: string; junitPath: string | null } {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`올바르지 않은 실행 ID: ${runId}`);
  const runDir = join(opts.runsDir ?? PATHS.runs, runId);
  if (!existsSync(runDir)) throw new Error(`실행 기록이 없습니다: ${runId}`);
  const summary = readSummary(runDir);
  return writeReports(runDir, summary, { junit: summary.junitPath !== null, root: opts.root });
}
