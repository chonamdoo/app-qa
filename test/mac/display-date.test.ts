import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('native local timestamp presentation', { skip: process.platform !== 'darwin' }, () => {
  let scratch: string | undefined;
  let executable: string;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'qautra-display-date-'));
    executable = join(scratch, 'dates');
    const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '6', '-strict-concurrency=complete', '-O',
      fileURLToPath(new URL('../../mac/Sources/QAutra/Model/DisplayDate.swift', import.meta.url)),
      fileURLToPath(new URL('./fixtures/DisplayDateFixture.swift', import.meta.url)), '-o', executable],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  after(() => { if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true }); });
  function format(timeZone: string, values: (string | null)[], missing?: string): string[] {
    const result = spawnSync(executable, [], { input: JSON.stringify({ timeZone, values, missing }), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }
  function calendar(text: string): number[] {
    const parts = [...text.matchAll(/\d+/g)].slice(0, 6).map(([value]) => Number(value));
    assert.equal(parts.length, 6, text);
    return parts;
  }
  it('uses the selected local calendar and crosses midnight into the next year', () => {
    const values = format('Asia/Seoul', ['2026-10-31T02:15:43.856Z', '2026-12-31T15:00:00Z']);
    assert.deepEqual(values.map(calendar), [[2026, 10, 31, 11, 15, 43], [2027, 1, 1, 0, 0, 0]]);
    assert.ok(values.every((value) => value.includes('Asia/Seoul') && value.includes('+09:00')));
  });
  it('treats fractional, whole-second and explicit-offset timestamps as the same displayed instant', () => {
    const values = format('Asia/Seoul', ['2026-10-31T02:15:43Z', '2026-10-31T11:15:43.856+09:00', '2026-10-31T11:15:43+09:00']);
    assert.equal(new Set(values).size, 1);
    assert.deepEqual(calendar(values[0]!), [2026, 10, 31, 11, 15, 43]);
  });
  it('distinguishes daylight-saving gaps and repeated local times using the actual offset', () => {
    const [before, after, first, repeated] = format('America/Los_Angeles', [
      '2026-03-08T09:59:59.999Z', '2026-03-08T10:00:00Z',
      '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z',
    ]);
    assert.deepEqual([before, after].map((value) => calendar(value!)), [[2026, 3, 8, 1, 59, 59], [2026, 3, 8, 3, 0, 0]]);
    assert.deepEqual(calendar(first!), [2026, 11, 1, 1, 30, 0]);
    assert.deepEqual(calendar(first!), calendar(repeated!));
    assert.ok(before!.includes('-08:00') && after!.includes('-07:00'));
    assert.ok(first!.includes('-07:00') && repeated!.includes('-08:00'));
    assert.notEqual(first, repeated);
  });
  it('marks malformed source values as unavailable while preserving their provenance', () => {
    const values = ['not-a-date', '', '2026-10-31T02-15-22-446Z-bb329a'];
    const unavailable = 'unavailable-source';
    const rendered = format('Asia/Seoul', values, unavailable);
    assert.equal(rendered.length, values.length);
    for (const [i, value] of rendered.entries()) {
      assert.ok(value.includes(unavailable));
      assert.ok(value.includes(values[i]!));
      assert.notEqual(value, values[i]);
    }
    assert.deepEqual(format('Asia/Seoul', [null], unavailable), [unavailable]);
  });
});
