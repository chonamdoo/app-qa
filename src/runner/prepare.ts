// Action preparation (architecture §5 위험 정책, §11, invariants 4–5): a mutation is approved only on the final fresh
// observation, never a truncated one — refind + hit-test (after scroll/swipe/back: the target must hold still) →
// deterministic policy on the fresh target and screen → mandatory Jev commit check for deterministically safe targets
// without `allowRisky` → after that wait, a new observation must show the same screen and target, hit-tested again at
// its tap point on that observation, and (drivers with element identity) the same element at that point — for Enter,
// the same focused element → one explicit approval result carrying that target. Nothing here dispatches; the session
// acts only on `approved`.
import type { Candidate, ClaimDecision, Point, Rect, ScreenModel } from '../core/types.ts';
import { isUnoccludedAt, refind } from '../observe/index.ts';
import { assessRisk, DESTRUCTIVE_CONTEXT, type RiskAssessment } from '../policy/risk.ts';
import type { DecisionSummary } from '../report/types.ts';
import type { AppProfile } from '../spec/schema.ts';
import { nodeOf } from './resolve.ts';

/** One observation: the screen model and the screenshot taken with it (if any). */
export interface Obs {
  model: ScreenModel;
  png: Uint8Array | null;
  ocr: boolean;
}

export type TargetSource = 'selector' | 'fast_path' | 'jev';

/**
 * What the action does: `activate` (tap, longPress), `edit` a field's text (type, clear), `submit` a form or dialog
 * (Enter: `press: enter`, and `type.submit` after the text is typed). Every one needs the Jev commit check on a
 * deterministically safe target; submission also treats a destructive-dialog screen as risky whatever the field is
 * called. Editing also needs an editable target.
 */
export type Mutation = 'activate' | 'edit' | 'submit';

/** Why nothing is dispatched: see `Approval`. */
export type Refusal = 'blocked_by_policy' | 'commit_check_unavailable' | 'stale_target' | 'not_editable' | 'observation_truncated';

export type Approval<T extends object> = ({ status: 'approved' } & T) | { status: Refusal; reason: string };

/**
 * A target-based mutation is never approved on a truncated observation (`depthCapped`: the web node cap, the iOS depth
 * cap): the cut part may hold a target of the same name (uniqueness) or destructive text (the policy).
 */
export const TRUNCATED_TARGET = '화면 구조가 잘려 관찰됨(노드·깊이 상한) — 잘린 부분에 같은 이름의 대상이나 위험 문구가 있을 수 있어 실행하지 않음';

/** A resolution result (the session's resolver); only the reason of a failure is used here. */
export type Resolution = { ok: true; candidate: Candidate; source: TargetSource; obs: Obs } | { ok: false; outcome: { reason: string } };

/** What preparation needs from the session; `Ctx` is the session's step context, passed back untouched. */
export interface PrepareHost<Ctx> {
  readonly profile: AppProfile;
  readonly clock: { now(): number; sleep(ms: number): Promise<void> };
  /** A fresh observation; `screenshot` takes the screen image with it (the settle baseline after a commit check). */
  observe(ocr: 'force' | 'never', screenshot: boolean): Promise<Obs>;
  /** The previous mutation was a scroll/swipe/back (`back` or `press: back`)/hideKeyboard: content may still be moving. */
  recentScroll(): boolean;
  /** The driver's hit-test of a tap at `p` on the element box `target` (iOS WDA, desktop `elementFromPoint`); undefined = cannot tell. */
  isHittable(p: Point, target: Rect | null): Promise<boolean | undefined>;
  /**
   * The identity of the element that receives a tap at `p` (desktop web: the page's element reference), null = nothing
   * there; undefined = the driver has none (native, mobile web: the tree path, resource id, box and state identify it).
   */
  elementIdAt(p: Point): Promise<string | null | undefined>;
  /** The identity of the element keys go to (desktop web: the focused element's reference), null = none; undefined as `elementIdAt`. */
  focusedElementId(): Promise<string | null | undefined>;
  /** Why Jev must not judge commits now (no client, no calibration, a failed gate, a surface the gate was not calibrated on), or null. */
  commitProblem(): string | null;
  /** Asks Jev (budgeted, receipt kept) whether activating `target` on `model` commits an irreversible change. */
  judgeCommit(ctx: Ctx, model: ScreenModel, target: Candidate): Promise<ClaimDecision>;
  /** Records a decision on the step (result + `decision` event). */
  decide(ctx: Ctx, decision: DecisionSummary): void;
  /** Emits the `policy` event. */
  policy(ctx: Ctx, risky: boolean, blocked: boolean, reasons: string[]): void;
}

const STABILIZE_POLL_MS = 100;
const STABILIZE_CAP_MS = 3000;
/** Rect drift (tap coordinates) still counted as the same place across two observations: sub-pixel rounding only. */
const SAME_RECT_TOLERANCE = 2;

const JEV_RISKY = '위험 요소는 Jev로 선택할 수 없습니다 — selector 또는 정확한 라벨을 쓰세요';

type Fresh = { ok: true; candidate: Candidate; obs: Obs } | { ok: false; reason: string; obs: Obs; moving: boolean };

/** Enter/submit confirms whatever form or dialog is shown: the field's own label rules plus the destructive-dialog context. */
function submitRisk(field: Candidate | null, model: ScreenModel, profile: AppProfile): RiskAssessment {
  const risk = assessRisk(field, model, profile);
  const hit = model.texts.map((t) => DESTRUCTIVE_CONTEXT.find((re) => re.test(t))).find((re) => re !== undefined);
  if (hit) risk.reasons.push(`파괴적 확인 대화상자 문맥(${hit.source})에서 제출(Enter)`);
  risk.risky = risk.reasons.length > 0;
  return risk;
}

/** A text field: input / secure-input role, or a tree node the platform reports as editable. */
function isEditable(c: Candidate, model: ScreenModel): boolean {
  if (c.role === 'input' || c.role === 'secure-input') return true;
  return c.source === 'tree' && nodeOf(model, c.nodeId)?.flags.editable === true;
}

/**
 * The target as `now` shows it, or why the approval no longer holds: another node, a moved rect (beyond sub-pixel
 * rounding) or another state (e.g. focus moved away from the field Enter submits). The rest of the screen may change
 * (clocks, live counters); what matters there is re-judged by the deterministic policy on `now`.
 */
function targetNow(target: Candidate, now: ScreenModel): { candidate: Candidate } | { reason: string } {
  const cur = refind(target, now);
  if (!cur || cur.nodeId !== target.nodeId) return { reason: `"${target.name}"이(가) 같은 요소로 남아 있지 않음` };
  if ((['x', 'y', 'width', 'height'] as const).some((k) => Math.abs(cur.rect[k] - target.rect[k]) > SAME_RECT_TOLERANCE)) return { reason: `"${target.name}" 위치가 바뀜` };
  if (cur.state.join() !== target.state.join()) return { reason: `"${target.name}" 상태가 바뀜 (${target.state.join(',') || '없음'} → ${cur.state.join(',') || '없음'})` };
  return { candidate: cur };
}

export class ActionPreparer<Ctx> {
  private readonly host: PrepareHost<Ctx>;

  constructor(host: PrepareHost<Ctx>) {
    this.host = host;
  }

  /**
   * Target-based mutation of a resolved candidate. A target that is gone, covered or not hittable on the fresh
   * observation is re-resolved once (`reresolve`, when given); one that keeps moving after a scroll is stale at once.
   * An `edit` whose fresh target is not a text field is `not_editable` (the driver taps the target before typing).
   */
  async target(
    ctx: Ctx,
    resolved: { candidate: Candidate; source: TargetSource },
    mutation: Mutation,
    allowRisky: boolean,
    reresolve: ((obs: Obs) => Promise<Resolution>) | null,
  ): Promise<Approval<{ candidate: Candidate; obs: Obs }>> {
    let source = resolved.source;
    let fresh = await this.freshen(resolved.candidate);
    const cut = this.truncated(ctx, fresh.obs, '');
    if (cut) return cut;
    if (!fresh.ok) {
      if (fresh.moving || !reresolve) return { status: 'stale_target', reason: `대상이 바뀜: ${fresh.reason}` };
      const again = await reresolve(fresh.obs);
      if (!again.ok) return { status: 'stale_target', reason: `대상이 바뀜: ${fresh.reason}; 재해석 실패: ${again.outcome.reason}` };
      const second = await this.freshen(again.candidate);
      const cutAgain = this.truncated(ctx, second.obs, '');
      if (cutAgain) return cutAgain;
      if (!second.ok) return { status: 'stale_target', reason: `대상이 바뀜: ${fresh.reason}; 재해석 후에도 ${second.reason}` };
      source = again.source;
      fresh = second;
    }
    if (mutation === 'edit' && !isEditable(fresh.candidate, fresh.obs.model)) {
      return { status: 'not_editable', reason: `"${fresh.candidate.name}"(${fresh.candidate.role})은(는) 입력 필드가 아님 — 입력·지우기 대상은 편집 가능한 필드여야 합니다` };
    }
    const verdict = await this.judge(ctx, fresh.candidate, source === 'jev', fresh.obs, mutation, allowRisky);
    return verdict.status === 'approved' ? { status: 'approved', candidate: verdict.target, obs: verdict.obs } : verdict;
  }

  /**
   * Enter (`press: enter`, `type.submit` after typing): the focused field (none = risk unknown) on a fresh observation.
   * The approved `obs` is the last observation before Enter.
   */
  async focused(ctx: Ctx, allowRisky: boolean): Promise<Approval<{ obs: Obs }>> {
    const obs = await this.host.observe('never', false);
    const cut = this.truncated(ctx, obs, '');
    if (cut) return cut;
    const field = obs.model.candidates.find((c) => c.state.includes('focused')) ?? null;
    return this.judge(ctx, field, false, obs, 'submit', allowRisky);
  }

  /** A target without a fresh screen element (`open` URL, `tapAt` coordinates): deterministic label policy only. */
  label(ctx: Ctx, risk: RiskAssessment, allowRisky: boolean): Approval<object> {
    if (risk.risky && !allowRisky) return this.block(ctx, risk.reasons, false);
    this.host.policy(ctx, risk.risky, false, risk.reasons);
    return { status: 'approved' };
  }

  /** `open` on a website: a URL outside the profile origins is refused whatever `allowRisky` says (the origins are the authorization). */
  navigation(ctx: Ctx, problem: string | null): Approval<object> {
    if (problem === null) return { status: 'approved' };
    this.host.policy(ctx, true, true, [problem]);
    return { status: 'blocked_by_policy', reason: `허용 범위 밖 이동 차단: ${problem}` };
  }

  /**
   * Policy, then the commit check. An approval carries the observation and target to act on: after a commit check, a
   * newer observation with its screenshot (what the action's effect is measured from: a change while Jev answered is
   * not the action's) and the target as it shows it (its tap point recomputed around anything that appeared meanwhile).
   */
  private judge(ctx: Ctx, target: Candidate, viaJev: boolean, obs: Obs, mutation: Mutation, allowRisky: boolean): Promise<Approval<{ obs: Obs; target: Candidate }>>;
  private judge(ctx: Ctx, target: Candidate | null, viaJev: boolean, obs: Obs, mutation: Mutation, allowRisky: boolean): Promise<Approval<{ obs: Obs; target: Candidate | null }>>;
  private async judge(ctx: Ctx, target: Candidate | null, viaJev: boolean, obs: Obs, mutation: Mutation, allowRisky: boolean): Promise<Approval<{ obs: Obs; target: Candidate | null }>> {
    const { model } = obs;
    const risk = mutation === 'submit' ? submitRisk(target, model, this.host.profile) : assessRisk(target, model, this.host.profile);
    // Risky elements act only through selector/fast path: allowRisky never unlocks a Jev-grounded risky target.
    if (risk.risky && viaJev) return this.block(ctx, [...risk.reasons, JEV_RISKY], allowRisky);
    if (risk.risky && !allowRisky) return this.block(ctx, risk.reasons, false);
    // Every target-based mutation of a deterministically safe target needs the commit check — an edit included: typing
    // into or clearing a field can still auto-save or search, and only Jev can add that refusal.
    if (!risk.risky && !allowRisky) {
      // The element the action reaches, identified before Jev is asked: the one at the tap point, for Enter the focused
      // one. A replacement with the same label, box, state and tree position (a re-rendered button or field) is another
      // element, and the approval is not its.
      const submit = mutation === 'submit';
      const before = !target ? undefined : submit ? await this.host.focusedElementId() : await this.host.elementIdAt(target.tapPoint);
      if (target && before === null) return { status: 'stale_target', reason: submit ? `"${target.name}"이(가) 포커스된 요소로 확인되지 않음 — 실행하지 않음` : `"${target.name}" 탭 지점에 요소가 없음 — 실행하지 않음` };
      const commit: Pick<ClaimDecision, 'verdict' | 'reason'> = target ? await this.commit(ctx, model, target) : { verdict: 'error', reason: '대상 없음' };
      // Refusal-add only: 'pass' (commits) blocks, 'fail' lets the deterministic verdict stand, anything else is no answer.
      if (commit.verdict === 'pass') return this.block(ctx, [commit.reason], false);
      if (commit.verdict !== 'fail' || !target) {
        const reason = `Jev commit 확인 불가(${commit.reason}) — 확인 없이 실행하지 않음 (allowRisky로 사람이 승인 가능)`;
        this.host.policy(ctx, false, true, [reason]);
        return { status: 'commit_check_unavailable', reason };
      }
      // The screen may change while Jev answers: the approval holds only if a new observation still shows the same
      // target and the deterministic policy still passes on it (a destructive dialog that appeared meanwhile blocks).
      // A tapped target is hit-tested again at its new tap point: something drawn over part of it moves the point.
      const now = await this.host.observe(target.source === 'ocr' ? 'force' : 'never', true);
      const cut = this.truncated(ctx, now, 'Jev commit 확인 후 ');
      if (cut) return cut;
      const same = targetNow(target, now.model);
      if ('reason' in same) return { status: 'stale_target', reason: `Jev commit 확인 중 ${same.reason} — 실행하지 않음` };
      const riskNow = mutation === 'submit' ? submitRisk(same.candidate, now.model, this.host.profile) : assessRisk(same.candidate, now.model, this.host.profile);
      if (riskNow.risky) return this.block(ctx, [...riskNow.reasons, 'Jev commit 확인 중 화면이 바뀜'], false);
      const hit = mutation === 'submit' ? null : await this.hitProblem(same.candidate, now);
      if (hit) return { status: 'stale_target', reason: `Jev commit 확인 중 ${hit} — 실행하지 않음` };
      if (before !== undefined && (submit ? await this.host.focusedElementId() : await this.host.elementIdAt(same.candidate.tapPoint)) !== before) {
        const what = submit ? `포커스된 "${target.name}"이(가)` : `"${target.name}" 탭 지점의 요소가`;
        return { status: 'stale_target', reason: `Jev commit 확인 중 ${what} 다른 요소로 바뀜 — 실행하지 않음` };
      }
      this.host.policy(ctx, risk.risky, false, risk.reasons);
      return { status: 'approved', obs: now, target: same.candidate };
    }
    this.host.policy(ctx, risk.risky, false, risk.reasons);
    return { status: 'approved', obs, target };
  }

  /** The Jev commit judgement, recorded as a `commit` decision; an unusable Jev is verdict 'error' (never asked). */
  private async commit(ctx: Ctx, model: ScreenModel, target: Candidate): Promise<Pick<ClaimDecision, 'verdict' | 'reason'>> {
    const problem = this.host.commitProblem();
    if (problem) return { verdict: 'error', reason: problem };
    const d = await this.host.judgeCommit(ctx, model, target);
    this.host.decide(ctx, {
      kind: 'commit',
      source: 'jev',
      verdict: d.verdict,
      intent: target.name,
      top: d.pYes === null ? null : [{ key: 'yes', label: '되돌릴 수 없는 변경', p: d.pYes }],
      target: { key: target.key, name: target.name, role: target.role, tapPoint: target.tapPoint },
      model: d.receipt?.model ?? null,
      requestId: d.receipt?.requestId ?? null,
      latencyMs: d.receipt?.latencyMs ?? null,
      reason: d.reason,
    });
    return d;
  }

  private block(ctx: Ctx, reasons: string[], allowRisky: boolean): Approval<never> {
    this.host.policy(ctx, true, true, reasons);
    return { status: 'blocked_by_policy', reason: `위험 동작 차단: ${reasons.join(', ')}${allowRisky ? '' : ' (allowRisky 필요)'}` };
  }

  /** The refusal of a target-based mutation on a truncated observation (see `TRUNCATED_TARGET`), or null. */
  private truncated(ctx: Ctx, obs: Obs, when: string): Approval<never> | null {
    if (!obs.model.snapshot.depthCapped) return null;
    const reason = `${when}${TRUNCATED_TARGET}`;
    this.host.policy(ctx, false, true, [reason]);
    return { status: 'observation_truncated', reason };
  }

  /** Fresh observation → refind → hit-test; after scroll/swipe/back the rect must repeat in two consecutive observations. */
  private async freshen(c: Candidate): Promise<Fresh> {
    const { host } = this;
    const ocr = c.source === 'ocr' ? 'force' : 'never';
    let obs = await host.observe(ocr, false);
    let cur = refind(c, obs.model);
    if (host.recentScroll()) {
      const until = host.clock.now() + STABILIZE_CAP_MS;
      for (;;) {
        if (host.clock.now() >= until) return { ok: false, moving: true, obs, reason: `스크롤 후 "${c.name}" 위치가 ${STABILIZE_CAP_MS}ms 안에 안정되지 않음` };
        await host.clock.sleep(STABILIZE_POLL_MS);
        const prev = cur?.rect ?? null;
        obs = await host.observe(ocr, false);
        cur = refind(c, obs.model);
        if (cur && prev && cur.rect.x === prev.x && cur.rect.y === prev.y && cur.rect.width === prev.width && cur.rect.height === prev.height) break;
      }
    }
    if (!cur) return { ok: false, moving: false, reason: `재관찰에서 "${c.name}"을(를) 다시 찾지 못함`, obs };
    const hit = await this.hitProblem(cur, obs);
    return hit ? { ok: false, moving: false, reason: hit, obs } : { ok: true, candidate: cur, obs };
  }

  /** Why a tap at `c.tapPoint` would not reach `c` on `obs` (another element drawn over it, the driver's hit-test), or null. */
  private async hitProblem(c: Candidate, obs: Obs): Promise<string | null> {
    const node = c.source === 'tree' ? nodeOf(obs.model, c.nodeId) : undefined;
    if (node && !isUnoccludedAt(obs.model.snapshot.nodes, node, c.tapPoint)) return `"${c.name}" 탭 지점을 다른 요소가 덮고 있음`;
    return (await this.host.isHittable(c.tapPoint, node ? node.rect : null)) === false ? `"${c.name}" isHittable=false` : null;
  }
}
