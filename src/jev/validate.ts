// Strict response validation (architecture §3): any failure is an error and nothing acts on the answer.
import { z } from 'zod';
import { JevError } from './config.ts';
import type { Questions } from './questions.ts';

// z.number() rejects NaN and ±Infinity.
const Unit = z.number().min(0).max(1);

const ChoiceWire = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: Unit,
  probabilities: z.record(z.string(), Unit),
});

const NoulWire = z.object({ type: z.literal('noul'), noul: Unit });

const Envelope = z.object({ model: z.string(), answers: z.record(z.string(), z.unknown()) });

const Usage = z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative() }) });

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: 'noul';
  /** P(yes). */
  noul: number;
}

export type JevAnswer = ChoiceAnswer | NoulAnswer;

export interface ValidatedResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number | null;
}

const SUM_TOLERANCE = 0.02;
/** Probabilities are rounded server-side; the reported choice may trail the max by rounding. */
const ARGMAX_TOLERANCE = 0.011;
/** Float noise when adding rounded decimals (0.9 + 0.06 + 0.06 = 1.0200000000000002). */
const EPS = 1e-9;

/** Checks a parsed 2xx body against the questions that were sent. Throws `JevError('invalid_response' | 'model_mismatch')`. */
export function validateResponse(raw: unknown, questions: Questions, model: string): ValidatedResponse {
  const envelope = parseOrThrow(Envelope, raw, '');
  if (envelope.model !== model) throw new JevError('model_mismatch', `응답 모델 ${envelope.model} ≠ 고정 모델 ${model}`);
  sameKeys('answers', Object.keys(envelope.answers), Object.keys(questions));

  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const path = `answers.${id}`;
    if (question.type === 'noul') {
      answers[id] = parseOrThrow(NoulWire, envelope.answers[id], path);
      continue;
    }
    const a = parseOrThrow(ChoiceWire, envelope.answers[id], path);
    const keys = Object.keys(question.criteria);
    sameKeys(`${path}.probabilities`, Object.keys(a.probabilities), keys);
    let sum = 0;
    let max = 0;
    for (const key of keys) {
      const p = a.probabilities[key]!;
      sum += p;
      if (p > max) max = p;
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE + EPS) throw invalid(`${path}.probabilities`, `sum ${sum.toFixed(3)}`);
    const chosen = a.probabilities[a.choice];
    if (chosen === undefined) throw invalid(`${path}.choice`, 'not a criteria key');
    if (chosen < max - ARGMAX_TOLERANCE - EPS) throw invalid(`${path}.choice`, 'not the argmax');
    answers[id] = a;
  }

  const usage = Usage.safeParse(raw);
  return { model: envelope.model, answers, inputTokens: usage.success ? usage.data.usage.input_tokens : null };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = [path, ...(issue?.path ?? []).map(String)].filter(Boolean).join('.') || 'body';
  throw invalid(where, issue?.message ?? 'invalid');
}

function sameKeys(path: string, got: string[], want: string[]): void {
  const wanted = new Set(want);
  const extra = got.find((k) => !wanted.has(k));
  if (extra !== undefined) throw invalid(`${path}.${extra}`, 'unexpected key');
  const present = new Set(got);
  const missing = want.find((k) => !present.has(k));
  if (missing !== undefined) throw invalid(`${path}.${missing}`, 'missing');
}

function invalid(path: string, problem: string): JevError {
  return new JevError('invalid_response', `Jev 응답 검증 실패: ${path}: ${problem}`);
}
