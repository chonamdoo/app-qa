import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { commitGeneration, recoverStaging, type Generation } from '../../src/plan/commit.ts';
import { tempDir } from './helpers.ts';

/** Writes `files` (path relative to `dir` → text). */
function put(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** Every file under `dir`, relative path ('/'-separated) → text. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out[relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/')] = readFileSync(join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

/** Every entry under `dir` (directories included) → its inode. */
function inodes(dir: string): Map<string, bigint> {
  return new Map(readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((rel) => [rel, statSync(join(dir, rel), { bigint: true }).ino]));
}

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const manifest = JSON.stringify({ files: ['inline/a.e2e.yaml', 'inline/b.e2e.yaml', 'plan.json'], stale: ['inline/c.e2e.yaml'] });
/** Generation 1: plan1, a1, c1. Generation 2: plan2, a2, b2 (c is stale). */
const previous = { 'plan.json': 'plan1', 'inline/a.e2e.yaml': 'a1', 'inline/c.e2e.yaml': 'c1' };

describe('plan generation crash recovery', () => {
  test('a process that died mid-swap (before the plan.json commit) is rolled back to the previous generation', () => {
    const planDir = tempDir();
    const stage = `.qa/staging-${deadPid()}-x`;
    put(planDir, {
      'plan.json': 'plan1',
      'inline/a.e2e.yaml': 'a2',
      'inline/b.e2e.yaml': 'b2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/old/plan.json`]: 'plan1',
      [`${stage}/new/plan.json`]: 'plan2',
      [`${stage}/manifest.json`]: manifest,
    });
    const notes = recoverStaging(planDir);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /되돌려 이전 계획을 복구했습니다/);
    assert.deepEqual(files(planDir), previous);
    assert.deepEqual(readdirSync(planDir).sort(), ['inline', 'plan.json'], 'staging directory removed');
  });

  test('a rollback interrupted halfway finishes on the next recovery', () => {
    const planDir = tempDir();
    const stage = `.qa/staging-${deadPid()}-x`;
    // plan.json and b already undone; a linked back to staging but its backup not yet renamed over it.
    put(planDir, {
      'plan.json': 'plan1',
      'inline/a.e2e.yaml': 'a2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/new/inline/a.e2e.yaml`]: 'a2',
      [`${stage}/new/inline/b.e2e.yaml`]: 'b2',
      [`${stage}/new/plan.json`]: 'plan2',
      [`${stage}/manifest.json`]: manifest,
    });
    recoverStaging(planDir);
    assert.deepEqual(files(planDir), previous);
  });

  test('a process that died after the commit gets its stale files pruned; the new generation stays', () => {
    const planDir = tempDir();
    const stage = `.qa/staging-${deadPid()}-x`;
    put(planDir, {
      'plan.json': 'plan2',
      'inline/a.e2e.yaml': 'a2',
      'inline/b.e2e.yaml': 'b2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/old/plan.json`]: 'plan1',
      [`${stage}/manifest.json`]: manifest,
    });
    assert.match(recoverStaging(planDir)[0]!, /정리를 마쳤습니다/);
    assert.deepEqual(files(planDir), { 'plan.json': 'plan2', 'inline/a.e2e.yaml': 'a2', 'inline/b.e2e.yaml': 'b2' });
  });

  test('incomplete staging (no manifest) is deleted; live processes and corrupt manifests are never touched', () => {
    const planDir = tempDir();
    put(planDir, { ...previous, [`.qa/staging-${deadPid()}-x/new/inline/a.e2e.yaml`]: 'a2' });
    recoverStaging(planDir);
    assert.deepEqual(files(planDir), previous);

    const live = { [`.qa/staging-${process.pid}-y/new/plan.json`]: 'plan2', [`.qa/staging-${process.pid}-y/manifest.json`]: manifest };
    put(planDir, live);
    assert.deepEqual(recoverStaging(planDir), []);
    assert.deepEqual(files(planDir), { ...previous, ...live });

    const corrupt = tempDir();
    put(corrupt, { ...previous, [`.qa/staging-${deadPid()}-z/manifest.json`]: JSON.stringify({ files: ['../../etc/passwd', 'plan.json'], stale: [] }) });
    assert.throws(() => recoverStaging(corrupt), /계획 교체 기록이 손상되었습니다/);
    assert.equal(files(corrupt)['inline/a.e2e.yaml'], 'a1');
  });
});

/** Generation 1 on disk; generation 2 replaces a and p, adds b and t (in a new directory), drops c. */
const gen1 = { 'plan.json': 'plan1', 'inline/a.e2e.yaml': 'a1', 'inline/c.e2e.yaml': 'c1', 'parking/p.e2e.yaml': 'p1' };
const gen2: Generation = {
  tests: new Map([
    ['inline/a.e2e.yaml', 'a2'],
    ['inline/b.e2e.yaml', 'b2'],
    ['parking/p.e2e.yaml', 'p2'],
    ['terms/t.e2e.yaml', 't2'],
  ]),
  plan: { generation: 2 },
  stale: ['inline/c.e2e.yaml'],
};
const gen2Files: Record<string, string> = { ...Object.fromEntries(gen2.tests), 'plan.json': `${JSON.stringify(gen2.plan, null, 2)}\n` };

/** Every fs call that can change a directory entry, plus `openSync` (the fsync opens), so a failure there is injected too. */
const ENTRY_OPS = ['linkSync', 'mkdirSync', 'openSync', 'renameSync', 'rmdirSync', 'rmSync', 'unlinkSync'] as const;
type EntryOp = (typeof ENTRY_OPS)[number];

/**
 * Runs `fn` with every `ENTRY_OPS` call routed through `around` — in every module: the builtin ESM bindings are re-synced,
 * so `import { renameSync } from 'node:fs'` sees the patch. Calls made while `around` runs go straight through.
 * `fsyncSync` becomes a no-op: it only matters for power loss, which no test can simulate, and costs ~80 ms per run.
 */
function interceptFs(around: (op: EntryOp, args: unknown[], call: () => unknown) => unknown, fn: () => void): void {
  const patchable = fs as unknown as Record<EntryOp | 'fsyncSync', (...args: unknown[]) => unknown>;
  const originals = (['fsyncSync', ...ENTRY_OPS] as const).map((op) => [op, patchable[op]] as const);
  let inside = false;
  patchable.fsyncSync = () => {};
  for (const op of ENTRY_OPS) {
    const original = patchable[op];
    patchable[op] = (...args) => {
      if (inside) return original(...args);
      inside = true;
      try {
        return around(op, args, () => original(...args));
      } finally {
        inside = false;
      }
    };
  }
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    for (const [op, original] of originals) patchable[op] = original;
    syncBuiltinESMExports();
  }
}

/** Previous-generation files a concurrent reader would miss right now, or find in neither the old nor the new version. */
function unreadable(planDir: string, committed: boolean): string[] {
  return Object.entries(gen1).flatMap(([rel, old]) => {
    const file = join(planDir, rel);
    if (!existsSync(file)) return committed && gen2.stale.includes(rel) ? [] : [`${rel} 없음`];
    const text = readFileSync(file, 'utf8');
    return text === old || text === gen2Files[rel] ? [] : [`${rel}: ${text}`];
  });
}

const isCommit = (planDir: string, op: EntryOp, args: unknown[]) => op === 'renameSync' && args[1] === join(planDir, 'plan.json');
const describeCall = (planDir: string, op: EntryOp, args: unknown[]) => `${op} ${relative(planDir, String(args[0]))}`;

describe('plan generation swap', () => {
  test('every previous file stays readable (old or new version) after every call, and a kill after any call recovers to exactly one generation', () => {
    const planDir = tempDir();
    put(planDir, gen1);
    const stageName = `staging-${process.pid}-p2`;
    const dead = deadPid();
    const gaps: string[] = [];
    const kills: { step: string; committed: boolean; dir: string }[] = [];
    let committed = false;
    interceptFs(
      (op, args, call) => {
        const result = call();
        committed ||= isCommit(planDir, op, args);
        const step = `#${kills.length + 1} ${describeCall(planDir, op, args)}`;
        for (const gap of unreadable(planDir, committed)) gaps.push(`${step}: ${gap}`);
        // Freeze the tree as a process killed right after this call leaves it; its staging now belongs to a dead pid.
        const dir = tempDir();
        cpSync(planDir, dir, { recursive: true });
        if (existsSync(join(dir, '.qa', stageName))) renameSync(join(dir, '.qa', stageName), join(dir, '.qa', `staging-${dead}-p2`));
        kills.push({ step, committed, dir });
        return result;
      },
      () => commitGeneration(planDir, 'p2', gen2, () => {}),
    );
    assert.deepEqual(gaps, []);
    assert.deepEqual(files(planDir), gen2Files);
    assert.ok(!existsSync(join(planDir, '.qa')));
    assert.ok(kills.some((k) => !k.committed) && kills.some((k) => k.committed));
    for (const { step, committed, dir } of kills) {
      recoverStaging(dir);
      assert.deepEqual(files(dir), committed ? gen2Files : gen1, `killed after ${step}`);
    }
  });

  test('a failure at any call up to the commit restores the previous generation: same bytes, same inodes, nothing left behind', () => {
    const counting = tempDir();
    put(counting, gen1);
    let calls = 0;
    let commitCall = 0;
    interceptFs(
      (op, args, call) => {
        calls++;
        if (isCommit(counting, op, args)) commitCall = calls;
        return call();
      },
      () => commitGeneration(counting, 'p2', gen2, () => {}),
    );
    assert.ok(commitCall > 0);

    for (let fail = 1; fail <= commitCall; fail++) {
      const planDir = tempDir();
      put(planDir, gen1);
      const before = inodes(planDir);
      const gaps: string[] = [];
      let call = 0;
      let failed = '';
      assert.throws(
        () =>
          interceptFs(
            (op, args, invoke) => {
              if (++call === fail) {
                failed = `#${fail} ${describeCall(planDir, op, args)}`;
                throw new Error('주입된 실패');
              }
              const result = invoke();
              for (const gap of unreadable(planDir, false)) gaps.push(`#${call} ${describeCall(planDir, op, args)}: ${gap}`);
              return result;
            },
            () => commitGeneration(planDir, 'p2', gen2, () => {}),
          ),
        /(\(기존 계획은 그대로\)|이전 계획으로 되돌렸습니다): 주입된 실패$/,
      );
      assert.deepEqual(gaps, [], `failed at ${failed}`);
      assert.deepEqual(files(planDir), gen1, `failed at ${failed}`);
      assert.deepEqual(inodes(planDir), before, `failed at ${failed}`);
    }
  });
});
