import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { FileLockedError } from '../../src/core/lock.ts';
import { PROCESS_STARTED_AT_MS, type ProcessProbe } from '../../src/core/process.ts';
import { acquirePlanLock, commitGeneration, nextCreatedAt, recoverStaging, type Generation } from '../../src/plan/commit.ts';
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
/** Staging directory of owner `pid` started at `startMs` (any start: a dead pid is dead whatever it recorded). */
const staging = (pid: number, startMs = 0, planId = 'x') => `.qa/staging-${pid}-${startMs}-${planId}`;

/** Recovery as `generatePlan` runs it: under the plan lock, released afterwards. */
function recover(planDir: string, probe?: ProcessProbe): string[] {
  const lock = acquirePlanLock(planDir, 'tteonam');
  try {
    return recoverStaging(lock, probe);
  } finally {
    lock.release();
  }
}

/** plan.json text of the generation created at `createdAt`. */
const planJson = (createdAt: string, label: string) => JSON.stringify({ createdAt, label });
const T1 = '2026-09-26T01:00:00.000Z';
const T2 = '2026-09-26T02:00:00.000Z';
const T3 = '2026-09-26T03:00:00.000Z';
const plan1 = planJson(T1, 'plan1');
const plan2 = planJson(T2, 'plan2');
/** Generation 2 (created T2) replaced generation 1 (created T1). */
const manifest = JSON.stringify({ base: T1, createdAt: T2, files: ['inline/a.e2e.yaml', 'inline/b.e2e.yaml', 'plan.json'], stale: ['inline/c.e2e.yaml'] });
/** Generation 1: plan1, a1, c1. Generation 2: plan2, a2, b2 (c is stale). */
const previous = { 'plan.json': plan1, 'inline/a.e2e.yaml': 'a1', 'inline/c.e2e.yaml': 'c1' };

describe('plan generation crash recovery', () => {
  test('a process that died mid-swap (before the plan.json commit) is rolled back to the previous generation', () => {
    const planDir = tempDir();
    const stage = staging(deadPid());
    put(planDir, {
      'plan.json': plan1,
      'inline/a.e2e.yaml': 'a2',
      'inline/b.e2e.yaml': 'b2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/old/plan.json`]: plan1,
      [`${stage}/new/plan.json`]: plan2,
      [`${stage}/manifest.json`]: manifest,
      [`${stage}/state`]: 'staged',
    });
    const notes = recover(planDir);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /되돌려 이전 계획을 복구했습니다/);
    assert.deepEqual(files(planDir), previous);
    assert.deepEqual(readdirSync(planDir).sort(), ['inline', 'plan.json'], 'staging directory and lock removed');
  });

  test('a rollback interrupted halfway finishes on the next recovery', () => {
    const planDir = tempDir();
    const stage = staging(deadPid());
    // plan.json and b already undone; a linked back to staging but its backup not yet renamed over it.
    put(planDir, {
      'plan.json': plan1,
      'inline/a.e2e.yaml': 'a2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/new/inline/a.e2e.yaml`]: 'a2',
      [`${stage}/new/inline/b.e2e.yaml`]: 'b2',
      [`${stage}/new/plan.json`]: plan2,
      [`${stage}/manifest.json`]: manifest,
      [`${stage}/state`]: 'rolling-back',
    });
    recover(planDir);
    assert.deepEqual(files(planDir), previous);
  });

  test('a rollback interrupted after the plan.json rename finishes on recovery; plan.json already being the new generation does not make it committed', () => {
    const planDir = tempDir();
    const stage = staging(deadPid());
    // The swap was complete (plan2, a2, b2) when a failed directory fsync started the rollback: plan.json was linked back
    // to staging and b (no backup) moved out, then the process died. plan2 references b, which is no longer published.
    put(planDir, {
      'plan.json': plan2,
      'inline/a.e2e.yaml': 'a2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/old/plan.json`]: plan1,
      [`${stage}/new/inline/b.e2e.yaml`]: 'b2',
      [`${stage}/new/plan.json`]: plan2,
      [`${stage}/manifest.json`]: manifest,
      [`${stage}/state`]: 'rolling-back',
    });
    assert.match(recover(planDir)[0]!, /되돌려 이전 계획을 복구했습니다/);
    assert.deepEqual(files(planDir), previous);
  });

  test('a process that died after the commit gets its stale files pruned; the new generation stays', () => {
    const planDir = tempDir();
    const stage = staging(deadPid());
    put(planDir, {
      'plan.json': plan2,
      'inline/a.e2e.yaml': 'a2',
      'inline/b.e2e.yaml': 'b2',
      'inline/c.e2e.yaml': 'c1',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/old/plan.json`]: plan1,
      [`${stage}/manifest.json`]: manifest,
      [`${stage}/state`]: 'committed',
      // A staged copy of plan.json left behind does not matter: the recorded state alone decides, and it says committed.
      [`${stage}/new/plan.json`]: plan2,
    });
    assert.match(recover(planDir)[0]!, /정리를 마쳤습니다/);
    assert.deepEqual(files(planDir), { 'plan.json': plan2, 'inline/a.e2e.yaml': 'a2', 'inline/b.e2e.yaml': 'b2' });
  });

  test('stagings of dead owners older than the committed plan are discarded without touching the newer files', () => {
    const planDir = tempDir();
    // Generation 3 (created T3) is committed and re-created c. Two dead generation-2 stagings remain: one died mid-swap
    // (its rollback would put a1/plan1 back), one after its commit (its prune would delete c).
    const newer = { 'plan.json': planJson(T3, 'plan3'), 'inline/a.e2e.yaml': 'a3', 'inline/b.e2e.yaml': 'b3', 'inline/c.e2e.yaml': 'c3' };
    const midSwap = staging(deadPid(), 0, 'mid');
    const committed = staging(deadPid(), 0, 'done');
    put(planDir, {
      ...newer,
      [`${midSwap}/old/inline/a.e2e.yaml`]: 'a1',
      [`${midSwap}/old/plan.json`]: plan1,
      [`${midSwap}/new/inline/b.e2e.yaml`]: 'b2',
      [`${midSwap}/new/plan.json`]: plan2,
      [`${midSwap}/manifest.json`]: manifest,
      [`${midSwap}/state`]: 'staged',
      [`${committed}/old/inline/a.e2e.yaml`]: 'a1',
      [`${committed}/manifest.json`]: manifest,
      [`${committed}/state`]: 'committed',
    });
    const before = inodes(planDir);
    const notes = recover(planDir);
    assert.equal(notes.length, 2);
    for (const note of notes) assert.match(note, /더 새 계획이 커밋되어 파일은 그대로 둡니다/);
    assert.deepEqual(files(planDir), newer);
    for (const rel of Object.keys(newer)) assert.equal(statSync(join(planDir, rel), { bigint: true }).ino, before.get(rel), rel);
  });

  test('owner liveness is pid + start time: a live owner is skipped, a reused pid and this process are recovered', () => {
    const planDir = tempDir();
    const liveStart = Date.parse('2026-09-26T00:00:00.000Z');
    const probe: ProcessProbe = (pid) => (pid === 4242 ? { alive: true, startedAtMs: liveStart } : { alive: false, startedAtMs: null });
    const live = { [`${staging(4242, liveStart, 'live')}/new/plan.json`]: plan2, [`${staging(4242, liveStart, 'live')}/manifest.json`]: manifest };
    put(planDir, { ...previous, ...live, [`${staging(4242, liveStart - 3_600_000, 'reused')}/new/inline/a.e2e.yaml`]: 'a2' });
    assert.deepEqual(recover(planDir, probe), [`중단된 계획 준비 파일을 지웠습니다 (교체 전): ${staging(4242, liveStart - 3_600_000, 'reused').slice(4)}`]);
    assert.deepEqual(files(planDir), { ...previous, ...live });

    // Under the plan lock a staging of this very process cannot be in progress: it is abandoned and rolled back.
    const own = tempDir();
    const stage = staging(process.pid, PROCESS_STARTED_AT_MS, 'own');
    put(own, {
      ...previous,
      'inline/a.e2e.yaml': 'a2',
      [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
      [`${stage}/new/plan.json`]: plan2,
      [`${stage}/manifest.json`]: manifest,
      [`${stage}/state`]: 'staged',
    });
    assert.match(recover(own, () => ({ alive: true, startedAtMs: PROCESS_STARTED_AT_MS }))[0]!, /되돌려 이전 계획을 복구했습니다/);
    assert.deepEqual(files(own), previous);
  });

  test('incomplete staging (no manifest) is deleted; corrupt manifests and a missing or unreadable state are never touched', () => {
    const planDir = tempDir();
    put(planDir, { ...previous, [`${staging(deadPid())}/new/inline/a.e2e.yaml`]: 'a2' });
    recover(planDir);
    assert.deepEqual(files(planDir), previous);

    const corrupt = tempDir();
    const corruptStage = staging(deadPid(), 0, 'z');
    put(corrupt, {
      ...previous,
      [`${corruptStage}/manifest.json`]: JSON.stringify({ base: T1, createdAt: T2, files: ['../../etc/passwd', 'plan.json'], stale: [] }),
      [`${corruptStage}/state`]: 'staged',
    });
    assert.throws(() => recover(corrupt), /계획 교체 기록이 손상되었습니다/);
    assert.equal(files(corrupt)['inline/a.e2e.yaml'], 'a1');

    // Mid-swap (a2 published, plan1 still committed) but the phase is unknown: neither rolled back nor pruned.
    for (const state of [undefined, '', 'commited', '{"state":"committed"}']) {
      const unknown = tempDir();
      const stage = staging(deadPid());
      const tree = {
        ...previous,
        'inline/a.e2e.yaml': 'a2',
        [`${stage}/old/inline/a.e2e.yaml`]: 'a1',
        [`${stage}/new/plan.json`]: plan2,
        [`${stage}/manifest.json`]: manifest,
        ...(state === undefined ? {} : { [`${stage}/state`]: state }),
      };
      put(unknown, tree);
      assert.throws(() => recover(unknown), /계획 교체 단계 기록이 없거나 손상되어 커밋 여부를 알 수 없습니다: .*직접 정리하세요/, `state ${state}`);
      assert.deepEqual(files(unknown), tree, `state ${state}`);
    }
  });
});

describe('plan lock', () => {
  test('a second holder fails fast while the first holds it; release frees it and removes the directories it created', () => {
    const root = tempDir();
    const planDir = join(root, 'tests', 'generated', 'tteonam');
    const first = acquirePlanLock(planDir, 'tteonam');
    assert.throws(
      () => acquirePlanLock(planDir, 'tteonam'),
      (err) => err instanceof FileLockedError && err.reason === 'held' && /^앱 tteonam의 계획 생성: 다른 qa 프로세스\(pid \d+, .+부터\)가 잠금을 갖고 있습니다\.$/.test(err.message),
    );
    first.release();
    assert.deepEqual(readdirSync(root), []);
    acquirePlanLock(planDir, 'tteonam').release();
  });

  test('generation createdAt strictly increases: a plan not newer than the committed one is refused before staging', () => {
    assert.equal(nextCreatedAt('2099-01-01T00:00:00.000Z', Date.parse(T1)), '2099-01-01T00:00:00.001Z');
    assert.equal(nextCreatedAt(T1, Date.parse(T2)), T2);
    const planDir = tempDir();
    put(planDir, previous);
    const before = inodes(planDir);
    const lock = acquirePlanLock(planDir, 'tteonam');
    try {
      assert.throws(() => commitGeneration(lock, 'p2', { tests: new Map([['inline/a.e2e.yaml', 'a2']]), plan: { createdAt: T1 }, stale: [] }, () => {}), /\(기존 계획은 그대로\): 새 계획의 createdAt/);
    } finally {
      lock.release();
    }
    assert.deepEqual(inodes(planDir), before);
    assert.deepEqual(files(planDir), previous);
  });
});

/** Generation 1 on disk; generation 2 replaces a and p, adds b and t (in a new directory), drops c. */
const gen1 = { 'plan.json': plan1, 'inline/a.e2e.yaml': 'a1', 'inline/c.e2e.yaml': 'c1', 'parking/p.e2e.yaml': 'p1' };
const gen2: Generation = {
  tests: new Map([
    ['inline/a.e2e.yaml', 'a2'],
    ['inline/b.e2e.yaml', 'b2'],
    ['parking/p.e2e.yaml', 'p2'],
    ['terms/t.e2e.yaml', 't2'],
  ]),
  plan: { createdAt: T2 },
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

/** The staging `commitGeneration(…, 'p2', …)` of this process uses. */
const STAGE = `staging-${process.pid}-${PROCESS_STARTED_AT_MS}-p2`;
/** The commit point: the `committed` state landing in the staging (checked after the call ran). */
const isCommit = (planDir: string, op: EntryOp, args: unknown[]) =>
  op === 'renameSync' && args[1] === join(planDir, '.qa', STAGE, 'state') && readFileSync(args[1], 'utf8') === 'committed';
const describeCall = (planDir: string, op: EntryOp, args: unknown[]) => `${op} ${relative(planDir, String(args[0]))}`;

/** A copy of `planDir` as a process killed right now leaves it: its staging and its plan lock belong to the dead pid `dead`. */
function frozen(planDir: string, dead: number): string {
  const dir = tempDir();
  cpSync(planDir, dir, { recursive: true });
  if (existsSync(join(dir, '.qa', STAGE))) renameSync(join(dir, '.qa', STAGE), join(dir, '.qa', `staging-${dead}-${PROCESS_STARTED_AT_MS}-p2`));
  writeFileSync(join(dir, '.qa', 'plan.lock'), JSON.stringify({ pid: dead, startedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(), acquiredAt: T1, token: 'killed' }));
  return dir;
}

describe('plan generation swap', () => {
  test('every previous file stays readable (old or new version) after every call, and a kill after any call recovers to exactly one generation', () => {
    const planDir = tempDir();
    put(planDir, gen1);
    const dead = deadPid();
    const gaps: string[] = [];
    const kills: { step: string; committed: boolean; dir: string }[] = [];
    let committed = false;
    const lock = acquirePlanLock(planDir, 'tteonam');
    interceptFs(
      (op, args, call) => {
        const result = call();
        committed ||= isCommit(planDir, op, args);
        const step = `#${kills.length + 1} ${describeCall(planDir, op, args)}`;
        for (const gap of unreadable(planDir, committed)) gaps.push(`${step}: ${gap}`);
        kills.push({ step, committed, dir: frozen(planDir, dead) });
        return result;
      },
      () => commitGeneration(lock, 'p2', gen2, () => {}),
    );
    lock.release();
    assert.deepEqual(gaps, []);
    assert.deepEqual(files(planDir), gen2Files);
    assert.ok(!existsSync(join(planDir, '.qa')));
    assert.ok(kills.some((k) => !k.committed) && kills.some((k) => k.committed));
    for (const { step, committed, dir } of kills) {
      recover(dir);
      assert.deepEqual(files(dir), committed ? gen2Files : gen1, `killed after ${step}`);
    }
  });

  test('a failure at any call up to the commit restores the previous generation (same bytes, same inodes, nothing left behind), and a kill at any call of that rollback recovers to it too', () => {
    const counting = tempDir();
    put(counting, gen1);
    let calls = 0;
    let commitCall = 0;
    const lock = acquirePlanLock(counting, 'tteonam');
    interceptFs(
      (op, args, call) => {
        calls++;
        const result = call();
        if (isCommit(counting, op, args)) commitCall = calls;
        return result;
      },
      () => commitGeneration(lock, 'p2', gen2, () => {}),
    );
    lock.release();
    assert.ok(commitCall > 0);

    const dead = deadPid();
    // Up to the directory fsync that makes the `committed` state durable (the call after its rename). This includes
    // failures after the plan.json rename, whose rollback starts from the new plan.json.
    for (let fail = 1; fail <= commitCall + 1; fail++) {
      const planDir = tempDir();
      put(planDir, gen1);
      const held = acquirePlanLock(planDir, 'tteonam');
      const before = inodes(planDir);
      const state = join(planDir, '.qa', STAGE, 'state');
      const gaps: string[] = [];
      let call = 0;
      let failed = '';
      const kills: { step: string; committed: boolean; dir: string }[] = [];
      try {
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
                // A kill during the undo that follows. Read-only opens (the fsyncs) leave nothing new to recover from.
                if (failed && !(op === 'openSync' && args[1] === 'r')) {
                  const committed = existsSync(state) && readFileSync(state, 'utf8') === 'committed';
                  kills.push({ step: `#${call} ${describeCall(planDir, op, args)}`, committed, dir: frozen(planDir, dead) });
                }
                return result;
              },
              () => commitGeneration(held, 'p2', gen2, () => {}),
            ),
          /(\(기존 계획은 그대로\)|이전 계획으로 되돌렸습니다): 주입된 실패$/,
        );
        assert.deepEqual(gaps, [], `failed at ${failed}`);
        assert.deepEqual(inodes(planDir), before, `failed at ${failed}`);
      } finally {
        held.release();
      }
      assert.deepEqual(files(planDir), gen1, `failed at ${failed}`);
      // Once `rolling-back` replaced the state, only the previous generation can come back; before that (a failure after
      // the `committed` rename landed) the swap is complete and recovery finishes that commit instead. Recovery runs
      // through `interceptFs` only to skip the fsyncs.
      interceptFs(
        (_op, _args, invoke) => invoke(),
        () => {
          for (const { step, committed, dir } of kills) {
            recover(dir);
            assert.deepEqual(files(dir), committed ? gen2Files : gen1, `failed at ${failed}, killed after ${step}`);
          }
        },
      );
    }
  });
});
