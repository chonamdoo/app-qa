// Replays the recorded live calibration run (test/jev/recordings) through the runtime decision functions.
// Guards the invariant that runtime requests are byte-identical to the calibrated ones (same digest → recording hit)
// and that the committed thresholds reproduce the recorded verdicts. A change to question wording, row format or the
// golden set shows up here as a replay miss or a verdict drift → recalibrate.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import type { ScreenModel } from '../../src/core/types.ts';
import { normLabel } from '../../src/observe/index.ts';
import { loadFixtureModel, loadGolden, runCalibration } from '../../src/jev/calibrate.ts';
import { JevClient } from '../../src/jev/client.ts';
import { loadJevConfig } from '../../src/jev/config.ts';
import { groundChoice, judgeClaim, judgeCommit, judgeWhich, reviewGenerated } from '../../src/jev/decide.ts';
import { loadCalibration, type Calibration } from '../../src/jev/gates.ts';

const recordings = join(PATHS.root, 'test', 'jev', 'recordings');
const goldenDir = join(PATHS.calibration, 'golden');
const calibration = loadCalibration('jev-1.13.0', 'q-v1');
const client = new JevClient(loadJevConfig({}, { mode: 'replay', recordingsDir: recordings }));
const golden = Object.fromEntries(loadGolden(goldenDir).map((g) => [g.data.primitive, g.data]));

const models = new Map<string, ScreenModel>();
function screen(name: string, patch?: { from: string; to: string }[]): ScreenModel {
  const key = `${name}|${JSON.stringify(patch ?? [])}`;
  if (!models.has(key)) models.set(key, loadFixtureModel(PATHS.fixtures, name, patch));
  return models.get(key)!;
}

type Primitive = 'grounding' | 'claim' | 'which' | 'commit' | 'review';
const ALL: readonly Primitive[] = ['grounding', 'claim', 'which', 'commit', 'review'];

function recorded(cal: Calibration, primitive: Primitive): Map<string, string> {
  const items = cal[primitive].evidence.items as { id: string; verdict: string }[];
  return new Map(items.map((i) => [i.id, i.verdict]));
}

test('the committed calibration record exists, no primitive failed and none has a confident-wrong item', () => {
  assert.ok(calibration, 'calibration/jev-1.13.0/q-v1.json missing');
  for (const p of ALL) {
    assert.notEqual(calibration[p].status, 'failed', p);
    assert.equal(calibration[p].evidence.confidentWrong, 0, p);
  }
  // Commit was calibrated only on targets the deterministic risk policy lets through.
  assert.deepEqual(calibration.commit.evidence.covered, []);
});

test('runtime grounding (strict) reproduces every recorded golden verdict, Korean intents included', async () => {
  const want = recorded(calibration!, 'grounding');
  const g = golden.grounding!;
  assert.equal(g.primitive, 'grounding');
  if (g.primitive !== 'grounding') return;
  for (const item of g.items) {
    const m = screen(item.screen, item.patch);
    const d = await groundChoice(client, m.candidates, item.intent, { texts: m.texts, calibration, strict: true });
    const got = d.verdict === 'pass' ? `pass:${d.candidate?.key}` : d.verdict;
    assert.equal(got, want.get(item.id), `${item.id} ${item.intent}: ${d.reason}`);
  }
});

test('runtime claim, which and commit reproduce every recorded golden verdict', async () => {
  const claims = golden.claim!;
  const claimWant = recorded(calibration!, 'claim');
  if (claims.primitive === 'claim') {
    for (const item of claims.items) {
      const m = screen(item.screen, item.patch);
      const d = await judgeClaim(client, m.candidates, item.claim, { texts: m.texts, calibration });
      assert.equal(d.verdict, claimWant.get(item.id), `${item.id}: ${d.reason}`);
    }
  }
  const which = golden.which!;
  const whichWant = recorded(calibration!, 'which');
  if (which.primitive === 'which') {
    for (const item of which.items) {
      const m = screen(item.screen, item.patch);
      const d = await judgeWhich(client, m.candidates, item.options, { texts: m.texts, calibration });
      const expectedVerdict = whichWant.get(item.id)!;
      assert.equal(d.verdict, expectedVerdict.startsWith('pass:') ? 'pass' : expectedVerdict, `${item.id}: ${d.reason}`);
      if (d.verdict === 'pass') assert.equal(d.option, item.options[Number(expectedVerdict.slice('pass:s'.length))]);
    }
  }
  const commit = golden.commit!;
  const commitWant = recorded(calibration!, 'commit');
  if (commit.primitive === 'commit') {
    for (const item of commit.items) {
      const m = screen(item.screen, item.patch);
      const target = m.candidates.find((c) => typeof item.target === 'string' && normLabel(c.name) === normLabel(item.target));
      assert.ok(target, item.id);
      const d = await judgeCommit(client, m.candidates, target, { texts: m.texts, calibration });
      assert.notEqual(d.verdict, 'error', `${item.id}: ${d.reason}`);
      assert.equal(d.verdict === 'pass' ? 'risky' : 'safe', commitWant.get(item.id), `${item.id}: ${d.reason}`);
    }
  }
});

test('runtime review reproduces every recorded golden verdict (defective tests stay draft)', async () => {
  const review = golden.review!;
  const want = recorded(calibration!, 'review');
  assert.equal(review.primitive, 'review');
  if (review.primitive !== 'review') return;
  for (const item of review.items) {
    const d = await reviewGenerated(client, { requirement: item.requirement, test: item.test }, { calibration });
    assert.equal(d.verdict, want.get(item.id), `${item.id}: ${d.reason}`);
    if (item.kind !== 'good') assert.equal(d.verdict, 'draft', item.id);
  }
});

const tmp = mkdtempSync(join(tmpdir(), 'jev-recal-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('re-running the calibration from the recordings reproduces the committed thresholds and evidence', async () => {
  const out = join(tmp, 'q-v1.json');
  // A reader holding the previous record keeps seeing it whole: the new record replaces it by rename, never in place.
  const previous = '{"previous": true}\n';
  writeFileSync(out, previous);
  const reader = openSync(out, 'r');
  try {
    await runCalibration({ client, goldenDir, out });
    assert.equal(readFileSync(reader, 'utf8'), previous);
  } finally {
    closeSync(reader);
  }
  assert.deepEqual(readdirSync(tmp), ['q-v1.json'], 'no temp file left next to the record');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const fresh = JSON.parse(readFileSync(out, 'utf8')) as Calibration;
  const committed = calibration!;
  assert.deepEqual(fresh.golden, committed.golden, 'golden files changed since calibration');
  for (const p of ALL) {
    assert.deepEqual(fresh[p].gate, committed[p].gate, p);
    assert.deepEqual(fresh[p].evidence, committed[p].evidence, p);
  }
});
