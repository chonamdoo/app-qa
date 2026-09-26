// Executes one test on one platform (architecture §5 + §11): observe → resolve → prepare (freshness, policy, commit check
// on the final fresh observation) → journal → act → settle → health → expect, with budgets, interrupts, variables,
// subflows and fail-closed verdicts for every step. Every write goes through the session's evidence sanitizer.
import { dirname, resolve as resolvePath } from 'node:path';
import type { ActionKind, QaEventBody } from '../core/events.ts';
import type {
  ActionOutcome,
  AppTarget,
  Candidate,
  DeviceInfo,
  Driver,
  GroundingDecision,
  HealthFinding,
  JevReceipt,
  Platform,
  Point,
  Rect,
  ScreenModel,
  Verdict,
} from '../core/types.ts';
import type { JevClient } from '../jev/client.ts';
import { JEV_MODEL } from '../jev/config.ts';
import { groundChoice, judgeClaim, judgeCommit, judgeWhich } from '../jev/decide.ts';
import { usableGate, type CalibratedPrimitive, type Calibration } from '../jev/gates.ts';
import { buildScreenModel, refind, type OcrLine } from '../observe/index.ts';
import { cleanText } from '../observe/text.ts';
import type { DecisionSummary, StepResult, TestResult } from '../report/types.ts';
import type { LoadedTest } from '../spec/load.ts';
import type { Condition as ConditionSchema, Expectation as ExpectationSchema, RepeatStepSpec, StepKind, StepSpec, TextMatch, WhichStepSpec } from '../spec/schema.ts';
import { stepKind } from '../spec/steps.ts';
import type { z } from 'zod';
import { checkHealth } from './health.ts';
import { dHash, decodePng, hammingHex, type Raster } from './image.ts';
import { findTabs, screenSlug, writeInventory } from './inventory.ts';
import { assessRisk, labelRisk } from '../policy/risk.ts';
import { ActionPreparer, type Approval, type Mutation, type Obs } from './prepare.ts';
import { asSelector, notFoundDiagnostics, resolveDeterministic, stateMatches, targetText, type TargetQuery, type TargetSpec } from './resolve.ts';
import { groupData, judgeLines, ruleProblem, type LineMatch } from './rule.ts';
import { EvidenceSanitizer, maskValue, SanitizedStore } from './sanitize.ts';
import { expandStep, stepLabel, UnsetVariableError } from './steps.ts';
import type { RunStore } from './store.ts';
import { worstVerdict } from './verdict.ts';

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface JevSetup {
  client: JevClient | null;
  calibration: Calibration | null;
  /** Why Jev cannot be used at all (config/calibration file error), shown on Jev steps. */
  problem: string | null;
}

export type OcrFn = (png: Uint8Array, screen: Rect) => Promise<OcrLine[]>;

export interface SessionEnv {
  runId: string;
  store: RunStore;
  driver: Driver;
  device: DeviceInfo;
  clock: Clock;
  jev: JevSetup;
  ocr: OcrFn | null;
  /** Posix path of the test file relative to the project root (for results). */
  relFile: string | null;
  signal?: AbortSignal;
}

type TextMatchSpec = z.infer<typeof TextMatch>;
type Phase = StepResult['phase'];

export const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 150;
const STABLE_GAP_MS = 250;
const HOLD_MS = 500;
const DHASH_SAME = 4;
const DHASH_DIFF = 7;
const MAX_REPEAT = 10;
const MAX_INTERRUPT_ROUNDS = 10;
const DEFAULT_BUDGET = { steps: 80, seconds: 600, jevCalls: 120 };
/** Findings whose FAIL attaches crash artifacts (the app died or was replaced). */
const CRASH_KINDS: Record<string, true> = { app_not_foreground: true, crash_dialog: true, anr_dialog: true, rn_redbox: true };

const HEALTH_LABEL: Record<HealthFinding['kind'], string> = {
  app_not_foreground: '앱이 포그라운드가 아님',
  crash_dialog: '앱 크래시 대화상자',
  anr_dialog: '앱 응답 없음(ANR)',
  rn_redbox: 'React Native RedBox 오류',
  rn_logbox_error: 'React Native LogBox 오류',
  rn_logbox_warning: 'React Native LogBox 경고',
  flutter_error: 'Flutter 오류',
  blank_screen: '빈 화면',
};

interface Outcome {
  verdict: Verdict;
  code: string | null;
  reason: string;
}

/** Stops the current step with a verdict (never an unexpected error). */
class StepAbort extends Error {
  readonly outcome: Outcome;
  constructor(verdict: Verdict, code: string | null, reason: string) {
    super(reason);
    this.outcome = { verdict, code, reason };
  }
}

interface StepCtx {
  seq: number;
  index: number;
  /** Display path: "3", "3.2", "3.w1.1". */
  path: string;
  label: string;
  phase: Phase;
  dir: string;
  file: string;
  /** Some ancestor (or the step) is optional: failures become SKIPPED. */
  optional: boolean;
  interrupts: boolean;
  decisions: DecisionSummary[];
  receipts: JevReceipt[];
  health: HealthFinding[];
  settle: StepResult['settle'];
  before: string | null;
  after: string | null;
  /** Step-start screenshot bytes (dHash baseline for settle). */
  beforePng: Uint8Array | null;
}

type Resolved = { ok: true; candidate: Candidate; source: 'selector' | 'fast_path' | 'jev'; obs: Obs } | { ok: false; outcome: Outcome; obs: Obs };

/** The approved preparation, or the step's verdict: stale / not editable → FAIL, blocked/unavailable → ERROR (nothing dispatched). */
function approved<T extends object>(approval: Approval<T>): { status: 'approved' } & T {
  if (approval.status === 'approved') return approval;
  throw new StepAbort(approval.status === 'stale_target' || approval.status === 'not_editable' ? 'FAIL' : 'ERROR', approval.status, approval.reason);
}

const PASS = (reason: string): Outcome => ({ verdict: 'PASS', code: null, reason });

function fingerprint(model: ScreenModel): string {
  return `${model.fingerprints.identity}|${model.fingerprints.layout}`;
}

/**
 * Lines deterministic text checks look at: visible texts plus names of tree candidates (RN/Compose fold row text
 * into the accessibility label, e.g. "출국장 4, 대기 8분, 원활").
 */
export function textLines(model: ScreenModel): string[] {
  const lines = new Set(model.texts);
  for (const c of model.candidates) if (c.source === 'tree' && c.name) lines.add(c.name);
  return [...lines];
}

function textFound(m: TextMatchSpec, lines: readonly string[]): string | undefined {
  if (typeof m === 'string') {
    const want = cleanText(m);
    return lines.find((l) => cleanText(l).includes(want));
  }
  const re = new RegExp(m.regex, m.flags);
  return lines.find((l) => re.test(l));
}

/** `until: {text: …}` alone means a text check on visible lines (substring), not an element selector. */
function textOnly(until: TargetSpec | { text: TextMatchSpec }): TextMatchSpec | null {
  if (typeof until !== 'object' || until.text === undefined) return null;
  return Object.keys(until).length === 1 ? until.text : null;
}

function describeMatch(m: TextMatchSpec): string {
  return typeof m === 'string' ? `"${m}"` : `/${m.regex}/${m.flags ?? ''}`;
}

const hashCache = new WeakMap<Uint8Array, string | null>();

function pngHash(png: Uint8Array | null): string | null {
  if (!png) return null;
  if (hashCache.has(png)) return hashCache.get(png)!;
  const raster = decodePng(png);
  const h = raster ? dHash(raster) : null;
  hashCache.set(png, h);
  return h;
}

export class TestSession {
  /** Everything but the raw run store: the session reaches the store only through `out`. */
  private readonly env: Omit<SessionEnv, 'store'>;
  private readonly test: LoadedTest;
  private readonly platform: Platform;
  private readonly app: AppTarget;
  /** The only way this session writes evidence and events: everything passes the evidence sanitizer. */
  private readonly out: SanitizedStore;
  private readonly preparer: ActionPreparer<StepCtx>;
  private readonly budget: { steps: number; seconds: number; jevCalls: number };
  private readonly results: StepResult[] = [];
  private readonly warnings: string[] = [];
  private readonly findings: HealthFinding[] = [];
  private readonly vars = new Map<string, string>();
  private readonly scopes: Record<string, string>[] = [];
  private readonly interruptCounts: number[];
  private readonly interruptFp: (string | null)[];
  private logsPath: string | null = null;
  private readonly crashPaths: string[] = [];
  private seq = 0;
  private actionSeq = 0;
  private stepCount = 0;
  private jevCalls = 0;
  private startedAt = 0;
  private startedIso = '';
  private lastActionAt = 0;
  private recentScroll = false;
  private ocrBroken = false;
  private readonly warned = new Set<string>();
  private readonly testDir: string;

  constructor(env: SessionEnv, test: LoadedTest, platform: Platform, app: AppTarget) {
    const { store, ...rest } = env;
    this.env = rest;
    this.test = test;
    this.platform = platform;
    this.app = app;
    this.out = new SanitizedStore(store, new EvidenceSanitizer(test.profile.redact));
    this.preparer = new ActionPreparer<StepCtx>({
      platform,
      profile: test.profile,
      clock: env.clock,
      observe: (ocr) => this.observe({ ocr }),
      recentScroll: () => this.recentScroll,
      isHittable: async (p) => env.driver.isHittable?.(p),
      commitProblem: () => this.jevProblem('commit'),
      judgeCommit: (ctx, model, target) => this.jevCall(ctx, () => judgeCommit(this.env.jev.client!, model.candidates, target, this.judgeOpts(model))),
      decide: (ctx, d) => this.decide(ctx, d),
      policy: (ctx, risky, blocked, reasons) => this.emitRef(ctx, { type: 'policy', risky, blocked, reasons }),
    });
    this.budget = { ...DEFAULT_BUDGET, ...test.spec.budget };
    this.interruptCounts = (test.spec.when ?? []).map(() => 0);
    this.interruptFp = (test.spec.when ?? []).map(() => null);
    this.testDir = `${test.id}/${platform}`;
  }

  /** The test's `run.started` entry, sanitized like every event: implicit start + setup + steps + teardown labels. */
  static announce(test: LoadedTest, platforms: Platform[]): { id: string; name: string; platforms: Platform[]; steps: string[] } {
    const s = test.spec;
    const steps = [startLabel(test), ...[...(s.setup ?? []), ...s.steps, ...(s.teardown ?? [])].map(stepLabel)];
    return new EvidenceSanitizer(test.profile.redact).deep({ id: test.id, name: s.name, platforms, steps });
  }

  async run(): Promise<TestResult> {
    const spec = this.test.spec;
    this.begin();
    const setup = spec.setup ?? [];
    let index = 0;
    const start = await this.execLeaf(index++, `1 ${startLabel(this.test)}`, 'setup', (ctx) => this.startApp(ctx));
    let stopped = start.verdict !== 'PASS';
    for (const [phase, list] of [
      ['setup', setup],
      ['main', spec.steps],
    ] as const) {
      for (const step of list) {
        const i = index++;
        if (stopped) continue;
        const r = await this.execStep(step, { index: i, path: String(i + 1), phase, file: this.test.file, optional: false, interrupts: true });
        if (r.verdict !== 'PASS' && r.verdict !== 'SKIPPED') stopped = true;
      }
    }
    for (const step of spec.teardown ?? []) {
      const i = index++;
      const r = await this.execStep(step, { index: i, path: String(i + 1), phase: 'teardown', file: this.test.file, optional: false, interrupts: false });
      if (r.verdict !== 'PASS' && r.verdict !== 'SKIPPED') {
        this.warnings.push(`정리 단계 실패(판정 불변): ${r.label}: ${r.reason}`);
        break;
      }
    }
    return this.finish();
  }

  /**
   * Smoke: launch (relaunch) → settle → health (incl. blank) → screenshot + inventory; with `crawl`, visits only
   * role-identified tab bar items (risk-filtered) and returns to the first tab. Jev answers are reference-only.
   */
  async runSmoke(opts: { crawl: boolean; inventoryDir: string }): Promise<TestResult> {
    this.begin();
    const app = this.test.spec.app;
    const platform = this.platform;
    let index = 0;
    const start = await this.execLeaf(index++, `1 ${startLabel(this.test)}`, 'setup', (ctx) => this.startApp(ctx));
    const seen: { home: Obs | null } = { home: null };
    if (start.verdict === 'PASS') {
      await this.execLeaf(index++, '2 화면 점검: launch', 'main', async (ctx) => {
        const home = await this.observeBefore(ctx);
        seen.home = home;
        ctx.after = ctx.before;
        await this.reference(ctx, home);
        writeInventory(opts.inventoryDir, app, platform, 'launch', home.model, 'smoke', this.out.clean);
        return PASS(`인벤토리 저장: 후보 ${home.model.candidates.length}개, 텍스트 ${home.model.texts.length}줄`);
      });
    }
    const first = seen.home;
    if (opts.crawl && first) {
      const tabs = findTabs(first.model).filter((tab) => {
        const risk = assessRisk(tab, first.model, this.test.profile);
        if (risk.risky) this.warnings.push(`위험 탭 건너뜀 "${tab.name}": ${risk.reasons.join(', ')}`);
        return !risk.risky;
      });
      if (!tabs.length) this.warnings.push('역할로 식별되는 탭바가 없어 순회하지 않음');
      let moved = false;
      for (const tab of tabs) {
        const i = index++;
        const r = await this.execLeaf(i, `${i + 1} 탭 순회: ${tab.name}`, 'main', async (ctx) => {
          const obs = await this.observeBefore(ctx);
          if (refind(tab, obs.model)?.state.includes('selected')) {
            ctx.after = ctx.before;
            await this.reference(ctx, obs);
            writeInventory(opts.inventoryDir, app, platform, `tab-${tab.name}`, obs.model, 'smoke', this.out.clean);
            return PASS('이미 선택된 탭 (행동 없음)');
          }
          // Role-identified tree element (deterministic), prepared like any tap on the fresh observation.
          const t = approved(await this.preparer.target(ctx, { candidate: tab, source: 'selector' }, 'activate', false, null));
          await this.act(ctx, 'tap', { point: t.candidate.tapPoint }, () => this.env.driver.tap(t.candidate.tapPoint));
          moved = true;
          const after = await this.settle(ctx, t.obs, true, DEFAULT_TIMEOUT_MS);
          await this.reference(ctx, after);
          writeInventory(opts.inventoryDir, app, platform, `tab-${tab.name}`, after.model, 'smoke', this.out.clean);
          return PASS(`"${tab.name}" 탭 화면 저장`);
        });
        if (r.verdict !== 'PASS') break;
      }
      if (moved) {
        const back = tabs[0]!;
        const i = index++;
        await this.execLeaf(i, `${i + 1} 첫 탭으로 복귀: ${back.name}`, 'main', async (ctx) => {
          const obs = await this.observeBefore(ctx);
          const t = approved(await this.preparer.target(ctx, { candidate: back, source: 'selector' }, 'activate', false, null));
          await this.act(ctx, 'tap', { point: t.candidate.tapPoint }, () => this.env.driver.tap(t.candidate.tapPoint));
          await this.settle(ctx, obs, true, DEFAULT_TIMEOUT_MS);
          return PASS(`"${back.name}" 탭으로 복귀`);
        });
      }
    }
    return this.finish();
  }

  private begin(): void {
    this.startedAt = this.env.clock.now();
    this.lastActionAt = this.startedAt;
    this.startedIso = new Date().toISOString();
    this.out.emit({ type: 'test.started', runId: this.env.runId, testId: this.test.id, platform: this.platform, name: this.test.spec.name });
  }

  /** Smoke reference column: Jev "error or blank?" claim — recorded, never part of the verdict. */
  private async reference(ctx: StepCtx, obs: Obs): Promise<void> {
    const claim = '이 화면은 오류 화면이거나 내용 없이 비어 있다';
    const none = { kind: 'claim' as const, intent: claim, top: null, target: null, model: null, requestId: null, latencyMs: null, reference: true };
    const problem = this.jevProblem('claim');
    if (problem) {
      this.decide(ctx, { ...none, source: 'none', verdict: 'error', reason: `참고용 Jev 판단 불가: ${problem}` });
      return;
    }
    try {
      const d = await this.jevCall(ctx, () => judgeClaim(this.env.jev.client!, obs.model.candidates, claim, this.judgeOpts(obs.model)));
      this.decide(ctx, {
        ...none,
        source: 'jev',
        verdict: d.verdict,
        top: d.pYes === null ? null : [{ key: 'yes', label: '오류/빈 화면', p: d.pYes }],
        model: d.receipt?.model ?? null,
        requestId: d.receipt?.requestId ?? null,
        latencyMs: d.receipt?.latencyMs ?? null,
        reason: `참고용: ${d.reason}`,
      });
    } catch (err) {
      if (!(err instanceof StepAbort)) throw err;
      this.decide(ctx, { ...none, source: 'none', verdict: 'error', reason: `참고용 Jev 생략: ${err.message}` });
    }
  }

  /** The result is sanitized with every secret known by now (summary.json, reports and the server read it). */
  private finish(): TestResult {
    const spec = this.test.spec;
    const counted = this.results.filter((r) => r.phase !== 'teardown');
    const verdict = worstVerdict(counted.map((r) => r.verdict));
    const decisive = [...counted].sort((a, b) => a.seq - b.seq).find((r) => r.verdict === verdict && verdict !== 'PASS');
    const durationMs = Math.round(this.env.clock.now() - this.startedAt);
    const reason = decisive ? `${decisive.label}: ${decisive.reason}` : verdict === 'PASS' ? '모든 스텝 통과' : '실행된 스텝 없음';
    this.out.emit({ type: 'test.finished', runId: this.env.runId, testId: this.test.id, platform: this.platform, verdict, reason, durationMs });
    const result: TestResult = {
      id: this.test.id,
      name: spec.name,
      file: this.env.relFile,
      app: spec.app,
      platform: this.platform,
      deviceId: this.env.device.id,
      deviceName: this.env.device.name,
      verdict,
      code: decisive?.code ?? null,
      reason,
      durationMs,
      covers: spec.covers ?? [],
      tags: spec.tags ?? [],
      status: spec.source?.status ?? null,
      plan: spec.source?.plan ?? null,
      steps: [...this.results].sort((a, b) => a.seq - b.seq),
      warnings: this.warnings,
      health: this.findings,
      logs: this.logsPath,
      crash: this.crashPaths,
      evidenceDir: this.testDir,
    };
    return this.out.clean.deep(result);
  }

  // ───────────────────────── step orchestration ─────────────────────────

  private async execStep(
    raw: StepSpec,
    meta: { index: number; path: string; phase: Phase; file: string; optional: boolean; interrupts: boolean },
  ): Promise<StepResult> {
    const label = `${meta.path} ${stepLabel(raw)}`;
    if (raw.platforms && !raw.platforms.includes(this.platform)) {
      return this.record(this.newCtx(meta, label), stepKind(raw), { verdict: 'SKIPPED', code: 'platform', reason: `${this.platform}에서는 실행하지 않는 스텝` }, 0);
    }
    return this.execLeaf(meta.index, label, meta.phase, (ctx) => this.dispatch(ctx, raw), meta, stepKind(raw), raw.optional ?? false);
  }

  private newCtx(meta: { index: number; phase: Phase; file: string; optional: boolean; interrupts: boolean }, label: string): StepCtx {
    const seq = ++this.seq;
    return {
      seq,
      index: meta.index,
      path: label.split(' ', 1)[0]!,
      label,
      phase: meta.phase,
      dir: `${this.testDir}/step-${String(seq).padStart(2, '0')}`,
      file: meta.file,
      optional: meta.optional,
      interrupts: meta.interrupts,
      decisions: [],
      receipts: [],
      health: [],
      settle: null,
      before: null,
      after: null,
      beforePng: null,
    };
  }

  /** Runs one step body with budget, events, evidence and optional→SKIPPED handling. */
  private async execLeaf(
    index: number,
    label: string,
    phase: Phase,
    body: (ctx: StepCtx) => Promise<Outcome>,
    meta: { file: string; optional: boolean; interrupts: boolean } = { file: this.test.file, optional: false, interrupts: false },
    kind: StepKind | 'start' = 'start',
    ownOptional = false,
  ): Promise<StepResult> {
    const ctx = this.newCtx({ index, phase, ...meta, optional: meta.optional || ownOptional }, label);
    const ref = { runId: this.env.runId, testId: this.test.id, platform: this.platform, index };
    this.out.emit({ type: 'step.started', ...ref, label });
    const t0 = this.env.clock.now();
    let outcome: Outcome;
    try {
      this.env.signal?.throwIfAborted();
      if (phase !== 'teardown') this.chargeStep();
      outcome = await body(ctx);
    } catch (err) {
      if (err instanceof StepAbort) outcome = err.outcome;
      else if (err instanceof UnsetVariableError) outcome = { verdict: 'ERROR', code: 'unset_variable', reason: err.message };
      else if (this.env.signal?.aborted) outcome = { verdict: 'ERROR', code: 'cancelled', reason: '실행이 취소되었습니다' };
      else outcome = { verdict: 'ERROR', code: 'internal', reason: `실행 오류: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (ctx.optional && (outcome.verdict === 'FAIL' || outcome.verdict === 'INCONCLUSIVE')) {
      outcome = { verdict: 'SKIPPED', code: outcome.code, reason: `선택 스텝 실패 → 건너뜀: ${outcome.reason}` };
    }
    return this.record(ctx, kind, outcome, this.env.clock.now() - t0);
  }

  private record(ctx: StepCtx, kind: string, outcome: Outcome, ms: number): StepResult {
    const result: StepResult = {
      seq: ctx.seq,
      index: ctx.index,
      label: ctx.label,
      kind,
      phase: ctx.phase,
      verdict: outcome.verdict,
      code: outcome.code,
      reason: outcome.reason,
      optional: ctx.optional,
      evidenceDir: ctx.dir,
      before: ctx.before,
      after: ctx.after,
      decisions: ctx.decisions,
      health: ctx.health,
      settle: ctx.settle,
      durationMs: Math.round(ms),
    };
    if (ctx.receipts.length) this.out.json(`${ctx.dir}/jev.json`, ctx.receipts, 'jev');
    this.out.json(`${ctx.dir}/verdict.json`, result, 'verdict');
    this.out.emit({
      type: 'step.finished',
      runId: this.env.runId,
      testId: this.test.id,
      platform: this.platform,
      index: ctx.index,
      verdict: outcome.verdict,
      reason: outcome.reason,
      evidenceDir: ctx.dir,
    });
    this.results.push(result);
    return result;
  }

  private chargeStep(): void {
    this.stepCount++;
    if (this.stepCount > this.budget.steps) throw new StepAbort('INCONCLUSIVE', 'budget_exceeded', `예산 초과: 스텝 ${this.budget.steps}개`);
    if (this.env.clock.now() - this.startedAt > this.budget.seconds * 1000) {
      throw new StepAbort('INCONCLUSIVE', 'budget_exceeded', `예산 초과: ${this.budget.seconds}초`);
    }
  }

  /** Runs a nested step list; returns the first non-passing child outcome (children stop there). */
  private async runNested(ctx: StepCtx, steps: readonly StepSpec[], path: string, file: string, phase: Phase = ctx.phase): Promise<Outcome> {
    const verdicts: Verdict[] = [];
    for (const [i, step] of steps.entries()) {
      const r = await this.execStep(step, { index: ctx.index, path: `${path}.${i + 1}`, phase, file, optional: ctx.optional, interrupts: ctx.interrupts });
      verdicts.push(r.verdict);
      if (r.verdict !== 'PASS' && r.verdict !== 'SKIPPED') return { verdict: r.verdict, code: r.code, reason: `${r.label}: ${r.reason}` };
    }
    return { verdict: verdicts.every((v) => v === 'SKIPPED') && verdicts.length ? 'SKIPPED' : 'PASS', code: null, reason: `하위 스텝 ${steps.length}개 통과` };
  }

  /** `${NAME}`: `use … with` scopes, then remembered values, then the environment — whose values are secrets from now on. */
  private lookup = (name: string): string | undefined => {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i]![name];
      if (v !== undefined) return v;
    }
    const remembered = this.vars.get(name);
    if (remembered !== undefined) return remembered;
    const env = process.env[name];
    if (env !== undefined) this.out.clean.addSecret(env);
    return env;
  };

  private async dispatch(ctx: StepCtx, raw: StepSpec): Promise<Outcome> {
    const step = expandStep(raw, this.lookup);
    // Containers: children observe and act themselves.
    if ('repeat' in step) return this.doRepeat(ctx, step);
    if ('use' in step) return this.doUse(ctx, step);
    let obs = await this.observeBefore(ctx);
    if (ctx.interrupts && (await this.runInterrupts(ctx, obs))) obs = await this.observeBefore(ctx);
    if ('which' in step) return this.doWhich(ctx, step, obs);
    const outcome = await this.leaf(ctx, step, obs);
    if (outcome.verdict !== 'PASS' || !step.expect) return outcome;
    const expected = await this.expectations(ctx, Array.isArray(step.expect) ? step.expect : [step.expect], step.timeout);
    return expected.verdict === 'PASS' ? outcome : expected;
  }

  private async leaf(ctx: StepCtx, step: StepSpec, obs: Obs): Promise<Outcome> {
    const timeout = step.timeout ?? DEFAULT_TIMEOUT_MS;
    const q = (target: TargetSpec): TargetQuery => ({ target, within: step.within, nth: step.nth, near: step.near });
    if ('launch' in step) return this.doLaunch(ctx, step.launch === true ? {} : step.launch, timeout);
    if ('open' in step) {
      approved(this.preparer.label(ctx, labelRisk(step.open, this.test.profile.risk), step.allowRisky ?? false));
      await this.act(ctx, 'open', { text: step.open }, () => this.env.driver.openUrl(this.app, step.open));
      await this.settle(ctx, obs, !step.expectNoChange, timeout);
      return PASS(`링크 열림: ${step.open}`);
    }
    if ('tap' in step || 'longPress' in step) {
      const target = 'tap' in step ? step.tap : step.longPress;
      const t = await this.approvedTarget(ctx, obs, q(target), 'activate', step.allowRisky, timeout);
      const point = t.candidate.tapPoint;
      if ('tap' in step) await this.act(ctx, 'tap', { point }, () => this.env.driver.tap(point));
      else await this.act(ctx, 'longPress', { point }, () => this.env.driver.longPress(point, step.holdMs));
      await this.settle(ctx, t.obs, !step.expectNoChange, timeout);
      return PASS(`"${t.candidate.name}" ${'tap' in step ? '탭' : '길게 누름'}`);
    }
    if ('tapAt' in step) {
      const s = obs.model.snapshot.screen;
      const point = { x: Math.round(s.x + step.tapAt.x * s.width), y: Math.round(s.y + step.tapAt.y * s.height) };
      approved(this.preparer.label(ctx, labelRisk(null), step.allowRisky ?? false));
      await this.act(ctx, 'tapAt', { point }, () => this.env.driver.tap(point));
      await this.settle(ctx, obs, !step.expectNoChange, timeout);
      return PASS(`좌표 ${point.x},${point.y} 탭`);
    }
    if ('type' in step) {
      const t = await this.approvedTarget(ctx, obs, q(step.into), 'edit', step.allowRisky, timeout);
      const point = t.candidate.tapPoint;
      // An observed secure field is secure whatever the DSL says; its value is masked in every later write.
      const secure = step.secure === true || t.candidate.role === 'secure-input';
      if (secure) this.out.clean.addSecret(step.type);
      const typed = await this.act(ctx, 'type', { point, text: secure ? maskValue(step.type) : step.type }, () =>
        this.env.driver.typeText(point, step.type, { secure, append: step.append, submit: false }),
      );
      if (typed.error?.startsWith('INPUT_UNVERIFIED')) throw new StepAbort('FAIL', 'input_unverified', `입력 확인 실패: ${typed.error}`);
      if (step.submit) {
        // Typing may change the screen: Enter is approved only on the observation after typing.
        approved(await this.preparer.focused(ctx, step.allowRisky ?? false));
        await this.act(ctx, 'press', { text: 'enter' }, () => this.env.driver.press('enter'));
      }
      await this.settle(ctx, t.obs, false, timeout);
      return PASS(`"${t.candidate.name}"에 입력 확인 (${typed.path})${step.submit ? ' 후 Enter' : ''}`);
    }
    if ('clear' in step) {
      const t = await this.approvedTarget(ctx, obs, q(step.clear), 'edit', step.allowRisky, timeout);
      const point = t.candidate.tapPoint;
      const cleared = await this.act(ctx, 'clear', { point }, () => this.env.driver.clearText(point));
      if (cleared.error?.startsWith('INPUT_UNVERIFIED')) throw new StepAbort('FAIL', 'input_unverified', `지우기 확인 실패: ${cleared.error}`);
      await this.settle(ctx, t.obs, false, timeout);
      return PASS(`"${t.candidate.name}" 지움`);
    }
    if ('press' in step) {
      // Enter submits the focused form or dialog; back/tab/escape/delete only navigate or edit.
      if (step.press === 'enter') approved(await this.preparer.focused(ctx, step.allowRisky ?? false));
      await this.act(ctx, 'press', { text: step.press }, () => this.env.driver.press(step.press));
      await this.settle(ctx, obs, !step.expectNoChange, timeout);
      return PASS(`${step.press} 키 누름`);
    }
    if ('hideKeyboard' in step) {
      if (!obs.model.snapshot.keyboardShown) return PASS('키보드가 이미 숨겨져 있음 (행동 없음)');
      await this.act(ctx, 'hideKeyboard', {}, () => this.env.driver.hideKeyboard(), {
        verdict: 'FAIL',
        code: 'keyboard_not_hidden',
        reason: '키보드가 숨겨지지 않음',
      });
      await this.settle(ctx, obs, false, timeout);
      return PASS('키보드 숨김');
    }
    if ('see' in step) {
      const r = await this.resolveLoop(ctx, obs, q(step.see), { strict: true, deadline: this.deadline(timeout), ocr: true });
      if (!r.ok) return r.outcome;
      await this.captureAfter(ctx, r.obs);
      return PASS(`보임: "${r.candidate.name}"`);
    }
    if ('seeNot' in step) return this.doSeeNot(ctx, obs, step.seeNot, timeout);
    if ('assertText' in step) return this.waitText(ctx, obs, step.assertText, true, timeout);
    if ('assertNoText' in step) return this.waitText(ctx, obs, step.assertNoText, false, timeout);
    if ('checkEach' in step) return this.doCheckEach(ctx, obs, step.checkEach, timeout);
    if ('claim' in step) return this.doClaim(ctx, obs, step.claim);
    if ('remember' in step) return this.doRemember(ctx, obs, step.remember, q, timeout);
    if ('scroll' in step) return this.doScroll(ctx, obs, step.scroll, q, !step.expectNoChange, timeout);
    if ('swipe' in step) {
      const s = obs.model.snapshot.screen;
      const at = (p: { x: number; y: number }): Point => ({ x: Math.round(s.x + p.x * s.width), y: Math.round(s.y + p.y * s.height) });
      const from = at(step.swipe.from);
      const to = at(step.swipe.to);
      await this.act(ctx, 'swipe', { point: from, to }, () => this.env.driver.swipe(from, to, step.swipe.durationMs));
      await this.settle(ctx, obs, !step.expectNoChange, timeout);
      return PASS('스와이프');
    }
    if ('back' in step) {
      await this.act(ctx, 'back', {}, () => this.env.driver.back());
      await this.settle(ctx, obs, !step.expectNoChange, timeout);
      return PASS('뒤로');
    }
    if ('location' in step) {
      const { lat, lon } = step.location;
      await this.act(ctx, 'location', { text: `${lat},${lon}` }, () => this.env.driver.setLocation(lat, lon));
      await this.settle(ctx, obs, false, timeout);
      return PASS(`위치 ${lat},${lon}`);
    }
    if ('wait' in step) {
      if (typeof step.wait === 'number') {
        await this.env.clock.sleep(step.wait);
        return PASS(`${step.wait}ms 대기`);
      }
      const until = step.wait.until;
      const text = textOnly(until);
      if (text !== null) return this.waitText(ctx, obs, text, true, timeout);
      const r = await this.resolveLoop(ctx, obs, q(until), { strict: false, deadline: this.deadline(timeout), ocr: true });
      if (!r.ok) return r.outcome;
      return PASS(`나타남: "${r.candidate.name}"`);
    }
    if ('capture' in step) {
      const png = obs.png ?? (await this.env.driver.screenshot());
      const rel = this.out.png(`${ctx.dir}/${screenSlug(this.out.clean.text(step.capture))}.png`, png);
      return PASS(`캡처 저장: ${rel}`);
    }
    throw new StepAbort('ERROR', 'unsupported_step', `지원하지 않는 스텝: ${stepLabel(step)}`);
  }

  // ───────────────────────── observation ─────────────────────────

  private async observe(opts: { screenshot?: boolean; ocr?: 'auto' | 'force' | 'never' } = {}): Promise<Obs> {
    this.env.signal?.throwIfAborted();
    const snap = await this.env.driver.snapshot({ screenshot: opts.screenshot ?? false });
    this.out.clean.observe(snap);
    const volatile = this.test.profile.volatile;
    let model = buildScreenModel(snap, { volatile });
    let png = snap.screenshotPng;
    let ocr = false;
    const mode = opts.ocr ?? 'auto';
    if (mode !== 'never' && (mode === 'force' || model.sparse) && this.env.ocr && !this.ocrBroken) {
      png ??= await this.env.driver.screenshot();
      try {
        model = buildScreenModel(snap, { volatile, ocr: await this.env.ocr(png, snap.screen) });
        ocr = true;
      } catch (err) {
        this.ocrBroken = true;
        this.warnOnce('ocr', `OCR 사용 불가: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { model, png, ocr };
  }

  /** Step-start observation with screenshot; saved as before.png / source.xml / elements.json. */
  private async observeBefore(ctx: StepCtx): Promise<Obs> {
    const obs = await this.observe({ screenshot: true });
    ctx.beforePng = obs.png;
    if (obs.png) ctx.before = this.out.png(`${ctx.dir}/before.png`, obs.png);
    this.out.source(`${ctx.dir}/source.xml`, obs.model.snapshot.rawSource);
    this.out.elements(`${ctx.dir}/elements.json`, obs.model);
    this.emitRef(ctx, {
      type: 'observe',
      screenshot: ctx.before,
      candidates: obs.model.candidates.length,
      sparse: obs.model.sparse,
      overflow: obs.model.overflow,
      ocr: obs.ocr,
    });
    return obs;
  }

  private async captureAfter(ctx: StepCtx, obs: Obs): Promise<void> {
    const png = obs.png ?? (await this.env.driver.screenshot());
    ctx.after = this.out.png(`${ctx.dir}/after.png`, png);
  }

  private emitRef(ctx: StepCtx, body: DistributiveOmit<Extract<QaEventBody, { index: number }>, 'runId' | 'testId' | 'platform' | 'index'>): void {
    this.out.emit({ ...body, runId: this.env.runId, testId: this.test.id, platform: this.platform, index: ctx.index } as QaEventBody);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
    this.out.emit({ type: 'log', level: 'warn', source: 'runner', message });
  }

  /** Deadline counted from the last mutating action (Maestro `adjustedToLatestInteraction`). */
  private deadline(timeout: number | undefined): number {
    return this.lastActionAt + (timeout ?? DEFAULT_TIMEOUT_MS);
  }

  // ───────────────────────── Jev plumbing ─────────────────────────

  /** Null when Jev may decide `primitive`; otherwise why not (reasons for missing calibration start with `uncalibrated`). */
  private jevProblem(primitive: CalibratedPrimitive): string | null {
    const { client, calibration, problem } = this.env.jev;
    if (!calibration) return problem ? `uncalibrated: ${problem}` : 'uncalibrated';
    const usable = usableGate(calibration, client?.model ?? JEV_MODEL, primitive);
    if (usable.reason) return usable.reason;
    return client ? null : (problem ?? 'Jev 클라이언트를 만들 수 없습니다');
  }

  private jevFailure(reason: string): Outcome {
    return { verdict: 'ERROR', code: reason.startsWith('uncalibrated') ? 'uncalibrated' : 'jev_error', reason: `Jev 판단 불가: ${reason}` };
  }

  private async jevCall<T extends { receipt: JevReceipt | null }>(ctx: StepCtx, call: () => Promise<T>): Promise<T> {
    if (this.jevCalls >= this.budget.jevCalls) throw new StepAbort('INCONCLUSIVE', 'budget_exceeded', `예산 초과: Jev 호출 ${this.budget.jevCalls}회`);
    const r = await call();
    if (r.receipt) {
      this.jevCalls++;
      ctx.receipts.push(r.receipt);
    }
    return r;
  }

  private judgeOpts(model: ScreenModel) {
    return { texts: model.texts, redact: this.out.clean.text, calibration: this.env.jev.calibration, signal: this.env.signal };
  }

  private decide(ctx: StepCtx, d: DecisionSummary): void {
    ctx.decisions.push(d);
    this.emitRef(ctx, {
      type: 'decision',
      kind: d.kind,
      intent: d.intent,
      verdict: d.verdict,
      source: d.source,
      probabilities: d.top ? Object.fromEntries(d.top.map((t) => [t.key, t.p])) : null,
      target: d.target,
      model: d.model,
      requestId: d.requestId,
      latencyMs: d.latencyMs,
      reason: d.reason,
    });
  }

  private top(probs: Record<string, number> | null, labelOf: (key: string) => string): DecisionSummary['top'] {
    if (!probs) return null;
    return Object.entries(probs)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([key, p]) => ({ key, label: key === 'none' ? '없음' : labelOf(key), p }));
  }

  private groundingDecision(intent: string, g: GroundingDecision, pool: readonly Candidate[]): DecisionSummary {
    return {
      kind: 'grounding',
      source: g.decisionSource,
      verdict: g.verdict,
      intent,
      top: this.top(g.probabilities, (k) => pool.find((c) => c.key === k)?.name ?? k),
      target: g.candidate ? { key: g.candidate.key, name: g.candidate.name, role: g.candidate.role, tapPoint: g.candidate.tapPoint } : null,
      model: g.receipt?.model ?? null,
      requestId: g.receipt?.requestId ?? null,
      latencyMs: g.receipt?.latencyMs ?? null,
      reason: g.reason,
    };
  }

  // ───────────────────────── resolution ─────────────────────────

  /**
   * Resolves a target, re-observing until `deadline` while not found (Jev is re-asked only when the screen fingerprint
   * changed). At the deadline one OCR pass is tried (if not done), then not_found / unsupported_surface / uncalibrated.
   */
  private async resolveLoop(ctx: StepCtx, first: Obs, q: TargetQuery, opts: { strict: boolean; deadline: number; ocr: boolean }): Promise<Resolved> {
    const sel = asSelector(q.target);
    const intentText = targetText(q.target);
    let obs = first;
    let ocrTried = first.ocr || !opts.ocr;
    let lastFp: string | null = null;
    let jevBlocked: string | null = null;
    for (;;) {
      const det = resolveDeterministic(obs.model, q);
      if (det.kind === 'found') {
        const c = det.candidate;
        this.decide(ctx, {
          kind: 'grounding',
          source: det.source,
          verdict: 'pass',
          intent: intentText,
          top: null,
          target: { key: c.key, name: c.name, role: c.role, tapPoint: c.tapPoint },
          model: null,
          requestId: null,
          latencyMs: null,
          reason: det.reason,
        });
        return { ok: true, candidate: c, source: det.source, obs };
      }
      if (det.kind === 'ambiguous') {
        this.decide(ctx, { kind: 'grounding', source: 'deterministic', verdict: 'ambiguous', intent: intentText, top: null, target: null, model: null, requestId: null, latencyMs: null, reason: det.reason });
        return { ok: false, outcome: { verdict: 'FAIL', code: 'ambiguous', reason: det.reason }, obs };
      }
      let notFoundReason = det.reason;
      if (det.kind === 'jev') {
        jevBlocked = this.jevProblem('grounding');
        const fp = fingerprint(obs.model);
        if (!jevBlocked && fp !== lastFp) {
          lastFp = fp;
          const g = await this.jevCall(ctx, () => groundChoice(this.env.jev.client!, det.pool, det.intent, { ...this.judgeOpts(obs.model), strict: opts.strict }));
          this.decide(ctx, this.groundingDecision(det.intent, g, det.pool));
          if (g.verdict === 'pass' && g.candidate) {
            if (stateMatches(g.candidate, sel.state)) return { ok: true, candidate: g.candidate, source: 'jev', obs };
            notFoundReason = `Jev 선택 "${g.candidate.name}" 상태 조건 불일치 ${JSON.stringify(sel.state)}`;
          } else if (g.verdict === 'ambiguous') {
            return { ok: false, outcome: { verdict: 'FAIL', code: 'ambiguous', reason: `${g.reason} — 문구 수정 필요` }, obs };
          } else if (g.verdict === 'error') {
            return { ok: false, outcome: this.jevFailure(g.reason), obs };
          } else notFoundReason = g.reason;
        }
      }
      if (this.env.clock.now() >= opts.deadline) {
        if (!ocrTried && this.env.ocr && !this.ocrBroken) {
          ocrTried = true;
          lastFp = null;
          obs = await this.observe({ ocr: 'force' });
          continue;
        }
        if (obs.model.candidates.length === 0) {
          return { ok: false, outcome: { verdict: 'INCONCLUSIVE', code: 'unsupported_surface', reason: '접근성 트리와 OCR 모두 대상을 제공하지 않는 화면' }, obs };
        }
        if (det.kind === 'jev' && jevBlocked) {
          return { ok: false, outcome: this.jevFailure(`${jevBlocked} (결정적 일치 없음: ${det.reason})`), obs };
        }
        const diag = notFoundDiagnostics(obs.model, q);
        return { ok: false, outcome: { verdict: 'FAIL', code: 'not_found', reason: `찾지 못함 "${intentText}": ${notFoundReason}; ${diag.join('; ')}` }, obs };
      }
      await this.env.clock.sleep(POLL_MS);
      obs = await this.observe();
    }
  }

  /** Mutating target: resolve (re-observing while not found) → preparation on the final fresh observation. */
  private async approvedTarget(ctx: StepCtx, obs: Obs, q: TargetQuery, mutation: Mutation, allowRisky: boolean | undefined, timeout: number) {
    const r = await this.resolveLoop(ctx, obs, q, { strict: false, deadline: this.deadline(timeout), ocr: true });
    if (!r.ok) throw new StepAbort(r.outcome.verdict, r.outcome.code, r.outcome.reason);
    const reresolve = (fresh: Obs) => this.resolveLoop(ctx, fresh, q, { strict: false, deadline: this.env.clock.now(), ocr: false });
    return approved(await this.preparer.target(ctx, r, mutation, allowRisky ?? false, reresolve));
  }

  // ───────────────────────── actions ─────────────────────────

  /** Journals the intent (fsync) before dispatch, then the outcome. `uncertain` ends the test (ERROR, no retry). */
  private async act<T extends ActionOutcome>(
    ctx: StepCtx,
    kind: ActionKind,
    detail: { point?: Point; to?: Point; text?: string },
    run: () => Promise<T>,
    onRejected?: Outcome,
  ): Promise<T> {
    this.env.signal?.throwIfAborted();
    const id = `${this.test.id}:${this.platform}:${++this.actionSeq}`;
    const base = { id, runId: this.env.runId, testId: this.test.id, platform: this.platform, step: ctx.seq, label: ctx.label, kind };
    const text = detail.text ?? null;
    this.out.journal({ phase: 'intent', ...base, point: detail.point ?? null, to: detail.to ?? null, text });
    let out: T;
    try {
      out = await run();
    } catch (err) {
      out = { status: 'uncertain', ms: 0, error: err instanceof Error ? err.message : String(err) } as T;
    }
    this.out.journal({ phase: 'outcome', ...base, status: out.status, ms: out.ms, error: out.error ?? null });
    this.emitRef(ctx, { type: 'action', kind, point: detail.point ?? null, to: detail.to ?? null, text, status: out.status, ms: out.ms });
    this.lastActionAt = this.env.clock.now();
    this.recentScroll = kind === 'swipe' || kind === 'scroll' || kind === 'back' || kind === 'hideKeyboard';
    if (out.status === 'uncertain') {
      throw new StepAbort('ERROR', 'uncertain_action', `행동 결과 불확실(${kind}): ${out.error ?? '알 수 없음'} — 자동 재시도하지 않음`);
    }
    if (out.status === 'rejected') throw onRejected ? new StepAbort(onRejected.verdict, onRejected.code, `${onRejected.reason}: ${out.error ?? ''}`) : new StepAbort('ERROR', 'action_rejected', `행동 거부됨(${kind}): ${out.error ?? ''}`);
    return out;
  }

  /**
   * Waits for change (identity/layout fingerprint, dHash fallback) then stability (2 equal observations ≥250 ms apart),
   * saves after.png, runs health. No change when one was required → INCONCLUSIVE no_effect.
   */
  private async settle(ctx: StepCtx, before: Obs, requireChange: boolean, timeout: number): Promise<Obs> {
    const { clock, driver } = this.env;
    const t0 = clock.now();
    const beforeFp = fingerprint(before.model);
    const beforeHash = pngHash(before.png ?? ctx.beforePng);
    let changed = false;
    let viaPixels = false;
    let cur = before;
    if (requireChange) {
      const deadline = this.lastActionAt + timeout;
      for (;;) {
        await clock.sleep(POLL_MS);
        cur = await this.observe({ ocr: 'never' });
        if (fingerprint(cur.model) !== beforeFp) {
          changed = true;
          break;
        }
        if (beforeHash) {
          const png = await driver.screenshot();
          const h = pngHash(png);
          if (h && hammingHex(h, beforeHash) >= DHASH_DIFF) {
            cur = { ...cur, png };
            changed = viaPixels = true;
            break;
          }
        }
        if (clock.now() >= deadline) break;
      }
    }
    let settled = false;
    if (changed || !requireChange) {
      const deadline = clock.now() + timeout;
      let prev = requireChange ? cur : await this.observe({ ocr: 'never' });
      let prevHash = viaPixels ? pngHash(prev.png) : null;
      for (;;) {
        await clock.sleep(STABLE_GAP_MS);
        const next = await this.observe({ ocr: 'never' });
        let same = fingerprint(next.model) === fingerprint(prev.model);
        let nextHash: string | null = null;
        if (same && viaPixels) {
          nextHash = pngHash(await driver.screenshot());
          same = nextHash !== null && prevHash !== null && hammingHex(nextHash, prevHash) <= DHASH_SAME;
        }
        prev = next;
        prevHash = nextHash;
        if (same) {
          settled = true;
          break;
        }
        if (clock.now() >= deadline) break;
      }
    }
    const final = await this.observe({ screenshot: true });
    const ms = Math.round(clock.now() - t0);
    ctx.settle = { changed, settled, ms };
    if (final.png) ctx.after = this.out.png(`${ctx.dir}/after.png`, final.png);
    this.emitRef(ctx, { type: 'settle', changed, settled, ms, screenshot: ctx.after });
    await this.health(ctx, final);
    if (requireChange && !changed) throw new StepAbort('INCONCLUSIVE', 'no_effect', `행동 후 ${timeout}ms 동안 화면 변화 없음 (expectNoChange가 아니면 효과 없음)`);
    return final;
  }

  private async health(ctx: StepCtx, obs: Obs): Promise<void> {
    const raster: Raster | null = obs.png ? decodePng(obs.png) : null;
    const findings = checkHealth(obs.model, raster, this.app.appId);
    ctx.health.push(...findings);
    this.findings.push(...findings);
    this.emitRef(ctx, { type: 'health', findings });
    for (const f of findings) if (f.severity === 'warn') this.warnOnce(`health:${f.kind}`, `${HEALTH_LABEL[f.kind]}: ${f.evidence}`);
    const fail = findings.find((f) => f.severity === 'fail');
    if (!fail) return;
    await this.attachLogs(fail.kind);
    throw new StepAbort('FAIL', fail.kind, `${HEALTH_LABEL[fail.kind]}: ${fail.evidence}`);
  }

  /** Test-window device log slice (+ crash artifacts when the app died); failures here only warn. */
  private async attachLogs(kind: HealthFinding['kind']): Promise<void> {
    const { driver } = this.env;
    const now = new Date().toISOString();
    if (!this.logsPath) {
      try {
        this.logsPath = this.out.text(`${this.testDir}/logs/device.log`, await driver.logSlice(this.startedIso, now), 'log');
      } catch (err) {
        this.warnOnce('logs', `기기 로그를 가져오지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (CRASH_KINDS[kind] && this.crashPaths.length === 0) {
      try {
        for (const a of await driver.crashArtifacts(this.app, this.startedIso)) {
          this.crashPaths.push(this.out.text(`${this.testDir}/crash/${a.name.replace(/[^\w.-]/g, '_')}`, a.content, 'crash'));
        }
      } catch (err) {
        this.warnOnce('crash', `크래시 기록을 가져오지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ───────────────────────── step kinds ─────────────────────────

  private async startApp(ctx: StepCtx): Promise<Outcome> {
    const spec = this.test.spec;
    const before = await this.observeBefore(ctx);
    if (spec.start === 'attach') {
      await this.health(ctx, before);
      await this.captureAfter(ctx, before);
      return PASS('실행 중인 앱에 연결');
    }
    const outcome = await this.doLaunch(ctx, { reset: spec.reset }, DEFAULT_TIMEOUT_MS);
    return outcome;
  }

  private async doLaunch(ctx: StepCtx, l: { reset?: 'none' | 'relaunch' | 'clear' | 'reinstall'; permissions?: Record<string, 'allow' | 'deny' | 'unset'>; arguments?: string[] }, timeout: number): Promise<Outcome> {
    const { driver } = this.env;
    const reset = l.reset ?? 'none';
    const opts = { permissions: l.permissions, arguments: l.arguments };
    const custom = l.permissions !== undefined || l.arguments !== undefined;
    if (reset === 'clear' || reset === 'reinstall') {
      await this.act(ctx, 'reset', { text: reset }, () => driver.reset(this.app, reset));
      if (custom) await this.act(ctx, 'terminate', {}, () => driver.terminate(this.app));
    } else if (reset === 'relaunch') await this.act(ctx, 'terminate', {}, () => driver.terminate(this.app));
    if (reset === 'none' || reset === 'relaunch' || custom) await this.act(ctx, 'launch', {}, () => driver.launch(this.app, opts));
    try {
      await driver.startLogs(this.app, this.out.clean.text);
    } catch (err) {
      this.warnOnce('startLogs', `기기 로그 수집 시작 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    const before = await this.observe({ ocr: 'never' });
    await this.settle(ctx, before, false, timeout);
    return PASS(`앱 실행 (${reset})`);
  }

  private async doSeeNot(ctx: StepCtx, first: Obs, intent: string, timeout: number): Promise<Outcome> {
    const q: TargetQuery = { target: intent };
    const deadline = this.deadline(timeout);
    let obs = first;
    let absentSince: number | null = null;
    let lastFp: string | null = null;
    let lastAbsent = false;
    for (;;) {
      const det = resolveDeterministic(obs.model, q);
      let absent: boolean;
      if (det.kind === 'found') absent = false;
      else if (det.kind === 'ambiguous') return { verdict: 'INCONCLUSIVE', code: 'ambiguous', reason: det.reason };
      else if (det.kind === 'not_found') absent = true;
      else {
        const problem = this.jevProblem('grounding');
        if (problem) return this.jevFailure(`${problem} (안 보임은 Jev로만 확인 가능)`);
        const fp = fingerprint(obs.model);
        if (fp !== lastFp) {
          lastFp = fp;
          const g = await this.jevCall(ctx, () => groundChoice(this.env.jev.client!, det.pool, det.intent, { ...this.judgeOpts(obs.model), strict: true }));
          this.decide(ctx, this.groundingDecision(det.intent, g, det.pool));
          if (g.verdict === 'error') return this.jevFailure(g.reason);
          if (g.verdict === 'ambiguous') return { verdict: 'INCONCLUSIVE', code: 'ambiguous', reason: `안 보임 판정 애매함: ${g.reason}` };
          lastAbsent = g.verdict === 'not_found';
        }
        absent = lastAbsent;
      }
      const now = this.env.clock.now();
      if (absent) {
        if (absentSince === null) absentSince = now;
        else if (now - absentSince >= HOLD_MS) {
          await this.captureAfter(ctx, obs);
          return PASS(`안 보임 확인 (${HOLD_MS}ms 간격 2회)`);
        }
      } else absentSince = null;
      if (now >= deadline && absentSince === null) {
        await this.captureAfter(ctx, obs);
        return { verdict: 'FAIL', code: 'still_visible', reason: `"${intent}"이(가) 아직 보임` };
      }
      await this.env.clock.sleep(absentSince === null ? POLL_MS : Math.max(0, HOLD_MS - (now - absentSince)));
      obs = await this.observe();
    }
  }

  private async waitText(ctx: StepCtx, first: Obs, m: TextMatchSpec, present: boolean, timeout: number): Promise<Outcome> {
    const deadline = this.deadline(timeout);
    let obs = first;
    let absentSince: number | null = null;
    for (;;) {
      const hit = textFound(m, textLines(obs.model));
      const now = this.env.clock.now();
      if (present && hit !== undefined) {
        if (obs !== first) await this.captureAfter(ctx, obs);
        this.decide(ctx, { kind: 'check', source: 'deterministic', verdict: 'pass', intent: describeMatch(m), top: null, target: null, model: null, requestId: null, latencyMs: null, reason: `일치: "${hit}"` });
        return PASS(`텍스트 있음: "${hit}"`);
      }
      if (!present) {
        if (hit === undefined) {
          absentSince ??= now;
          if (now - absentSince >= HOLD_MS) {
            await this.captureAfter(ctx, obs);
            return PASS(`텍스트 없음 ${HOLD_MS}ms 유지: ${describeMatch(m)}`);
          }
        } else absentSince = null;
      }
      if (now >= deadline && (present || absentSince === null)) {
        await this.captureAfter(ctx, obs);
        return present
          ? { verdict: 'FAIL', code: 'text_not_found', reason: `텍스트 없음: ${describeMatch(m)}` }
          : { verdict: 'FAIL', code: 'text_present', reason: `있으면 안 되는 텍스트가 보임: "${hit}"` };
      }
      await this.env.clock.sleep(present || absentSince === null ? POLL_MS : Math.max(0, HOLD_MS - (now - absentSince)));
      obs = await this.observe();
    }
  }

  private async doCheckEach(ctx: StepCtx, first: Obs, check: { pattern: string; rule: Record<string, unknown>; min: number }, timeout: number): Promise<Outcome> {
    let re: RegExp;
    try {
      re = new RegExp(check.pattern, 'u');
    } catch (err) {
      return { verdict: 'ERROR', code: 'invalid_regex', reason: `checkEach 정규식 오류: ${(err as Error).message}` };
    }
    const invalid = ruleProblem(check.rule);
    if (invalid) return { verdict: 'ERROR', code: 'invalid_rule', reason: `checkEach 규칙 오류: ${invalid}` };
    const deadline = this.deadline(timeout);
    let obs = first;
    let matches: LineMatch[] = [];
    for (;;) {
      matches = [];
      for (const line of textLines(obs.model)) {
        const m = re.exec(line);
        if (m) matches.push({ line, data: groupData(m.groups ?? {}) });
      }
      if (matches.length >= check.min || this.env.clock.now() >= deadline) break;
      await this.env.clock.sleep(POLL_MS);
      obs = await this.observe();
    }
    await this.captureAfter(ctx, obs);
    const outcome = judgeLines(check.rule, matches, check.min);
    const verdict = outcome.verdict === 'PASS' ? 'pass' : outcome.verdict === 'ERROR' ? 'error' : 'fail';
    this.decide(ctx, { kind: 'check', source: 'deterministic', verdict, intent: `/${check.pattern}/`, top: null, target: null, model: null, requestId: null, latencyMs: null, reason: outcome.reason });
    return outcome;
  }

  private async doClaim(ctx: StepCtx, obs: Obs, claim: string): Promise<Outcome> {
    const problem = this.jevProblem('claim');
    if (problem) return this.jevFailure(problem);
    const d = await this.jevCall(ctx, () => judgeClaim(this.env.jev.client!, obs.model.candidates, claim, this.judgeOpts(obs.model)));
    this.decide(ctx, {
      kind: 'claim',
      source: 'jev',
      verdict: d.verdict,
      intent: claim,
      top: d.pYes === null ? null : [{ key: 'yes', label: '참', p: d.pYes }],
      target: null,
      model: d.receipt?.model ?? null,
      requestId: d.receipt?.requestId ?? null,
      latencyMs: d.receipt?.latencyMs ?? null,
      reason: d.reason,
    });
    await this.captureAfter(ctx, obs);
    if (d.verdict === 'pass') return PASS(d.reason);
    if (d.verdict === 'fail') return { verdict: 'FAIL', code: 'claim_false', reason: d.reason };
    if (d.verdict === 'inconclusive') return { verdict: 'INCONCLUSIVE', code: 'claim_inconclusive', reason: d.reason };
    return this.jevFailure(d.reason);
  }

  private async doRemember(
    ctx: StepCtx,
    first: Obs,
    r: { name: string; from: TargetSpec | { regex: string } },
    q: (t: TargetSpec) => TargetQuery,
    timeout: number,
  ): Promise<Outcome> {
    const from = r.from;
    let value: string;
    if (typeof from === 'object' && 'regex' in from) {
      const re = new RegExp(from.regex, 'u');
      const deadline = this.deadline(timeout);
      let obs = first;
      for (;;) {
        const m = textLines(obs.model)
          .map((l) => re.exec(l))
          .find((x) => x !== null);
        if (m) {
          value = m.groups?.value ?? m[1] ?? m[0];
          break;
        }
        if (this.env.clock.now() >= deadline) return { verdict: 'FAIL', code: 'text_not_found', reason: `기억할 값 없음: /${from.regex}/` };
        await this.env.clock.sleep(POLL_MS);
        obs = await this.observe();
      }
    } else {
      const res = await this.resolveLoop(ctx, first, q(from), { strict: false, deadline: this.deadline(timeout), ocr: true });
      if (!res.ok) return res.outcome;
      if (res.candidate.role === 'secure-input') return { verdict: 'ERROR', code: 'secure_value', reason: '보안 입력란의 값은 기억할 수 없습니다' };
      value = res.candidate.value ?? res.candidate.name;
    }
    this.vars.set(r.name, value);
    return PASS(`${r.name} = "${value}"`);
  }

  private async doWhich(ctx: StepCtx, step: WhichStepSpec, first: Obs): Promise<Outcome> {
    const branches = step.which;
    const options = Object.keys(branches);
    const problem = this.jevProblem('which');
    if (problem) return this.jevFailure(problem);
    const deadline = this.deadline(step.timeout);
    let obs = first;
    let lastFp: string | null = null;
    for (;;) {
      const fp = fingerprint(obs.model);
      if (fp !== lastFp) {
        lastFp = fp;
        const d = await this.jevCall(ctx, () => judgeWhich(this.env.jev.client!, obs.model.candidates, options, this.judgeOpts(obs.model)));
        this.decide(ctx, {
          kind: 'which',
          source: 'jev',
          verdict: d.verdict,
          intent: options.join(' | '),
          top: this.top(d.probabilities, (k) => options[Number(k.slice(1))] ?? k),
          target: null,
          model: d.receipt?.model ?? null,
          requestId: d.receipt?.requestId ?? null,
          latencyMs: d.receipt?.latencyMs ?? null,
          reason: d.reason,
        });
        if (d.verdict === 'pass' && d.option !== null) {
          const branch = await this.runNested(ctx, branches[d.option] ?? [], `${ctx.path}[${d.option}]`, ctx.file);
          return branch.verdict === 'PASS' || branch.verdict === 'SKIPPED' ? PASS(`분기 "${d.option}" 실행`) : branch;
        }
        if (d.verdict === 'ambiguous') return { verdict: 'FAIL', code: 'ambiguous', reason: `${d.reason} — 문구 수정 필요` };
        if (d.verdict === 'error') return this.jevFailure(d.reason);
      }
      if (this.env.clock.now() >= deadline) return { verdict: 'FAIL', code: 'which_none', reason: '어느 분기의 화면도 아님 (로딩 중이거나 해당 없음)' };
      await this.env.clock.sleep(POLL_MS);
      obs = await this.observe();
    }
  }

  private async doRepeat(ctx: StepCtx, step: RepeatStepSpec): Promise<Outcome> {
    const r = step.repeat;
    const cap = Math.min(r.times ?? MAX_REPEAT, MAX_REPEAT);
    for (let i = 0; i < cap; i++) {
      if (r.while && !(await this.condition(ctx, r.while))) return PASS(`${i}회 반복 후 조건 해제`);
      const out = await this.runNested(ctx, r.steps, `${ctx.path}.${i + 1}`, ctx.file);
      if (out.verdict !== 'PASS' && out.verdict !== 'SKIPPED') return out;
    }
    if (r.while && r.times === undefined && (await this.condition(ctx, r.while))) {
      return { verdict: 'INCONCLUSIVE', code: 'repeat_limit', reason: `반복 상한 ${MAX_REPEAT}회 후에도 조건이 참` };
    }
    return PASS(`${cap}회 반복`);
  }

  private async doUse(ctx: StepCtx, step: Extract<StepSpec, { use: string }>): Promise<Outcome> {
    const file = resolvePath(dirname(ctx.file), step.use);
    const flow = this.test.flows.get(file);
    if (!flow) return { verdict: 'ERROR', code: 'flow_missing', reason: `하위 흐름이 로드되지 않음: ${step.use}` };
    this.scopes.push(step.with ?? {});
    try {
      const out = await this.runNested(ctx, flow.steps, ctx.path, file);
      return out.verdict === 'PASS' || out.verdict === 'SKIPPED' ? PASS(`하위 흐름 "${flow.name}" 완료`) : out;
    } finally {
      this.scopes.pop();
    }
  }

  private async doScroll(
    ctx: StepCtx,
    first: Obs,
    s: { direction: 'up' | 'down' | 'left' | 'right'; until?: TargetSpec | { text: TextMatchSpec }; max: number },
    q: (t: TargetSpec) => TargetQuery,
    requireChange: boolean,
    timeout: number,
  ): Promise<Outcome> {
    const swipe = (obs: Obs): { from: Point; to: Point } => {
      const scrolls = obs.model.candidates.filter((c) => c.role === 'scroll');
      const area = scrolls.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.rect ?? obs.model.snapshot.screen;
      const cy = Math.round(area.y + area.height / 2);
      const at = (fx: number, fy: number): Point => ({ x: Math.round(area.x + fx * area.width), y: Math.round(area.y + fy * area.height) });
      // Direction = where the content moves into view, so the finger moves the opposite way.
      if (s.direction === 'down') return { from: at(0.5, 0.75), to: at(0.5, 0.25) };
      if (s.direction === 'up') return { from: at(0.5, 0.25), to: at(0.5, 0.75) };
      if (s.direction === 'right') return { from: { x: at(0.8, 0).x, y: cy }, to: { x: at(0.2, 0).x, y: cy } };
      return { from: { x: at(0.2, 0).x, y: cy }, to: { x: at(0.8, 0).x, y: cy } };
    };
    const until = s.until;
    if (!until) {
      const { from, to } = swipe(first);
      await this.act(ctx, 'scroll', { point: from, to }, () => this.env.driver.swipe(from, to, 450));
      await this.settle(ctx, first, requireChange, timeout);
      return PASS(`${s.direction} 스크롤`);
    }
    const text = textOnly(until);
    let obs = first;
    for (let i = 0; ; i++) {
      if (text !== null) {
        const hit = textFound(text, textLines(obs.model));
        if (hit !== undefined) return PASS(`스크롤 ${i}회 후 텍스트 "${hit}" 보임`);
      } else {
        const r = await this.resolveLoop(ctx, obs, q(until), { strict: true, deadline: this.env.clock.now(), ocr: false });
        if (r.ok) return PASS(`스크롤 ${i}회 후 "${r.candidate.name}" 보임`);
        if (r.outcome.code !== 'not_found') return r.outcome;
      }
      if (i >= s.max) break;
      const { from, to } = swipe(obs);
      const fpBefore = fingerprint(obs.model);
      await this.act(ctx, 'scroll', { point: from, to }, () => this.env.driver.swipe(from, to, 450));
      obs = await this.settle(ctx, obs, false, timeout);
      if (fingerprint(obs.model) === fpBefore) return { verdict: 'FAIL', code: 'not_found', reason: `스크롤 끝에 도달 (${i + 1}회): ${targetText(until)} 없음` };
    }
    return { verdict: 'FAIL', code: 'not_found', reason: `스크롤 ${s.max}회 후에도 없음: ${text !== null ? describeMatch(text) : targetText(until)}` };
  }

  /** Loop condition on a fresh observation: deterministic text checks, or a target (Jev strict when needed). */
  private async condition(ctx: StepCtx, cond: Condition): Promise<boolean> {
    const obs = await this.observe();
    if ('text' in cond) return textFound(cond.text, textLines(obs.model)) !== undefined;
    if ('noText' in cond) return textFound(cond.noText, textLines(obs.model)) === undefined;
    const r = await this.resolveLoop(ctx, obs, { target: cond.see }, { strict: true, deadline: this.env.clock.now(), ocr: false });
    if (r.ok) return true;
    if (r.outcome.code === 'not_found') return false;
    throw new StepAbort(r.outcome.verdict, r.outcome.code, `조건 판정 실패: ${r.outcome.reason}`);
  }

  private async expectations(ctx: StepCtx, list: readonly Expectation[], timeout: number | undefined): Promise<Outcome> {
    for (const exp of list) {
      const obs = await this.observe();
      let out: Outcome;
      if ('see' in exp) {
        const r = await this.resolveLoop(ctx, obs, { target: exp.see }, { strict: true, deadline: this.deadline(timeout), ocr: true });
        out = r.ok ? PASS(`보임: "${r.candidate.name}"`) : r.outcome;
      } else if ('text' in exp) out = await this.waitText(ctx, obs, exp.text, true, timeout ?? DEFAULT_TIMEOUT_MS);
      else if ('noText' in exp) out = await this.waitText(ctx, obs, exp.noText, false, timeout ?? DEFAULT_TIMEOUT_MS);
      else out = await this.doClaim(ctx, obs, exp.claim);
      if (out.verdict !== 'PASS') return { ...out, reason: `기대 결과 불충족: ${out.reason}` };
    }
    return PASS('기대 결과 충족');
  }

  // ───────────────────────── interrupts ─────────────────────────

  /** `when` handlers before a step: deterministic match first, Jev (strict) only when the screen changed. */
  private async runInterrupts(ctx: StepCtx, first: Obs): Promise<boolean> {
    const when = this.test.spec.when ?? [];
    if (!when.length) return false;
    let obs = first;
    let fired = false;
    for (let round = 0; round < MAX_INTERRUPT_ROUNDS; round++) {
      let hit = -1;
      for (const [i, w] of when.entries()) {
        if (this.interruptCounts[i]! >= w.max) continue;
        if (await this.interruptSeen(ctx, i, obs)) {
          hit = i;
          break;
        }
      }
      if (hit < 0) return fired;
      fired = true;
      this.interruptCounts[hit]!++;
      const out = await this.runNested({ ...ctx, interrupts: false }, when[hit]!.do, `${ctx.path}.w${hit + 1}`, this.test.file, 'interrupt');
      if (out.verdict !== 'PASS' && out.verdict !== 'SKIPPED') throw new StepAbort(out.verdict, out.code, `인터럽트 처리 실패: ${out.reason}`);
      obs = await this.observe();
    }
    return fired;
  }

  private async interruptSeen(ctx: StepCtx, i: number, obs: Obs): Promise<boolean> {
    const w = (this.test.spec.when ?? [])[i]!;
    const expanded = expandStep({ see: w.see }, this.lookup);
    const see = 'see' in expanded ? expanded.see : w.see;
    const det = resolveDeterministic(obs.model, { target: see });
    if (det.kind === 'found') return true;
    if (det.kind !== 'jev') return false;
    const problem = this.jevProblem('grounding');
    if (problem) {
      this.warnOnce(`when:${i}`, `when 인터럽트 "${targetText(see)}": Jev 사용 불가(${problem}) — 결정적 일치만 확인`);
      return false;
    }
    const fp = fingerprint(obs.model);
    if (this.interruptFp[i] === fp) return false;
    this.interruptFp[i] = fp;
    const g = await this.jevCall(ctx, () => groundChoice(this.env.jev.client!, det.pool, det.intent, { ...this.judgeOpts(obs.model), strict: true }));
    this.decide(ctx, this.groundingDecision(`when: ${det.intent}`, g, det.pool));
    return g.verdict === 'pass';
  }
}

type Condition = z.infer<typeof ConditionSchema>;
type Expectation = z.infer<typeof ExpectationSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function startLabel(test: LoadedTest): string {
  return test.spec.start === 'attach' ? '앱 시작: 실행 중인 앱에 연결' : `앱 시작: ${test.spec.reset}`;
}

export function appTarget(profile: LoadedTest['profile'], platform: Platform): AppTarget | null {
  if (platform === 'android') {
    const a = profile.android;
    return a ? { platform, appId: a.package, ...(a.activity ? { activity: a.activity } : {}), ...(a.apk ? { binaryPath: a.apk } : {}) } : null;
  }
  const i = profile.ios;
  return i ? { platform, appId: i.bundleId, ...(i.app ? { binaryPath: i.app } : {}) } : null;
}
