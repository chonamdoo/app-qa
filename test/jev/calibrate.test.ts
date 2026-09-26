import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrateClaim, calibrateCommit, calibrateGrounding, calibrateReview, type CalibrationSample, type ReviewKind } from '../../src/jev/calibrate.ts';

const criteria = { maxConfidentWrong: 0, minAcceptance: 0.8 };
const meta = (id: string) => ({ id, lang: 'ko' as const, tags: [] });
const claim = (id: string, p: number, expected: boolean): Extract<CalibrationSample, { kind: 'claim' }> => ({ kind: 'claim', p, expected, meta: meta(id) });
const commit = (id: string, p: number, expected: boolean): Extract<CalibrationSample, { kind: 'commit' }> => ({ kind: 'commit', p, expected, meta: meta(id) });

test('claim: a confidently-wrong false claim pushes `yes` above it, and the threshold sits midway between the classes', () => {
  const items = [claim('t1', 0.99, true), claim('t2', 0.95, true), claim('t3', 0.91, true), claim('f1', 0.85, false), claim('f2', 0.02, false)];
  const { gate, report } = calibrateClaim(items, criteria);
  assert.equal(report.confidentWrong, 0);
  assert.ok(gate.yes > 0.85 && gate.yes <= 0.91, `yes=${gate.yes}`);
  assert.equal(gate.yes, 0.89);
  assert.equal(report.items.find((i) => i.id === 'f1')?.outcome, 'rejected');
});

test('claim: with evidence only on one side, `no` stays at the conservative edge instead of the lenient grid end', () => {
  const items = [claim('t1', 0.97, true), claim('f1', 0.1, false), claim('f2', 0.03, false)];
  const { gate } = calibrateClaim(items, criteria);
  // Nothing constrains `no` from above inside [0.01, 0.49]: keep it right at the highest accepted false claim.
  assert.equal(gate.no, 0.1);
});

test('status is failed when acceptance misses the pre-registered 80%', () => {
  // Classes overlap: every threshold either errs confidently or leaves most items inconclusive.
  const items = [claim('t1', 0.6, true), claim('t2', 0.55, true), claim('f1', 0.62, false), claim('f2', 0.58, false), claim('t3', 0.99, true)];
  const { report } = calibrateClaim(items, criteria);
  assert.equal(report.confidentWrong, 0);
  assert.equal(report.status, 'failed');
  assert.ok(report.acceptance < 0.8);
});

const commitCriteria = { maxConfidentWrong: 0, maxFalseAlarmRate: 0.1 };
const safeLow = Array.from({ length: 10 }, (_, i) => commit(`low${i}`, 0.02 + i * 0.01, false));

test('commit: lowered to catch every residual commit while false alarms stay within 10%', () => {
  const r = calibrateCommit([commit('r1', 0.34, true), commit('r2', 0.8, true), ...safeLow], commitCriteria);
  assert.equal(r.report.status, 'calibrated');
  assert.equal(r.report.confidentWrong, 0);
  assert.ok(r.gate.risky > 0.11 && r.gate.risky <= 0.34, `risky=${r.gate.risky}`);
});

test('commit: if catching every residual commit costs more than 10% false alarms, the section fails (no fallback gate)', () => {
  const items = [commit('r1', 0.2, true), commit('s1', 0.3, false), commit('s2', 0.25, false), ...safeLow];
  const r = calibrateCommit(items, commitCriteria);
  assert.equal(r.report.status, 'failed');
  // The record keeps the measured threshold and what it cost, for the audit trail.
  assert.ok(r.gate.risky <= 0.2 && r.report.falseAlarmRate > 0.1, JSON.stringify({ gate: r.gate, far: r.report.falseAlarmRate }));
  assert.equal(r.report.confidentWrong, 0);
});

test('commit: the bar is never raised above 0.5 even when every risky item scores far higher', () => {
  const r = calibrateCommit([commit('r1', 0.95, true), commit('r2', 0.9, true), commit('s1', 0.7, false), ...safeLow], commitCriteria);
  assert.ok(r.gate.risky <= 0.5, `risky=${r.gate.risky}`);
  assert.equal(r.report.items.find((i) => i.id === 's1')?.outcome, 'rejected'); // a false alarm, never a miss
});

const review = (id: string, reviewKind: ReviewKind, addresses: number, unrelated: number, clarification: number): Extract<CalibrationSample, { kind: 'review' }> => ({
  kind: 'review',
  reviewKind,
  scores: { addresses, unrelated, clarification },
  meta: meta(id),
});
const reviewCriteria = { maxConfidentWrong: 0, minGoodApproval: 0.8 };

test('review: every defect kind is kept draft while good tests are approvable', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => review(`g${i}`, 'good', 0.85, 0.2, 0.2)),
    review('miss', 'missing_assertion', 0.3, 0.2, 0.2),
    review('extra', 'unrelated_steps', 0.8, 0.9, 0.2),
    review('wrong', 'wrong_requirement', 0.05, 0.9, 0.3),
    review('vague', 'vague_requirement', 0.7, 0.2, 0.8),
  ];
  const { gate, report } = calibrateReview(items, reviewCriteria);
  assert.equal(report.status, 'calibrated');
  assert.equal(report.confidentWrong, 0);
  assert.equal(report.goodApproved, 5);
  assert.ok(gate.addressesMin > 0.3 && gate.addressesMin <= 0.85 && gate.unrelatedMax < 0.9 && gate.clarificationMax < 0.8, JSON.stringify(gate));
});

test('review: a defect that looks exactly like a good test forces failed (planner keeps everything draft)', () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) => review(`g${i}`, 'good', 0.85, 0.2, 0.2)),
    review('lookalike', 'missing_assertion', 0.9, 0.1, 0.1),
  ];
  const { report } = calibrateReview(items, reviewCriteria);
  assert.equal(report.confidentWrong, 0);
  assert.equal(report.status, 'failed');
});

test('grounding: a confident pick on a duplicate (expected ambiguous) or an absent target is excluded by the pass gate', () => {
  const g = (id: string, probs: Record<string, number>, expected: Extract<CalibrationSample, { kind: 'grounding' }>['expected']) => ({
    kind: 'grounding' as const,
    probs,
    expected,
    meta: meta(id),
  });
  const items = [
    g('ok1', { e1: 1, e2: 0, none: 0 }, { kind: 'target', key: 'e1' }),
    g('ok2', { e1: 0.02, e2: 0.97, none: 0.01 }, { kind: 'target', key: 'e2' }),
    g('ok3', { e1: 0.99, e2: 0, none: 0.01 }, { kind: 'target', key: 'e1' }),
    g('dup', { e1: 0.9, e2: 0.1, none: 0 }, { kind: 'ambiguous', keys: ['e1', 'e2'] }),
    g('absent', { e1: 0.93, e2: 0.0, none: 0.07 }, { kind: 'none' }),
    g('gone', { e1: 0.05, e2: 0.05, none: 0.9 }, { kind: 'none' }),
  ];
  const { gate, report, nonStrict } = calibrateGrounding(items, criteria);
  assert.equal(report.confidentWrong, 0);
  assert.equal(nonStrict.confidentWrong, 0);
  // The absent target can at best be refused (ambiguous); not_found needs none on top.
  assert.equal(report.accepted, 5);
  assert.equal(report.items.find((i) => i.id === 'absent')?.outcome, 'rejected');
  assert.ok(gate.minGap > 0.8 || gate.minTop > 0.9, JSON.stringify(gate));
  assert.ok(gate.noneMin <= 0.9);
});
