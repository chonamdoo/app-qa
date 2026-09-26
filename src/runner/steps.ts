// Step helpers: kind detection, Korean labels (run.started / reports) and run-time `${NAME}` expansion.
import type { StepSpec } from '../spec/schema.ts';

export type StepKind =
  | 'launch'
  | 'open'
  | 'tap'
  | 'longPress'
  | 'tapAt'
  | 'type'
  | 'clear'
  | 'press'
  | 'hideKeyboard'
  | 'see'
  | 'seeNot'
  | 'assertText'
  | 'assertNoText'
  | 'checkEach'
  | 'claim'
  | 'remember'
  | 'which'
  | 'repeat'
  | 'use'
  | 'scroll'
  | 'swipe'
  | 'back'
  | 'location'
  | 'wait'
  | 'capture';

const STEP_KIND_LABEL: Record<StepKind, string> = {
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

export function stepKind(step: StepSpec): StepKind {
  for (const key of Object.keys(step)) if (key in STEP_KIND_LABEL) return key as StepKind;
  throw new Error(`알 수 없는 스텝: ${JSON.stringify(step)}`);
}

function describe(value: unknown): string {
  if (value === true || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    if ('regex' in value) return `/${String(value.regex)}/`;
    return Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' || typeof v === 'number' ? v : describe(v) || JSON.stringify(v)}`)
      .join(', ');
  }
  return JSON.stringify(value);
}

/** "탭: 출국장", "입력: "인천" → 검색창", "반복: 3회" … Secure text is never shown. */
export function stepLabel(step: StepSpec): string {
  const kind = stepKind(step);
  const fields = step as Record<string, unknown>;
  let detail: string;
  if ('type' in step) detail = `${step.secure ? '••••' : `"${step.type}"`} → ${describe(step.into)}`;
  else if ('which' in step) detail = Object.keys(step.which).join(' | ');
  else if ('repeat' in step) detail = step.repeat.times !== undefined ? `${step.repeat.times}회` : `조건 ${describe(step.repeat.while)}`;
  else if ('wait' in step) detail = typeof step.wait === 'number' ? `${step.wait}ms` : `${describe(step.wait.until)}까지`;
  else if ('checkEach' in step) detail = `/${step.checkEach.pattern}/`;
  else if ('remember' in step) detail = `${step.remember.name} ← ${describe(step.remember.from)}`;
  else if ('scroll' in step) detail = `${step.scroll.direction}${step.scroll.until ? ` → ${describe(step.scroll.until)}` : ''}`;
  else detail = describe(fields[kind]);
  return detail ? `${STEP_KIND_LABEL[kind]}: ${detail}` : STEP_KIND_LABEL[kind];
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Unset variables named in one message. */
export class UnsetVariableError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`값이 없는 변수: ${names.join(', ')} (.env 또는 remember/with로 지정하세요)`);
    this.name = 'UnsetVariableError';
    this.names = names;
  }
}

/** Replaces `${NAME}` via `lookup`; throws UnsetVariableError listing every unresolved name. */
function expandString(text: string, lookup: (name: string) => string | undefined): string {
  const missing: string[] = [];
  const out = text.replace(VAR, (whole, name: string) => {
    const v = lookup(name);
    if (v === undefined) {
      missing.push(name);
      return whole;
    }
    return v;
  });
  if (missing.length) throw new UnsetVariableError([...new Set(missing)]);
  return out;
}

function expandDeep(value: unknown, lookup: (name: string) => string | undefined): unknown {
  if (typeof value === 'string') return expandString(value, lookup);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, lookup));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, lookup);
    return out;
  }
  return value;
}

/**
 * Expands every string of a step at run time. Nested step lists (repeat.steps, which branches) stay raw and are
 * expanded when they run, so values remembered in between are visible; `use` paths are resolved at load time.
 */
export function expandStep(step: StepSpec, lookup: (name: string) => string | undefined): StepSpec {
  if ('repeat' in step) {
    const { steps, ...condition } = step.repeat;
    const { repeat: _r, ...common } = step;
    return { ...(expandDeep(common, lookup) as object), repeat: { ...(expandDeep(condition, lookup) as object), steps } } as StepSpec;
  }
  if ('which' in step) {
    const which: Record<string, unknown> = {};
    for (const [option, branch] of Object.entries(step.which)) which[expandString(option, lookup)] = branch;
    const { which: _w, ...rest } = step;
    return { ...(expandDeep(rest, lookup) as object), which } as StepSpec;
  }
  if ('use' in step) {
    const { use, ...rest } = step;
    return { ...(expandDeep(rest, lookup) as object), use } as StepSpec;
  }
  return expandDeep(step, lookup) as StepSpec;
}
