// Jev without network: a real JevClient whose fetch is answered by a script, plus the test calibration record.
import { readFileSync } from 'node:fs';
import { JevClient } from '../../src/jev/client.ts';
import { loadJevConfig } from '../../src/jev/config.ts';
import { Calibration } from '../../src/jev/gates.ts';
import type { Question } from '../../src/jev/questions.ts';
import type { JevSetup } from '../../src/runner/engine.ts';

/** `test/fixtures/calibration.json`, validated against the live schema (parsed per use so schema drift fails only Jev tests). */
export function testCalibration(): Calibration {
  return Calibration.parse(JSON.parse(readFileSync(new URL('../fixtures/calibration.json', import.meta.url), 'utf8')));
}

export interface JevRequestLog {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
}

/** Answer builder for one question id; return the wire answer object. */
export type Answerer = (id: string, question: Question, state: Record<string, unknown>) => unknown;

/** Choice answer giving `pick` probability `p` and spreading the rest evenly (sums to 1, argmax = pick). */
export function choice(question: Question, pick: string, p: number): unknown {
  if (question.type !== 'choice') throw new Error('not a choice question');
  const keys = Object.keys(question.criteria);
  const rest = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? p : rest]));
  return { type: 'choice', choice: pick, confidence: p, probabilities };
}

/** Grounding key whose row names `name` (criteria descriptions are "role | name | state | region"). */
export function keyNamed(question: Question, name: string): string {
  if (question.type !== 'choice') throw new Error('not a choice question');
  const hit = Object.entries(question.criteria).find(([, d]) => d?.split(' | ')[1] === name);
  if (!hit) throw new Error(`no row named ${name}`);
  return hit[0];
}

export function noul(p: number): unknown {
  return { type: 'noul', noul: p };
}

/** Calibrated Jev whose responses come from `answer`; `requests` records every call. */
export function jevStub(answer: Answerer): { setup: JevSetup; requests: JevRequestLog[] } {
  const requests: JevRequestLog[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; state: Record<string, unknown>; questions: Record<string, Question> };
    requests.push({ state: body.state, questions: body.questions });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, answer(id, q, body.state)]));
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 42 } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-typesafe-request-id': `req-${requests.length}` },
    });
  }) as typeof fetch;
  const client = new JevClient(loadJevConfig({ TYPESAFE_API_KEY: 'test-key-not-real' }), { fetchImpl, sleep: async () => undefined });
  return { setup: { client, calibration: testCalibration(), problem: null }, requests };
}

/** No calibration record and no client: every Jev decision must come out as ERROR `uncalibrated`. */
export const UNCALIBRATED: JevSetup = { client: null, calibration: null, problem: null };
