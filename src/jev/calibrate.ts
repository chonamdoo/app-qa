// `qa calibrate`: runs the golden sets (calibration/golden/*.yaml, answers referenced by candidate NAME on real fixtures)
// against the pinned model, searches per-primitive thresholds under the pre-registered criteria, and writes
// calibration/<model>/<questionVersion>.json. A primitive that misses the criteria is written with status 'failed',
// which keeps its runtime decisions fail-closed ('uncalibrated').
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PATHS } from '../core/config.ts';
import { sha256, writeJson } from '../core/fsx.ts';
import type { Candidate, Platform, ScreenModel, Snapshot } from '../core/types.ts';
import { buildScreenModel, normLabel, parseAndroidSource, parseIosSource } from '../observe/index.ts';
import { labelRisk } from '../runner/risk.ts';
import { TestSpec } from '../spec/schema.ts';
import { JevCallError, type JevClient } from './client.ts';
import { BUILTIN_REDACTOR, claimRequest, commitRequest, groundingRequest, reviewRequest, whichRequest, type JevRequest } from './decide.ts';
import {
  calibrationPath,
  gateClaim,
  gateGrounding,
  gateWhich,
  type Calibration,
  type ClaimGate,
  type CommitGate,
  type GroundingGate,
  type ReviewGate,
  type WhichGate,
} from './gates.ts';
import { NONE, QUESTION_IDS, QUESTION_VERSION } from './questions.ts';
import type { ChoiceAnswer, JevAnswer, NoulAnswer } from './validate.ts';

// ───────────────────────── golden set schema ─────────────────────────

const Count = z.number().int().min(0);
const Rate = z.number().min(0).max(1);
const Criteria = z.strictObject({ maxConfidentWrong: Count, minAcceptance: Rate });
const CommitCriteria = z.strictObject({ maxConfidentWrong: Count, maxFalseAlarmRate: Rate });
const ReviewCriteria = z.strictObject({ maxConfidentWrong: Count, minGoodApproval: Rate });
const Screen = z.string().regex(/^(android|ios)\/[\w.-]+\/[\w.-]+$/, 'screen = <platform>/<app>/<fixture name>');
/** Literal label substitution on the fixture source, for label variants of a real screen (flagged `synthetic`). */
const Patch = z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1) })).optional();
const Tags = z.array(z.string()).default([]);
/** Candidate reference by visible name (normLabel equality), or by a substring that must hit exactly one candidate. */
const NameRef = z.union([z.string().min(1), z.strictObject({ includes: z.string().min(1) })]);

const GroundingItem = z.strictObject({
  id: z.string().min(1),
  screen: Screen,
  patch: Patch,
  intent: z.string().min(1),
  expect: z.union([
    z.strictObject({ target: NameRef, nth: z.number().int().min(1).optional() }),
    z.strictObject({ none: z.enum(['absent', 'occluded']) }),
    z.strictObject({ ambiguous: NameRef }),
  ]),
  tags: Tags,
});
const ClaimItem = z.strictObject({ id: z.string().min(1), screen: Screen, patch: Patch, claim: z.string().min(1), expect: z.boolean(), tags: Tags });
const WhichItem = z.strictObject({
  id: z.string().min(1),
  screen: Screen,
  patch: Patch,
  options: z.array(z.string().min(1)).min(2),
  expect: z.union([z.number().int().min(0), z.literal('none')]),
  tags: Tags,
});
const CommitItem = z.strictObject({ id: z.string().min(1), screen: Screen, patch: Patch, target: NameRef, expect: z.boolean(), tags: Tags });

const REVIEW_KINDS = ['good', 'missing_assertion', 'unrelated_steps', 'wrong_requirement', 'vague_requirement'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
const ReviewItem = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(REVIEW_KINDS),
  requirement: z.strictObject({ id: z.string().min(1), text: z.string().min(1) }),
  /** Raw test object as the planner sends it; must validate as TestSpec. */
  test: z.record(z.string(), z.unknown()),
  tags: Tags,
});

const GoldenFile = z.discriminatedUnion('primitive', [
  z.strictObject({ primitive: z.literal('grounding'), criteria: Criteria, items: z.array(GroundingItem).min(1) }),
  z.strictObject({ primitive: z.literal('claim'), criteria: Criteria, items: z.array(ClaimItem).min(1) }),
  z.strictObject({ primitive: z.literal('which'), criteria: Criteria, items: z.array(WhichItem).min(1) }),
  z.strictObject({ primitive: z.literal('commit'), criteria: CommitCriteria, items: z.array(CommitItem).min(1) }),
  z.strictObject({ primitive: z.literal('review'), criteria: ReviewCriteria, items: z.array(ReviewItem).min(1) }),
]);
type GoldenFile = z.infer<typeof GoldenFile>;
type Primitive = GoldenFile['primitive'];
type NameRef = z.infer<typeof NameRef>;
type CriteriaT = z.infer<typeof Criteria>;
type CommitCriteriaT = z.infer<typeof CommitCriteria>;
type ReviewCriteriaT = z.infer<typeof ReviewCriteria>;
const PRIMITIVES: readonly Primitive[] = ['grounding', 'claim', 'which', 'commit', 'review'];

// ───────────────────────── evaluation types ─────────────────────────

export type Outcome = 'accepted' | 'rejected' | 'confident_wrong';

export interface ItemResult {
  id: string;
  lang: 'ko' | 'en';
  tags: string[];
  expected: string;
  verdict: string;
  outcome: Outcome;
  /** Raw argmax (before gating) was the expected answer. */
  top1: boolean;
  top: string | null;
  pTop: number;
  pNone: number | null;
}

/** Counts shared by every primitive's evidence. */
export interface ItemStats {
  n: number;
  accepted: number;
  confidentWrong: number;
  top1: number;
  byLang: Record<'ko' | 'en', { n: number; accepted: number; confidentWrong: number; top1: number }>;
  items: ItemResult[];
}

/** grounding / claim / which: acceptance-based criteria. */
export interface PrimitiveReport extends ItemStats {
  status: 'calibrated' | 'failed';
  acceptance: number;
}

/** commit on the residual set: misses are confident-wrong, false alarms are `rejected`. */
export interface CommitReport extends ItemStats {
  status: 'calibrated' | 'advisory';
  risky: number;
  safe: number;
  falseAlarms: number;
  falseAlarmRate: number;
  /** Best threshold the search found, even when it missed the criteria (the gate is then 0.5, advisory). */
  best: { risky: number; confidentWrong: number; falseAlarmRate: number };
  /** Golden items the deterministic risk policy already blocks (excluded from the threshold). */
  covered: { id: string; reasons: string[] }[];
}

export interface ReviewReport extends ItemStats {
  status: 'calibrated' | 'failed';
  good: number;
  goodApproved: number;
  goodApproval: number;
  /** Accuracy of each Noul against its own truth (at the chosen threshold), for information. */
  perNoul: Record<keyof ReviewScores, { scored: number; correct: number }>;
}

export interface CalibrationReport {
  file: string;
  calibration: Calibration;
  reports: { grounding: PrimitiveReport; claim: PrimitiveReport; which: PrimitiveReport; commit: CommitReport; review: ReviewReport };
  /** Grounding with the non-strict gap rescue (tap/type), for the same items. */
  groundingNonStrict: { accepted: number; acceptance: number; confidentWrong: number };
  calls: number;
  /** Calls answered from existing recordings (`reuse`) instead of the API. */
  reused: number;
  inputTokens: number;
  latencyMs: { p50: number; p95: number };
}

export interface CalibrationOptions {
  client: JevClient;
  /** Replay client over existing recordings: requests it can answer are not sent again (grow a golden set cheaply). */
  reuse?: JevClient;
  goldenDir?: string;
  fixturesDir?: string;
  /** Output record path; defaults to calibration/<model>/<questionVersion>.json. */
  out?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

// ───────────────────────── runner ─────────────────────────

export async function runCalibration(opts: CalibrationOptions): Promise<CalibrationReport> {
  const { client } = opts;
  const goldenDir = opts.goldenDir ?? join(PATHS.calibration, 'golden');
  const fixturesDir = opts.fixturesDir ?? PATHS.fixtures;
  const log = opts.log ?? (() => {});
  const golden = loadGolden(goldenDir);
  const byPrimitive = Object.fromEntries(golden.map((g) => [g.data.primitive, g.data])) as Partial<Record<Primitive, GoldenFile>>;
  const missing = PRIMITIVES.filter((p) => !byPrimitive[p]);
  if (missing.length) throw new Error(`골든셋 파일 없음: ${missing.join(', ')}`);

  const screens = new Map<string, ScreenModel>();
  const screenOf = (screen: string, patch: { from: string; to: string }[] | undefined): ScreenModel => {
    const cacheKey = `${screen}|${JSON.stringify(patch ?? [])}`;
    let model = screens.get(cacheKey);
    if (!model) {
      model = loadFixtureModel(fixturesDir, screen, patch);
      screens.set(cacheKey, model);
    }
    return model;
  };

  // Build every request up front so golden-set mistakes fail before any API call.
  interface Job {
    primitive: Primitive;
    id: string;
    req: JevRequest;
    score: (answers: Record<string, JevAnswer>) => Pending;
  }
  const jobs: Job[] = [];
  const g = byPrimitive.grounding!;
  if (g.primitive === 'grounding') {
    for (const item of g.items) {
      const model = screenOf(item.screen, item.patch);
      const cands = model.candidates;
      const exp = item.expect;
      const expected: GroundExpect =
        'target' in exp
          ? { kind: 'target', key: resolveOne(cands, exp.target, exp.nth, item.id).key }
          : 'none' in exp
            ? { kind: 'none' }
            : { kind: 'ambiguous', keys: resolveMany(cands, exp.ambiguous, item.id) };
      if ('none' in exp && exp.none === 'occluded' && cands.some((c) => normLabel(c.name).includes(normLabel(item.intent)))) {
        throw new Error(`${item.id}: 가림 항목인데 의도 문구와 같은 이름의 후보가 보입니다`);
      }
      jobs.push({
        primitive: 'grounding',
        id: item.id,
        req: groundingRequest(cands, item.intent, model.texts, BUILTIN_REDACTOR),
        score: (a) => ({ kind: 'grounding', probs: (a[QUESTION_IDS.grounding] as ChoiceAnswer).probabilities, expected, meta: meta(item.id, item.intent, item.tags, item.patch) }),
      });
    }
  }
  const c = byPrimitive.claim!;
  if (c.primitive === 'claim') {
    for (const item of c.items) {
      const model = screenOf(item.screen, item.patch);
      jobs.push({
        primitive: 'claim',
        id: item.id,
        req: claimRequest(model.candidates, item.claim, model.texts, BUILTIN_REDACTOR),
        score: (a) => ({ kind: 'claim', p: (a[QUESTION_IDS.claim] as NoulAnswer).noul, expected: item.expect, meta: meta(item.id, item.claim, item.tags, item.patch) }),
      });
    }
  }
  const w = byPrimitive.which!;
  if (w.primitive === 'which') {
    for (const item of w.items) {
      if (item.expect !== 'none' && item.expect >= item.options.length) throw new Error(`${item.id}: expect ${item.expect} 범위 밖`);
      const model = screenOf(item.screen, item.patch);
      const expected = item.expect === 'none' ? NONE : `s${item.expect}`;
      jobs.push({
        primitive: 'which',
        id: item.id,
        req: whichRequest(model.candidates, item.options, model.texts, BUILTIN_REDACTOR),
        score: (a) => ({
          kind: 'which',
          probs: (a[QUESTION_IDS.which] as ChoiceAnswer).probabilities,
          expected,
          meta: meta(item.id, item.options.join(' / '), item.tags, item.patch),
        }),
      });
    }
  }
  // Commit only adds refusals on top of the deterministic policy: items that policy already blocks set no threshold.
  const covered: { id: string; reasons: string[] }[] = [];
  const k = byPrimitive.commit!;
  if (k.primitive === 'commit') {
    for (const item of k.items) {
      const model = screenOf(item.screen, item.patch);
      const target = resolveOne(model.candidates, item.target, undefined, item.id);
      const deterministic = labelRisk(target.name, undefined, model.texts);
      if (deterministic.risky) {
        covered.push({ id: item.id, reasons: deterministic.reasons });
        continue;
      }
      jobs.push({
        primitive: 'commit',
        id: item.id,
        req: commitRequest(model.candidates, target, model.texts, BUILTIN_REDACTOR),
        score: (a) => ({ kind: 'commit', p: (a[QUESTION_IDS.commit] as NoulAnswer).noul, expected: item.expect, meta: meta(item.id, target.name, item.tags, item.patch) }),
      });
    }
  }
  const r = byPrimitive.review!;
  if (r.primitive === 'review') {
    for (const item of r.items) {
      const parsed = TestSpec.safeParse(item.test);
      if (!parsed.success) throw new Error(`${item.id}: test가 TestSpec이 아닙니다 — ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
      jobs.push({
        primitive: 'review',
        id: item.id,
        req: reviewRequest({ requirement: item.requirement, test: item.test }, BUILTIN_REDACTOR),
        score: (a) => ({
          kind: 'review',
          reviewKind: item.kind,
          scores: {
            addresses: (a[QUESTION_IDS.addresses] as NoulAnswer).noul,
            unrelated: (a[QUESTION_IDS.unrelated] as NoulAnswer).noul,
            clarification: (a[QUESTION_IDS.clarification] as NoulAnswer).noul,
          },
          meta: meta(item.id, item.requirement.text, item.tags, undefined),
        }),
      });
    }
  }
  log(`골든 ${jobs.length}건(결정적 정책이 막는 commit ${covered.length}건 제외), 화면 ${screens.size}개 — ${client.model} / ${QUESTION_VERSION} (${client.config.mode})`);

  const latencies: number[] = [];
  let inputTokens = 0;
  let reused = 0;
  const pending = new Map<string, Pending>();
  const ask = async (job: Job) => {
    if (opts.reuse) {
      try {
        const hit = await opts.reuse.systemOne(job.req.state, job.req.questions, QUESTION_VERSION);
        reused++;
        return hit;
      } catch (err) {
        if (!(err instanceof JevCallError && err.kind === 'replay_miss')) throw err;
      }
    }
    return client.systemOne(job.req.state, job.req.questions, QUESTION_VERSION);
  };
  const run = async (job: Job): Promise<void> => {
    const res = await ask(job);
    latencies.push(res.receipt.latencyMs);
    inputTokens += res.receipt.inputTokens ?? 0;
    pending.set(`${job.primitive}:${job.id}`, job.score(res.answers));
  };
  const retryable: Partial<Record<JevCallError['kind'], true>> = { timeout: true, network: true, http: true, invalid_response: true };
  const failed = await pool(jobs, opts.concurrency ?? 4, async (job) => {
    try {
      await run(job);
      return null;
    } catch (err) {
      if (err instanceof JevCallError && retryable[err.kind]) return job;
      throw err;
    }
  });
  // One sequential second chance for transient failures; anything still failing aborts (no partial calibration).
  for (const job of failed.filter((j): j is Job => j !== null)) {
    try {
      await run(job);
    } catch (err) {
      throw new Error(`${job.primitive}:${job.id} 재시도 실패 — ${(err as Error).message}`);
    }
  }
  log(`Jev 호출 ${jobs.length}회 완료 (녹화 재사용 ${reused}회)`);

  const results = jobs.map((j) => pending.get(`${j.primitive}:${j.id}`)!);
  const pick = <K extends Pending['kind']>(kind: K) => results.filter((x): x is Extract<Pending, { kind: K }> => x.kind === kind);

  const grounding = calibrateGrounding(pick('grounding'), g.criteria as CriteriaT);
  const claim = calibrateClaim(pick('claim'), c.criteria as CriteriaT);
  const which = calibrateWhich(pick('which'), w.criteria as CriteriaT);
  const commit = calibrateCommit(pick('commit'), k.criteria as CommitCriteriaT, covered);
  const review = calibrateReview(pick('review'), r.criteria as ReviewCriteriaT);

  const allOk = [grounding, claim, which, review].every((x) => x.report.status === 'calibrated');
  const calibration: Calibration = {
    model: client.model,
    questionVersion: QUESTION_VERSION,
    createdAt: new Date().toISOString(),
    status: allOk ? 'calibrated' : 'failed',
    golden: golden.map((f) => ({ file: relative(PATHS.root, f.file), sha256: f.sha256, items: f.data.items.length })),
    method:
      'per primitive, 0.01-step grid: fewest confident-wrong, then most accepted; each threshold then set inside the ' +
      'interval that keeps every item outcome unchanged — midpoint when items bound it on both sides, conservative end ' +
      'when one side is only the grid limit. commit: residual items only (not blocked by src/runner/risk.ts labelRisk). ' +
      'Pre-registered criteria and ranges: calibration/golden/*.yaml headers.',
    grounding: { status: grounding.report.status, criteria: g.criteria as CriteriaT, gate: grounding.gate, evidence: evidence(grounding.report, { nonStrict: grounding.nonStrict }) },
    claim: { status: claim.report.status, criteria: c.criteria as CriteriaT, gate: claim.gate, evidence: evidence(claim.report) },
    which: { status: which.report.status, criteria: w.criteria as CriteriaT, gate: which.gate, evidence: evidence(which.report) },
    commit: { status: commit.report.status, criteria: k.criteria as CommitCriteriaT, gate: commit.gate, evidence: evidence(commit.report) },
    review: { status: review.report.status, criteria: r.criteria as ReviewCriteriaT, gate: review.gate, evidence: evidence(review.report) },
  };
  const file = opts.out ?? calibrationPath(client.model, QUESTION_VERSION);
  writeJson(file, calibration);
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    file,
    calibration,
    reports: { grounding: grounding.report, claim: claim.report, which: which.report, commit: commit.report, review: review.report },
    groundingNonStrict: grounding.nonStrict,
    calls: jobs.length,
    reused,
    inputTokens,
    latencyMs: { p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0 },
  };
}

// ───────────────────────── golden loading ─────────────────────────

/** Parses and validates every golden file (ids unique per primitive). Exported for replay tests. */
export function loadGolden(dir: string): { file: string; sha256: string; data: GoldenFile }[] {
  if (!existsSync(dir)) throw new Error(`골든셋 디렉터리 없음: ${dir}`);
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) throw new Error(`골든셋 파일 없음: ${dir}`);
  const seen = new Set<string>();
  return files.map((name) => {
    const file = join(dir, name);
    const text = readFileSync(file, 'utf8');
    const parsed = GoldenFile.safeParse(parseYaml(text));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`골든셋 형식 오류 ${name}: ${issue?.path.join('.')}: ${issue?.message}`);
    }
    for (const item of parsed.data.items) {
      const key = `${parsed.data.primitive}:${item.id}`;
      if (seen.has(key)) throw new Error(`골든셋 id 중복: ${key}`);
      seen.add(key);
    }
    return { file, sha256: sha256(text), data: parsed.data };
  });
}

const PARSERS: Record<Platform, (xml: string, screen: Snapshot['screen']) => Snapshot['nodes']> = {
  android: parseAndroidSource,
  ios: parseIosSource,
};

/** fixtures/<platform>/<app>/<name>.{xml,meta.json} → ScreenModel, optionally with literal label patches. */
export function loadFixtureModel(fixturesDir: string, screen: string, patch?: { from: string; to: string }[]): ScreenModel {
  const [platform] = screen.split('/') as [Platform];
  const base = join(fixturesDir, screen);
  let xml = readFileSync(`${base}.xml`, 'utf8');
  for (const p of patch ?? []) {
    if (!xml.includes(p.from)) throw new Error(`${screen}: 패치 대상 문구 없음 "${p.from}"`);
    xml = xml.split(p.from).join(p.to);
  }
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) as { windowRect: Snapshot['screen']; capturedAt: string };
  const snapshot: Snapshot = {
    platform,
    takenAt: meta.capturedAt,
    screen: meta.windowRect,
    nodes: PARSERS[platform](xml, meta.windowRect),
    rawSource: xml,
    screenshotPng: null,
    foregroundApp: null,
    keyboardShown: false,
    maxDepth: null,
    depthCapped: false,
  };
  return buildScreenModel(snapshot, {});
}

function matches(cands: readonly Candidate[], ref: NameRef): Candidate[] {
  if (typeof ref === 'string') {
    const want = normLabel(ref);
    return cands.filter((c) => normLabel(c.name) === want);
  }
  const part = normLabel(ref.includes);
  return cands.filter((c) => normLabel(c.name).includes(part));
}

function resolveOne(cands: readonly Candidate[], ref: NameRef, nth: number | undefined, id: string): Candidate {
  const hits = matches(cands, ref);
  const label = typeof ref === 'string' ? ref : `*${ref.includes}*`;
  if (hits.length === 0) throw new Error(`${id}: 후보 "${label}" 없음`);
  if (nth !== undefined) {
    const hit = hits[nth - 1];
    if (!hit) throw new Error(`${id}: 후보 "${label}" ${nth}번째 없음 (${hits.length}개)`);
    return hit;
  }
  if (hits.length > 1) throw new Error(`${id}: 후보 "${label}"가 ${hits.length}개 — nth 또는 ambiguous로 지정`);
  return hits[0]!;
}

function resolveMany(cands: readonly Candidate[], ref: NameRef, id: string): string[] {
  const hits = matches(cands, ref);
  if (hits.length < 2) throw new Error(`${id}: ambiguous 항목은 같은 이름 후보가 2개 이상이어야 합니다 (${hits.length}개)`);
  return hits.map((h) => h.key);
}

// ───────────────────────── scoring & threshold search ─────────────────────────

interface Meta {
  id: string;
  lang: 'ko' | 'en';
  tags: string[];
}

function meta(id: string, text: string, tags: string[], patch: unknown[] | undefined): Meta {
  return { id, lang: HANGUL.test(text) ? 'ko' : 'en', tags: patch?.length ? [...tags, 'synthetic'] : tags };
}

export type GroundExpect = { kind: 'target'; key: string } | { kind: 'none' } | { kind: 'ambiguous'; keys: string[] };

export interface ReviewScores {
  addresses: number;
  unrelated: number;
  clarification: number;
}

/** One answered golden item, ready for gating (exported for tests of the threshold search). */
export type CalibrationSample =
  | { kind: 'grounding'; probs: Record<string, number>; expected: GroundExpect; meta: Meta }
  | { kind: 'claim'; p: number; expected: boolean; meta: Meta }
  | { kind: 'which'; probs: Record<string, number>; expected: string; meta: Meta }
  | { kind: 'commit'; p: number; expected: boolean; meta: Meta }
  | { kind: 'review'; reviewKind: ReviewKind; scores: ReviewScores; meta: Meta };
type Pending = CalibrationSample;

/** Grid in 0.01 units from `from` to `to` inclusive; descending when from > to. Callers list conservative values first. */
function grid(from: number, to: number, step = 0.01): number[] {
  const [a, b, s] = [Math.round(from * 100), Math.round(to * 100), Math.round(step * 100)];
  const out: number[] = [];
  if (a <= b) for (let v = a; v <= b; v += s) out.push(v / 100);
  else for (let v = a; v >= b; v -= s) out.push(v / 100);
  return out;
}

const count = (outcomes: readonly Outcome[], o: Outcome) => outcomes.filter((x) => x === o).length;

/** Fewest confident-wrong, then most accepted; the first (most conservative) grid entry wins ties. */
function searchBest<P>(params: readonly P[], evaluate: (p: P) => Outcome[]): P {
  let best: { p: P; cw: number; acc: number } | null = null;
  for (const p of params) {
    const outcomes = evaluate(p);
    const cw = count(outcomes, 'confident_wrong');
    const acc = count(outcomes, 'accepted');
    if (!best || cw < best.cw || (cw === best.cw && acc > best.acc)) best = { p, cw, acc };
  }
  return best!.p;
}

interface Dim<P> {
  /** Grid values, conservative first. */
  values: number[];
  get(p: P): number;
  set(p: P, v: number): P;
}

/**
 * Places each threshold inside the interval that leaves every item's outcome unchanged: at the midpoint when items
 * bound it on both sides (maximum margin), at the conservative end when one side is only the grid limit (no
 * extrapolation beyond evidence). Coordinates are centred one after another.
 */
function centre<P>(best: P, dims: readonly Dim<P>[], evaluate: (p: P) => Outcome[]): P {
  let cur = best;
  for (const d of dims) {
    const sig = evaluate(cur).join();
    const same = (v: number) => evaluate(d.set(cur, v)).join() === sig;
    const i = d.values.findIndex((v) => Math.abs(v - d.get(cur)) < 1e-9);
    if (i < 0) continue;
    let lo = i;
    let hi = i;
    while (lo > 0 && same(d.values[lo - 1]!)) lo--;
    while (hi < d.values.length - 1 && same(d.values[hi + 1]!)) hi++;
    const bounded = lo > 0 && hi < d.values.length - 1;
    cur = d.set(cur, d.values[bounded ? Math.floor((lo + hi) / 2) : lo]!);
  }
  return cur;
}

type Row = { meta: Meta; expected: string; verdict: string; top: string | null; pTop: number; pNone: number | null; top1: boolean };

function stats(items: readonly Row[], outcomes: readonly Outcome[]): ItemStats {
  const results: ItemResult[] = items.map((it, i) => ({
    id: it.meta.id,
    lang: it.meta.lang,
    tags: it.meta.tags,
    expected: it.expected,
    verdict: it.verdict,
    outcome: outcomes[i]!,
    top1: it.top1,
    top: it.top,
    pTop: round(it.pTop),
    pNone: it.pNone === null ? null : round(it.pNone),
  }));
  const tally = (rs: ItemResult[]) => ({
    n: rs.length,
    accepted: rs.filter((r) => r.outcome === 'accepted').length,
    confidentWrong: rs.filter((r) => r.outcome === 'confident_wrong').length,
    top1: rs.filter((r) => r.top1).length,
  });
  return { ...tally(results), byLang: { ko: tally(results.filter((r) => r.lang === 'ko')), en: tally(results.filter((r) => r.lang === 'en')) }, items: results };
}

function acceptanceReport(items: readonly Row[], outcomes: readonly Outcome[], criteria: CriteriaT): PrimitiveReport {
  const s = stats(items, outcomes);
  const acceptance = s.n ? s.accepted / s.n : 0;
  const status = s.confidentWrong <= criteria.maxConfidentWrong && acceptance >= criteria.minAcceptance ? 'calibrated' : 'failed';
  return { status, ...s, acceptance: round(acceptance) };
}

function evidence(r: { status: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { status: _status, ...rest } = r;
  return { ...rest, ...extra };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function groundOutcome(verdict: string, key: string | null, exp: GroundExpect): Outcome {
  if (verdict === 'ambiguous') return exp.kind === 'ambiguous' ? 'accepted' : 'rejected';
  if (verdict === 'not_found') return exp.kind === 'none' ? 'accepted' : 'confident_wrong';
  return exp.kind === 'target' && key === exp.key ? 'accepted' : 'confident_wrong';
}

export function calibrateGrounding(items: Extract<Pending, { kind: 'grounding' }>[], criteria: CriteriaT) {
  const judge = (gate: GroundingGate, strict: boolean) =>
    items.map((it) => {
      const r = gateGrounding(it.probs, gate, strict);
      return groundOutcome(r.verdict, r.key, it.expected);
    });
  const strictly = (gate: GroundingGate) => judge(gate, true);
  const laxly = (gate: GroundingGate) => judge(gate, false);
  // Pass thresholds only act on items with a candidate on top, noneMin only on items with none on top: search each alone.
  const topValues = grid(0.99, 0.3);
  const gapValues = grid(0.9, 0.05, 0.05);
  const noneValues = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
  const passGrid: GroundingGate[] = [];
  for (const minTop of topValues) {
    for (const minGap of gapValues) for (const maxNone of noneValues) passGrid.push({ minTop, minGap, maxNone, noneMin: 1, rescueGap: null });
  }
  const pass = searchBest(passGrid, strictly);
  const withNone = searchBest(topValues.map((noneMin) => ({ ...pass, noneMin })), strictly);
  const strictGate = centre(
    withNone,
    [
      { values: topValues, get: (g) => g.minTop, set: (g, minTop) => ({ ...g, minTop }) },
      { values: gapValues, get: (g) => g.minGap, set: (g, minGap) => ({ ...g, minGap }) },
      { values: noneValues, get: (g) => g.maxNone, set: (g, maxNone) => ({ ...g, maxNone }) },
      { values: topValues, get: (g) => g.noneMin, set: (g, noneMin) => ({ ...g, noneMin }) },
    ],
    strictly,
  );

  // The rescue only matters for non-strict grounding (tap/type): kept only if it adds acceptance at no added confident-wrong.
  const rescueValues = grid(0.95, Math.min(0.95, strictGate.minGap + 0.05), 0.05);
  const rescued = searchBest(rescueValues.map((rescueGap) => ({ ...strictGate, rescueGap })), laxly);
  const base = laxly(strictGate);
  const withRescue = laxly(rescued);
  const keep = count(withRescue, 'accepted') > count(base, 'accepted') && count(withRescue, 'confident_wrong') <= count(base, 'confident_wrong');
  const rescueDim: Dim<GroundingGate> = { values: rescueValues, get: (g) => g.rescueGap ?? 1, set: (g, rescueGap) => ({ ...g, rescueGap }) };
  const gate = roundGate(keep ? centre(rescued, [rescueDim], laxly) : strictGate);

  const rows = items.map((it) => {
    const r = gateGrounding(it.probs, gate, true);
    const exp = it.expected;
    const top = topCandidate(it.probs);
    const argmax = (it.probs[NONE] ?? 0) > top.p ? NONE : top.key;
    return {
      meta: it.meta,
      expected: exp.kind === 'target' ? exp.key : exp.kind === 'none' ? NONE : `ambiguous(${exp.keys.join(',')})`,
      verdict: r.verdict === 'pass' ? `pass:${r.key}` : r.verdict,
      top: top.key,
      pTop: top.p,
      pNone: it.probs[NONE] ?? 0,
      top1: exp.kind === 'target' ? argmax === exp.key : exp.kind === 'none' ? argmax === NONE : false,
    };
  });
  const nonStrict = laxly(gate);
  return {
    gate,
    report: acceptanceReport(rows, strictly(gate), criteria),
    nonStrict: {
      accepted: count(nonStrict, 'accepted'),
      acceptance: round(items.length ? count(nonStrict, 'accepted') / items.length : 0),
      confidentWrong: count(nonStrict, 'confident_wrong'),
    },
  };
}

export function calibrateClaim(items: Extract<Pending, { kind: 'claim' }>[], criteria: CriteriaT) {
  const evaluate = (gate: ClaimGate) =>
    items.map((it): Outcome => {
      const v = gateClaim(it.p, gate);
      return v === 'inconclusive' ? 'rejected' : (v === 'pass') === it.expected ? 'accepted' : 'confident_wrong';
    });
  const yesValues = grid(0.99, 0.5);
  const noValues = grid(0.01, 0.49);
  const params: ClaimGate[] = [];
  for (const yes of yesValues) for (const no of noValues) params.push({ yes, no });
  const gate = centre(
    searchBest(params, evaluate),
    [
      { values: yesValues, get: (g) => g.yes, set: (g, yes) => ({ ...g, yes }) },
      { values: noValues, get: (g) => g.no, set: (g, no) => ({ ...g, no }) },
    ],
    evaluate,
  );
  const rows = items.map((it) => ({
    meta: it.meta,
    expected: String(it.expected),
    verdict: gateClaim(it.p, gate),
    top: null,
    pTop: it.p,
    pNone: null,
    top1: it.p >= 0.5 === it.expected,
  }));
  return { gate, report: acceptanceReport(rows, evaluate(gate), criteria) };
}

export function calibrateWhich(items: Extract<Pending, { kind: 'which' }>[], criteria: CriteriaT) {
  const evaluate = (gate: WhichGate) =>
    items.map((it): Outcome => {
      const r = gateWhich(it.probs, gate);
      return r.verdict === 'ambiguous' ? 'rejected' : (r.verdict === 'none' ? NONE : r.key) === it.expected ? 'accepted' : 'confident_wrong';
    });
  const topValues = grid(0.99, 0.3);
  const gapValues = grid(0.9, 0.05, 0.05);
  const params: WhichGate[] = [];
  for (const minTop of topValues) for (const minGap of gapValues) for (const noneMin of topValues) params.push({ minTop, minGap, noneMin });
  const gate = centre(
    searchBest(params, evaluate),
    [
      { values: topValues, get: (g) => g.minTop, set: (g, minTop) => ({ ...g, minTop }) },
      { values: gapValues, get: (g) => g.minGap, set: (g, minGap) => ({ ...g, minGap }) },
      { values: topValues, get: (g) => g.noneMin, set: (g, noneMin) => ({ ...g, noneMin }) },
    ],
    evaluate,
  );
  const rows = items.map((it) => {
    const r = gateWhich(it.probs, gate);
    const top = topCandidate(it.probs);
    const argmax = (it.probs[NONE] ?? 0) > top.p ? NONE : top.key;
    return {
      meta: it.meta,
      expected: it.expected,
      verdict: r.verdict === 'pass' ? `pass:${r.key}` : r.verdict,
      top: top.key,
      pTop: top.p,
      pNone: it.probs[NONE] ?? 0,
      top1: argmax === it.expected,
    };
  });
  return { gate, report: acceptanceReport(rows, evaluate(gate), criteria) };
}

/**
 * Commit on the residual set (items the deterministic policy does not block). A missed commit is confident-wrong; a
 * false alarm only blocks a step (rejected) and is bounded by `maxFalseAlarmRate`. The bar is never raised above the
 * architecture's 0.5. When no threshold meets both criteria the gate is 0.5 and the status `advisory` (log, never
 * block on commit alone).
 */
export function calibrateCommit(
  items: Extract<Pending, { kind: 'commit' }>[],
  criteria: CommitCriteriaT,
  covered: { id: string; reasons: string[] }[] = [],
): { gate: CommitGate; report: CommitReport } {
  const evaluate = (gate: CommitGate) =>
    items.map((it): Outcome => {
      const flagged = it.p >= gate.risky;
      return it.expected ? (flagged ? 'accepted' : 'confident_wrong') : flagged ? 'rejected' : 'accepted';
    });
  const safe = items.filter((it) => !it.expected).length;
  const measure = (gate: CommitGate) => {
    const falseAlarms = items.filter((it) => !it.expected && it.p >= gate.risky).length;
    return { confidentWrong: count(evaluate(gate), 'confident_wrong'), falseAlarms, falseAlarmRate: safe ? falseAlarms / safe : 0 };
  };
  const values = grid(0.05, 0.5);
  const best = centre(
    searchBest(
      values.map((risky) => ({ risky })),
      evaluate,
    ),
    [{ values, get: (g) => g.risky, set: (_g, risky) => ({ risky }) }],
    evaluate,
  );
  const b = measure(best);
  const ok = b.confidentWrong <= criteria.maxConfidentWrong && b.falseAlarmRate <= criteria.maxFalseAlarmRate;
  const gate: CommitGate = ok ? best : { risky: 0.5 };
  const m = measure(gate);
  const rows = items.map((it) => ({
    meta: it.meta,
    expected: String(it.expected),
    verdict: it.p >= gate.risky ? 'risky' : 'safe',
    top: null,
    pTop: it.p,
    pNone: null,
    top1: it.p >= 0.5 === it.expected,
  }));
  return {
    gate,
    report: {
      status: ok ? 'calibrated' : 'advisory',
      ...stats(rows, evaluate(gate)),
      risky: items.length - safe,
      safe,
      falseAlarms: m.falseAlarms,
      falseAlarmRate: round(m.falseAlarmRate),
      best: { risky: best.risky, confidentWrong: b.confidentWrong, falseAlarmRate: round(b.falseAlarmRate) },
      covered,
    },
  };
}

/** Per-Noul truth for each review kind (null = not scored). */
const REVIEW_TRUTH: Record<ReviewKind, Record<keyof ReviewScores, boolean | null>> = {
  good: { addresses: true, unrelated: false, clarification: false },
  missing_assertion: { addresses: false, unrelated: false, clarification: false },
  unrelated_steps: { addresses: true, unrelated: true, clarification: false },
  wrong_requirement: { addresses: false, unrelated: true, clarification: false },
  vague_requirement: { addresses: null, unrelated: null, clarification: true },
};

/**
 * Review gate: approvable only when every Noul is inside its threshold. Any defective test judged approvable is
 * confident-wrong; good tests must be approvable at `minGoodApproval`.
 */
export function calibrateReview(items: Extract<Pending, { kind: 'review' }>[], criteria: ReviewCriteriaT): { gate: ReviewGate; report: ReviewReport } {
  const approvable = (s: ReviewScores, g: ReviewGate) => s.addresses >= g.addressesMin && s.unrelated <= g.unrelatedMax && s.clarification <= g.clarificationMax;
  const evaluate = (g: ReviewGate) =>
    items.map((it): Outcome => {
      const ok = approvable(it.scores, g);
      return it.reviewKind === 'good' ? (ok ? 'accepted' : 'rejected') : ok ? 'confident_wrong' : 'accepted';
    });
  const highValues = grid(0.99, 0.5);
  const lowValues = grid(0.01, 0.5);
  const params: ReviewGate[] = [];
  for (const addressesMin of highValues) {
    for (const unrelatedMax of lowValues) for (const clarificationMax of lowValues) params.push({ addressesMin, unrelatedMax, clarificationMax });
  }
  const gate = centre(
    searchBest(params, evaluate),
    [
      { values: highValues, get: (g) => g.addressesMin, set: (g, addressesMin) => ({ ...g, addressesMin }) },
      { values: lowValues, get: (g) => g.unrelatedMax, set: (g, unrelatedMax) => ({ ...g, unrelatedMax }) },
      { values: lowValues, get: (g) => g.clarificationMax, set: (g, clarificationMax) => ({ ...g, clarificationMax }) },
    ],
    evaluate,
  );
  const outcomes = evaluate(gate);
  const good = items.filter((it) => it.reviewKind === 'good').length;
  const approved = items.filter((it, i) => it.reviewKind === 'good' && outcomes[i] === 'accepted').length;
  const accuracy = (noul: keyof ReviewScores, flagged: (v: number) => boolean) => {
    const judged = items.filter((it) => REVIEW_TRUTH[it.reviewKind][noul] !== null);
    return { scored: judged.length, correct: judged.filter((it) => flagged(it.scores[noul]) === REVIEW_TRUTH[it.reviewKind][noul]).length };
  };
  const rows = items.map((it) => ({
    meta: it.meta,
    expected: `${it.reviewKind}→${it.reviewKind === 'good' ? 'approvable' : 'draft'}`,
    verdict: approvable(it.scores, gate) ? 'approvable' : 'draft',
    top: `a=${round(it.scores.addresses)} u=${round(it.scores.unrelated)} c=${round(it.scores.clarification)}`,
    pTop: it.scores.addresses,
    pNone: null,
    top1: (it.scores.addresses >= 0.5 && it.scores.unrelated < 0.5 && it.scores.clarification < 0.5) === (it.reviewKind === 'good'),
  }));
  const cw = count(outcomes, 'confident_wrong');
  const goodApproval = good ? approved / good : 0;
  return {
    gate,
    report: {
      status: cw <= criteria.maxConfidentWrong && goodApproval >= criteria.minGoodApproval ? 'calibrated' : 'failed',
      ...stats(rows, outcomes),
      good,
      goodApproved: approved,
      goodApproval: round(goodApproval),
      perNoul: {
        addresses: accuracy('addresses', (v) => v >= gate.addressesMin),
        unrelated: accuracy('unrelated', (v) => v > gate.unrelatedMax),
        clarification: accuracy('clarification', (v) => v > gate.clarificationMax),
      },
    },
  };
}

function topCandidate(probs: Record<string, number>): { key: string | null; p: number } {
  let key: string | null = null;
  let p = -1;
  for (const [k, v] of Object.entries(probs)) if (k !== NONE && v > p) [key, p] = [k, v];
  return { key, p: Math.max(p, 0) };
}

function roundGate(g: GroundingGate): GroundingGate {
  return { minTop: round(g.minTop), minGap: round(g.minGap), maxNone: round(g.maxNone), noneMin: round(g.noneMin), rescueGap: g.rescueGap === null ? null : round(g.rescueGap) };
}

/** Runs `fn` over `items` with at most `n` in flight; results keep input order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
