// Read-only views over the project state the UI browses: runs (.qa/runs), plans (tests/generated), app profiles (apps/).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { expandHome } from '../core/config.ts';
import type { QaEvent } from '../core/events.ts';
import { sha256 } from '../core/fsx.ts';
import type { Platform, Verdict } from '../core/types.ts';
import { AppProfile, PlanFile, TestSpec, type StepSpec } from '../spec/schema.ts';

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

function parseJsonl(text: string, wanted: (line: string) => boolean): QaEvent[] {
  const out: QaEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line || !wanted(line)) continue;
    try {
      out.push(JSON.parse(line) as QaEvent);
    } catch {
      // A crash can leave a torn last line; skip it.
    }
  }
  return out;
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
      const events = hasEvents ? parseJsonl(await readFile(eventsFile, 'utf8'), (l) => l.includes('"run.started"') || l.includes('"run.finished"')) : [];
      let started: Extract<QaEvent, { type: 'run.started' }> | undefined;
      let finished: Extract<QaEvent, { type: 'run.finished' }> | undefined;
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
        tests: started?.tests.map(({ id, name, platforms }) => ({ id, name, platforms })) ?? [],
        devices: started?.devices ?? [],
        reportPath: finished?.reportPath ?? (existsSync(report) ? report : null),
        hasEvents,
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

const STEP_KIND_LABEL: Record<string, string> = {
  launch: '앱 실행',
  open: '링크 열기',
  tap: '탭',
  longPress: '길게 누르기',
  tapAt: '좌표 탭',
  type: '입력',
  clear: '지우기',
  press: '키 누르기',
  hideKeyboard: '키보드 숨기기',
  see: '보임',
  seeNot: '안 보임',
  assertText: '텍스트 확인',
  assertNoText: '텍스트 없음',
  checkEach: '각 줄 검사',
  claim: '판정',
  remember: '기억',
  which: '분기',
  repeat: '반복',
  use: '하위 흐름',
  scroll: '스크롤',
  swipe: '스와이프',
  back: '뒤로',
  location: '위치 설정',
  wait: '대기',
  capture: '캡처',
};

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
  const fields = step as Record<string, unknown>;
  const kind = Object.keys(fields).find((key) => STEP_KIND_LABEL[key] !== undefined);
  if (kind === undefined) return JSON.stringify(step);
  const value = fields[kind];
  let detail: string;
  if (kind === 'type') detail = `${fields.secure ? '••••' : `"${String(value)}"`} → ${describeValue(fields.into)}`;
  else if (kind === 'which' && value && typeof value === 'object') detail = Object.keys(value).join(' | ');
  else if (kind === 'wait' && typeof value === 'number') detail = `${value}ms`;
  else detail = describeValue(value);
  return detail ? `${STEP_KIND_LABEL[kind]}: ${detail}` : STEP_KIND_LABEL[kind]!;
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
}

/** Most recent test.finished per `testId platform` across the latest runs. */
async function latestResults(runsDir: string, runLimit: number): Promise<Map<string, PlanTestView['results'][number]>> {
  const latest = new Map<string, PlanTestView['results'][number]>();
  for (const run of await listRuns(runsDir, runLimit)) {
    if (!run.hasEvents) continue;
    const events = parseJsonl(await readFile(join(run.runDir, 'events.jsonl'), 'utf8'), (l) => l.includes('"test.finished"'));
    for (const e of events) {
      if (e.type !== 'test.finished') continue;
      const key = `${e.testId} ${e.platform}`;
      const prev = latest.get(key);
      if (!prev || prev.ts < e.ts) latest.set(key, { platform: e.platform, verdict: e.verdict, runId: e.runId, ts: e.ts });
    }
  }
  return latest;
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
  const results = await latestResults(opts.runsDir, 30);
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
  return { app: opts.app, planPath, plan, docs, tests };
}
