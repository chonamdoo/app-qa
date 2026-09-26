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
  /** Korean, one per rule that fired. */
  reasons: string[];
}

const EN_PATTERNS: readonly { word: string; re: RegExp }[] = RISK_KEYWORDS_EN.map((word) => ({
  word,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${word.split(' ').join('\\s*')}(?![\\p{L}\\p{N}])`, 'iu'),
}));

/**
 * Risk of acting on an element labelled `label`. `null`/blank → risky + unknown. `risk.allow` lists exact labels that are
 * known safe despite a keyword hit (it does not lift the confirm-dialog rule); `risk.deny` adds substrings.
 * `contextTexts` are the other visible texts of the screen (destructive dialog detection).
 */
export function labelRisk(
  label: string | null,
  risk?: { deny?: readonly string[]; allow?: readonly string[] },
  contextTexts: readonly string[] = [],
): RiskAssessment {
  const norm = label === null ? '' : normLabel(label);
  if (!norm) return { risky: true, unknown: true, reasons: ['라벨 없는 대상 — 위험 여부를 알 수 없음'] };
  const reasons: string[] = [];
  const allowed = (risk?.allow ?? []).some((a) => normLabel(a) === norm);
  if (!allowed) {
    for (const word of RISK_KEYWORDS_KO) if (norm.includes(word)) reasons.push(`위험 키워드 "${word}"`);
    for (const { word, re } of EN_PATTERNS) if (re.test(norm)) reasons.push(`위험 키워드 "${word}"`);
    for (const word of risk?.deny ?? []) {
      const w = normLabel(word);
      if (w && norm.includes(w)) reasons.push(`앱 프로필 deny "${word}"`);
    }
  }
  if (CONFIRM_LABELS.includes(norm)) {
    const hit = contextTexts.map((t) => DESTRUCTIVE_CONTEXT.find((re) => re.test(t))).find((re) => re !== undefined);
    if (hit) reasons.push(`파괴적 확인 대화상자 문맥(${hit.source})의 확인 버튼`);
  }
  return { risky: reasons.length > 0, unknown: false, reasons };
}

/** Deterministic risk of a resolved candidate on the current screen (Jev commit is layered on by the runner). */
export function assessRisk(candidate: Candidate | null, model: ScreenModel, profile: AppProfile | null): RiskAssessment {
  return labelRisk(candidate?.name ?? null, profile?.risk, model.texts);
}
