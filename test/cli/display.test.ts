import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { clearDisplayState, displayStateCheck } from '../../src/cli/display.ts';
import { acquireDisplayLock, markDisplayUnknown, readDisplayUnknown } from '../../src/drivers/index.ts';

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-display-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const UNKNOWN = { since: '2026-09-26T05:00:00.000Z', reason: 'Chrome 창 종료를 확인하지 못함', runId: 'run-7' };

describe('display-unknown marker (qa doctor / qa setup --browsers)', () => {
  test('qa doctor fails while the marker exists, naming reason, since and how to clear it', () => {
    const dir = freshDir();
    assert.equal(displayStateCheck({ dir }).ok, true);
    markDisplayUnknown(UNKNOWN, { dir });
    const check = displayStateCheck({ dir });
    assert.equal(check.ok, false);
    for (const part of [UNKNOWN.reason, UNKNOWN.since, UNKNOWN.runId]) assert.ok(check.detail.includes(part), check.detail);
    assert.match(check.hint ?? '', /창.*닫은 뒤 `qa setup --browsers`/);
    assert.notEqual(readDisplayUnknown({ dir }), null, 'doctor is read-only');
  });

  test('qa setup --browsers clears the marker, says what it cleared and that it assumes the windows were closed', () => {
    const dir = freshDir();
    markDisplayUnknown(UNKNOWN, { dir });
    const check = clearDisplayState({ dir });
    assert.equal(check.ok, true);
    assert.ok(check.detail.includes(UNKNOWN.reason) && check.detail.includes(UNKNOWN.since), check.detail);
    assert.match(check.detail, /브라우저 창을 닫았다고 보고/);
    assert.equal(readDisplayUnknown({ dir }), null);
    assert.equal(displayStateCheck({ dir }).ok, true);
    assert.doesNotMatch(clearDisplayState({ dir }).detail, /지웠습니다/, 'nothing left to clear');
  });

  test('qa setup --browsers never clears while another qa process holds the display', () => {
    const dir = freshDir();
    markDisplayUnknown(UNKNOWN, { dir });
    const held = acquireDisplayLock({ dir });
    try {
      const check = clearDisplayState({ dir });
      assert.equal(check.ok, false);
      assert.match(check.detail, /지우지 않았습니다/);
      assert.notEqual(readDisplayUnknown({ dir }), null);
    } finally {
      held.release();
    }
    assert.equal(clearDisplayState({ dir }).ok, true);
    assert.equal(readDisplayUnknown({ dir }), null);
  });
});
