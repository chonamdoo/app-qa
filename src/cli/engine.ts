import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectEngineClient, EngineHttpError, type EngineClient } from '../core/agent-client.ts';
import { formatCounts, formatQaCounts } from '../report/console.ts';
import { SUMMARY_SCHEMA, type RunSummary } from '../report/types.ts';
import type { JobRequest, JobView } from '../server/jobs.ts';

export class CliJobCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliJobCancelled';
  }
}

const finished = (job: JobView): boolean => job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled';

export async function runEngineJob(request: JobRequest, options: { client?: EngineClient; signal?: AbortSignal } = {}): Promise<JobView> {
  let interrupted = options.signal?.aborted ?? false;
  const interrupt = () => { interrupted = true; };
  if (options.signal) options.signal.addEventListener('abort', interrupt, { once: true });
  else process.once('SIGINT', interrupt);
  let job: JobView | null = null;
  let cancellationSent = false;
  try {
    if (interrupted) throw new CliJobCancelled('작업을 제출하기 전에 취소했습니다.');
    const client = options.client ?? await connectEngineClient();
    if (interrupted) throw new CliJobCancelled('작업을 제출하기 전에 취소했습니다.');
    try {
      job = await client.request<JobView>('/api/jobs', { method: 'POST', body: request });
    } catch (error) {
      throw new Error(`작업 제출 응답을 확인하지 못했습니다. 자동 재제출하지 않습니다. 엔진 작업 목록에서 제출 여부를 확인하세요. ${error instanceof Error ? error.message : String(error)}`);
    }
    console.error(`작업 ${job.id} · ${job.state}`);
    let lastState = job.state;
    while (true) {
      if (interrupted && !cancellationSent && !finished(job)) {
        cancellationSent = true;
        console.error(`작업 ${job.id}에 취소를 요청합니다. 취소는 이미 발생한 효과를 되돌리지 않습니다.`);
        try {
          await client.request(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
        } catch (error) {
          if (!(error instanceof EngineHttpError && error.status === 409)) throw error;
        }
      }
      if (finished(job)) {
        if (interrupted || job.state === 'cancelled') throw new CliJobCancelled(`작업 ${job.id} · ${job.state}: ${job.message ?? '종료됨'}. 이미 발생한 효과의 취소나 복구를 보장하지 않습니다.`);
        return job;
      }
      await delay(250);
      job = await client.request<JobView>(`/api/jobs/${encodeURIComponent(job.id)}`);
      if (job.state !== lastState) {
        console.error(`작업 ${job.id} · ${job.state}`);
        lastState = job.state;
      }
    }
  } catch (error) {
    if (error instanceof CliJobCancelled) throw error;
    if (job) throw new Error(`작업 ${job.id}의 최종 상태를 확인하지 못했습니다. 요청을 재전송하지 않았습니다. 엔진에서 같은 작업을 확인하세요. ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', interrupt);
    else process.removeListener('SIGINT', interrupt);
  }
}

export async function readJobRunSummary(client: EngineClient, job: JobView): Promise<RunSummary | null> {
  if (!job.resultPath) return null;
  const runId = basename(dirname(job.resultPath));
  const summary = await client.request<RunSummary>(`/api/runs/${encodeURIComponent(runId)}`);
  if (summary.$schema !== SUMMARY_SCHEMA || summary.runId !== runId) throw new Error(`작업 ${job.id}의 실행 요약이 리포트 경로와 일치하지 않습니다.`);
  return summary;
}

export function printRunSummary(job: JobView, summary: RunSummary): void {
  for (const test of summary.tests) if (test.code === 'spec_invalid') console.error(`\n테스트 파일 오류:\n${test.reason}`);
  console.log(`\n결과: ${formatCounts(summary.counts) || '실행된 테스트 없음'}`);
  console.log(`QA 상태: ${formatQaCounts(summary.qaCounts)}`);
  console.log(`리포트: ${job.resultPath}`);
}
