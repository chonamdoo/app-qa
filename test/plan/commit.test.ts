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

/** Every directory-entry mutation and durability barrier, including failures opening a directory for fsync. */
const ENTRY_OPS = ['fsyncSync', 'linkSync', 'mkdirSync', 'openSync', 'renameSync', 'rmdirSync', 'rmSync', 'unlinkSync'] as const;
type EntryOp = (typeof ENTRY_OPS)[number];

/**
 * Runs `fn` with every `ENTRY_OPS` call routed through `around` — in every module: the builtin ESM bindings are re-synced,
 * so `import { renameSync } from 'node:fs'` sees the patch. Calls made while `around` runs go straight through.
 * Successful fsyncs are simulated; injected failures still exercise the durability barriers.
 */
function interceptFs(around: (op: EntryOp, args: unknown[], call: () => unknown) => unknown, fn: () => void): void {
  const patchable = fs as unknown as Record<EntryOp, (...args: unknown[]) => unknown>;
  const originals = ENTRY_OPS.map((op) => [op, patchable[op]] as const);
  let inside = false;
  for (const op of ENTRY_OPS) {
    const original = op === 'fsyncSync' ? () => {} : patchable[op];
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
/** Read the transaction record, not syscall paths: durable writes may resolve OS-owned directory aliases. */
function recoversNew(planDir: string): boolean {
  const state = join(planDir, '.qa', STAGE, 'state');
  if (existsSync(state)) return readFileSync(state, 'utf8') === 'committed';
  return JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')).createdAt === T2;
}
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
  test('every previous file stays readable (old or new version) after every operation, and every crash recovers one complete generation', () => {
    interceptFs((_op, _args, invoke) => invoke(), () => {
      const planDir = tempDir();
      put(planDir, gen1);
      const dead = deadPid();
      const gaps: string[] = [];
      const kills: { step: string; committed: boolean; dir: string }[] = [];
      const lock = acquirePlanLock(planDir, 'tteonam');
      interceptFs(
        (op, args, invoke) => {
          const result = invoke();
          const committed = recoversNew(planDir);
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
  });

  test('failure at every publication or cleanup operation and crashes during its rollback preserve one complete recoverable generation', () => {
    interceptFs((_op, _args, invoke) => invoke(), () => {
      const counting = tempDir();
      put(counting, gen1);
      const points: { step: string; committed: boolean }[] = [];
      const lock = acquirePlanLock(counting, 'tteonam');
      interceptFs(
        (op, args, invoke) => {
          points.push({ step: describeCall(counting, op, args), committed: recoversNew(counting) });
          return invoke();
        },
        () => commitGeneration(lock, 'p2', gen2, () => {}),
      );
      lock.release();
      assert.ok(points.some((point) => point.committed) && points.some((point) => !point.committed));

      const dead = deadPid();
      for (const [fail, point] of points.entries()) {
        const planDir = tempDir();
        put(planDir, gen1);
        const held = acquirePlanLock(planDir, 'tteonam');
        const before = inodes(planDir);
        const gaps: string[] = [];
        const kills: { step: string; committed: boolean; dir: string }[] = [];
        let call = 0;
        let failed = false;
        try {
          assert.throws(() =>
            interceptFs(
              (op, args, invoke) => {
                if (call++ === fail) {
                  failed = true;
                  throw new Error('주입된 실패');
                }
                const result = invoke();
                const committed = recoversNew(planDir);
                const step = `#${call} ${describeCall(planDir, op, args)}`;
                for (const gap of unreadable(planDir, committed)) gaps.push(`${step}: ${gap}`);
                if (failed && op !== 'openSync' && op !== 'fsyncSync') {
                  kills.push({ step, committed, dir: frozen(planDir, dead) });
                }
                return result;
              },
              () => commitGeneration(held, 'p2', gen2, () => {}),
            ),
          );
          assert.ok(failed, `fault not reached: ${point.step}`);
          assert.deepEqual(gaps, [], `failed at ${point.step}`);
        } finally {
          held.release();
        }
        const committed = recoversNew(planDir);
        if (!point.committed) assert.equal(committed, false, `precommit failure: ${point.step}`);
        recover(planDir);
        assert.deepEqual(files(planDir), committed ? gen2Files : gen1, `failed at ${point.step}`);
        if (!committed) {
          for (const rel of Object.keys(gen1)) {
            assert.equal(statSync(join(planDir, rel), { bigint: true }).ino, before.get(rel), `failed at ${point.step}: ${rel}`);
          }
        }
        for (const { step, committed, dir } of kills) {
          recover(dir);
          assert.deepEqual(files(dir), committed ? gen2Files : gen1, `failed at ${point.step}, killed after ${step}`);
        }
      }
    });
  });

  test('a durability failure after publishing plan.json and the committed state rolls back without losing old files', () => {
    interceptFs((_op, _args, invoke) => invoke(), () => {
      const planDir = tempDir();
      put(planDir, gen1);
      const held = acquirePlanLock(planDir, 'tteonam');
      const before = inodes(planDir);
      let failed = false;
      let published: string | undefined;
      try {
        assert.throws(() =>
          interceptFs(
            (op, _args, invoke) => {
              if (!failed && op === 'fsyncSync' && recoversNew(planDir)) {
                failed = true;
                published = readFileSync(join(planDir, 'plan.json'), 'utf8');
                throw new Error('커밋 내구성 실패');
              }
              return invoke();
            },
            () => commitGeneration(held, 'p2', gen2, () => {}),
          ),
        );
        assert.ok(failed);
        assert.equal(published, gen2Files['plan.json']);
        assert.deepEqual(inodes(planDir), before);
      } finally {
        held.release();
      }
      assert.deepEqual(files(planDir), gen1);
    });
  });

  test('cleanup retains the committed recovery record until stale test deletion is durable, and recovery never rolls it back', () => {
    interceptFs((_op, _args, invoke) => invoke(), () => {
      const planDir = tempDir();
      const retired = 'retired/c.e2e.yaml';
      const generation = { ...gen2, stale: [...gen2.stale, retired] };
      put(planDir, { ...gen1, [retired]: 'c1' });
      const parent = statSync(planDir, { bigint: true });
      const held = acquirePlanLock(planDir, 'tteonam');
      let failed = false;
      let retained = false;
      let committed = false;
      try {
        assert.throws(() =>
          interceptFs(
            (op, args, invoke) => {
              const syncing = op === 'fsyncSync' ? fs.fstatSync(args[0] as number, { bigint: true }) : undefined;
              if (!failed && syncing !== undefined && syncing.dev === parent.dev && syncing.ino === parent.ino && !existsSync(join(planDir, 'retired'))) {
                failed = true;
                retained = existsSync(join(planDir, '.qa', STAGE, 'manifest.json'));
                committed = recoversNew(planDir);
                throw new Error('정리 내구성 실패');
              }
              return invoke();
            },
            () => commitGeneration(held, 'p2', generation, () => {}),
          ),
        );
        assert.ok(failed);
        assert.ok(retained, 'prune is not durable yet');
        assert.ok(committed);
        for (const [rel, text] of Object.entries(gen2Files)) assert.equal(readFileSync(join(planDir, rel), 'utf8'), text);
      } finally {
        held.release();
      }
      recover(planDir);
      assert.deepEqual(files(planDir), gen2Files);
    });
  });
});
