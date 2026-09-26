// The host-wide "desktop display unknown" marker (`src/drivers/lock.ts`): `qa doctor` reports it, `qa setup --browsers`
// clears it. A qa process writes it before it opens a desktop browser and removes it once that browser's end is
// confirmed; it stays when the end or start could not be confirmed, or the process was killed or crashed first. While it
// exists every desktop web test is BLOCKED (`display_unknown`): a browser window may still be on the shared display.
import type { Check } from '../appium/setup.ts';
import { acquireDisplayLock, clearDisplayUnknown, DeviceLockedError, readDisplayUnknown, type DisplayUnknown } from '../drivers/index.ts';

const LABEL = '데스크톱 화면 상태';
const CLEAR_HINT = 'qa 실행이 아직 진행 중이면 끝날 때까지 기다리세요(정상 종료하면 표시가 지워집니다). 끝났는데도 남아 있으면 남은 자동화 브라우저 창(Chrome·Safari)을 모두 닫은 뒤 `qa setup --browsers`로 표시를 지우세요';

function unknownDetail(unknown: DisplayUnknown): string {
  return `${unknown.reason} (${unknown.since}부터${unknown.runId ? `, 실행 ${unknown.runId}` : ''})`;
}

/** `qa doctor`: fails while the marker exists (a malformed marker counts as existing). Read-only. */
export function displayStateCheck(opts: { dir?: string } = {}): Check {
  const unknown = readDisplayUnknown(opts);
  if (unknown === null) return { label: LABEL, ok: true, detail: '확인됨 — 이전 실행이 닫지 못한 브라우저 창 표시 없음' };
  return { label: LABEL, ok: false, detail: `알 수 없음 — 데스크톱 웹 테스트가 모두 BLOCKED됩니다: ${unknownDetail(unknown)}`, hint: CLEAR_HINT };
}

/**
 * `qa setup --browsers`: clears the marker under the display lock, so a qa process that is using the display (and may
 * be about to record an unknown state) is never overridden — then nothing is cleared and the check fails. Clearing
 * assumes the user closed the leftover automation browser windows, and says so.
 */
export function clearDisplayState(opts: { dir?: string } = {}): Check {
  let lock;
  try {
    lock = acquireDisplayLock(opts);
  } catch (err) {
    if (!(err instanceof DeviceLockedError)) throw err;
    return { label: LABEL, ok: false, detail: `표시를 지우지 않았습니다 — ${err.message}`, hint: '그 qa 실행이 끝난 뒤 `qa setup --browsers`를 다시 실행하세요' };
  }
  try {
    const unknown = readDisplayUnknown(opts);
    if (unknown === null) return { label: LABEL, ok: true, detail: '확인됨 — 지울 표시 없음' };
    clearDisplayUnknown(opts);
    return {
      label: LABEL,
      ok: true,
      detail: `"알 수 없음" 표시를 지웠습니다: ${unknownDetail(unknown)}. 남은 자동화 브라우저 창을 닫았다고 보고 데스크톱 웹 테스트를 다시 허용합니다 — 아직 창이 남아 있으면 지금 닫으세요`,
    };
  } finally {
    lock.release();
  }
}
