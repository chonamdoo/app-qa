// Step kind detection and Korean kind labels shared by the runner, reports, planner and server.
import { STEP_KINDS, type StepKind, type StepSpec } from './schema.ts';

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  launch: '앱 실행',
  open: '링크 열기',
  tap: '탭',
  longPress: '길게 누르기',
  tapAt: '좌표 탭',
  type: '입력',
  clear: '지우기',
  press: '키 누르기',
  hideKeyboard: '키보드 숨기기',
  see: '보임',
  seeNot: '안 보임',
  assertText: '텍스트 확인',
  assertNoText: '텍스트 없음',
  checkEach: '각 줄 검사',
  claim: '판정',
  remember: '기억',
  which: '분기',
  repeat: '반복',
  use: '하위 흐름',
  scroll: '스크롤',
  swipe: '스와이프',
  back: '뒤로',
  location: '위치 설정',
  wait: '대기',
  capture: '캡처',
};

const KIND_SET: ReadonlySet<string> = new Set(STEP_KINDS);

/** The kind of a (possibly unvalidated) step object, or null when it has none of the known kind keys. */
export function findStepKind(step: object): StepKind | null {
  for (const key of Object.keys(step)) if (KIND_SET.has(key)) return key as StepKind;
  return null;
}

export function stepKind(step: StepSpec): StepKind {
  const kind = findStepKind(step);
  if (kind === null) throw new Error(`알 수 없는 스텝: ${JSON.stringify(step)}`);
  return kind;
}
