import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { canonicalJson, JevCallError, JevClient, requestKey } from '../../src/jev/client.ts';
import type { Questions } from '../../src/jev/questions.ts';
import { body, choiceAnswer, scriptedFetch, TEST_KEY, testConfig } from './_helpers.ts';

const questions: Questions = { target: { type: 'choice', instructions: 'q', criteria: { e1: 'a', none: 'b' } } };
const state = { screen: { rows: ['e1 | button | 항공편 찾기 | - | middle'], texts: ['떠남'] }, intent: '항공편 찾기' };
const ok = { status: 200, body: body({ target: choiceAnswer({ e1: 0.97, none: 0.03 }) }), headers: { 'x-typesafe-request-id': 'req-1' } };
const noSleep = async () => {};

async function callError(client: JevClient): Promise<JevCallError> {
  try {
    await client.systemOne(state, questions, 'q-v1');
  } catch (e) {
    if (e instanceof JevCallError) return e;
    throw e;
  }
  assert.fail('expected JevCallError');
}

test('429 is retried with backoff and the retry is marked; the receipt carries request id, model and tokens', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 429, body: { error: 'slow down' }, headers: { 'retry-after-ms': '10' } }, ok]);
  const slept: number[] = [];
  const client = new JevClient(testConfig(), { fetchImpl, sleep: async (ms) => void slept.push(ms) });
  const r = await client.systemOne(state, questions, 'q-v1');
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [10]);
  assert.equal(calls[0]!.headers['x-typesafe-retry-count'], undefined);
  assert.equal(calls[1]!.headers['x-typesafe-retry-count'], '1');
  assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(JSON.parse(calls[0]!.body).model, 'jev-1.13.0');
  assert.equal(r.receipt.requestId, 'req-1');
  assert.equal(r.receipt.model, 'jev-1.13.0');
  assert.equal(r.receipt.inputTokens, 321);
  assert.equal(r.receipt.error, null);
  assert.equal(r.receipt.questionVersion, 'q-v1');
  assert.deepEqual(r.answers.target, choiceAnswer({ e1: 0.97, none: 0.03 }));
});

test('5xx and 529 are retried until attempts run out, then fail as http with the last status', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 503, body: {} }, { status: 529, body: {} }]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep, maxAttempts: 3 }));
  assert.equal(calls.length, 3);
  assert.equal(e.kind, 'http');
  assert.equal(e.status, 529);
});

test('422 is not retried and the error names the failing field but never echoes the body', async () => {
  const detail = [{ loc: ['body', 'questions', 'target', 'criteria'], msg: 'bad', input: '비밀 화면 문구' }];
  const { fetchImpl, calls } = scriptedFetch([{ status: 422, body: { detail } }, ok]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep }));
  assert.equal(calls.length, 1);
  assert.equal(e.kind, 'http');
  assert.equal(e.status, 422);
  assert.match(e.message, /body\.questions\.target\.criteria/);
  assert.doesNotMatch(e.message, /비밀/);
  assert.equal(e.receipt.error?.startsWith('http:'), true);
  assert.equal(e.receipt.answers, null);
});

test('401 fails at once and neither the message nor the receipt contains the API key', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 401, body: { error: `invalid key ${TEST_KEY}` } }]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep }));
  assert.equal(calls.length, 1);
  assert.equal(e.status, 401);
  assert.doesNotMatch(`${e.message} ${JSON.stringify(e.receipt)}`, new RegExp(TEST_KEY));
});

test('an attempt that exceeds its timeout fails as timeout without retry', async () => {
  const { fetchImpl, calls } = scriptedFetch(['hang', ok]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep, attemptTimeoutMs: 20 }));
  assert.equal(e.kind, 'timeout');
  assert.equal(calls.length, 1);
});

test('a connection failure is a network error', async () => {
  const { fetchImpl } = scriptedFetch([new TypeError('fetch failed')]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep }));
  assert.equal(e.kind, 'network');
});

test('a non-JSON 2xx body is an invalid response', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 200, body: '<html>oops</html>' }]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep }));
  assert.equal(e.kind, 'invalid_response');
});

test('a response from another model is rejected and the receipt records which model answered', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 200, body: body({ target: choiceAnswer({ e1: 1, none: 0 }) }, 'jev-1.14.0') }]);
  const e = await callError(new JevClient(testConfig(), { fetchImpl, sleep: noSleep }));
  assert.equal(e.kind, 'model_mismatch');
  assert.equal(e.receipt.model, 'jev-1.14.0');
});

test('a Choice with more than 255 options is refused before sending', async () => {
  const criteria: Record<string, null> = { none: null };
  for (let i = 1; i <= 255; i++) criteria[`e${i}`] = null;
  const { fetchImpl, calls } = scriptedFetch([ok]);
  const client = new JevClient(testConfig(), { fetchImpl });
  await assert.rejects(client.systemOne(state, { target: { type: 'choice', instructions: 'q', criteria } }, 'q-v1'), (e: unknown) => e instanceof JevCallError && e.kind === 'request');
  assert.equal(calls.length, 0);
});

const tmp = mkdtempSync(join(tmpdir(), 'jev-rec-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('record stores the response under the request digest and replay serves it without network', async () => {
  const { fetchImpl } = scriptedFetch([ok]);
  const recorded = await new JevClient(testConfig('record', tmp), { fetchImpl }).systemOne(state, questions, 'q-v1');
  assert.deepEqual(readdirSync(tmp), [`${requestKey('jev-1.13.0', 'q-v1', state, questions)}.json`]);

  const offline = scriptedFetch([new Error('network must not be used in replay')]);
  const replay = new JevClient(testConfig('replay', tmp), { fetchImpl: offline.fetchImpl });
  // Same request built with a different key order hits the same recording.
  const reordered = { intent: state.intent, screen: { texts: state.screen.texts, rows: state.screen.rows } };
  const r = await replay.systemOne(reordered, questions, 'q-v1');
  assert.equal(offline.calls.length, 0);
  assert.deepEqual(r.answers, recorded.answers);
  assert.equal(r.receipt.requestId, 'req-1');
  assert.equal(r.receipt.stateDigest, recorded.receipt.stateDigest);
});

test('replay without a recording for the request is an error (a changed question version misses)', async () => {
  const replay = new JevClient(testConfig('replay', tmp));
  await assert.rejects(replay.systemOne(state, questions, 'q-v2'), (e: unknown) => e instanceof JevCallError && e.kind === 'replay_miss');
});

test('canonical JSON sorts keys at every depth but keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
});
