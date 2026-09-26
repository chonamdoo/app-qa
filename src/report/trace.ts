// Requirement traceability (architecture §6/§5): plan.json requirements → covering tests → verdict per platform,
// with draft status and document-change detection (current sha256 ≠ plan.json).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandHome } from '../core/config.ts';
import { sha256 } from '../core/fsx.ts';
import type { Platform, Verdict } from '../core/types.ts';
import { PlanFile, type Requirement } from '../spec/schema.ts';
import type { RunSummary, TestResult } from './types.ts';

export interface TraceTest {
  file: string | null;
  id: string;
  name: string;
  status: 'draft' | 'approved' | 'rejected' | null;
  /** Verdict per platform in this run; absent = not run here. */
  verdicts: Partial<Record<Platform, Verdict>>;
}

export interface TraceRow {
  requirement: Requirement;
  docState: 'same' | 'changed' | 'missing';
  tests: TraceTest[];
}

export interface Traceability {
  app: string;
  /** Plan path relative to the project root (posix). */
  plan: string;
  createdAt: string;
  docs: { path: string; state: 'same' | 'changed' | 'missing' }[];
  rows: TraceRow[];
  untestable: { requirement: string; reason: string; text: string | null }[];
  error: string | null;
}

function docState(root: string, path: string, digest: string): 'same' | 'changed' | 'missing' {
  // UI-typed scenarios are the virtual document `inline.md`: nothing on disk to re-hash.
  if (path === 'inline.md') return 'same';
  const file = resolve(root, expandHome(path));
  if (!existsSync(file) || !statSync(file).isFile()) return 'missing';
  return sha256(readFileSync(file)) === digest ? 'same' : 'changed';
}

/** One matrix per app whose tests declare `covers` and whose plan.json exists. */
export function buildTraceability(summary: RunSummary, root: string): Traceability[] {
  const byApp = new Map<string, TestResult[]>();
  for (const t of summary.tests) {
    const list = byApp.get(t.app) ?? [];
    list.push(t);
    byApp.set(t.app, list);
  }
  const out: Traceability[] = [];
  for (const [app, tests] of byApp) {
    if (!tests.some((t) => t.covers.length)) continue;
    const plan = tests.find((t) => t.plan)?.plan ?? `tests/generated/${app}/plan.json`;
    const planFile = resolve(root, plan);
    if (!existsSync(planFile)) continue;
    const base: Traceability = { app, plan, createdAt: '', docs: [], rows: [], untestable: [], error: null };
    let parsed: PlanFile;
    try {
      const checked = PlanFile.safeParse(JSON.parse(readFileSync(planFile, 'utf8')));
      if (!checked.success) {
        out.push({ ...base, error: `plan.json 형식 오류: ${checked.error.issues.map((i) => i.path.join('.')).join(', ')}` });
        continue;
      }
      parsed = checked.data;
    } catch (err) {
      out.push({ ...base, error: `plan.json을 읽을 수 없음: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const docs = parsed.docs.map((d) => ({ path: d.path, state: docState(root, d.path, d.sha256) }));
    const stateOf = new Map(docs.map((d) => [d.path, d.state]));
    const runByFile = new Map<string, TestResult[]>();
    for (const t of tests) {
      if (!t.file) continue;
      const list = runByFile.get(t.file) ?? [];
      list.push(t);
      runByFile.set(t.file, list);
    }
    const verdictsOf = (results: readonly TestResult[]) => Object.fromEntries(results.map((r) => [r.platform, r.verdict])) as Partial<Record<Platform, Verdict>>;
    const rows = parsed.requirements.map((requirement): TraceRow => {
      const covering: TraceTest[] = [];
      const seen = new Set<string>();
      for (const entry of parsed.tests.filter((e) => e.covers.includes(requirement.id))) {
        const results = runByFile.get(entry.file) ?? [];
        seen.add(entry.file);
        covering.push({
          file: entry.file,
          id: results[0]?.id ?? entry.file.split('/').pop()!.replace(/\.e2e\.ya?ml$/, ''),
          name: results[0]?.name ?? entry.file,
          status: results[0]?.status ?? entry.status,
          verdicts: verdictsOf(results),
        });
      }
      // Hand-written tests that cover the requirement without being in the plan.
      for (const [file, results] of runByFile) {
        if (seen.has(file) || !results[0]!.covers.includes(requirement.id)) continue;
        covering.push({ file, id: results[0]!.id, name: results[0]!.name, status: results[0]!.status, verdicts: verdictsOf(results) });
      }
      return { requirement, docState: stateOf.get(requirement.doc) ?? 'same', tests: covering };
    });
    const textOf = new Map(parsed.requirements.map((r) => [r.id, r.text]));
    out.push({
      ...base,
      createdAt: parsed.createdAt,
      docs,
      rows,
      untestable: parsed.untestable.map((u) => ({ requirement: u.requirement, reason: u.reason, text: textOf.get(u.requirement) ?? null })),
    });
  }
  return out;
}
