import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { recoverStaging } from '../../src/plan/commit.ts';
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
    // plan.json and b already undone; a moved back to staging but its backup not yet restored.
    put(planDir, {
      'plan.json': 'plan1',
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
