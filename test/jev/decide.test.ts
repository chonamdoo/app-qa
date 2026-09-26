import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candidate } from '../../src/core/types.ts';
import { JevClient } from '../../src/jev/client.ts';
import { claimRequest, commitRequest, groundChoice, groundingRequest, judgeClaim, judgeCommit, judgeWhich, reviewGenerated, reviewRequest, whichRequest } from '../../src/jev/decide.ts';
import { createRedactor } from '../../src/jev/redact.ts';
import { body, choiceAnswer, scriptedFetch, testCalibration, testConfig } from './_helpers.ts';

function cand(key: string, name: string, role: Candidate['role'] = 'button', value: string | null = null): Candidate {
  return {
    key,
    nodeId: key,
    role,
    name,
    value,
    state: [],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    tapPoint: { x: 50, y: 20 },
    actionable: true,
    region: 'bottom',
    source: 'tree',
  };
}

const cands = [cand('e1', '닫기'), cand('e2', '항공편 바꾸기'), cand('e3', '내 항공편 지우기')];
const texts = ['내 항공편', 'EY827'];
const noSleep = async () => {};

function clientFor(answers: Record<string, unknown>) {
  const stub = scriptedFetch([{ status: 200, body: body(answers), headers: { 'x-typesafe-request-id': 'req-9' } }]);
  return { client: new JevClient(testConfig(), { fetchImpl: stub.fetchImpl, sleep: noSleep }), calls: stub.calls };
}

test('without a calibration record every primitive errors as uncalibrated and never calls Jev', async () => {
  const { client, calls } = clientFor({});
  const opts = { texts, calibration: null };
  const g = await groundChoice(client, cands, '닫기 버튼', opts);
  assert.deepEqual([g.verdict, g.reason, g.candidate, g.receipt], ['error', 'uncalibrated', null, null]);
  assert.equal((await judgeClaim(client, cands, '시트가 열려 있다', opts)).verdict, 'error');
  assert.equal((await judgeWhich(client, cands, ['홈', '시트'], opts)).verdict, 'error');
  assert.equal((await judgeCommit(client, cands, cands[2]!, opts)).verdict, 'error');
  const r = await reviewGenerated(client, { requirement: { id: 'r1', text: '항공편을 지울 수 있다' }, test: {} }, { calibration: null });
  assert.deepEqual([r.verdict, r.review.issues], ['error', ['uncalibrated']]);
  assert.equal(calls.length, 0);
});

test('a primitive whose calibration failed stays fail-closed while calibrated ones still work', async () => {
  const cal = testCalibration();
  cal.grounding.status = 'failed';
  const { client, calls } = clientFor({ claim: { type: 'noul', noul: 0.95 } });
  const g = await groundChoice(client, cands, '닫기', { texts, calibration: cal });
  assert.equal(g.verdict, 'error');
  assert.match(g.reason, /^uncalibrated/);
  const c = await judgeClaim(client, cands, '시트가 열려 있다', { texts, calibration: cal });
  assert.equal(c.verdict, 'pass');
  assert.equal(calls.length, 1);
});

test('a calibration for another model is not used', async () => {
  const cal = { ...testCalibration(), model: 'jev-1.12.0' };
  const { client, calls } = clientFor({});
  assert.match((await judgeClaim(client, cands, 'x', { texts, calibration: cal })).reason, /^uncalibrated/);
  assert.equal(calls.length, 0);
});

test('grounding pass returns the chosen candidate, its probabilities and the receipt', async () => {
  const { client } = clientFor({ target: choiceAnswer({ e1: 0.01, e2: 0.02, e3: 0.96, none: 0.01 }) });
  const g = await groundChoice(client, cands, '등록한 항공편 삭제', { texts, calibration: testCalibration() });
  assert.equal(g.verdict, 'pass');
  assert.equal(g.candidate?.name, '내 항공편 지우기');
  assert.equal(g.decisionSource, 'jev');
  assert.equal(g.probabilities?.e3, 0.96);
  assert.equal(g.receipt?.requestId, 'req-9');
  assert.equal(g.receipt?.questionVersion, 'q-v1');
});

test('grounding not_found and ambiguous never carry a candidate', async () => {
  const miss = clientFor({ target: choiceAnswer({ e1: 0.05, e2: 0.05, e3: 0.05, none: 0.85 }) });
  const nf = await groundChoice(miss.client, cands, '로그인 버튼', { texts, calibration: testCalibration() });
  assert.deepEqual([nf.verdict, nf.candidate], ['not_found', null]);
  const split = clientFor({ target: choiceAnswer({ e1: 0.0, e2: 0.5, e3: 0.46, none: 0.04 }) });
  const amb = await groundChoice(split.client, cands, '항공편 버튼', { texts, calibration: testCalibration() });
  assert.deepEqual([amb.verdict, amb.candidate], ['ambiguous', null]);
});

test('strict grounding (see) refuses the gap rescue that tap accepts', async () => {
  const answers = { target: choiceAnswer({ e1: 0.65, e2: 0.1, e3: 0.1, none: 0.15 }) };
  const cal = testCalibration();
  cal.grounding.gate = { minTop: 0.7, minGap: 0.3, maxNone: 0.2, noneMin: 0.6, rescueGap: 0.5 };
  assert.equal((await groundChoice(clientFor(answers).client, cands, '닫기', { texts, calibration: cal })).verdict, 'pass');
  assert.equal((await groundChoice(clientFor(answers).client, cands, '닫기', { texts, calibration: cal, strict: true })).verdict, 'ambiguous');
});

test('an API failure becomes verdict error with the failing receipt, not a guess', async () => {
  const stub = scriptedFetch([{ status: 422, body: { detail: [] } }]);
  const client = new JevClient(testConfig(), { fetchImpl: stub.fetchImpl, sleep: noSleep });
  const g = await groundChoice(client, cands, '닫기', { texts, calibration: testCalibration() });
  assert.equal(g.verdict, 'error');
  assert.equal(g.candidate, null);
  assert.match(g.reason, /^jev_http/);
  assert.match(g.receipt?.error ?? '', /422/);
});

test('redaction masks app-profile patterns and built-in PII in rows, texts and intent before sending', async () => {
  const { client, calls } = clientFor({ target: choiceAnswer({ e1: 0.97, e2: 0.01, e3: 0.01, none: 0.01 }) });
  const withPii = [cand('e1', '예약번호 ABC123 확인'), cand('e2', 'user@example.com'), cand('e3', '010-1234-5678로 전화')];
  await groundChoice(client, withPii, '예약번호 ABC123 확인 버튼', {
    texts: ['카드 1234-5678-9012-3456', '주민번호 900101-1234567'],
    redact: createRedactor(['[A-Z]{3}\\d{3}']),
    calibration: testCalibration(),
  });
  const sent = calls[0]!.body;
  for (const secret of ['ABC123', 'user@example.com', '010-1234-5678', '1234-5678-9012-3456', '900101-1234567']) {
    assert.equal(sent.includes(secret), false, `${secret} leaked`);
  }
  assert.match(sent, /예약번호 \[REDACTED\] 확인/);
  // No coordinates ever reach Jev.
  assert.doesNotMatch(sent, /tapPoint|"rect"|"x":/);
});

test('a secret containing `|` is redacted in its raw field, before the row format rewrites `|` to `¦`', () => {
  const SECRET = 'demo|private-token';
  const redact = createRedactor(['demo\\|private-token']);
  const leaky = { ...cand('e4', `토큰 ${SECRET}`, 'input', SECRET), state: ['focused', SECRET] };
  const pool = [...cands, leaky];
  const shown = [`토큰: ${SECRET}`];
  const requests = {
    grounding: groundingRequest(pool, '토큰 입력란', shown, redact),
    claim: claimRequest(pool, '토큰이 보인다', shown, redact),
    which: whichRequest(pool, ['홈', '토큰 화면'], shown, redact),
    commit: commitRequest(pool, leaky, shown, redact),
    review: reviewRequest({ requirement: { id: 'r1', text: `토큰 ${SECRET}` }, test: { steps: [{ type: SECRET, into: leaky.name }] } }, redact),
  };
  for (const [name, req] of Object.entries(requests)) {
    const sent = JSON.stringify(req);
    for (const form of [SECRET, 'demo¦private-token']) assert.equal(sent.includes(form), false, `${name} request leaks ${form}`);
  }
  assert.equal(requests.commit.state.target, 'e4 | input | 토큰 [REDACTED] | value="[REDACTED]", focused, [REDACTED] | bottom');
});

test('which maps the winning s-key back to the option text; none means loading / none of these', async () => {
  const options = ['홈 화면', '내 항공편 시트'];
  const hit = await judgeWhich(clientFor({ screen: choiceAnswer({ s0: 0.05, s1: 0.93, none: 0.02 }) }).client, cands, options, { texts, calibration: testCalibration() });
  assert.deepEqual([hit.verdict, hit.option], ['pass', '내 항공편 시트']);
  const none = await judgeWhich(clientFor({ screen: choiceAnswer({ s0: 0.1, s1: 0.1, none: 0.8 }) }).client, cands, options, { texts, calibration: testCalibration() });
  assert.deepEqual([none.verdict, none.option], ['none', null]);
});

test('commit: at or above the calibrated bar is risky (pass), below is not', async () => {
  const cal = testCalibration();
  cal.commit.gate = { risky: 0.47 };
  const at = await judgeCommit(clientFor({ commits: { type: 'noul', noul: 0.47 } }).client, cands, cands[2]!, { texts, calibration: cal });
  assert.deepEqual([at.verdict, at.pYes], ['pass', 0.47]);
  const below = await judgeCommit(clientFor({ commits: { type: 'noul', noul: 0.46 } }).client, cands, cands[0]!, { texts, calibration: cal });
  assert.equal(below.verdict, 'fail');
});

test('commit: a section that missed its criteria is an error without calling Jev (the check is unavailable)', async () => {
  const cal = testCalibration();
  cal.commit.status = 'failed';
  const { client, calls } = clientFor({ commits: { type: 'noul', noul: 0.9 } });
  const d = await judgeCommit(client, cands, cands[2]!, { texts, calibration: cal });
  assert.deepEqual([d.verdict, d.pYes, d.receipt], ['error', null, null]);
  assert.match(d.reason, /uncalibrated: commit/);
  assert.equal(calls.length, 0);
});

test('review: a failed review calibration keeps every test out of approvable without calling Jev', async () => {
  const cal = testCalibration();
  cal.review.status = 'failed';
  const { client, calls } = clientFor({});
  const r = await reviewGenerated(client, { requirement: { id: 'r', text: 'x' }, test: {} }, { calibration: cal });
  assert.equal(r.verdict, 'error');
  assert.match(r.review.issues[0] ?? '', /^uncalibrated/);
  assert.equal(calls.length, 0);
});

test('review: all three Nouls inside the gate → approvable; any outside → draft with issues', async () => {
  const input = { requirement: { id: 'doc#flight', text: '내 항공편을 지울 수 있다' }, test: { name: 't', steps: [{ tap: '내 항공편 지우기' }] } };
  const ok = await reviewGenerated(
    clientFor({ addresses_requirement: { type: 'noul', noul: 0.9 }, unrelated_steps: { type: 'noul', noul: 0.1 }, needs_clarification: { type: 'noul', noul: 0.2 } }).client,
    input,
    { calibration: testCalibration() },
  );
  assert.equal(ok.verdict, 'approvable');
  assert.deepEqual(ok.review, { addressesRequirement: 0.9, unrelatedSteps: 0.1, needsClarification: 0.2, issues: [] });
  const bad = await reviewGenerated(
    clientFor({ addresses_requirement: { type: 'noul', noul: 0.79 }, unrelated_steps: { type: 'noul', noul: 0.21 }, needs_clarification: { type: 'noul', noul: 0.3 } }).client,
    input,
    { calibration: testCalibration() },
  );
  assert.equal(bad.verdict, 'draft');
  assert.equal(bad.review.issues.length, 2);
});
