import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JevError } from '../../src/jev/config.ts';
import type { Questions } from '../../src/jev/questions.ts';
import { validateResponse } from '../../src/jev/validate.ts';

const MODEL = 'jev-1.13.0';
const questions: Questions = {
  target: { type: 'choice', instructions: 'q', criteria: { e1: 'a', e2: 'b', none: 'c' } },
  claim: { type: 'noul', instructions: 'q' },
};

interface Body {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage?: unknown;
}

function good(): Body {
  return {
    model: MODEL,
    answers: {
      target: { type: 'choice', choice: 'e1', confidence: 0.8, probabilities: { e1: 0.9, e2: 0.06, none: 0.04 } },
      claim: { type: 'noul', noul: 0.97 },
    },
    usage: { input_tokens: 100, output_tokens: 5 },
  };
}

function rejects(mutate: (b: Body) => void, kind: JevError['kind'], pathPart: string): void {
  const b = good();
  mutate(b);
  assert.throws(
    () => validateResponse(b, questions, MODEL),
    (e: unknown) => e instanceof JevError && e.kind === kind && e.message.includes(pathPart),
  );
}

test('accepts a well-formed response and returns typed answers and token usage', () => {
  const v = validateResponse(good(), questions, MODEL);
  assert.deepEqual(v.answers.target, { type: 'choice', choice: 'e1', confidence: 0.8, probabilities: { e1: 0.9, e2: 0.06, none: 0.04 } });
  assert.deepEqual(v.answers.claim, { type: 'noul', noul: 0.97 });
  assert.equal(v.inputTokens, 100);
});

test('rejects a missing answer key', () => rejects((b) => delete b.answers.claim, 'invalid_response', 'answers.claim'));

test('rejects an extra answer key', () => rejects((b) => (b.answers.bonus = { type: 'noul', noul: 0.5 }), 'invalid_response', 'answers.bonus'));

test('rejects probabilities missing a criteria key', () =>
  rejects((b) => (b.answers.target!.probabilities = { e1: 0.94, e2: 0.06 }), 'invalid_response', 'probabilities.none'));

test('rejects probabilities with a key that was not offered', () =>
  rejects((b) => (b.answers.target!.probabilities = { e1: 0.9, e2: 0.04, none: 0.04, e9: 0.02 }), 'invalid_response', 'probabilities.e9'));

test('rejects probabilities whose sum is off by more than 0.02', () => {
  rejects((b) => (b.answers.target!.probabilities = { e1: 0.9, e2: 0.06, none: 0.07 }), 'invalid_response', 'sum');
  // 1.02 exactly is within tolerance.
  const b = good();
  b.answers.target!.probabilities = { e1: 0.9, e2: 0.06, none: 0.06 };
  assert.doesNotThrow(() => validateResponse(b, questions, MODEL));
});

test('rejects a choice that is not the argmax beyond rounding tolerance', () => {
  rejects((b) => {
    b.answers.target!.choice = 'e2';
    b.answers.target!.probabilities = { e1: 0.5, e2: 0.45, none: 0.05 };
  }, 'invalid_response', 'argmax');
  // Within 0.011 of the max (rounding) is accepted.
  const b = good();
  b.answers.target!.choice = 'e2';
  b.answers.target!.probabilities = { e1: 0.48, e2: 0.47, none: 0.05 };
  assert.doesNotThrow(() => validateResponse(b, questions, MODEL));
});

test('rejects a choice outside the criteria', () => rejects((b) => (b.answers.target!.choice = 'e7'), 'invalid_response', 'choice'));

test('a choice naming an Object.prototype member is not a criteria key', () => {
  for (const choice of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    rejects((b) => (b.answers.target!.choice = choice), 'invalid_response', 'answers.target.choice');
  }
});

test('an own __proto__ key in the wire body is rejected, not silently dropped', () => {
  // JSON.parse keeps `__proto__` as an own key; the parsed record would otherwise look exactly like the criteria.
  const probs = JSON.parse('{"e1":0.9,"e2":0.06,"none":0.04,"__proto__":0.5}');
  rejects((b) => (b.answers.target!.probabilities = probs), 'invalid_response', 'answers.target.probabilities');
  rejects((b) => (b.answers = JSON.parse(`{"__proto__":{},${JSON.stringify(good().answers).slice(1)}`)), 'invalid_response', 'answers');
});

test('probabilities supplied only through the prototype chain are missing', () => {
  const inherited = Object.assign(Object.create({ none: 0.04 }), { e1: 0.9, e2: 0.06 });
  rejects((b) => (b.answers.target!.probabilities = inherited), 'invalid_response', 'probabilities.none');
});

test('rejects a response from another model as model_mismatch', () => rejects((b) => (b.model = 'jev-1.14.0'), 'model_mismatch', 'jev-1.14.0'));

test('rejects NaN, infinite and out-of-range numbers', () => {
  rejects((b) => (b.answers.claim!.noul = Number.NaN), 'invalid_response', 'answers.claim');
  rejects((b) => (b.answers.claim!.noul = Number.POSITIVE_INFINITY), 'invalid_response', 'answers.claim');
  rejects((b) => (b.answers.claim!.noul = 1.2), 'invalid_response', 'answers.claim');
  rejects((b) => (b.answers.target!.probabilities = { e1: Number.NaN, e2: 0.5, none: 0.5 }), 'invalid_response', 'answers.target');
  rejects((b) => (b.answers.target!.confidence = -0.1), 'invalid_response', 'answers.target');
});

test('rejects an answer whose type differs from the question', () =>
  rejects((b) => (b.answers.claim = { type: 'choice', choice: 'e1', confidence: 1, probabilities: { e1: 1 } }), 'invalid_response', 'answers.claim'));

test('missing usage does not reject (not decision-relevant) but reports null tokens', () => {
  const b = good();
  delete b.usage;
  assert.equal(validateResponse(b, questions, MODEL).inputTokens, null);
});
