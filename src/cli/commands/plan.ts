// `qa plan --app <id> [docs...] [--text "..."] [--llm claude-cli|codex-cli] [--model m] [--approve] [--run [--platform p]]`
import { relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../../core/config.ts';
import type { QaEventBody } from '../../core/events.ts';
import { generatePlan, LLM_PROVIDERS } from '../../plan/index.ts';
import { runTests } from '../../runner/index.ts';

const PLATFORMS: Record<string, 'android' | 'ios' | 'all'> = { android: 'android', ios: 'ios', all: 'all' };

export async function cmdPlan(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        app: { type: 'string' },
        text: { type: 'string' },
        llm: { type: 'string' },
        model: { type: 'string' },
        approve: { type: 'boolean', default: false },
        run: { type: 'boolean', default: false },
        platform: { type: 'string', default: 'all' },
      },
    });
  } catch (err) {
    console.error(`qa plan: ${(err as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (!values.app) {
    console.error('qa plan: --app <앱 id>가 필요합니다 (예: qa plan --app tteonam [문서...] [--text "시나리오"])');
    return 2;
  }
  const llm = values.llm === undefined ? undefined : LLM_PROVIDERS[values.llm];
  if (values.llm !== undefined && !llm) {
    console.error(`qa plan: --llm은 claude-cli | codex-cli 중 하나입니다 (현재: ${values.llm})`);
    return 2;
  }
  const platform = PLATFORMS[values.platform];
  if (!platform) {
    console.error(`qa plan: --platform은 android | ios | all 중 하나입니다 (현재: ${values.platform})`);
    return 2;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  const events = {
    emit(e: QaEventBody) {
      if (e.type === 'plan.progress') console.error(`[plan:${e.phase}] ${e.message}`);
      else if (e.type === 'log') console.error(`[${e.level === 'warn' ? '경고' : e.level}] ${e.message}`);
    },
  };
  try {
    const result = await generatePlan({
      app: values.app,
      docs: positionals,
      text: values.text,
      llm,
      model: values.model,
      approve: values.approve,
      events,
      signal: controller.signal,
    });
    const { plan } = result;
    const newFiles = new Set(result.testFiles.map((f) => relative(ROOT, f).split(sep).join('/')));
    const fresh = plan.tests.filter((t) => newFiles.has(t.file));
    const approved = fresh.filter((t) => t.status === 'approved').length;
    console.log(`계획: ${relative(ROOT, result.planPath)}`);
    console.log(`요구사항 ${plan.requirements.length}개 · 이번 테스트 ${fresh.length}개 (draft ${fresh.length - approved}, approved ${approved}) · 테스트 불가 ${plan.untestable.length}개`);
    for (const t of fresh) {
      console.log(`  [${t.status}] ${t.file} ← ${t.covers.join(', ')}${t.review.issues.length ? `\n      이슈: ${t.review.issues.join(' / ')}` : ''}`);
    }
    if (plan.untestable.length) {
      console.log('테스트 불가:');
      for (const u of plan.untestable) console.log(`  ${u.requirement}: ${u.reason}`);
    }
    for (const d of result.dropped) console.log(`폐기: ${d.label} (${d.covers.join(', ')}): ${d.errors.join('; ')}`);
    if (!values.run) return 0;
    if (!result.testFiles.length) {
      console.error('qa plan --run: 실행할 생성 테스트가 없습니다');
      return 1;
    }
    const run = await runTests({ paths: result.testFiles, platform, signal: controller.signal });
    console.log(`실행 ${run.runId}: ${Object.entries(run.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}\n리포트: ${run.reportPath}`);
    // Fail closed: exit 0 only when something ran and every result is PASS.
    const total = Object.values(run.counts).reduce((a, b) => a + b, 0);
    return total > 0 && run.counts.PASS === total ? 0 : 1;
  } catch (err) {
    console.error(`qa plan: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
  }
}
