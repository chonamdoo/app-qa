// Gates turn validated Jev probabilities into verdicts using only thresholds from the calibration record
// `calibration/<model>/<questionVersion>.json`. Choice and Noul thresholds are separate per primitive (never shared).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../core/config.ts';
import { JEV_MODEL, JevError } from './config.ts';
import { NONE, QUESTION_VERSION } from './questions.ts';

const P = z.number().min(0).max(1);
const Status = z.enum(['calibrated', 'failed']);
const Count = z.number().int().min(0);

export const GroundingGate = z.strictObject({
  /** Pass needs top candidate ≥ minTop … */
  minTop: P,
  /** … and top − max(second candidate, none) ≥ minGap … */
  minGap: P.refine((v) => v > 0, 'minGap must be > 0 (ties never pass)'),
  /** … and P(none) ≤ maxNone. */
  maxNone: P,
  /** not_found needs none strictly on top and P(none) ≥ noneMin; anything else is ambiguous. */
  noneMin: P,
  /** Non-strict only: pass on a large gap even below minTop (still needs P(none) ≤ maxNone). null = disabled. */
  rescueGap: P.nullable(),
});
export type GroundingGate = z.infer<typeof GroundingGate>;

export const ClaimGate = z.strictObject({ yes: P, no: P }).refine((g) => g.no < g.yes, 'claim gate needs no < yes');
export type ClaimGate = z.infer<typeof ClaimGate>;

export const WhichGate = z.strictObject({ minTop: P, minGap: P.refine((v) => v > 0), noneMin: P });
export type WhichGate = z.infer<typeof WhichGate>;

/** P(commit) ≥ risky → the target is treated as risky. Refusal-add only, on top of the deterministic risk policy. */
export const CommitGate = z.strictObject({ risky: P });
export type CommitGate = z.infer<typeof CommitGate>;

/** approvable = addresses ≥ addressesMin AND unrelated ≤ unrelatedMax AND clarification ≤ clarificationMax. */
export const ReviewGate = z.strictObject({ addressesMin: P, unrelatedMax: P, clarificationMax: P });
export type ReviewGate = z.infer<typeof ReviewGate>;

const Evidence = z.record(z.string(), z.unknown());
const AcceptanceCriteria = z.strictObject({ maxConfidentWrong: Count, minAcceptance: P });
const section = <G extends z.ZodType>(gate: G) => z.strictObject({ status: Status, criteria: AcceptanceCriteria, gate, evidence: Evidence });

export const Calibration = z.strictObject({
  model: z.string(),
  questionVersion: z.string(),
  createdAt: z.string(),
  /** calibrated only when every section is calibrated. */
  status: Status,
  golden: z.array(z.strictObject({ file: z.string(), sha256: z.string(), items: z.number().int() })),
  /** How the thresholds were searched (audit trail). */
  method: z.string(),
  grounding: section(GroundingGate),
  claim: section(ClaimGate),
  which: section(WhichGate),
  /** failed = no threshold met the criteria: the commit check is unavailable and every target it guards is refused. */
  commit: z.strictObject({
    status: Status,
    criteria: z.strictObject({ maxConfidentWrong: Count, maxFalseAlarmRate: P }),
    gate: CommitGate,
    evidence: Evidence,
  }),
  review: z.strictObject({ status: Status, criteria: z.strictObject({ maxConfidentWrong: Count, minGoodApproval: P }), gate: ReviewGate, evidence: Evidence }),
});
export type Calibration = z.infer<typeof Calibration>;

export type CalibratedPrimitive = 'grounding' | 'claim' | 'which' | 'commit' | 'review';

export function calibrationPath(model = JEV_MODEL, questionVersion = QUESTION_VERSION, dir = PATHS.calibration): string {
  return join(dir, model, `${questionVersion}.json`);
}

/** null when no record exists (every Jev decision is then `error: uncalibrated`); throws on a corrupt record. */
export function loadCalibration(model = JEV_MODEL, questionVersion = QUESTION_VERSION, dir = PATHS.calibration): Calibration | null {
  const file = calibrationPath(model, questionVersion, dir);
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new JevError('config', `캘리브레이션 파일이 JSON이 아닙니다: ${file}`);
  }
  const parsed = Calibration.safeParse(json);
  if (!parsed.success) throw new JevError('config', `캘리브레이션 파일 형식 오류: ${file}: ${parsed.error.issues[0]?.path.join('.')}`);
  if (parsed.data.model !== model || parsed.data.questionVersion !== questionVersion) {
    throw new JevError('config', `캘리브레이션 파일의 모델/질문 버전이 경로와 다릅니다: ${file}`);
  }
  return parsed.data;
}

/**
 * The gate for one primitive, or a reason why Jev must not decide: no record, a record for another model /
 * question version, or a primitive whose pre-registered criteria were not met.
 */
export function usableGate<K extends CalibratedPrimitive>(
  calibration: Calibration | null | undefined,
  model: string,
  primitive: K,
): { gate: Calibration[K]['gate']; reason: null } | { gate: null; reason: string } {
  if (!calibration) return { gate: null, reason: 'uncalibrated' };
  if (calibration.model !== model || calibration.questionVersion !== QUESTION_VERSION) {
    return { gate: null, reason: `uncalibrated: 레코드(${calibration.model}/${calibration.questionVersion}) ≠ 현재(${model}/${QUESTION_VERSION})` };
  }
  const s = calibration[primitive];
  if (s.status === 'failed') return { gate: null, reason: `uncalibrated: ${primitive} 사전등록 기준 미달` };
  return { gate: s.gate, reason: null };
}

export interface ChoiceGateResult<V extends string> {
  verdict: V;
  /** Chosen option key when verdict is pass; else the best non-none option (for reports). */
  key: string | null;
  pTop: number;
  pNone: number;
  gap: number;
  /** True when the pass came through the non-strict gap rescue. */
  rescued: boolean;
}

/**
 * Best non-none option, P(none), and the gap = top − max(runner-up, none). The gap is rounded to 1e-9 so rounded
 * wire probabilities sitting exactly on a threshold (0.7 − 0.4 = 0.29999999999999993) compare as intended.
 */
function rankChoice(probs: Record<string, number>): { key: string | null; pTop: number; pNone: number; gap: number } {
  let key: string | null = null;
  let pTop = 0;
  let pSecond = 0;
  for (const [k, p] of Object.entries(probs)) {
    if (k === NONE) continue;
    if (key === null || p > pTop) {
      if (key !== null) pSecond = pTop;
      key = k;
      pTop = p;
    } else if (p > pSecond) pSecond = p;
  }
  const pNone = probs[NONE] ?? 0;
  return { key, pTop, pNone, gap: Math.round((pTop - Math.max(pSecond, pNone)) * 1e9) / 1e9 };
}

export function gateGrounding(probs: Record<string, number>, gate: GroundingGate, strict: boolean): ChoiceGateResult<'pass' | 'ambiguous' | 'not_found'> {
  const r = rankChoice(probs);
  const base = { ...r, rescued: false };
  if (r.pNone > r.pTop) return { ...base, verdict: r.pNone >= gate.noneMin ? 'not_found' : 'ambiguous' };
  if (r.key === null || r.pNone > gate.maxNone || r.gap <= 0) return { ...base, verdict: 'ambiguous' };
  if (r.pTop >= gate.minTop && r.gap >= gate.minGap) return { ...base, verdict: 'pass' };
  if (!strict && gate.rescueGap !== null && r.gap >= gate.rescueGap) return { ...base, verdict: 'pass', rescued: true };
  return { ...base, verdict: 'ambiguous' };
}

export function gateWhich(probs: Record<string, number>, gate: WhichGate): ChoiceGateResult<'pass' | 'none' | 'ambiguous'> {
  const r = rankChoice(probs);
  const base = { ...r, rescued: false };
  if (r.pNone > r.pTop) return { ...base, verdict: r.pNone >= gate.noneMin ? 'none' : 'ambiguous' };
  if (r.key !== null && r.pTop >= gate.minTop && r.gap >= gate.minGap) return { ...base, verdict: 'pass' };
  return { ...base, verdict: 'ambiguous' };
}

export function gateClaim(pYes: number, gate: ClaimGate): 'pass' | 'fail' | 'inconclusive' {
  if (pYes >= gate.yes) return 'pass';
  if (pYes <= gate.no) return 'fail';
  return 'inconclusive';
}
