// Jev-backed decisions for the runner and planner. Every function fails closed: no calibration, a failed call or an
// invalid response yields verdict 'error' (with the receipt when Jev was reached) and never a guessed answer.
import type { Candidate, ClaimDecision, GroundingDecision, JevReceipt, WhichDecision } from '../core/types.ts';
import { candidateRow } from '../core/candidate-row.ts';
import { JevCallError, type JevClient } from './client.ts';
import { gateClaim, gateGrounding, gateWhich, usableGate, type Calibration } from './gates.ts';
import {
  claimQuestion,
  commitQuestion,
  groundingQuestion,
  MAX_CHOICE_OPTIONS,
  QUESTION_IDS,
  QUESTION_VERSION,
  reviewQuestions,
  whichQuestion,
  type Questions,
  type ScreenState,
} from './questions.ts';
import { createRedactor, redactDeep, type Redactor } from './redact.ts';
import type { ChoiceAnswer, JevAnswer, NoulAnswer } from './validate.ts';

export interface JudgeOptions {
  /** Visible text lines of the current screen (`ScreenModel.texts`). */
  texts: readonly string[];
  /** App-profile redactor; defaults to the built-in PII patterns only. */
  redact?: Redactor;
  calibration: Calibration | null | undefined;
  signal?: AbortSignal;
}

export interface ReviewDecision {
  /** approvable = passes the calibrated review gate (the planner still saves `draft` unless `--approve`). */
  verdict: 'approvable' | 'draft' | 'error';
  /** Same shape as `PlanFile.tests[].review`. */
  review: { addressesRequirement: number | null; unrelatedSteps: number | null; needsClarification: number | null; issues: string[] };
  receipt: JevReceipt | null;
  reason: string;
}

/** Commit judgement; `advisory` = the commit gate did not meet its criteria, so log it but never block on it alone. */
export interface CommitDecision extends ClaimDecision {
  advisory: boolean;
}

/** Exact request a decision sends; calibration builds requests through the same functions so recordings replay. */
export interface JevRequest {
  state: Record<string, unknown>;
  questions: Questions;
}

export const BUILTIN_REDACTOR = createRedactor();
const fmt = (p: number) => p.toFixed(2);

export function groundingRequest(cands: readonly Candidate[], intent: string, texts: readonly string[], redact: Redactor): JevRequest {
  const screen = screenState(cands, texts, redact);
  return { state: { screen, intent: redact(intent) }, questions: { [QUESTION_IDS.grounding]: groundingQuestion(cands.map((c) => c.key), screen.rows) } };
}

export function claimRequest(cands: readonly Candidate[], claim: string, texts: readonly string[], redact: Redactor): JevRequest {
  return { state: { screen: screenState(cands, texts, redact), claim: redact(claim) }, questions: { [QUESTION_IDS.claim]: claimQuestion() } };
}

export function whichRequest(cands: readonly Candidate[], options: readonly string[], texts: readonly string[], redact: Redactor): JevRequest {
  const redacted = options.map(redact);
  return { state: { screen: screenState(cands, texts, redact), options: redacted }, questions: { [QUESTION_IDS.which]: whichQuestion(redacted) } };
}

export function commitRequest(cands: readonly Candidate[], target: Candidate, texts: readonly string[], redact: Redactor): JevRequest {
  return {
    state: { screen: screenState(cands, texts, redact), target: redact(candidateRow(target)) },
    questions: { [QUESTION_IDS.commit]: commitQuestion() },
  };
}

/** Generated-test review request; the requirement and test are redacted like screen text. */
export function reviewRequest(input: { requirement: { id: string; text: string }; test: unknown }, redact: Redactor): JevRequest {
  return { state: redactDeep({ requirement: input.requirement, test: input.test }, redact), questions: reviewQuestions() };
}

/** Resolves an intent to one candidate. `strict` (for `see`) disables the gap rescue. */
export async function groundChoice(
  client: JevClient,
  cands: readonly Candidate[],
  intent: string,
  opts: JudgeOptions & { strict?: boolean },
): Promise<GroundingDecision> {
  const usable = usableGate(opts.calibration, client.model, 'grounding');
  if (!usable.gate) return { verdict: 'error', candidate: null, probabilities: null, decisionSource: 'none', receipt: null, reason: usable.reason };
  if (cands.length === 0) return { verdict: 'not_found', candidate: null, probabilities: null, decisionSource: 'none', receipt: null, reason: '후보 없음' };
  if (cands.length >= MAX_CHOICE_OPTIONS) {
    return { verdict: 'error', candidate: null, probabilities: null, decisionSource: 'none', receipt: null, reason: `overflow: 후보 ${cands.length}개 > ${MAX_CHOICE_OPTIONS - 1}` };
  }
  const req = groundingRequest(cands, intent, opts.texts, opts.redact ?? BUILTIN_REDACTOR);
  const call = await ask(client, req, opts.signal);
  if (!call.ok) return { verdict: 'error', candidate: null, probabilities: null, decisionSource: 'jev', receipt: call.receipt, reason: call.reason };
  const answer = call.answers[QUESTION_IDS.grounding] as ChoiceAnswer; // validated against the choice question
  const g = gateGrounding(answer.probabilities, usable.gate, opts.strict ?? false);
  const top = cands.find((c) => c.key === g.key) ?? null;
  const stats = `${g.key ?? '-'} ${fmt(g.pTop)}, 차이 ${fmt(g.gap)}, none ${fmt(g.pNone)}`;
  const reason =
    g.verdict === 'pass'
      ? `Jev 선택 ${g.key} "${top?.name ?? ''}" (${stats}${g.rescued ? ', 차이 구제' : ''})`
      : g.verdict === 'not_found'
        ? `Jev: 화면에 대상 없음 (none ${fmt(g.pNone)})`
        : `Jev: 애매함 (${stats})`;
  return {
    verdict: g.verdict,
    candidate: g.verdict === 'pass' ? top : null,
    probabilities: answer.probabilities,
    decisionSource: 'jev',
    receipt: call.receipt,
    reason,
  };
}

/** Noul: does the current screen support `claim`? pass / fail / inconclusive by the calibrated band. */
export async function judgeClaim(client: JevClient, cands: readonly Candidate[], claim: string, opts: JudgeOptions): Promise<ClaimDecision> {
  const usable = usableGate(opts.calibration, client.model, 'claim');
  if (!usable.gate) return { verdict: 'error', pYes: null, decisionSource: 'jev', receipt: null, reason: usable.reason };
  const call = await ask(client, claimRequest(cands, claim, opts.texts, opts.redact ?? BUILTIN_REDACTOR), opts.signal);
  if (!call.ok) return { verdict: 'error', pYes: null, decisionSource: 'jev', receipt: call.receipt, reason: call.reason };
  const p = (call.answers[QUESTION_IDS.claim] as NoulAnswer).noul;
  const verdict = gateClaim(p, usable.gate);
  const label = verdict === 'pass' ? '참' : verdict === 'fail' ? '거짓' : '불확실';
  return { verdict, pYes: p, decisionSource: 'jev', receipt: call.receipt, reason: `Jev claim ${label} (P=${fmt(p)})` };
}

/**
 * Which option describes the current screen? `option` is the option text; `probabilities` keep the wire keys
 * (`s0..sN` in option order, plus `none` = still loading / none of these).
 */
export async function judgeWhich(client: JevClient, cands: readonly Candidate[], options: readonly string[], opts: JudgeOptions): Promise<WhichDecision> {
  const usable = usableGate(opts.calibration, client.model, 'which');
  if (!usable.gate) return { verdict: 'error', option: null, probabilities: null, receipt: null, reason: usable.reason };
  if (options.length < 1 || options.length >= MAX_CHOICE_OPTIONS) {
    return { verdict: 'error', option: null, probabilities: null, receipt: null, reason: `which 선택지 수 ${options.length} (허용 1..${MAX_CHOICE_OPTIONS - 1})` };
  }
  const call = await ask(client, whichRequest(cands, options, opts.texts, opts.redact ?? BUILTIN_REDACTOR), opts.signal);
  if (!call.ok) return { verdict: 'error', option: null, probabilities: null, receipt: call.receipt, reason: call.reason };
  const answer = call.answers[QUESTION_IDS.which] as ChoiceAnswer;
  const g = gateWhich(answer.probabilities, usable.gate);
  const option = g.verdict === 'pass' && g.key ? (options[Number(g.key.slice(1))] ?? null) : null;
  const reason =
    g.verdict === 'pass'
      ? `Jev 화면 판정 "${option}" (${fmt(g.pTop)}, 차이 ${fmt(g.gap)})`
      : g.verdict === 'none'
        ? `Jev: 로딩 중이거나 해당 없음 (none ${fmt(g.pNone)})`
        : `Jev: 애매함 (${g.key ?? '-'} ${fmt(g.pTop)}, 차이 ${fmt(g.gap)}, none ${fmt(g.pNone)})`;
  return { verdict: g.verdict, option, probabilities: answer.probabilities, receipt: call.receipt, reason };
}

/**
 * Would activating `target` commit an irreversible/external change? verdict 'pass' = yes (treat as risky).
 * Refusal-add only: callers may block on 'pass' (unless `advisory`) but must never unblock a deterministic risk on 'fail'.
 */
export async function judgeCommit(client: JevClient, cands: readonly Candidate[], target: Candidate, opts: JudgeOptions): Promise<CommitDecision> {
  const usable = usableGate(opts.calibration, client.model, 'commit');
  const advisory = opts.calibration?.commit.status === 'advisory';
  if (!usable.gate) return { verdict: 'error', pYes: null, decisionSource: 'jev', receipt: null, reason: usable.reason, advisory };
  const call = await ask(client, commitRequest(cands, target, opts.texts, opts.redact ?? BUILTIN_REDACTOR), opts.signal);
  if (!call.ok) return { verdict: 'error', pYes: null, decisionSource: 'jev', receipt: call.receipt, reason: call.reason, advisory };
  const p = (call.answers[QUESTION_IDS.commit] as NoulAnswer).noul;
  const risky = p >= usable.gate.risky;
  const note = advisory ? ' [참고용: commit 보정 기준 미달, 단독 차단 금지]' : '';
  return {
    verdict: risky ? 'pass' : 'fail',
    pYes: p,
    decisionSource: 'jev',
    receipt: call.receipt,
    reason: `${risky ? `Jev: 되돌릴 수 없는 변경일 수 있음 (P=${fmt(p)} ≥ ${fmt(usable.gate.risky)})` : `Jev: 커밋 동작 아님 (P=${fmt(p)})`}${note}`,
    advisory,
  };
}

/** Reviews one generated test against its requirement with three independent Nouls and the calibrated review gate. */
export async function reviewGenerated(
  client: JevClient,
  input: { requirement: { id: string; text: string }; test: unknown },
  opts: { redact?: Redactor; calibration: Calibration | null | undefined; signal?: AbortSignal },
): Promise<ReviewDecision> {
  const empty = { addressesRequirement: null, unrelatedSteps: null, needsClarification: null };
  const usable = usableGate(opts.calibration, client.model, 'review');
  if (!usable.gate) return { verdict: 'error', review: { ...empty, issues: [usable.reason] }, receipt: null, reason: usable.reason };
  const gate = usable.gate;
  const call = await ask(client, reviewRequest(input, opts.redact ?? BUILTIN_REDACTOR), opts.signal);
  if (!call.ok) return { verdict: 'error', review: { ...empty, issues: [call.reason] }, receipt: call.receipt, reason: call.reason };
  const noul = (id: string) => (call.answers[id] as NoulAnswer).noul;
  const addressesRequirement = noul(QUESTION_IDS.addresses);
  const unrelatedSteps = noul(QUESTION_IDS.unrelated);
  const needsClarification = noul(QUESTION_IDS.clarification);
  const issues: string[] = [];
  if (addressesRequirement < gate.addressesMin) issues.push(`요구사항을 검증하지 않을 수 있음 (addresses_requirement ${fmt(addressesRequirement)})`);
  if (unrelatedSteps > gate.unrelatedMax) issues.push(`요구사항과 무관한 스텝이 있을 수 있음 (unrelated_steps ${fmt(unrelatedSteps)})`);
  if (needsClarification > gate.clarificationMax) issues.push(`요구사항이 모호해 확인이 필요함 (needs_clarification ${fmt(needsClarification)})`);
  return {
    verdict: issues.length ? 'draft' : 'approvable',
    review: { addressesRequirement, unrelatedSteps, needsClarification, issues },
    receipt: call.receipt,
    reason: issues.length ? issues.join('; ') : 'Jev 검토 통과',
  };
}

/** Rows via Observe's single row format, then redaction of every screen string. */
function screenState(cands: readonly Candidate[], texts: readonly string[], redact: Redactor): ScreenState {
  return { rows: cands.map((c) => redact(candidateRow(c))), texts: texts.map(redact) };
}

type Asked = { ok: true; answers: Record<string, JevAnswer>; receipt: JevReceipt } | { ok: false; receipt: JevReceipt; reason: string };

async function ask(client: JevClient, req: JevRequest, signal: AbortSignal | undefined): Promise<Asked> {
  try {
    const r = await client.systemOne(req.state, req.questions, QUESTION_VERSION, { signal });
    return { ok: true, answers: r.answers, receipt: r.receipt };
  } catch (err) {
    if (!(err instanceof JevCallError)) throw err;
    return { ok: false, receipt: err.receipt, reason: `jev_${err.kind}: ${err.message}` };
  }
}
