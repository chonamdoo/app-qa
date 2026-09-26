// Jev candidate rows (no coordinates) and the human-readable `qa inspect` table.
import type { Candidate, ScreenModel } from '../core/types.ts';
import { isActionable, ownLabel, roleOf } from './normalize.ts';
import { normLabel } from './text.ts';

const NO_NAME = '(이름 없음)';
const NAME_WIDTH = 40;
const CELL_WIDTH = 24;

/**
 * One Jev row: "e3 | button | 항공편 찾기 | disabled | bottom". Always five columns; state is comma-joined, prefixed
 * by value="…" when the value differs from the name, "-" when empty. `|` inside text is replaced by `¦`.
 */
export function candidateRow(c: Candidate): string {
  const state = [...(c.value !== null && c.value !== c.name ? [`value="${c.value}"`] : []), ...c.state].join(', ');
  return `${c.key} | ${c.role} | ${c.name.replaceAll('|', '¦') || NO_NAME} | ${state.replaceAll('|', '¦') || '-'} | ${c.region}`;
}

export function candidateRows(model: ScreenModel): string[] {
  return model.candidates.map(candidateRow);
}

/** East Asian wide/fullwidth code points take two terminal columns. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

/** Truncates to `max` columns with an ellipsis. */
function clampWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/**
 * `qa inspect` table: every candidate (key, role, name, value, state, region, tap point, flags) followed by the
 * named actionable nodes hidden by occlusion. Flags: 유일 = normalized name unique on screen (fast-path eligible),
 * OCR = OCR line, 가림 = fully occluded (not a candidate).
 */
export function renderCandidateTable(model: ScreenModel): string {
  const counts = new Map<string, number>();
  for (const c of model.candidates) {
    const key = normLabel(c.name);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const header = ['키', '역할', '이름', '값', '상태', '영역', '탭', '표시'];
  const rows: string[][] = model.candidates.map((c) => {
    const flags = [...(counts.get(normLabel(c.name)) === 1 ? ['유일'] : []), ...(c.source === 'ocr' ? ['OCR'] : [])];
    return [
      c.key,
      c.role,
      c.name || NO_NAME,
      c.value ?? '',
      c.state.join(','),
      c.region,
      `${c.tapPoint.x},${c.tapPoint.y}`,
      flags.join(','),
    ];
  });
  const byId = new Map(model.snapshot.nodes.map((n) => [n.id, n]));
  for (const id of model.occludedNodeIds) {
    const n = byId.get(id);
    if (!n) continue;
    const name = ownLabel(n);
    const role = roleOf(n, model.snapshot.platform);
    if (name === null || !isActionable(n, role)) continue;
    rows.push(['-', role, name, '', '', '', '', '가림']);
  }
  const all = [header, ...rows].map((r) => r.map((cell, col) => clampWidth(cell, col === 2 ? NAME_WIDTH : CELL_WIDTH)));
  const widths = header.map((_, col) => Math.max(...all.map((r) => displayWidth(r[col]!))));
  const lines = all.map((r) => r.map((cell, col) => cell + ' '.repeat(widths[col]! - displayWidth(cell))).join('  ').trimEnd());
  lines.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '));
  const summary = [
    `후보 ${model.candidates.length}개`,
    `가림 ${rows.length - model.candidates.length}개`,
    `텍스트 ${model.texts.length}줄`,
    ...(model.sparse ? ['희소 화면'] : []),
    ...(model.overflow ? ['후보 254개 초과'] : []),
  ].join(' · ');
  return `${lines.join('\n')}\n${summary}\n`;
}
