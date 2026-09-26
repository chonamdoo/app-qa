// Deterministic target resolution (architecture §5): selector (exact) → fast path (unique normalized label) → hand-off
// to Jev grounding. `within` narrows to a container, `nth` picks in reading order, `near` picks the closest match.
import type { Candidate, Point, RawNode, Rect, ScreenModel } from '../core/types.ts';
import { normLabel } from '../observe/index.ts';
import { cleanText } from '../observe/text.ts';
import type { StateFilter, Target, TextMatch } from '../spec/schema.ts';
import type { z } from 'zod';

export type TargetSpec = z.infer<typeof Target>;
export type SelectorSpec = Exclude<TargetSpec, string>;
type TextMatchSpec = z.infer<typeof TextMatch>;
type StateSpec = z.infer<typeof StateFilter>;

export interface TargetQuery {
  target: TargetSpec;
  within?: string;
  nth?: number;
  near?: string;
  /**
   * What the step will do with the target. `edit` (type/clear) only ever acts on a text field, so equal labels narrow
   * to editable candidates (a form's `<label>` and its field share one name); `act` (tap/longPress) prefers the one
   * actionable candidate among equal labels over plain text.
   */
  purpose?: 'edit' | 'act';
}

const EDITABLE_ROLES: ReadonlySet<Candidate['role']> = new Set(['input', 'secure-input']);

/** Equal matches narrowed by what the step does; never narrows to nothing. */
function forPurpose(matches: Candidate[], purpose: TargetQuery['purpose']): Candidate[] {
  const narrowed =
    purpose === 'edit' ? matches.filter((c) => EDITABLE_ROLES.has(c.role)) : purpose === 'act' && matches.length > 1 ? matches.filter((c) => c.actionable) : matches;
  return narrowed.length > 0 && (purpose === 'edit' || narrowed.length === 1) ? narrowed : matches;
}

export type Deterministic =
  | { kind: 'found'; candidate: Candidate; source: 'selector' | 'fast_path'; reason: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'not_found'; reason: string }
  /** No deterministic answer: ask Jev to ground `intent` among `pool`. */
  | { kind: 'jev'; pool: Candidate[]; intent: string; reason: string };

export function asSelector(target: TargetSpec): SelectorSpec {
  return typeof target === 'string' ? { intent: target } : target;
}

/** Human description of a target for reasons and Jev intents. */
export function targetText(target: TargetSpec): string {
  if (typeof target === 'string') return target;
  const parts: string[] = [];
  if (target.intent) parts.push(target.intent);
  for (const key of ['text', 'desc', 'id'] as const) {
    const m = target[key];
    if (m !== undefined) parts.push(`${key}=${typeof m === 'string' ? `"${m}"` : `/${m.regex}/${m.flags ?? ''}`}`);
  }
  return parts.join(' ');
}

const nodeMaps = new WeakMap<ScreenModel, Map<string, RawNode>>();

export function nodeOf(model: ScreenModel, id: string): RawNode | undefined {
  let map = nodeMaps.get(model);
  if (!map) {
    map = new Map(model.snapshot.nodes.map((n) => [n.id, n]));
    nodeMaps.set(model, map);
  }
  return map.get(id);
}

function textMatches(m: TextMatchSpec, value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof m === 'string') return cleanText(value) === cleanText(m);
  return new RegExp(m.regex, m.flags).test(value);
}

function selectorMatches(model: ScreenModel, c: Candidate, sel: SelectorSpec): boolean {
  const node = c.source === 'tree' ? nodeOf(model, c.nodeId) : undefined;
  if (sel.text !== undefined && !textMatches(sel.text, c.name) && !textMatches(sel.text, node?.text)) return false;
  if (sel.desc !== undefined && !textMatches(sel.desc, node?.desc)) return false;
  if (sel.id !== undefined) {
    const rid = node?.resourceId;
    if (!rid || !(textMatches(sel.id, rid) || textMatches(sel.id, rid.slice(rid.lastIndexOf('/') + 1)))) return false;
  }
  return true;
}

export function stateMatches(c: Candidate, state: StateSpec | undefined): boolean {
  if (!state) return true;
  if (state.enabled !== undefined && state.enabled === c.state.includes('disabled')) return false;
  if (state.checked !== undefined && state.checked !== c.state.includes('checked')) return false;
  if (state.selected !== undefined && state.selected !== c.state.includes('selected')) return false;
  if (state.focused !== undefined && state.focused !== c.state.includes('focused')) return false;
  return true;
}

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Rect of the element labelled exactly `label` (candidates first, then any visible raw node by desc/text/id).
 * A leaf label node (no children) stands for its parent group. Null with a reason when absent or not unique.
 */
function labelledRect(model: ScreenModel, label: string): { rect: Rect; exclude: string | null } | { rect: null; reason: string } {
  const want = normLabel(label);
  const cands = model.candidates.filter((c) => normLabel(c.name) === want);
  let node: RawNode | undefined;
  if (cands.length > 1) return { rect: null, reason: `"${label}" 일치 ${cands.length}개` };
  if (cands.length === 1) {
    node = cands[0]!.source === 'tree' ? nodeOf(model, cands[0]!.nodeId) : undefined;
    if (!node) return { rect: cands[0]!.rect, exclude: cands[0]!.key };
  } else {
    const occluded = new Set(model.occludedNodeIds);
    const nodes = model.snapshot.nodes.filter(
      (n) => !occluded.has(n.id) && [n.desc, n.text, n.resourceId].some((v) => v !== null && normLabel(v) === want),
    );
    if (nodes.length !== 1) return { rect: null, reason: nodes.length ? `"${label}" 일치 ${nodes.length}개` : `"${label}" 없음` };
    node = nodes[0]!;
  }
  const group = node.childIds.length === 0 && node.parentId ? (nodeOf(model, node.parentId) ?? node) : node;
  return { rect: group.rect, exclude: cands[0]?.key ?? null };
}

/** Among equal matches: nth (reading order) or the one nearest `near`; ambiguous otherwise. */
function pick(model: ScreenModel, matches: Candidate[], q: TargetQuery, what: string): { candidate: Candidate } | { kind: 'ambiguous' | 'not_found'; reason: string } {
  const sorted = [...matches].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (q.nth !== undefined) {
    const c = sorted[q.nth - 1];
    return c ? { candidate: c } : { kind: 'not_found', reason: `${what} ${sorted.length}개 — ${q.nth}번째 없음` };
  }
  if (sorted.length === 1) return { candidate: sorted[0]! };
  if (q.near !== undefined) {
    const anchor = labelledRect(model, q.near);
    if (!anchor.rect) return { kind: 'ambiguous', reason: `${what} ${sorted.length}개, near 기준 ${anchor.reason}` };
    const a = center(anchor.rect);
    const dist = (c: Candidate) => Math.hypot(center(c.rect).x - a.x, center(c.rect).y - a.y);
    const byDistance = sorted.sort((x, y) => dist(x) - dist(y));
    if (dist(byDistance[0]!) === dist(byDistance[1]!)) return { kind: 'ambiguous', reason: `${what} ${sorted.length}개, near 기준에서 거리가 같음` };
    return { candidate: byDistance[0]! };
  }
  return { kind: 'ambiguous', reason: `${what} ${sorted.length}개 — nth 또는 near로 지정하세요 (문구 수정 필요)` };
}

/** Candidate pool after `within`, or a not_found when the container itself cannot be located. */
function scopedPool(model: ScreenModel, within: string | undefined): { pool: Candidate[] } | { reason: string } {
  if (within === undefined) return { pool: model.candidates };
  const container = labelledRect(model, within);
  if (!container.rect) return { reason: `within 컨테이너 ${container.reason}` };
  const rect = container.rect;
  return {
    pool: model.candidates.filter((c) => {
      const p = center(c.rect);
      return c.key !== container.exclude && p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;
    }),
  };
}

export function resolveDeterministic(model: ScreenModel, q: TargetQuery): Deterministic {
  const sel = asSelector(q.target);
  const scoped = scopedPool(model, q.within);
  if ('reason' in scoped) return { kind: 'not_found', reason: scoped.reason };
  let pool = scoped.pool;
  if (sel.text !== undefined || sel.desc !== undefined || sel.id !== undefined) {
    const matches = pool.filter((c) => selectorMatches(model, c, sel));
    if (matches.length === 0) return { kind: 'not_found', reason: `셀렉터(${targetText({ ...sel, intent: undefined })})와 일치하는 요소 없음` };
    const ok = forPurpose(matches.filter((c) => stateMatches(c, sel.state)), q.purpose);
    if (ok.length === 0) return { kind: 'not_found', reason: `셀렉터 일치 ${matches.length}개, 상태 조건 불일치 ${JSON.stringify(sel.state)}` };
    if (sel.intent === undefined || ok.length === 1 || q.nth !== undefined || q.near !== undefined) {
      const r = pick(model, ok, q, '셀렉터 일치');
      return 'candidate' in r ? { kind: 'found', candidate: r.candidate, source: 'selector', reason: `셀렉터 일치 "${r.candidate.name}"` } : r;
    }
    pool = ok; // selector narrowed; the intent decides among the rest
  }
  const intent = sel.intent!;
  const want = normLabel(intent);
  const labelled = pool.filter((c) => normLabel(c.name) === want);
  // A state filter narrows equal labels (e.g. the focused one of a label + input pair) before uniqueness is judged.
  const ok = forPurpose(labelled.filter((c) => stateMatches(c, sel.state)), q.purpose);
  if (labelled.length > 0 && ok.length === 0) return { kind: 'not_found', reason: `라벨 일치 ${labelled.length}개, 상태 조건 불일치 ${JSON.stringify(sel.state)}` };
  if (ok.length === 1 || (ok.length > 1 && (q.nth !== undefined || q.near !== undefined))) {
    const r = pick(model, ok, q, '라벨 일치');
    return 'candidate' in r ? { kind: 'found', candidate: r.candidate, source: 'fast_path', reason: `라벨 유일 일치 "${r.candidate.name}"` } : r;
  }
  return {
    kind: 'jev',
    pool,
    intent,
    reason: labelled.length ? `라벨 일치 ${labelled.length}개 (유일하지 않음)` : '정확히 일치하는 라벨 없음',
  };
}

function isAncestor(model: ScreenModel, ancestorId: string, n: RawNode): boolean {
  for (let p = n.parentId; p !== null; p = nodeOf(model, p)?.parentId ?? null) if (p === ancestorId) return true;
  return false;
}

/** Why a target was not found: container match, matches elsewhere on the screen, matches hidden behind an overlay. */
export function notFoundDiagnostics(model: ScreenModel, q: TargetQuery): string[] {
  const sel = asSelector(q.target);
  const out: string[] = [];
  const label = sel.intent !== undefined ? normLabel(sel.intent) : null;
  const matchesCandidate = (c: Candidate) =>
    sel.text !== undefined || sel.desc !== undefined || sel.id !== undefined ? selectorMatches(model, c, sel) : normLabel(c.name) === label;
  if (q.within !== undefined) {
    const scoped = scopedPool(model, q.within);
    if ('reason' in scoped) out.push(`within "${q.within}": ${scoped.reason}`);
    else {
      out.push(`within "${q.within}" 컨테이너 일치 (내부 후보 ${scoped.pool.length}개)`);
      const inPool = new Set(scoped.pool.map((c) => c.key));
      const elsewhere = model.candidates.filter((c) => !inPool.has(c.key) && matchesCandidate(c)).length;
      if (elsewhere) out.push(`컨테이너 밖에서 일치 ${elsewhere}개`);
    }
  } else {
    const n = model.candidates.filter(matchesCandidate).length;
    if (n) out.push(`화면에서 일치 ${n}개 (상태/순번 조건 확인)`);
  }
  const occluded = model.occludedNodeIds
    .map((id) => nodeOf(model, id))
    .filter((n): n is RawNode => n !== undefined)
    .filter((n) => {
      if (sel.text !== undefined || sel.desc !== undefined || sel.id !== undefined) {
        return (
          (sel.text === undefined || textMatches(sel.text, n.text) || textMatches(sel.text, n.desc)) &&
          (sel.desc === undefined || textMatches(sel.desc, n.desc)) &&
          (sel.id === undefined || textMatches(sel.id, n.resourceId))
        );
      }
      return [n.desc, n.text].some((v) => v !== null && label !== null && normLabel(v).includes(label));
    })
    // A labelled button and its own text child are one hidden element.
    .filter((n, _i, all) => !all.some((o) => o !== n && isAncestor(model, o.id, n)));
  if (occluded.length) out.push(`다른 요소에 가려진 일치 ${occluded.length}개 (예: "${cleanText(occluded[0]!.desc ?? occluded[0]!.text ?? '')}")`);
  if (!out.length) out.push('화면 어디에도 일치 없음');
  return out;
}
