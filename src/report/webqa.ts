// web-qa skill records gate export (check-run v1): `<run>/web-qa/plan.json` + `result.json` for runs with website
// targets, checked with `node <web-qa>/scripts/check-run.mjs <run>/web-qa/plan.json <run>/web-qa/result.json <run>`.
// Written once when the run finishes (evidence is final and sanitized by then); `qa report` never rewrites it, so the
// hashes keep describing the bytes the run produced.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256, writeJsonAtomic } from '../core/fsx.ts';
import type { Platform } from '../core/types.ts';
import { updateManifest } from './manifest.ts';
import type { QaStatus } from './status.ts';
import type { RunSummary, TestResult } from './types.ts';

/** Directory under the run dir; the evidence root of the export is the run dir itself. */
export const WEB_QA_DIR = 'web-qa';

export type CheckRunStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'SKIPPED';

/**
 * check-run v1 has no "inconclusive": the test ran without establishing its expected outcome, so it is exported as FAIL
 * (summary.json and the reports keep INCONCLUSIVE and the original code).
 */
const CHECK_RUN_STATUS: Record<QaStatus, CheckRunStatus> = { PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'FAIL', BLOCKED: 'BLOCKED', NOT_RUN: 'NOT_RUN', SKIPPED: 'SKIPPED' };

export interface WebQaPlan {
  version: 1;
  runId: string;
  buildId: string;
  required: { scenarioId: string; targetId: Platform }[];
}

export interface WebQaResult {
  version: 1;
  runId: string;
  buildId: string;
  runnerExitCode: number;
  attempts: { scenarioId: string; targetId: Platform; attempt: number; status: CheckRunStatus; evidence: { path: string; sha256: string }[] }[];
}

/** Every non-empty file under the run-relative `dir` (posix paths relative to the run dir, sorted) with its SHA-256. */
function evidence(runDir: string, dir: string): { path: string; sha256: string }[] {
  const root = join(runDir, dir);
  if (!existsSync(root)) return [];
  const out: { path: string; sha256: string }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const bytes = readFileSync(file);
    if (bytes.length > 0) out.push({ path: relative(runDir, file).split(sep).join('/'), sha256: sha256(bytes) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes `web-qa/plan.json` + `result.json` (atomically, recorded in the manifest) when the run has a website result;
 * returns the run-relative paths written (none otherwise). Required = every website test × platform of the run plus
 * results whose profile is unknown (test files that failed to load): an unrunnable file is NOT_RUN, never dropped from
 * the gate. One attempt each (the runner never retries); evidence = the files of the result's own evidence directory
 * (none for results that never ran).
 */
export function writeWebQa(runDir: string, summary: RunSummary, opts: { buildId: string; runnerExitCode: number }): string[] {
  if (!summary.tests.some((t) => t.surface === 'web')) return [];
  const rows = summary.tests.filter((t) => t.surface !== 'app');
  const combos = new Map<string, number>();
  for (const t of rows) combos.set(`${t.id} ${t.platform}`, (combos.get(`${t.id} ${t.platform}`) ?? 0) + 1);
  // A duplicate test id (the loader reports the second file as invalid) would repeat a combination: name it by file.
  const scenarioOf = (t: TestResult) => (combos.get(`${t.id} ${t.platform}`)! > 1 && t.file ? `${t.id} (${t.file})` : t.id);
  const header = { version: 1 as const, runId: summary.runId, buildId: opts.buildId };
  const plan: WebQaPlan = { ...header, required: rows.map((t) => ({ scenarioId: scenarioOf(t), targetId: t.platform })) };
  const result: WebQaResult = {
    ...header,
    runnerExitCode: opts.runnerExitCode,
    attempts: rows.map((t) => ({
      scenarioId: scenarioOf(t),
      targetId: t.platform,
      attempt: 1,
      status: CHECK_RUN_STATUS[t.qaStatus],
      evidence: t.steps.length > 0 ? evidence(runDir, t.evidenceDir) : [],
    })),
  };
  const paths = [`${WEB_QA_DIR}/plan.json`, `${WEB_QA_DIR}/result.json`];
  writeJsonAtomic(join(runDir, WEB_QA_DIR, 'plan.json'), plan);
  writeJsonAtomic(join(runDir, WEB_QA_DIR, 'result.json'), result);
  updateManifest(runDir, summary.runId, paths.map((relativePath) => ({ kind: 'report' as const, relativePath })));
  return paths;
}
