// Shared stubs for Jev tests: a scripted fetch that records every request, and wire-format response builders.
import { JEV_MODEL, loadJevConfig, type JevConfig, type JevMode } from '../../src/jev/config.ts';
import type { Calibration } from '../../src/jev/gates.ts';

export const TEST_KEY = 'ts_test_KEY_0123456789';

export function testConfig(mode: JevMode = 'live', recordingsDir = '/nonexistent'): JevConfig {
  return loadJevConfig({ TYPESAFE_API_KEY: TEST_KEY }, { mode, recordingsDir });
}

export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Step = { status: number; body: unknown; headers?: Record<string, string> } | 'hang' | Error;

/** Plays `steps` in order (the last one repeats); `calls` records each request as sent. */
export function scriptedFetch(steps: Step[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (step instanceof Error) throw step;
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function choiceAnswer(probabilities: Record<string, number>): { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice, confidence: 0.5, probabilities };
}

export function body(answers: Record<string, unknown>, model = JEV_MODEL): unknown {
  return { model, answers, usage: { input_tokens: 321, output_tokens: 12 } };
}

/** A valid calibration record with round, hand-picked gates (not the measured ones). */
export function testCalibration(): Calibration {
  const evidence = {};
  const criteria = { maxConfidentWrong: 0, minAcceptance: 0.8 };
  return {
    model: JEV_MODEL,
    questionVersion: 'q-v1',
    createdAt: '2026-09-26T00:00:00.000Z',
    status: 'calibrated',
    method: 'test',
    golden: [],
    grounding: { status: 'calibrated', criteria, gate: { minTop: 0.7, minGap: 0.3, maxNone: 0.1, noneMin: 0.6, rescueGap: 0.5 }, evidence },
    claim: { status: 'calibrated', criteria, gate: { yes: 0.9, no: 0.1 }, evidence },
    which: { status: 'calibrated', criteria, gate: { minTop: 0.7, minGap: 0.3, noneMin: 0.6 }, evidence },
    commit: { status: 'calibrated', criteria: { maxConfidentWrong: 0, maxFalseAlarmRate: 0.1 }, gate: { risky: 0.5 }, evidence },
    review: {
      status: 'calibrated',
      criteria: { maxConfidentWrong: 0, minGoodApproval: 0.8 },
      gate: { addressesMin: 0.8, unrelatedMax: 0.2, clarificationMax: 0.3 },
      evidence,
    },
  };
}