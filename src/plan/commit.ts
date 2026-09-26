// Atomic plan generations (architecture invariant 9). One generation per app at a time: the whole generate → commit →
// prune sequence holds `<planDir>/.qa/plan.lock` (an owner lock, `src/core/lock.ts`), and so does recovery. A new
// generation (test files + plan.json) is written and fsynced into `<planDir>/.qa/staging-<pid>-<start>-<planId>/new/`
// (pid + process start time name the owner; `.qa` is skipped by test discovery). The staging's `state` file, replaced
// atomically, records its phase: `staged` before the manifest (written last, it marks the staging as complete),
// `committed` once the plan.json rename below is durable, `rolling-back` before the first undo step. The swap first
// hard-links every existing target into `old/` — the target itself stays in place — and then renames each staged file
// over its target: rename(2) replaces the path atomically, so a reader always finds a previous-generation file (old or
// new version) and never a gap. plan.json goes last; the durable `committed` state after its rename is the commit point.
// Only after it are the previous generation's files that the new plan no longer references pruned. Any failure before
// the commit runs the exact inverse of the swap, so the previous generation stays byte-identical (the very same
// inodes). A staging directory left by a dead process is finished by the next plan of the same app, decided by its
// state alone: `committed` → its prune is finished (never rolled back), `staged`/`rolling-back` → rolled back, missing
// or unreadable → left for manual cleanup. Either only while plan.json is still a generation the staging recorded:
// plan.json `createdAt` strictly increases per app, so a staging older than the committed plan is discarded untouched.
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { ensureDir, writeAtomic, writeJsonAtomic } from '../core/fsx.ts';
import { acquireFileLock, type FileLock } from '../core/lock.ts';
import { isProcessAlive, PROCESS_STARTED_AT_MS, systemProbe, type ProcessProbe } from '../core/process.ts';

const PLAN_FILE = 'plan.json';
const STAGING_ROOT = '.qa';
const LOCK_FILE = 'plan.lock';
const MANIFEST = 'manifest.json';
const STATE_FILE = 'state';
/** A staging's phase (its `state` file); recovery decides by it, never by which staged files happen to exist. */
const Phase = z.enum(['staged', 'committed', 'rolling-back']);
type Phase = z.infer<typeof Phase>;

export interface Generation {
  /** Test files: path relative to the plan directory → YAML text. */
  tests: ReadonlyMap<string, string>;
  /** Written as plan.json; `createdAt` must be later than the committed plan's (it orders generations for recovery). */
  plan: { readonly createdAt: string };
  /** Previous-generation files (relative to the plan directory) the new plan no longer references. */
  stale: readonly string[];
}

/** A path relative to the plan directory that stays inside it. */
const RelPath = z.string().min(1).refine((p) => !isAbsolute(p) && !normalize(p).split(sep).includes('..'));
const Manifest = z.strictObject({
  /** `createdAt` of the plan.json this generation replaces (null: there was none) — the only plan a rollback may restore. */
  base: z.string().nullable(),
  /** `createdAt` of the staged plan.json. */
  createdAt: z.string(),
  /** Staged files in swap order; plan.json is last. */
  files: z.array(RelPath).refine((files) => files.at(-1) === PLAN_FILE),
  stale: z.array(RelPath),
});
type Manifest = z.infer<typeof Manifest>;

/** Proof that the caller holds `<planDir>/.qa/plan.lock`: staging, swap and recovery only run under it. */
export interface PlanLock {
  readonly planDir: string;
  release(): void;
}

/**
 * Takes the per-app plan lock without waiting: a concurrent generation of the same app (any process) makes it throw
 * FileLockedError. `release()` also removes the directories acquiring it had to create, once they are empty again.
 */
export function acquirePlanLock(planDir: string, app: string): PlanLock {
  const root = join(planDir, STAGING_ROOT);
  let top = root;
  while (!existsSync(dirname(top))) top = dirname(top);
  let lock: FileLock;
  try {
    lock = acquireFileLock(join(root, LOCK_FILE), { purpose: `앱 ${app}의 계획 생성` });
  } catch (err) {
    removeEmptyDirs(root, top);
    throw err;
  }
  return {
    planDir,
    release: () => {
      lock.release();
      removeEmptyDirs(root, top);
    },
  };
}

/** `createdAt` for the next generation: now, but always after the committed plan's even when the clock is behind it. */
export function nextCreatedAt(committed: string | undefined, now = Date.now()): string {
  const after = committed === undefined ? Number.NaN : Date.parse(committed) + 1;
  return new Date(Number.isNaN(after) ? now : Math.max(now, after)).toISOString();
}

/**
 * Stages `gen`, calls `beforeSwap` (its throw aborts with nothing changed), swaps it in, commits and prunes stale files.
 * Throws after restoring the previous generation when anything before the commit (the durable `committed` state) fails.
 */
export function commitGeneration(lock: PlanLock, planId: string, gen: Generation, beforeSwap: () => void): void {
  const { planDir } = lock;
  const stage = join(planDir, STAGING_ROOT, `staging-${process.pid}-${PROCESS_STARTED_AT_MS}-${planId}`);
  const files = [...[...gen.tests.keys()].sort(), PLAN_FILE];
  let phase: 'stage' | 'ready' | 'swap' = 'stage';
  try {
    const base = committedCreatedAt(planDir);
    if (base !== null && !(Date.parse(gen.plan.createdAt) > Date.parse(base))) {
      throw new Error(`새 계획의 createdAt(${gen.plan.createdAt})이 커밋된 계획(${base})보다 늦지 않습니다`);
    }
    const manifest: Manifest = { base, createdAt: gen.plan.createdAt, files, stale: [...gen.stale] };
    for (const [rel, text] of gen.tests) writeAtomic(join(stage, 'new', rel), text);
    writeJsonAtomic(join(stage, 'new', PLAN_FILE), gen.plan);
    // Directory entries up to the plan directory must be durable before the staging is marked staged.
    for (let dir = join(stage, 'new'); dir !== dirname(planDir); dir = dirname(dir)) fsyncDir(dir);
    writeAtomic(join(stage, STATE_FILE), 'staged');
    writeJsonAtomic(join(stage, MANIFEST), manifest);
    phase = 'ready';
    beforeSwap();
    phase = 'swap';
    backUp(planDir, stage, files);
    fsyncDirs(files.slice(0, -1).flatMap((rel) => swapIn(planDir, stage, rel)));
    fsyncDirs(swapIn(planDir, stage, PLAN_FILE));
    writeAtomic(join(stage, STATE_FILE), 'committed');
  } catch (err) {
    try {
      if (phase === 'stage') discard(planDir, stage);
      else rollback(planDir, stage, files);
    } catch (undoErr) {
      throw new Error(`계획 교체 실패 후 되돌리기도 실패했습니다: ${(undoErr as Error).message} — 이전 파일은 ${join(stage, 'old')}에 남아 있습니다 (다음 qa plan이 복구)`, { cause: err });
    }
    const message = (err as Error).message;
    if (phase === 'stage') throw new Error(`새 계획을 준비하지 못했습니다 (기존 계획은 그대로): ${message}`, { cause: err });
    if (phase === 'swap') throw new Error(`테스트 파일 교체에 실패해 이전 계획으로 되돌렸습니다: ${message}`, { cause: err });
    throw err;
  }
  prune(planDir, stage, gen.stale);
}

/**
 * Finishes the staging directories of dead owners (dead pid, or a pid reused by a process with another start time; a
 * staging of this very process is abandoned too, since the caller holds the plan lock), decided by the staging's state:
 * `committed` → stale files pruned while plan.json is still the staged one; `staged`/`rolling-back` → rolled back while
 * plan.json is the one it replaced or the staged one (the swap may have stopped either side of the plan.json rename).
 * Once a newer plan is committed the staging is discarded without touching any plan file; incomplete staging (no
 * manifest) is deleted; a complete one without a readable state is left for manual cleanup (throws). Returns one Korean
 * note per directory.
 */
export function recoverStaging(lock: PlanLock, probe: ProcessProbe = systemProbe): string[] {
  const { planDir } = lock;
  const root = join(planDir, STAGING_ROOT);
  const notes: string[] = [];
  for (const name of readdirSync(root)) {
    const owner = /^staging-(\d+)-(\d+)-/.exec(name);
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (pid !== process.pid && isProcessAlive(pid, Number(owner[2]), probe)) continue;
    const stage = join(root, name);
    const manifestFile = join(stage, MANIFEST);
    if (!existsSync(manifestFile)) {
      discard(planDir, stage);
      notes.push(`중단된 계획 준비 파일을 지웠습니다 (교체 전): ${name}`);
      continue;
    }
    const manifest = readManifest(manifestFile);
    const state = readPhase(join(stage, STATE_FILE));
    const recorded = state === 'committed' ? [manifest.createdAt] : [manifest.base, manifest.createdAt];
    const current = committedCreatedAt(planDir);
    if (recorded.includes(current)) {
      if (state === 'committed') {
        prune(planDir, stage, manifest.stale);
        notes.push(`중단된 계획 교체(커밋 완료)의 정리를 마쳤습니다: ${name}`);
      } else {
        rollback(planDir, stage, manifest.files);
        notes.push(`중단된 계획 교체를 되돌려 이전 계획을 복구했습니다: ${name}`);
      }
    } else if (current !== null && Date.parse(current) > Date.parse(manifest.createdAt)) {
      discard(planDir, stage);
      notes.push(`중단된 계획 교체 기록을 지웠습니다 — 그 뒤에 더 새 계획이 커밋되어 파일은 그대로 둡니다: ${name}`);
    } else {
      throw new Error(`중단된 계획 교체 기록이 현재 plan.json(${current ?? '없음'})과 맞지 않습니다: ${stage} — 파일을 확인한 뒤 staging 디렉터리를 직접 정리하세요`);
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
 * is moved out — then each backup is renamed over its target. The staging is marked `rolling-back` before the first
 * step (replacing even a `committed` whose directory fsync failed), so recovery finishes the undo instead of taking a
 * half-undone swap for a commit. Idempotent at every intermediate state, so a crash during the rollback itself is
 * recovered by running it again.
 */
function rollback(planDir: string, stage: string, files: readonly string[]): void {
  writeAtomic(join(stage, STATE_FILE), 'rolling-back');
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
  if (!existsSync(stage)) return;
  rmSync(join(stage, MANIFEST), { force: true });
  fsyncDir(stage);
  rmSync(stage, { recursive: true, force: true });
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

/** The staging's phase. Throws when it is missing or unreadable: without it recovery cannot tell the commit point. */
function readPhase(file: string): Phase {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // reported below
  }
  const parsed = Phase.safeParse(text.trim());
  if (!parsed.success) throw new Error(`계획 교체 단계 기록이 없거나 손상되어 커밋 여부를 알 수 없습니다: ${file} — 파일을 확인한 뒤 staging 디렉터리를 직접 정리하세요`);
  return parsed.data;
}

/** `createdAt` of the committed plan.json; null when there is none. Throws when it cannot be read or ordered. */
function committedCreatedAt(planDir: string): string | null {
  const file = join(planDir, PLAN_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // reported below
  }
  const createdAt = typeof json === 'object' && json !== null && 'createdAt' in json ? json.createdAt : undefined;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`plan.json의 createdAt을 읽을 수 없습니다: ${file} — 고치거나 지운 뒤 다시 실행하세요`);
  }
  return createdAt;
}

/**
 * Removes `dir`, then its parents up to `top`, while they are empty. Best effort: a directory that cannot be removed
 * (another process's entry, already gone) only stays behind, so it never fails the plan it cleans up after.
 */
function removeEmptyDirs(dir: string, top: string): void {
  for (let d = dir; ; d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === top) return;
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
