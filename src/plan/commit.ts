// Atomic plan generations (architecture invariant 9). A new generation (test files + plan.json) is written and fsynced
// into `<planDir>/.qa/staging-<pid>-<planId>/new/` (`.qa` is skipped by test discovery); a manifest written last marks
// the staging as complete. The swap first hard-links every existing target into `old/` — the target itself stays in
// place — and then renames each staged file over its target: rename(2) replaces the path atomically, so a reader always
// finds a previous-generation file (old or new version) and never a gap. plan.json goes last; that rename is the commit
// point. Only after it are the previous generation's files that the new plan no longer references pruned. Any failure
// before the commit runs the exact inverse of the swap, so the previous generation stays byte-identical (the very same
// inodes); a staging directory left by a dead process is rolled back (or, when it had already committed, its prune is
// finished) by the next plan of the same app.
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { ensureDir, writeAtomic, writeJsonAtomic } from '../core/fsx.ts';

const PLAN_FILE = 'plan.json';
const STAGING_ROOT = '.qa';
const MANIFEST = 'manifest.json';

export interface Generation {
  /** Test files: path relative to the plan directory → YAML text. */
  tests: ReadonlyMap<string, string>;
  plan: unknown;
  /** Previous-generation files (relative to the plan directory) the new plan no longer references. */
  stale: readonly string[];
}

/** A path relative to the plan directory that stays inside it. */
const RelPath = z.string().min(1).refine((p) => !isAbsolute(p) && !normalize(p).split(sep).includes('..'));
const Manifest = z.strictObject({
  /** Staged files in swap order; plan.json is last. */
  files: z.array(RelPath).refine((files) => files.at(-1) === PLAN_FILE),
  stale: z.array(RelPath),
});
type Manifest = z.infer<typeof Manifest>;

/**
 * Stages `gen`, calls `beforeSwap` (its throw aborts with nothing changed), swaps it in and prunes stale files.
 * Throws after restoring the previous generation when anything before the commit fails.
 */
export function commitGeneration(planDir: string, planId: string, gen: Generation, beforeSwap: () => void): void {
  const stage = join(planDir, STAGING_ROOT, `staging-${process.pid}-${planId}`);
  const manifest: Manifest = { files: [...[...gen.tests.keys()].sort(), PLAN_FILE], stale: [...gen.stale] };
  let phase: 'stage' | 'ready' | 'swap' = 'stage';
  try {
    for (const [rel, text] of gen.tests) writeAtomic(join(stage, 'new', rel), text);
    writeJsonAtomic(join(stage, 'new', PLAN_FILE), gen.plan);
    // Directory entries up to the plan directory must be durable before the manifest says "staged".
    for (let dir = join(stage, 'new'); dir !== dirname(planDir); dir = dirname(dir)) fsyncDir(dir);
    writeJsonAtomic(join(stage, MANIFEST), manifest);
    phase = 'ready';
    beforeSwap();
    phase = 'swap';
    backUp(planDir, stage, manifest.files);
    const tests = manifest.files.slice(0, -1);
    fsyncDirs(tests.flatMap((rel) => swapIn(planDir, stage, rel)));
    fsyncDirs(swapIn(planDir, stage, PLAN_FILE));
  } catch (err) {
    try {
      if (phase === 'stage') discard(planDir, stage);
      else rollback(planDir, stage, manifest.files);
    } catch (undoErr) {
      throw new Error(`계획 교체 실패 후 되돌리기도 실패했습니다: ${(undoErr as Error).message} — 이전 파일은 ${join(stage, 'old')}에 남아 있습니다 (다음 프로세스의 qa plan이 복구)`, { cause: err });
    }
    const message = (err as Error).message;
    if (phase === 'stage') throw new Error(`새 계획을 준비하지 못했습니다 (기존 계획은 그대로): ${message}`, { cause: err });
    if (phase === 'swap') throw new Error(`테스트 파일 교체에 실패해 이전 계획으로 되돌렸습니다: ${message}`, { cause: err });
    throw err;
  }
  prune(planDir, stage, manifest.stale);
}

/**
 * Finishes staging directories of dead processes: uncommitted (staged plan.json still present) → rolled back,
 * committed → stale files pruned, incomplete staging (no manifest) → deleted. Returns one Korean note per directory.
 */
export function recoverStaging(planDir: string): string[] {
  const root = join(planDir, STAGING_ROOT);
  if (!existsSync(root)) return [];
  const notes: string[] = [];
  for (const name of readdirSync(root)) {
    const pid = Number(/^staging-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    const stage = join(root, name);
    const manifestFile = join(stage, MANIFEST);
    if (!existsSync(manifestFile)) {
      discard(planDir, stage);
      notes.push(`중단된 계획 준비 파일을 지웠습니다 (교체 전): ${name}`);
      continue;
    }
    const manifest = readManifest(manifestFile);
    if (existsSync(join(stage, 'new', PLAN_FILE))) {
      rollback(planDir, stage, manifest.files);
      notes.push(`중단된 계획 교체를 되돌려 이전 계획을 복구했습니다: ${name}`);
    } else {
      prune(planDir, stage, manifest.stale);
      notes.push(`중단된 계획 교체(커밋 완료)의 정리를 마쳤습니다: ${name}`);
    }
  }
  return notes;
}

/**
 * Hard-links every existing target into `old/` (the target stays in place) and makes the links durable before any
 * target is replaced.
 */
function backUp(planDir: string, stage: string, files: readonly string[]): void {
  const dirs: string[] = [];
  for (const rel of files) {
    const target = join(planDir, rel);
    if (!existsSync(target)) continue;
    const backup = join(stage, 'old', rel);
    ensureDir(dirname(backup));
    linkSync(target, backup);
    for (let dir = dirname(backup); dir !== dirname(stage); dir = dirname(dir)) dirs.push(dir);
  }
  fsyncDirs(dirs);
}

/** new/ → target: atomically replaces a backed-up target, or creates a new file. Returns the directories that changed. */
function swapIn(planDir: string, stage: string, rel: string): string[] {
  const target = join(planDir, rel);
  const staged = join(stage, 'new', rel);
  ensureDir(dirname(target));
  renameSync(staged, target);
  return [dirname(target), dirname(staged)];
}

/**
 * Exact inverse of the swap, in reverse order: first every swapped-in file returns to `new/` — as a second link while
 * a backup is about to replace it, so no previous file ever disappears; a file without backup did not exist before and
 * is moved out — then each backup is renamed over its target. Idempotent at every intermediate state, so a crash during
 * the rollback itself is recovered by running it again.
 */
function rollback(planDir: string, stage: string, files: readonly string[]): void {
  const paths = [...files].reverse().map((rel) => ({ target: join(planDir, rel), staged: join(stage, 'new', rel), backup: join(stage, 'old', rel) }));
  for (const { target, staged, backup } of paths) {
    if (existsSync(staged) || !existsSync(target)) continue;
    ensureDir(dirname(staged));
    if (existsSync(backup)) linkSync(target, staged);
    else renameSync(target, staged);
  }
  fsyncDirs(paths.flatMap(({ target, staged }) => [dirname(staged), dirname(target)]));
  // A backup that is still the target's own inode was linked but never replaced: the target already is the old file.
  for (const { target, backup } of paths) if (existsSync(backup) && !sameFile(backup, target)) renameSync(backup, target);
  const dirs = paths.map(({ target }) => dirname(target));
  fsyncDirs(dirs);
  for (const dir of new Set(dirs)) removeEmptyDir(dir, planDir);
  discard(planDir, stage);
}

function sameFile(a: string, b: string): boolean {
  const x = statSync(a, { bigint: true, throwIfNoEntry: false });
  const y = statSync(b, { bigint: true, throwIfNoEntry: false });
  return x !== undefined && y !== undefined && x.dev === y.dev && x.ino === y.ino;
}

function prune(planDir: string, stage: string, stale: readonly string[]): void {
  for (const rel of stale) {
    const file = join(planDir, rel);
    rmSync(file, { force: true });
    removeEmptyDir(dirname(file), planDir);
  }
  discard(planDir, stage);
}

/** The manifest goes first, so a crash while deleting the rest never looks like a staging to recover. */
function discard(planDir: string, stage: string): void {
  if (existsSync(stage)) {
    rmSync(join(stage, MANIFEST), { force: true });
    fsyncDir(stage);
    rmSync(stage, { recursive: true, force: true });
  }
  removeEmptyDir(join(planDir, STAGING_ROOT), planDir);
}

function readManifest(file: string): Manifest {
  let json: unknown = null;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // reported below
  }
  const parsed = Manifest.safeParse(json);
  if (!parsed.success) throw new Error(`계획 교체 기록이 손상되었습니다: ${file} — 파일을 확인한 뒤 staging 디렉터리를 직접 정리하세요`);
  return parsed.data;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeEmptyDir(dir: string, stop: string): void {
  if (dir !== stop && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

function fsyncDirs(dirs: readonly string[]): void {
  for (const dir of new Set(dirs)) if (existsSync(dir)) fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
