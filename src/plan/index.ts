// `qa plan` programmatic API (architecture §6, §10): documents → requirements → LLM tests → deterministic validation →
// Jev review → tests/generated/<app>/<doc-slug>/<test-id>.e2e.yaml + tests/generated/<app>/plan.json.
// plan.json is merged per document: re-planning a document replaces only that document's requirements, tests and
// untestable entries (the inline scenario is the document `inline.md`).
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadEnv, ROOT } from '../core/config.ts';
import type { EventSink } from '../core/events.ts';
import { newRunId, writeJson, writeSecure } from '../core/fsx.ts';
import { JevClient } from '../jev/client.ts';
import { loadJevConfig } from '../jev/config.ts';
import { reviewGenerated } from '../jev/decide.ts';
import { loadCalibration, type Calibration } from '../jev/gates.ts';
import { createRedactor, type Redactor } from '../jev/redact.ts';
import { PlanFile, type Requirement } from '../spec/schema.ts';
import { DEFAULT_CONTEXT_DIRS, loadAppContext, type ContextDirs } from './context.ts';
import { generateTests, type DroppedTest, type GeneratedTest } from './generate.ts';
import { ingestDocuments, INLINE_DOC } from './ingest.ts';
import { createLlm, DEFAULT_LLM_MODELS, LLM_PROVIDERS, type LlmProvider } from './llm.ts';
import { segmentRequirements } from './segment.ts';

export { ingestDocuments, INLINE_DOC, type IngestedDoc, type DocKind } from './ingest.ts';
export { segmentRequirements, slugify, mapHeader } from './segment.ts';
export { generateTests, type GenerationResult, type GeneratedTest, type DroppedTest } from './generate.ts';
export { checkOutput, checkTest, type CheckContext } from './validate.ts';
export { createLlm, extractJson, LLM_PROVIDERS, DEFAULT_LLM_MODELS, type Llm, type LlmProvider } from './llm.ts';
export { loadAppContext, type AppContext, type ScreenInfo } from './context.ts';

type PlanTest = PlanFile['tests'][number];

/** Jev access for the review step; `client: null` = unavailable (every test stays draft with `reason`). */
export interface JevAccess {
  client: JevClient | null;
  calibration: Calibration | null;
  reason?: string;
}

export interface GeneratePlanOptions {
  app: string;
  /** Paths, globs or directories; empty = the app profile's `docs` (unless `text` is given). */
  docs: string[];
  /** Scenario typed in the UI / `--text` (virtual document `inline.md`). */
  text?: string;
  llm?: LlmProvider;
  model?: string;
  /** Promote tests that pass the Jev review gate to `approved` (default: everything stays `draft`). */
  approve?: boolean;
  events?: EventSink;
  signal?: AbortSignal;
  // ── seams (tests, server) ──
  /** Environment for QA_LLM / QA_LLM_MODEL / QA_CLAUDE_BIN / QA_CODEX_BIN / Jev settings. Default process.env (+ .env). */
  env?: NodeJS.ProcessEnv;
  /** Project root that receives `tests/generated/<app>/…`; plan paths are relative to it. Default ROOT. */
  root?: string;
  contextDirs?: Partial<ContextDirs>;
  /** Pre-built Jev access; default = live client from env + calibration record (unavailable → draft with the reason). */
  jev?: JevAccess;
  cwd?: string;
}

export interface GeneratePlanResult {
  planPath: string;
  plan: PlanFile;
  /** Absolute paths of the test files written by this run. */
  testFiles: string[];
  /** Tests the model produced that failed validation after the revision round. */
  dropped: DroppedTest[];
}

const REVIEW_CONCURRENCY = 4;

export async function generatePlan(opts: GeneratePlanOptions): Promise<GeneratePlanResult> {
  const env = opts.env ?? process.env;
  if (env === process.env) loadEnv();
  const root = opts.root ?? ROOT;
  const planDir = join(root, 'tests', 'generated', opts.app);
  const planPath = join(planDir, 'plan.json');
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const planId = newRunId();
  const events = opts.events;
  const progress = (phase: 'ingest' | 'segment' | 'generate' | 'validate' | 'review' | 'write', message: string) =>
    events?.emit({ type: 'plan.progress', planId, phase, message });
  const warn = (message: string) => events?.emit({ type: 'log', level: 'warn', source: 'plan', message });

  const providerName = opts.llm ?? env.QA_LLM?.trim() ?? 'claude-cli';
  const provider = LLM_PROVIDERS[providerName];
  if (!provider) throw new Error(`알 수 없는 LLM: ${providerName} (claude-cli | codex-cli)`);
  const envModel = opts.llm === undefined || opts.llm === env.QA_LLM?.trim() ? env.QA_LLM_MODEL?.trim() : undefined;
  const model = opts.model ?? (envModel || DEFAULT_LLM_MODELS[provider]);

  const hasText = Boolean(opts.text?.trim());
  try {
    if (opts.signal?.aborted) throw new Error('계획 생성이 취소되었습니다');
    const context = loadAppContext(opts.app, { ...DEFAULT_CONTEXT_DIRS, ...opts.contextDirs });
    const sources = opts.docs.length || hasText ? opts.docs : context.profile.docs;
    events?.emit({ type: 'plan.started', planId, app: opts.app, docs: [...sources, ...(hasText ? [INLINE_DOC] : [])] });
    context.warnings.forEach(warn);
    if (!sources.length && !hasText) throw new Error(`문서가 없습니다: 문서 경로나 --text를 주거나 apps/${opts.app}.yaml에 docs를 적으세요`);

    const previous = readPlan(planPath);
    const reservedSlugs = new Map<string, string>();
    for (const r of previous?.requirements ?? []) reservedSlugs.set(r.doc, r.id.slice(0, r.id.indexOf('#')));

    progress('ingest', `문서 ${sources.length + (hasText ? 1 : 0)}개 읽는 중`);
    const docs = await ingestDocuments(sources, { text: opts.text, cwd: opts.cwd, reservedSlugs });
    progress('ingest', `문서 ${docs.length}개: ${docs.map((d) => d.path).join(', ')}`);
    const requirements = segmentRequirements(docs);
    if (!requirements.length) throw new Error('문서에서 요구사항을 찾지 못했습니다');
    progress('segment', `요구사항 ${requirements.length}개 (${docs.map((d) => `${d.slug} ${requirements.filter((r) => r.doc === d.path).length}`).join(', ')})`);
    progress('generate', `화면 인벤토리 ${context.screens.length}개 (${context.screens[0]?.source ?? '없음'})`);

    const llm = createLlm({ provider, model, env });
    const generated = await generateTests({ llm, context, requirements, signal: opts.signal, onProgress: progress });
    for (const note of llm.notes) warn(note);
    for (const d of generated.dropped) warn(`테스트 폐기 (${d.label}): ${d.errors.join('; ')}`);

    // ── ids, files ──
    const byId = new Map(requirements.map((r) => [r.id, r]));
    const usedIds = new Set<string>();
    const placed = generated.tests.map((t, i) => {
      const base = typeof t.spec.id === 'string' ? t.spec.id : `test-${i + 1}`;
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      usedIds.add(id);
      const docSlug = t.covers[0]!.slice(0, t.covers[0]!.indexOf('#'));
      return { test: t, id, file: join(planDir, docSlug, `${id}.e2e.yaml`) };
    });

    // ── Jev review ──
    progress('review', `Jev 검토: 테스트 ${placed.length}개`);
    const jev = opts.jev ?? resolveJev(env);
    if (!jev.client) warn(`Jev를 쓸 수 없어 모든 테스트를 draft로 둡니다: ${jev.reason ?? 'unavailable'}`);
    const redact = createRedactor(context.profile.redact);
    const entries: PlanTest[] = new Array(placed.length);
    let next = 0;
    const worker = async () => {
      while (next < placed.length) {
        const k = next++;
        const { test, id, file } = placed[k]!;
        entries[k] = await reviewTest(test, id, rel(file), byId, jev, redact, opts.approve === true, opts.signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, placed.length) }, worker));
    const approvable = entries.filter((e) => e.review.issues.length === 0).length;
    progress('review', `Jev 검토 완료: 승인 가능 ${approvable}/${entries.length}${opts.approve ? ` · 승인 ${entries.filter((e) => e.status === 'approved').length}` : ''}`);

    // ── merge with the previous plan (other documents are kept) ──
    const newPaths = new Set(docs.map((d) => d.path));
    const keptReqs = previous?.requirements.filter((r) => !newPaths.has(r.doc)) ?? [];
    const keptIds = new Set(keptReqs.map((r) => r.id));
    const keptTests: PlanTest[] = [];
    const removedTests: PlanTest[] = [];
    for (const t of previous?.tests ?? []) (t.covers.length && t.covers.every((c) => keptIds.has(c)) ? keptTests : removedTests).push(t);
    const keptUntestable = previous?.untestable.filter((u) => keptIds.has(u.requirement)) ?? [];
    const accounted = new Set([...keptTests.flatMap((t) => t.covers), ...keptUntestable.map((u) => u.requirement)]);
    for (const r of keptReqs) {
      if (!accounted.has(r.id)) keptUntestable.push({ requirement: r.id, reason: '다른 문서를 다시 계획하면서 이 요구사항을 다루던 테스트가 제거됨 — 이 문서도 다시 계획하세요' });
    }
    const approvedRemoved = removedTests.filter((t) => t.status === 'approved').length;
    if (approvedRemoved) warn(`이전 계획의 승인된 테스트 ${approvedRemoved}개가 새 계획으로 대체됩니다`);

    const plan = PlanFile.parse({
      version: 1,
      app: opts.app,
      createdAt: new Date().toISOString(),
      llm: { provider, model },
      docs: [...(previous?.docs.filter((d) => !newPaths.has(d.path)) ?? []), ...docs.map((d) => ({ path: d.path, sha256: d.sha256, kind: d.kind }))],
      requirements: [...keptReqs, ...requirements],
      tests: [...keptTests, ...entries],
      untestable: [...keptUntestable, ...generated.untestable],
    });

    // ── write ──
    if (opts.signal?.aborted) throw new Error('계획 생성이 취소되었습니다');
    const newFiles = new Set(placed.map((p) => p.file));
    for (const t of removedTests) {
      const file = resolve(root, t.file);
      if (!file.startsWith(planDir + sep) || newFiles.has(file) || !existsSync(file)) continue;
      rmSync(file);
      const dir = dirname(file);
      if (dir !== planDir && readdirSync(dir).length === 0) rmdirSync(dir);
    }
    placed.forEach(({ test, id, file }, k) => {
      const status = entries[k]!.status;
      const { id: _id, name, platforms, tags, covers, app, ...rest } = test.spec;
      const body = { id, name, app, ...(platforms ? { platforms } : {}), ...(tags ? { tags } : {}), covers, source: { plan: rel(planPath), status }, ...rest };
      writeSecure(file, `# qa plan으로 생성됨 · 상태 ${status} · 계획 ${rel(planPath)}\n${stringifyYaml(body, { lineWidth: 0 })}`);
    });
    writeJson(planPath, plan);
    progress('write', `테스트 ${placed.length}개 저장: ${rel(planDir)}`);
    const message = `요구사항 ${requirements.length}개 · 테스트 ${placed.length}개 · 테스트 불가 ${generated.untestable.length}개`;
    events?.emit({ type: 'plan.finished', planId, planPath, requirements: requirements.length, tests: placed.length, untestable: generated.untestable.length, ok: true, message });
    return { planPath, plan, testFiles: placed.map((p) => p.file), dropped: generated.dropped };
  } catch (err) {
    events?.emit({ type: 'plan.finished', planId, planPath, requirements: 0, tests: 0, untestable: 0, ok: false, message: (err as Error).message });
    throw err;
  }
}

function readPlan(file: string): PlanFile | null {
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`기존 plan.json이 JSON이 아닙니다: ${file} — 고치거나 지운 뒤 다시 실행하세요`);
  }
  const parsed = PlanFile.safeParse(json);
  if (!parsed.success) throw new Error(`기존 plan.json 형식 오류: ${file}: ${parsed.error.issues[0]?.path.join('.')} — 고치거나 지운 뒤 다시 실행하세요`);
  return parsed.data;
}

function resolveJev(env: NodeJS.ProcessEnv): JevAccess {
  try {
    const client = new JevClient(loadJevConfig(env));
    return { client, calibration: loadCalibration(client.model) };
  } catch (err) {
    return { client: null, calibration: null, reason: `jev_unavailable: ${(err as Error).message}` };
  }
}

/**
 * Jev review → status. `approved` needs: `--approve`, the review gate passed (approvable) and no validation warnings.
 * Uncalibrated / unavailable Jev or a failed call leaves the test in `draft` with the reason as an issue.
 */
async function reviewTest(
  test: GeneratedTest,
  id: string,
  file: string,
  requirements: ReadonlyMap<string, Requirement>,
  jev: JevAccess,
  redact: Redactor,
  approve: boolean,
  signal: AbortSignal | undefined,
): Promise<PlanTest> {
  const covers = test.covers;
  if (!jev.client) {
    return { file, covers, status: 'draft', review: { addressesRequirement: null, unrelatedSteps: null, needsClarification: null, issues: [jev.reason ?? 'jev_unavailable', ...test.warnings] } };
  }
  const requirement = { id: covers.join(', '), text: covers.map((c) => `[${c}] ${requirements.get(c)?.text ?? ''}`).join('\n\n') };
  const decision = await reviewGenerated(jev.client, { requirement, test: { ...test.spec, id } }, { redact, calibration: jev.calibration, signal });
  const issues = [...decision.review.issues, ...test.warnings];
  const status = approve && decision.verdict === 'approvable' && !test.warnings.length ? 'approved' : 'draft';
  return { file, covers, status, review: { ...decision.review, issues } };
}
