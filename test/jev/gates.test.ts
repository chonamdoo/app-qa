import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JevError } from '../../src/jev/config.ts';
import { gateClaim, gateGrounding, gateWhich, loadCalibration, usableGate, type GroundingGate } from '../../src/jev/gates.ts';
import { testCalibration } from './_helpers.ts';

const G: GroundingGate = { minTop: 0.7, minGap: 0.3, maxNone: 0.1, noneMin: 0.6, rescueGap: 0.5 };

test('grounding passes exactly at minTop / minGap / maxNone and not a hair below', () => {
  // All three exactly on their thresholds (gap 0.7 − 0.4 is 0.29999999999999993 in floats).
  assert.equal(gateGrounding({ e1: 0.7, e2: 0.4, none: 0.1 }, { ...G, maxNone: 0.1 }, true).verdict, 'pass');
  assert.equal(gateGrounding({ e1: 0.69, e2: 0.2, none: 0.1 }, G, true).verdict, 'ambiguous');
  assert.equal(gateGrounding({ e1: 0.7, e2: 0.41, none: 0.1 }, G, true).verdict, 'ambiguous');
  assert.equal(gateGrounding({ e1: 0.85, e2: 0.04, none: 0.11 }, G, true).verdict, 'ambiguous');
  const pass = gateGrounding({ e1: 0.05, e2: 0.9, none: 0.05 }, G, true);
  assert.deepEqual([pass.verdict, pass.key], ['pass', 'e2']);
});

test('grounding gap is measured against the stronger of the runner-up and none', () => {
  // e1 − e2 = 0.8 but e1 − none = 0.1 → not clear.
  assert.equal(gateGrounding({ e1: 0.5, e2: 0.0, none: 0.4 }, { ...G, minTop: 0.4, maxNone: 0.5 }, true).verdict, 'ambiguous');
});

test('not_found needs none strictly on top and at least noneMin; a tie with a candidate is ambiguous', () => {
  assert.equal(gateGrounding({ e1: 0.4, none: 0.6 }, G, true).verdict, 'not_found');
  assert.equal(gateGrounding({ e1: 0.41, e2: 0.0, none: 0.59 }, G, true).verdict, 'ambiguous');
  assert.equal(gateGrounding({ e1: 0.5, none: 0.5 }, G, true).verdict, 'ambiguous');
  // A large none mass that is not on top is ambiguous, never not_found.
  assert.equal(gateGrounding({ e1: 0.55, none: 0.45 }, G, true).verdict, 'ambiguous');
});

test('the gap rescue passes a clear-but-low top only in non-strict mode', () => {
  const probs = { e1: 0.6, e2: 0.05, e3: 0.05, none: 0.05, e4: 0.25 };
  // top 0.6 < 0.7, gap 0.35 < rescue 0.5 → ambiguous either way.
  assert.equal(gateGrounding(probs, G, false).verdict, 'ambiguous');
  const clear = { e1: 0.65, e2: 0.1, e3: 0.1, e4: 0.1, none: 0.05 };
  const lax = gateGrounding(clear, { ...G, rescueGap: 0.55 }, false);
  assert.equal(lax.verdict, 'pass');
  assert.equal(lax.rescued, true);
  assert.equal(gateGrounding(clear, { ...G, rescueGap: 0.55 }, true).verdict, 'ambiguous');
  assert.equal(gateGrounding(clear, { ...G, rescueGap: null }, false).verdict, 'ambiguous');
});

test('which: pass on a clear option, none only when none leads and reaches noneMin', () => {
  const W = { minTop: 0.7, minGap: 0.3, noneMin: 0.6 };
  const pass = gateWhich({ s0: 0.9, s1: 0.05, none: 0.05 }, W);
  assert.deepEqual([pass.verdict, pass.key], ['pass', 's0']);
  assert.equal(gateWhich({ s0: 0.2, s1: 0.1, none: 0.7 }, W).verdict, 'none');
  assert.equal(gateWhich({ s0: 0.3, s1: 0.2, none: 0.5 }, W).verdict, 'ambiguous');
  assert.equal(gateWhich({ s0: 0.6, s1: 0.35, none: 0.05 }, W).verdict, 'ambiguous');
});

test('claim band: ≥ yes pass, ≤ no fail, strictly between inconclusive', () => {
  const C = { yes: 0.9, no: 0.1 };
  assert.equal(gateClaim(0.9, C), 'pass');
  assert.equal(gateClaim(0.89, C), 'inconclusive');
  assert.equal(gateClaim(0.11, C), 'inconclusive');
  assert.equal(gateClaim(0.1, C), 'fail');
});

test('usableGate refuses missing records, other models/versions and primitives that failed criteria', () => {
  const cal = testCalibration();
  assert.equal(usableGate(null, 'jev-1.13.0', 'grounding').reason, 'uncalibrated');
  assert.match(usableGate(cal, 'jev-1.14.0', 'claim').reason ?? '', /^uncalibrated/);
  assert.match(usableGate({ ...cal, questionVersion: 'q-v0' }, 'jev-1.13.0', 'claim').reason ?? '', /^uncalibrated/);
  const failed = { ...cal, which: { ...cal.which, status: 'failed' as const } };
  assert.match(usableGate(failed, 'jev-1.13.0', 'which').reason ?? '', /^uncalibrated/);
  assert.deepEqual(usableGate(failed, 'jev-1.13.0', 'claim').gate, cal.claim.gate);
});

const dir = mkdtempSync(join(tmpdir(), 'jev-cal-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('loadCalibration: null when absent, parsed when valid, error when corrupt or misfiled', () => {
  assert.equal(loadCalibration('jev-1.13.0', 'q-v1', dir), null);
  mkdirSync(join(dir, 'jev-1.13.0'), { recursive: true });
  const file = join(dir, 'jev-1.13.0', 'q-v1.json');
  writeFileSync(file, JSON.stringify(testCalibration()));
  assert.deepEqual(loadCalibration('jev-1.13.0', 'q-v1', dir), testCalibration());
  writeFileSync(file, JSON.stringify({ ...testCalibration(), claim: { status: 'calibrated', gate: { yes: 0.2, no: 0.8 }, evidence: {} } }));
  assert.throws(() => loadCalibration('jev-1.13.0', 'q-v1', dir), (e: unknown) => e instanceof JevError && e.kind === 'config');
  writeFileSync(file, JSON.stringify({ ...testCalibration(), model: 'jev-1.12.0' }));
  assert.throws(() => loadCalibration('jev-1.13.0', 'q-v1', dir), (e: unknown) => e instanceof JevError && e.kind === 'config');
  writeFileSync(file, '{not json');
  assert.throws(() => loadCalibration('jev-1.13.0', 'q-v1', dir), (e: unknown) => e instanceof JevError && e.kind === 'config');
});
