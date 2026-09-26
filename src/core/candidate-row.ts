// Jev wire format for one candidate (no coordinates). A contract: observe's inspect table and Jev questions share it.
import type { Candidate } from './types.ts';

const NO_NAME = '(이름 없음)';

/**
 * One Jev row: "e3 | button | 항공편 찾기 | disabled | bottom". Always five columns; state is comma-joined, prefixed
 * by value="…" when the value differs from the name, "-" when empty. `|` inside text is replaced by `¦`, so text sent
 * off the machine is redacted field by field before this, never on the finished row.
 */
export function candidateRow(c: Candidate): string {
  const state = [...(c.value !== null && c.value !== c.name ? [`value="${c.value}"`] : []), ...c.state].join(', ');
  return `${c.key} | ${c.role} | ${c.name.replaceAll('|', '¦') || NO_NAME} | ${state.replaceAll('|', '¦') || '-'} | ${c.region}`;
}
