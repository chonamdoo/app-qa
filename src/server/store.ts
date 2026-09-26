// Read-only views over the project state the UI browses: runs (.qa/runs), plans (tests/generated), app profiles (apps/).
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { expandHome } from '../core/config.ts';
import { sha256 } from '../core/fsx.ts';
import type { Platform, Verdict } from '../core/types.ts';
import { AppProfile, findStepKind, PlanFile, STEP_KIND_LABEL, TestSpec, type StepSpec } from '../spec/schema.ts';

export class PathRejected extends Error {}

const RUN_ID = /^[\w][\w.-]*$/;

/** Absolute run directory for a run id, or null when the id is not a plain directory name. */
export function runDirFor(runsDir: string, runId: string): string | null {
  return RUN_ID.test(runId) && !runId.includes('..') ? join(runsDir, runId) : null;
}

/**
 * Resolves URL-encoded path segments inside `base`. Rejects `..`/`.`/empty segments, encoded separators,
 * NUL, and symlinks that escape `base`.
 */
export function resolveInside(base: string, encodedRest: string): string {
  const segments = encodedRest.split('/').map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new PathRejected('잘못된 경로 인코딩');
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) throw new PathRejected('허용되지 않는 경로 구성 요소');
    return decoded;
  });
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new PathRejected('실행 디렉터리 밖 경로');
  if (existsSync(target)) {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realBase + sep)) throw new PathRejected('실행 디렉터리 밖을 가리키는 링크');
  }
  return target;
}

/** Nearest existing ancestor resolved through symlinks, plus the not-yet-existing rest. */
function realpathLoose(path: string): string {
  const rest: string[] = [];
  let head = path;
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Plan-job document sources → absolute paths/globs (`~` expanded, relative to `root`), each confined to `roots` by
 * realpath (glob base and every current glob hit included). Entries listed verbatim in `allowed` (the app profile's
 * `docs`) pass unchanged. Absolute output keeps the planner independent of the engine's working directory.
 */
export function resolvePlanDocs(docs: readonly string[], opts: { root: string; roots: readonly string[]; allowed: readonly string[] }): string[] {
  const realRoots = opts.roots.map(realpathLoose);
  const inside = (path: string): boolean => {
    const real = realpathLoose(path);
    return realRoots.some((base) => {
      const rel = relative(base, real);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
  };
  return docs.map((doc) => {
    if (opts.allowed.includes(doc)) return doc;
    const abs = resolve(opts.root, expandHome(doc));
    const segments = abs.split(sep);
    const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
    const confined =
      firstGlob === -1 ? inside(abs) : inside(segments.slice(0, firstGlob).join(sep) || sep) && globSync(abs).every((hit) => inside(resolve(hit)));
    if (!confined) throw new PathRejected(`문서 경로가 허용된 위치 밖입니다 (프로젝트, .qa/uploads, 앱 프로필 docs만 가능): ${doc}`);
    return abs;
  });
}

const EventBase = { seq: z.number().int(), ts: z.string() };
const PlatformValue = z.enum(['android', 'ios']);
const VerdictValue = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'SKIPPED']);

/** The events.jsonl lines these views read, validated field by field (only the fields they read). */
const StoredEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    ...EventBase,
    tests: z.array(z.object({ id: z.string(), name: z.string(), platforms: z.array(PlatformValue) })),
    devices: z.array(z.object({ platform: PlatformValue, id: z.string(), name: z.string() })),
  }),
  z.object({ type: z.literal('run.finished'), ...EventBase, counts: z.record(VerdictValue, z.number()), reportPath: z.string() }),
  z.object({ type: z.literal('test.finished'), ...EventBase, runId: z.string(), testId: z.string(), platform: PlatformValue, verdict: VerdictValue }),
]);
type StoredEvent = z.infer<typeof StoredEvent>;

/**
 * Events of the `wanted` types; a line that mentions one of them but fails to parse or validate (torn last line after a
 * crash, hand edits, older formats) is skipped and counted, never passed on.
 */
function parseJsonl(text: string, wanted: readonly StoredEvent['type'][]): { events: StoredEvent[]; invalid: number } {
  const types: ReadonlySet<string> = new Set(wanted);
  const events: StoredEvent[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (!line || !wanted.some((type) => line.includes(`"${type}"`))) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    // A line of another type that merely quotes a wanted one (e.g. a log message) is not ours to judge.
    if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && !types.has(value.type)) continue;
    const parsed = StoredEvent.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else invalid++;
  }
  return { events, invalid };
}

export interface RunListItem {
  runId: string;
  runDir: string;
  startedAt: string;
  finished: boolean;
  counts: Record<Verdict, number> | null;
  tests: { id: string; name: string; platforms: Platform[] }[];
  devices: { platform: Platform; id: string; name: string }[];
  reportPath: string | null;
  hasEvents: boolean;
  /** events.jsonl lines of the types read here that were skipped as malformed. */
  invalidEventLines: number;
}

/** Most recent runs first (run ids sort by start time). */
export async function listRuns(runsDir: string, limit = 200): Promise<RunListItem[]> {
  if (!existsSync(runsDir)) return [];
  const dirs = (await readdir(runsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && RUN_ID.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);
  return Promise.all(
    dirs.map(async (runId): Promise<RunListItem> => {
      const runDir = join(runsDir, runId);
      const eventsFile = join(runDir, 'events.jsonl');
      const hasEvents = existsSync(eventsFile);
      const { events, invalid } = hasEvents ? parseJsonl(await readFile(eventsFile, 'utf8'), ['run.started', 'run.finished']) : { events: [], invalid: 0 };
      let started: Extract<StoredEvent, { type: 'run.started' }> | undefined;
      let finished: Extract<StoredEvent, { type: 'run.finished' }> | undefined;
      for (const e of events) {
        if (e.type === 'run.started') started = e;
        else if (e.type === 'run.finished') finished = e;
      }
      const report = join(runDir, 'report.html');
      return {
        runId,
        runDir,
        startedAt: started?.ts ?? (await stat(runDir)).mtime.toISOString(),
        finished: finished !== undefined,
        counts: finished?.counts ?? null,
        tests: started?.tests ?? [],
        devices: started?.devices ?? [],
        reportPath: finished?.reportPath ?? (existsSync(report) ? report : null),
        hasEvents,
        invalidEventLines: invalid,
      };
    }),
  );
}

export async function listAppProfiles(appsDir: string): Promise<{ profiles: AppProfile[]; errors: { file: string; error: string }[] }> {
  const profiles: AppProfile[] = [];
  const errors: { file: string; error: string }[] = [];
  if (!existsSync(appsDir)) return { profiles, errors };
  for (const name of (await readdir(appsDir)).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = join(appsDir, name);
    try {
      const parsed = AppProfile.safeParse(parseYaml(await readFile(file, 'utf8')));
      if (parsed.success) profiles.push(parsed.data);
      else errors.push({ file, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { profiles, errors };
}

export interface PlanListItem {
  app: string;
  planPath: string;
  createdAt: string | null;
  requirements: number;
  tests: number;
  untestable: number;
  error: string | null;
}

export async function listPlans(generatedDir: string): Promise<PlanListItem[]> {
  if (!existsSync(generatedDir)) return [];
  const out: PlanListItem[] = [];
  for (const dir of await readdir(generatedDir, { withFileTypes: true })) {
    const planPath = join(generatedDir, dir.name, 'plan.json');
    if (!dir.isDirectory() || !existsSync(planPath)) continue;
    const parsed = await readPlan(planPath);
    out.push(
      parsed.success
        ? { app: dir.name, planPath, createdAt: parsed.data.createdAt, requirements: parsed.data.requirements.length, tests: parsed.data.tests.length, untestable: parsed.data.untestable.length, error: null }
        : { app: dir.name, planPath, createdAt: null, requirements: 0, tests: 0, untestable: 0, error: parsed.error },
    );
  }
  return out.sort((a, b) => a.app.localeCompare(b.app));
}

async function readPlan(planPath: string): Promise<{ success: true; data: PlanFile } | { success: false; error: string }> {
  try {
    const parsed = PlanFile.safeParse(JSON.parse(await readFile(planPath, 'utf8')));
    return parsed.success ? parsed : { success: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function describeValue(value: unknown): string {
  if (value === true) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`)
      .join(', ');
  }
  return JSON.stringify(value);
}

/** Korean checklist label for a DSL step (the runner's `run.started` labels replace these once a run starts). */
export function stepLabel(step: StepSpec): string {
  const kind = findStepKind(step);
  if (kind === null) return JSON.stringify(step);
  const fields: ReadonlyMap<string, unknown> = new Map(Object.entries(step));
  const value = fields.get(kind);
  let detail: string;
  if (kind === 'type') detail = `${fields.get('secure') ? '••••' : `"${String(value)}"`} → ${describeValue(fields.get('into'))}`;
  else if (kind === 'which' && value && typeof value === 'object') detail = Object.keys(value).join(' | ');
  else if (kind === 'wait' && typeof value === 'number') detail = `${value}ms`;
  else detail = describeValue(value);
  return detail ? `${STEP_KIND_LABEL[kind]}: ${detail}` : STEP_KIND_LABEL[kind];
}

export interface PlanTestView {
  file: string;
  path: string;
  id: string;
  name: string | null;
  platforms: Platform[];
  steps: string[];
  error: string | null;
  /** Latest verdict per platform from recent runs. */
  results: { platform: Platform; verdict: Verdict; runId: string; ts: string }[];
}

export interface PlanView {
  app: string;
  planPath: string;
  plan: PlanFile;
  docs: { path: string; kind: string; state: 'same' | 'changed' | 'missing' }[];
  tests: PlanTestView[];
  /** Malformed test.finished lines skipped while collecting `results`. */
  invalidEventLines: number;
}

/** Most recent test.finished per `testId platform` across the latest runs, and the malformed lines skipped. */
async function latestResults(runsDir: string, runLimit: number): Promise<{ latest: Map<string, PlanTestView['results'][number]>; invalid: number }> {
  const latest = new Map<string, PlanTestView['results'][number]>();
  let invalid = 0;
  for (const run of await listRuns(runsDir, runLimit)) {
    if (!run.hasEvents) continue;
    const parsed = parseJsonl(await readFile(join(run.runDir, 'events.jsonl'), 'utf8'), ['test.finished']);
    invalid += parsed.invalid;
    for (const e of parsed.events) {
      if (e.type !== 'test.finished') continue;
      const key = `${e.testId} ${e.platform}`;
      const prev = latest.get(key);
      if (!prev || prev.ts < e.ts) latest.set(key, { platform: e.platform, verdict: e.verdict, runId: e.runId, ts: e.ts });
    }
  }
  return { latest, invalid };
}

export async function readPlanView(opts: { root: string; generatedDir: string; runsDir: string; app: string }): Promise<PlanView | { error: string } | null> {
  if (!RUN_ID.test(opts.app)) return null;
  const planPath = join(opts.generatedDir, opts.app, 'plan.json');
  if (!existsSync(planPath)) return null;
  const parsed = await readPlan(planPath);
  if (!parsed.success) return { error: parsed.error };
  const plan = parsed.data;
  const docs = plan.docs.map((doc): PlanView['docs'][number] => {
    const file = resolve(opts.root, expandHome(doc.path));
    if (!existsSync(file) || !statSync(file).isFile()) return { path: doc.path, kind: doc.kind, state: 'missing' };
    return { path: doc.path, kind: doc.kind, state: sha256(readFileSync(file)) === doc.sha256 ? 'same' : 'changed' };
  });
  const { latest: results, invalid: invalidEventLines } = await latestResults(opts.runsDir, 30);
  const tests = await Promise.all(
    plan.tests.map(async (entry): Promise<PlanTestView> => {
      const path = resolve(opts.root, entry.file);
      const fallbackId = basename(entry.file).replace(/\.e2e\.ya?ml$/, '');
      const base = { file: entry.file, path, id: fallbackId, name: null, platforms: [] as Platform[], steps: [] as string[], results: [] };
      let spec: TestSpec;
      try {
        const checked = TestSpec.safeParse(parseYaml(await readFile(path, 'utf8')));
        if (!checked.success) return { ...base, error: checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
        spec = checked.data;
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
      const id = spec.id ?? fallbackId;
      const platforms: Platform[] = spec.platforms ?? ['android', 'ios'];
      return {
        ...base,
        id,
        name: spec.name,
        platforms,
        steps: spec.steps.map(stepLabel),
        error: null,
        results: platforms.flatMap((p) => results.get(`${id} ${p}`) ?? []),
      };
    }),
  );
  return { app: opts.app, planPath, plan, docs, tests, invalidEventLines };
}
