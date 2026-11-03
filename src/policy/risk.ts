// Risk policy (architecture §5): deterministic keyword + context rules decide whether a target may be acted on
// without `allowRisky`. Jev commit judgement can only add a refusal (applied by the runner), never remove one.
import type { Candidate, ScreenModel } from '../core/types.ts';
import { normLabel } from '../observe/text.ts';
import type { AppProfile } from '../spec/schema.ts';

/** Korean has no word boundaries: matched as substrings of the normalized label. */
export const RISK_KEYWORDS_KO: readonly string[] = [
  '삭제',
  '지우기',
  '제거',
  '결제',
  '구매',
  '주문',
  '탈퇴',
  '로그아웃',
  '초기화',
  '송금',
  '이체',
  '전송',
  '보내기',
  '공유',
  '신고',
  '차단',
  '구독',
  '해지',
  '전화',
  '권한 허용',
];

/** Matched on Unicode word boundaries, case-insensitive; inner spaces match any whitespace run (or none). */
export const RISK_KEYWORDS_EN: readonly string[] = [
  'delete',
  'remove',
  'erase',
  'pay',
  'purchase',
  'buy',
  'order',
  'checkout',
  'unsubscribe',
  'sign out',
  'log out',
  'reset',
  'send',
  'transfer',
  'share',
  'report',
  'block',
  'call',
];

/** Screen texts that mark a destructive confirmation dialog; inside one, plain confirm labels are risky too. */
export const DESTRUCTIVE_CONTEXT: readonly RegExp[] = [
  /삭제하시겠/,
  /지우시겠/,
  /탈퇴하시겠/,
  /정말/,
  /되돌릴 수 없/,
  /복구할 수 없/,
  /cannot be undone/i,
  /can't be undone/i,
  /are you sure/i,
  /permanently/i,
];

/** Exact (normalized) confirm labels that are risky only inside a destructive context. */
export const CONFIRM_LABELS: readonly string[] = ['확인', '예', '네', 'ok', 'yes', '계속', 'continue', 'confirm'];

export interface RiskAssessment {
  risky: boolean;
  /** The target has no label, so its effect cannot be judged (tapAt, unnamed icon). */
  unknown: boolean;
  /** A fixture grant can cover business effects, not unknown targets, explicit denials or system actions. */
  boundary: 'none' | 'business' | 'host-system' | 'deny' | 'unknown';
  /** Korean, one per rule that fired. */
  reasons: string[];
}

const EN_PATTERNS: readonly { word: string; re: RegExp }[] = RISK_KEYWORDS_EN.map((word) => ({
  word,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${word.split(' ').join('\\s*')}(?![\\p{L}\\p{N}])`, 'iu'),
}));

/**
 * Risk of acting on an element labelled `label`. `null`/blank → risky + unknown. Exact `risk.allow` labels exempt
 * business keywords only; explicit denials, system actions and destructive confirmations retain their boundaries.
 * `contextTexts` are the other visible texts of the screen.
 */
export function labelRisk(
  label: string | null,
  risk?: { deny?: readonly string[]; allow?: readonly string[] },
  contextTexts: readonly string[] = [],
): RiskAssessment {
  const norm = label === null ? '' : normLabel(label);
  if (!norm) return { risky: true, unknown: true, boundary: 'unknown', reasons: ['라벨 없는 대상 — 위험 여부를 알 수 없음'] };
  const assessment: RiskAssessment = { risky: false, unknown: false, boundary: 'none', reasons: [] };
  const allowed = (risk?.allow ?? []).some((a) => normLabel(a) === norm);
  for (const word of RISK_KEYWORDS_KO) {
    const system = word === '전화' || word === '권한 허용';
    if (norm.includes(word) && (!allowed || system)) {
      assessment.reasons.push(`위험 키워드 "${word}"`);
      if (system) assessment.boundary = 'host-system';
      else if (assessment.boundary === 'none') assessment.boundary = 'business';
    }
  }
  for (const { word, re } of EN_PATTERNS) {
    const system = word === 'call';
    if (re.test(norm) && (!allowed || system)) {
      assessment.reasons.push(`위험 키워드 "${word}"`);
      if (system) assessment.boundary = 'host-system';
      else if (assessment.boundary === 'none') assessment.boundary = 'business';
    }
  }
  for (const word of risk?.deny ?? []) {
    const normalized = normLabel(word);
    if (normalized && norm.includes(normalized)) { assessment.reasons.push(`앱 프로필 deny "${word}"`); assessment.boundary = 'deny'; }
  }
  if (CONFIRM_LABELS.includes(norm)) {
    const hit = contextTexts.map((text) => DESTRUCTIVE_CONTEXT.find((pattern) => pattern.test(text))).find((pattern) => pattern !== undefined);
    if (hit) {
      assessment.reasons.push(`파괴적 확인 대화상자 문맥(${hit.source})의 확인 버튼`);
      if (assessment.boundary === 'none') assessment.boundary = 'business';
    }
  }
  assessment.risky = assessment.reasons.length > 0;
  return assessment;
}

/** Deterministic risk of a resolved candidate on the current screen (Jev commit is layered on by the runner). */
export function assessRisk(candidate: Candidate | null, model: ScreenModel, profile: AppProfile | null): RiskAssessment {
  return labelRisk(candidate?.name ?? null, profile?.risk, model.texts);
}
