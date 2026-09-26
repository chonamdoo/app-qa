// LLM generation with deterministic validation: one call per requirement batch, at most ONE structured revision
// round with the exact validation errors, then every still-invalid test is dropped and its requirements are recorded
// as untestable with the reason. Model output never reaches disk without passing `checkOutput`.
import type { Requirement } from '../spec/schema.ts';
import type { AppContext } from './context.ts';
import { extractJson, type Llm } from './llm.ts';
import { buildPrompt, buildRevisionPrompt, outputJsonSchema } from './prompt.ts';
import { checkOutput, formatErrors, type CheckContext, type CheckedOutput, type Untestable } from './validate.ts';

export interface GeneratedTest {
  /** Validated test object as it will be written (without `id` normalization and `source`). */
  spec: Record<string, unknown>;
  covers: string[];
  warnings: string[];
}

export interface DroppedTest {
  label: string;
  covers: string[];
  errors: string[];
}

export interface GenerationResult {
  tests: GeneratedTest[];
  untestable: Untestable[];
  dropped: DroppedTest[];
}

export interface GenerateOptions {
  llm: Llm;
  context: AppContext;
  requirements: readonly Requirement[];
  signal?: AbortSignal;
  onProgress?: (phase: 'generate' | 'validate', message: string) => void;
}

/** Requirements per LLM call; large spreadsheets are split so each reply stays well inside output limits. */
const MAX_BATCH_REQUIREMENTS = 60;
const MAX_BATCH_CHARS = 30_000;

export async function generateTests(opts: GenerateOptions): Promise<GenerationResult> {
  const { llm, context, signal } = opts;
  const progress = opts.onProgress ?? (() => {});
  const schema = outputJsonSchema();
  const batches: Requirement[][] = [];
  let chars = 0;
  for (const r of opts.requirements) {
    const last = batches.at(-1);
    if (!last || last.length >= MAX_BATCH_REQUIREMENTS || chars + r.text.length > MAX_BATCH_CHARS) {
      batches.push([r]);
      chars = r.text.length;
    } else {
      last.push(r);
      chars += r.text.length;
    }
  }

  const result: GenerationResult = { tests: [], untestable: [], dropped: [] };
  for (const [b, batch] of batches.entries()) {
    const where = batches.length > 1 ? ` (배치 ${b + 1}/${batches.length})` : '';
    const ctx: CheckContext = {
      app: context.profile.id,
      profile: context.profile,
      envNames: context.envNames,
      requirementIds: new Set(batch.map((r) => r.id)),
      screens: context.screens,
    };
    const prompt = buildPrompt(context, batch, schema);
    progress('generate', `${llm.provider} ${llm.model}로 요구사항 ${batch.length}개 테스트 생성 중${where}`);
    const first = await llm.complete(prompt, { schema, signal });
    let checked = parseAndCheck(first, ctx);
    let errors = formatErrors(checked);
    if (errors.length) {
      progress('validate', `검증 오류 ${errors.length}건${where} → 오류 목록으로 1회 수정 요청`);
      try {
        const revised = parseAndCheck(await llm.complete(buildRevisionPrompt(prompt, first, errors), { schema, signal }), ctx);
        // An unparseable revision must not throw away tests that were already valid in the first reply.
        if (!revised.unparsed || checked.unparsed) checked = revised;
        else progress('validate', `수정 응답이 JSON이 아님 — 첫 결과의 유효한 테스트만 사용`);
      } catch (err) {
        if (signal?.aborted) throw err;
        progress('validate', `수정 요청 실패: ${(err as Error).message} — 첫 결과의 유효한 테스트만 사용`);
      }
      errors = formatErrors(checked);
      progress('validate', errors.length ? `수정 후에도 오류 ${errors.length}건${where} — 오류 테스트는 폐기` : `수정 후 검증 통과${where}`);
    } else progress('validate', `검증 통과${where}`);
    collectBatch(checked, batch, result);
  }
  return result;
}

function parseAndCheck(text: string, ctx: CheckContext): CheckedOutput & { unparsed: boolean } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { tests: [], untestable: [], errors: [(err as Error).message], unparsed: true };
  }
  return { ...checkOutput(raw, ctx), unparsed: false };
}

/** Valid tests are kept; every batch requirement ends up covered or untestable (with the most specific reason). */
function collectBatch(checked: CheckedOutput & { unparsed: boolean }, batch: readonly Requirement[], out: GenerationResult): void {
  const covered = new Set<string>();
  const droppedFor = new Map<string, DroppedTest>();
  for (const t of checked.tests) {
    if (t.errors.length) {
      const dropped = { label: t.label, covers: t.covers, errors: t.errors };
      out.dropped.push(dropped);
      for (const c of t.covers) if (!droppedFor.has(c)) droppedFor.set(c, dropped);
      continue;
    }
    out.tests.push({ spec: t.spec, covers: t.covers, warnings: t.warnings });
    for (const c of t.covers) covered.add(c);
  }
  const listed = new Set<string>();
  for (const u of checked.untestable) {
    if (covered.has(u.requirement) || listed.has(u.requirement)) continue;
    listed.add(u.requirement);
    out.untestable.push(u);
  }
  for (const r of batch) {
    if (covered.has(r.id) || listed.has(r.id)) continue;
    const dropped = droppedFor.get(r.id);
    let reason = '생성 누락: 모델이 이 요구사항에 대한 테스트나 사유를 내지 않음';
    if (dropped) reason = `검증 실패로 테스트 폐기 (${dropped.label}): ${dropped.errors[0]}`;
    else if (checked.unparsed) reason = `생성 실패: ${checked.errors[0]}`;
    out.untestable.push({ requirement: r.id, reason });
  }
}
