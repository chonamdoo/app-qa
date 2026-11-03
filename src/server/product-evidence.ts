import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, constants } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentCallContext, AgentRequestInput } from '../core/agent.ts';
import { commitDirectory, ensureDir, writeAll, writeJsonAtomic } from '../core/fsx.ts';
import { acquireFileLock } from '../core/lock.ts';
import { RecordingSegmentSchema, RecordingStatusSchema, recordingCleanupConfirmed } from '../core/recording.ts';
import type { PublishedRevision, RegressionAttempt, RegressionRun, ScenarioOrigin } from '../core/regression.ts';
import {
  EvidenceSelection, ProductEvidenceRequest, ProductEvidenceError, assertEvidenceDigestReadable, assertProductEvidenceRead,
  defaultEvidenceAuthorityRoot, evidenceJSONDigest, evidenceRelativePath, evidenceRunKey, evidenceTombstone,
  hashOpenPrivateEvidence, hashPrivateEvidence, immutableProductEvidencePath, openPrivateEvidence, openPrivateRunEvidence, readOpenPrivateEvidenceJSON, readPrivateEvidenceJSON,
  type EvidenceConsent, type EvidenceOperationPreview, type EvidenceOperationResult, type EvidenceQuery,
  type ProductArtifact, type ProductEvidenceReports, type ProductReportRow, type ProductSymptomGroup, type RunEvidenceReader,
  type NativeDownloadLease, type NativeDownloadPending, type PortableEvidenceRenderer,
} from '../core/product-evidence.ts';
import { NativeDownloadRegistry } from './native-downloads.ts';

const UUID = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Terminal: Record<string, true> = { finished: true, cancelled: true, blocked: true };
const Manifest = z.object({ $schema: z.literal('app-qa/manifest/v1'), runId: z.string(), updatedAt: z.iso.datetime({ offset: true }), entries: z.array(z.object({ kind: z.string(), relativePath: z.string(), sizeBytes: z.number().int().nonnegative() })).max(20_000) });
const Video = z.object({ schema: z.literal('qautra/attempt-video/v1'), binding: z.object({ attemptId: UUID, runId: z.string(), platform: z.string(), deviceId: z.string() }), state: z.enum(['ready', 'incomplete']), cleanup: z.enum(['confirmed', 'unknown']), segments: z.array(RecordingSegmentSchema).max(2000), gaps: z.array(z.unknown()).max(10000), artifacts: z.array(z.object({ file: z.string(), status: RecordingStatusSchema })).max(2000).optional() });
const Result = z.object({ attemptId: UUID, revisionId: z.string(), runId: z.string().nullable(), business: z.string(), cleanup: z.string() });
const Summary = z.object({ runId: z.string(), tests: z.array(z.object({ id: z.string(), platform: z.string(), deviceId: z.string().nullable(), verdict: z.string(), code: z.string().nullable(), reason: z.string(), steps: z.array(z.object({ seq: z.number().int(), index: z.number().int(), label: z.string(), kind: z.string(), phase: z.string(), verdict: z.string(), code: z.string().nullable(), reason: z.string(), durationMs: z.number(), decisions: z.array(z.unknown()), health: z.array(z.unknown()) })).max(10000) })).max(1000) });
export interface ProductEvidencePolicy { version: string; localExport: boolean; rawLocalExport: boolean; delete: boolean }
export interface ProductEvidenceDependencies {
  root: string;
  runsDir?: string;
  query: EvidenceQuery;
  authorityRoot?: string;
  now?: () => number;
  policy?: () => ProductEvidencePolicy;
  /** Injected by the composition root; exports are refused without it rather than shipped without index.html. */
  renderPortableHtml?: PortableEvidenceRenderer;
}
type PreviewState = { preview: EvidenceOperationPreview; rows: ProductReportRow[]; principal: string };
const ConsentArtifact = z.strictObject({
  id: Digest, requestID: UUID, attemptID: UUID, runID: z.string(), revisionID: z.string(), testID: z.string(),
  target: z.strictObject({ platform: z.string(), deviceId: z.string() }), kind: z.string(), relativePath: z.string(), capturedAt: z.string(),
  captureClock: z.enum(['source', 'encoder-observed', 'manifest-update']), privacy: z.enum(['raw', 'sanitized-text-not-shared']),
  state: z.enum(['ready', 'finalizing', 'incomplete', 'missing', 'deleted', 'deletion-confirmation-needed', 'blocked']),
  sha256: Digest.nullable(), bytes: z.number().int().nonnegative().nullable(), reason: z.string().nullable(), exportable: z.boolean(), deletable: z.boolean(), gaps: z.array(z.json()),
});
// Key order matches the row built in reports(): export metadata binds the digest of the serialized rows, and zod emits keys in schema order.
const ConsentRow = z.strictObject({
  requestID: UUID, runName: z.string(), attemptID: UUID, runID: z.string().nullable(), revisionID: z.string(), testID: z.string(),
  originalCaseIDs: z.array(z.string()), target: z.json(), createdAt: z.string(), business: z.string(), execution: z.string(), evidence: z.string(),
  cleanup: z.string(), code: z.string().nullable(), expected: z.array(z.json()), requiredChecks: z.array(z.string()), completedChecks: z.array(z.string()),
  actual: z.json(), conditions: z.json(), limitations: z.array(z.string()),
});
const RecordSchema = z.strictObject({
  preview: z.strictObject({
    previewID: UUID, operation: z.enum(['export', 'delete']), selection: EvidenceSelection, scopeDigest: Digest, policyDigest: Digest,
    expiresAt: z.iso.datetime({ offset: true }), artifacts: z.array(ConsentArtifact).max(2000), resultRows: z.number().int().nonnegative(), warning: z.string(), blocked: z.array(z.string()),
  }),
  rows: z.array(ConsentRow), principal: z.string().min(1), consentID: UUID, revoked: z.boolean(), consumed: z.boolean(), exportID: UUID.nullable(),
});
type ConsentRecord = z.infer<typeof RecordSchema>;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
function fault(status: number, code: string, message: string): never { throw new ProductEvidenceError(status, code, message); }
const outsideCopies = '관리 밖으로 저장·복사한 export는 QAutra가 원격 삭제할 수 없습니다. 외부 네트워크 전송은 수행하지 않습니다.';
const warning = '선택한 원시 화면·영상·로그와 결과·조건에는 개인정보가 포함될 수 있습니다. 텍스트 정제는 영상 마스킹이 아닙니다. 공유용 마스킹 자료를 생성하지 않습니다. 이번 작업의 정확한 범위만 승인합니다.';

function exportContentScope(artifacts: readonly Pick<ProductArtifact, 'exportable' | 'kind' | 'runID' | 'sha256'>[], rows: readonly { runID: string | null }[]): { runIDs: string[]; authorizedRunIDs: string[]; digests: string[] } {
  const included = artifacts.filter(item => item.exportable);
  return {
    runIDs: [...new Set(included.filter(item => item.kind !== 'media-receipt').map(item => item.runID))].sort(),
    authorizedRunIDs: [...new Set([...rows.flatMap(row => row.runID ? [row.runID] : []), ...included.map(item => item.runID)])].sort(),
    digests: [...new Set([...included.flatMap(item => item.sha256 ? [item.sha256] : []), evidenceJSONDigest(rows)])].sort(),
  };
}

export class ProductEvidenceService {
  private readonly root: string;
  readonly authorityRoot: string;
  private readonly previews = new Map<string, PreviewState>();
  private readonly dependencies: ProductEvidenceDependencies;
  private readonly nativeDownloads: NativeDownloadRegistry;
  constructor(dependencies: ProductEvidenceDependencies) {
    this.dependencies = dependencies;
    this.root = resolve(dependencies.root);
    this.authorityRoot = resolve(dependencies.authorityRoot ?? defaultEvidenceAuthorityRoot());
    if (this.authorityRoot === this.root || this.authorityRoot.startsWith(`${this.root}/`)) fault(500, 'authority_not_private', '삭제·철회 권위는 프로젝트 backup 밖의 사용자 전용 경로여야 합니다');
    this.nativeDownloads = new NativeDownloadRegistry(this.authorityRoot, () => this.now());
  }
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private expired(at: string): boolean {
    const time = Date.parse(at);
    return !Number.isFinite(time) || time <= this.now();
  }
  private consent(consentID: string): ConsentRecord {
    let value: unknown;
    try { value = readPrivateEvidenceJSON(this.authorityRoot, `consents/${UUID.parse(consentID)}.json`); }
    catch (error) { if (missing(error)) fault(403, 'consent_unavailable', '동의 기록이 없습니다. 새 작업별 확인이 필요합니다'); throw error; }
    const record = RecordSchema.safeParse(value);
    if (!record.success || record.data.consentID !== consentID) fault(409, 'consent_record_invalid', '동의 기록의 범위·만료 형식을 확인하지 못했습니다. 새 작업별 확인이 필요합니다');
    return record.data;
  }
  private policy(): ProductEvidencePolicy {
    return z.strictObject({ version: z.string().min(1), localExport: z.boolean(), rawLocalExport: z.boolean(), delete: z.boolean() }).parse(this.dependencies.policy?.() ?? { version: 'local-user-confirmed/v1', localExport: true, rawLocalExport: true, delete: true });
  }
  private principal(context: AgentCallContext): string {
    if (context.operatorReview?.channel !== 'local-ui' || !context.operatorReview.principalId) fault(403, 'local_review_required', '이번 작업은 로컬 사용자의 별도 범위 확인이 필요합니다');
    return context.operatorReview.principalId;
  }
  private audit(event: string, details: unknown): void {
    writeJsonAtomic(join(this.authorityRoot, 'audit', `${randomUUID()}.json`), { schema: 'qautra/evidence-audit/v1', at: new Date(this.now()).toISOString(), project: evidenceJSONDigest(this.root), event, details });
  }
  private async query<T>(request: AgentRequestInput): Promise<T> {
    const reply = await this.dependencies.query.call(request);
    if (!reply.ok) fault(409, reply.error.code, reply.error.message);
    return reply.result as T;
  }
  private async runs(requestID?: string): Promise<RegressionRun[]> {
    const runs = await this.query<RegressionRun[]>({ method: 'regression.list' });
    if (!Array.isArray(runs) || runs.length > 10000) fault(409, 'run_scope_invalid', '실행 조회 범위를 확인하지 못했습니다');
    if (requestID && !runs.some(run => run.requestId === requestID)) fault(404, 'run_missing', '선택한 실행 기록이 없습니다');
    return runs.filter(run => !requestID || run.requestId === requestID);
  }
  private runRoot(runID: string): string { return join(this.dependencies.runsDir ?? join(this.root, '.qa', 'runs'), evidenceRelativePath(runID)); }
  private read(runID: string, path: string): unknown {
    const reader = this.openRunFile(runID, path, 16 * 1024 ** 2);
    try { return readOpenPrivateEvidenceJSON({ fd: reader.fd, size: reader.bytes, assertUnchanged: reader.assertUnchanged }); }
    finally { closeSync(reader.fd); }
  }
  private ownership(attempt: RegressionAttempt): boolean {
    if (!attempt.runId) return false;
    try { const result = Result.parse(this.read(attempt.runId, 'attempt-result.json')); return result.attemptId === attempt.attemptId && result.revisionId === attempt.revisionId && result.runId === attempt.runId && result.business === attempt.business && result.cleanup === attempt.cleanup; }
    catch { return false; }
  }
  async reports(requestID?: string): Promise<ProductEvidenceReports> {
    const rows: ProductReportRow[] = [], revisions = new Map<string, PublishedRevision | null>();
    const origins = new Map<string, string[]>();
    const currentEvidence = await this.library({ method: 'library', requestID });
    for (const run of await this.runs(requestID)) for (const attempt of run.attempts) {
      if (!revisions.has(attempt.revisionId)) {
        try { const revision = await this.query<PublishedRevision>({ method: 'scenario.get', revisionId: attempt.revisionId }); revisions.set(attempt.revisionId, revision.revisionId === attempt.revisionId ? revision : null); }
        catch { revisions.set(attempt.revisionId, null); }
      }
      const revision = revisions.get(attempt.revisionId), limitations: string[] = [];
      const expected = revision?.definition.checks.filter(check => attempt.requiredChecks.includes(check.id) && check.platforms.includes(attempt.target.platform)) ?? [];
      if (expected.length !== attempt.requiredChecks.length) limitations.push('원 발행본의 필수 검증 일부를 확인하지 못했습니다. 최신 정의로 보충하지 않습니다.');
      const originalCaseIDs: string[] = [];
      for (const testID of attempt.chain?.members ?? [attempt.testId]) {
        const key = `${attempt.revisionId}:${testID}`;
        if (!origins.has(key)) {
          try {
            const origin = await this.query<ScenarioOrigin>({ method: 'scenario.origin', revisionId: attempt.revisionId, testId: testID });
            origins.set(key, origin.revisionId === attempt.revisionId && origin.testId === testID && origin.availability === 'verified' ? [...new Set(origin.manifest.source.mappings.flatMap(mapping => mapping.originalCaseID ? [mapping.originalCaseID] : []))] : []);
          } catch { origins.set(key, []); }
        }
        originalCaseIDs.push(...origins.get(key)!);
      }
      if (!originalCaseIDs.length) limitations.push('원 TC ID 매핑이 발행본에 포착되지 않았습니다. 현재 문서에서 추정하지 않습니다.');
      let actual: unknown = { business: attempt.business, code: attempt.code, message: attempt.message, steps: null };
      if (attempt.runId) {
        try {
          const summary = Summary.parse(this.read(attempt.runId, 'summary.json'));
          if (summary.runId !== attempt.runId || !this.ownership(attempt)) throw new Error('ownership');
          const members = new Set(attempt.chain?.members ?? [attempt.testId]);
          actual = { business: attempt.business, code: attempt.code, message: attempt.message, tests: summary.tests.filter(test => members.has(test.id) && test.platform === attempt.target.platform && test.deviceId === attempt.target.deviceId) };
        } catch { limitations.push('원 summary 또는 attempt 소유권을 확인하지 못했습니다. 실행 접수 기록만 표시합니다.'); }
      }
      const marker = attempt.runId ? evidenceTombstone(this.root, attempt.runId, this.authorityRoot) : null;
      const videos = currentEvidence.artifacts.filter(item => item.attemptID === attempt.attemptId && item.kind === 'video');
      const evidence = marker?.state ?? (attempt.evidence === 'ready' ? !videos.length || videos.some(item => item.state === 'missing') ? 'missing' : videos.some(item => item.state === 'blocked') ? 'blocked' : videos.some(item => item.state !== 'ready') ? 'incomplete' : 'ready' : attempt.evidence);
      rows.push({ requestID: run.requestId, runName: run.name, attemptID: attempt.attemptId, runID: attempt.runId, revisionID: attempt.revisionId, testID: attempt.testId, originalCaseIDs: [...new Set(originalCaseIDs)], target: attempt.target, createdAt: run.createdAt, business: attempt.business, execution: attempt.state, evidence, cleanup: attempt.cleanup, code: attempt.code, expected, requiredChecks: [...attempt.requiredChecks], completedChecks: [...attempt.completedChecks], actual, conditions: attempt.conditions ?? null, limitations });
    }
    return { rows, groups: groupProductSymptoms(rows) };
  }
  async library(filter: Extract<ProductEvidenceRequest, { method: 'library' }> = { method: 'library' }): Promise<{ artifacts: ProductArtifact[]; limitations: string[]; externalTransmission: 'denied' }> {
    const artifacts: ProductArtifact[] = [], limitations: string[] = [];
    const allRuns = await this.runs();
    if (filter.requestID && !allRuns.some(run => run.requestId === filter.requestID)) fault(404, 'run_missing', '선택한 실행 기록이 없습니다');
    const runs = allRuns.filter(run => !filter.requestID || run.requestId === filter.requestID);
    const owners = new Map<string, number>();
    for (const run of allRuns) for (const attempt of run.attempts) if (attempt.runId) owners.set(attempt.runId, (owners.get(attempt.runId) ?? 0) + 1);
    for (const run of runs) for (const attempt of run.attempts) {
      if (!attempt.runId || (filter.attemptID && attempt.attemptId !== filter.attemptID)) continue;
      const runID = attempt.runId, safe = this.ownership(attempt) && owners.get(runID) === 1;
      const terminal = Boolean(Terminal[attempt.state] && Terminal[run.state]) && attempt.cleanup === 'confirmed';
      const marker = evidenceTombstone(this.root, runID, this.authorityRoot);
      const add = (kind: string, path: string, capturedAt: string, options: { sha256?: string; bytes?: number; ready?: boolean; finalized?: boolean; gaps?: unknown[]; captureClock?: ProductArtifact['captureClock']; copiesConfirmed?: boolean } = {}): void => {
        try { evidenceRelativePath(path); } catch { limitations.push(`${attempt.attemptId}: manifest의 안전하지 않은 경로를 차단했습니다`); return; }
        if (immutableProductEvidencePath(path)) kind = 'media-receipt';
        const id = evidenceJSONDigest([run.requestId, attempt.attemptId, runID, path]);
        if (artifacts.some(artifact => artifact.id === id)) return;
        const erased = kind === 'media-receipt' ? null : marker;
        let state: ProductArtifact['state'] = erased?.state ?? (terminal ? options.ready === false ? 'incomplete' : 'ready' : attempt.state === 'finalizing' ? 'finalizing' : 'incomplete');
        let reason: string | null = null, sha256: string | null = options.sha256 ?? null, bytes: number | null = options.bytes ?? null;
        if (!erased) {
          try {
            const actual = hashPrivateEvidence(this.runRoot(runID), path);
            if ((sha256 && actual.sha256 !== sha256) || (bytes !== null && actual.bytes !== bytes)) throw new Error('manifest digest/size mismatch');
            sha256 = actual.sha256; bytes = actual.bytes;
            assertEvidenceDigestReadable(sha256, this.authorityRoot);
          } catch (error) {
            state = error instanceof ProductEvidenceError && error.status === 410 ? 'deleted' : missing(error) ? 'missing' : 'blocked';
            reason = state === 'missing' ? 'manifest에 기록됐지만 실제 파일이 없습니다' : error instanceof Error ? error.message : '증거 읽기 차단';
          }
        }
        if (!safe) { if (!marker) state = 'blocked'; reason = 'attempt 원 결과와 유일한 run 소유권을 확인하지 못했습니다'; }
        artifacts.push({ id, requestID: run.requestId, attemptID: attempt.attemptId, runID, revisionID: attempt.revisionId, testID: attempt.testId, target: attempt.target, kind, relativePath: path, capturedAt, captureClock: options.captureClock ?? 'manifest-update', privacy: 'raw', state, sha256, bytes, reason, exportable: safe && terminal && (state === 'ready' || state === 'incomplete' && options.finalized === true) && kind !== 'report', deletable: safe && terminal && !marker && options.copiesConfirmed !== false && ['screenshot', 'video', 'source', 'elements', 'log', 'crash', 'report', 'diagnostic'].includes(kind) && !['blocked', 'deleted', 'deletion-confirmation-needed'].includes(state), gaps: options.gaps ?? [] });
      };
      try {
        const manifest = Manifest.parse(this.read(runID, 'manifest.json'));
        if (manifest.runId !== runID) throw new Error('manifest ownership mismatch');
        for (const entry of manifest.entries) {
          const immutable = entry.relativePath === 'journal.jsonl' || ['verdict', 'jev', 'events', 'junit'].includes(entry.kind) || /^web-qa\/(plan|result)\.json$/.test(entry.relativePath) || /(^|\/)(summary|attempt-result|scenario-revision|manifest|conditions-receipt|target-receipt|fixture-initial|fixture-final)\.json$/.test(entry.relativePath);
          if (immutable) continue;
          const expected = entry.kind === 'report' ? entry.relativePath === 'report.html' : /^(?:[^/]+\/(?:android|ios|desktop-chrome|desktop-safari)\/|logs\/|crashes\/)/.test(entry.relativePath);
          if (!expected || !['screenshot', 'source', 'elements', 'log', 'crash', 'report'].includes(entry.kind)) { limitations.push(`${attempt.attemptId}: 관리 capture 범위 밖의 manifest 항목은 제공하지 않습니다`); continue; }
          add(entry.kind, entry.relativePath, manifest.updatedAt, { bytes: entry.sizeBytes });
        }
      } catch { limitations.push(`${attempt.attemptId}: 일반 증거 manifest를 확인하지 못했습니다`); }
      try {
        const video = Video.parse(this.read(runID, `video/${attempt.attemptId}/manifest.json`));
        if (video.binding.attemptId !== attempt.attemptId || video.binding.runId !== runID || video.binding.deviceId !== attempt.target.deviceId || video.binding.platform !== attempt.target.platform) throw new Error('video ownership');
        const cleanup = video.cleanup === 'confirmed' && !!video.artifacts?.length && video.artifacts.every(artifact => recordingCleanupConfirmed(artifact.status));
        for (const segment of video.segments) {
          if (!segment.file.startsWith(`video/${attempt.attemptId}/segment-`) || !/^segment-\d{4}\.mp4$/.test(basename(segment.file))) { limitations.push(`${attempt.attemptId}: 잘못된 영상 귀속 경로`); continue; }
          const status = video.artifacts?.find(artifact => artifact.file === segment.file)?.status;
          const finalized = !!status && recordingCleanupConfirmed(status) && status.file === 'durable' && status.media === 'valid';
          add('video', segment.file, segment.startedAt, { sha256: segment.sha256, bytes: segment.bytes, ready: video.state === 'ready' && finalized, finalized, gaps: video.gaps, captureClock: segment.timing?.basis ?? 'source', copiesConfirmed: cleanup });
        }
        for (const artifact of video.artifacts ?? []) {
          if (!artifact.file.startsWith(`video/${attempt.attemptId}/`) || !/^segment-\d{4}\.mp4$/.test(basename(artifact.file))) continue;
          add('video', artifact.file, run.updatedAt, { ready: false, gaps: video.gaps, copiesConfirmed: cleanup });
          for (const suffix of ['.integrity.json', '.validation.json']) {
            try { lstatSync(join(this.runRoot(runID), `${artifact.file}${suffix}`)); add('media-receipt', `${artifact.file}${suffix}`, run.updatedAt, { copiesConfirmed: cleanup }); }
            catch (error) { if (!missing(error)) throw error; }
          }
          for (const diagnostic of artifact.status.diagnostics) {
            const path = relative(this.runRoot(runID), resolve(this.runRoot(runID), diagnostic));
            try { evidenceRelativePath(path); } catch { limitations.push(`${attempt.attemptId}: worker spool/진단 복사본의 소유·삭제 범위 확인이 필요합니다`); continue; }
            try { if (lstatSync(join(this.runRoot(runID), path)).isDirectory()) { limitations.push(`${attempt.attemptId}: 진단 디렉터리의 개별 복사본 목록이 없어 삭제 확인이 필요합니다`); continue; } } catch (error) { if (!missing(error)) throw error; }
            add('diagnostic', path, run.updatedAt, { ready: false, copiesConfirmed: cleanup });
          }
        }
        if (!cleanup) limitations.push(`${attempt.attemptId}: capture·encoder·worker spool 정리가 미확인입니다`);
        for (const name of readdirSync(join(this.runRoot(runID), 'video', attempt.attemptId))) {
          if (/^segment-\d{4}\.mp4(?:\.integrity\.json|\.validation\.json)?$/.test(name) || name === 'manifest.json' || artifacts.some(item => item.attemptID === attempt.attemptId && item.relativePath === `video/${attempt.attemptId}/${name}`)) continue;
          limitations.push(`${attempt.attemptId}: 목록에 없는 임시 segment·worker spool·복사본의 삭제 확인이 필요합니다`);
        }
      } catch { limitations.push(`${attempt.attemptId}: 영상 manifest·capture 소유권을 확인하지 못했습니다`); }
    }
    const filtered = artifacts.filter(item => (!filter.target || [item.target.platform, item.target.deviceId, `${item.target.platform}:${item.target.deviceId}`].includes(filter.target)) && (!filter.kind || item.kind === filter.kind) && (!filter.capturedFrom || Date.parse(item.capturedAt) >= Date.parse(filter.capturedFrom)) && (!filter.capturedTo || Date.parse(item.capturedAt) <= Date.parse(filter.capturedTo)));
    return { artifacts: filtered.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id)), limitations, externalTransmission: 'denied' };
  }
  private async scope(operation: 'export' | 'delete', selection: EvidenceSelection): Promise<{ artifacts: ProductArtifact[]; rows: ProductReportRow[]; blocked: string[]; policyDigest: string; scopeDigest: string }> {
    const library = await this.library(), reports = await this.reports();
    if (selection.requestIDs.some(id => !reports.rows.some(row => row.requestID === id))) fault(404, 'selection_missing', '선택한 실행이 더 이상 없습니다');
    const artifacts = selection.artifactIDs.map(id => library.artifacts.find(item => item.id === id && selection.requestIDs.includes(item.requestID)) ?? fault(409, 'selection_changed', '선택한 증거의 소유권·범위가 달라졌습니다')).sort((a, b) => a.id.localeCompare(b.id));
    const rows = reports.rows.filter(row => selection.requestIDs.includes(row.requestID));
    const policy = this.policy(), policyDigest = evidenceJSONDigest(policy), blocked: string[] = [];
    if (operation === 'export' && (!policy.localExport || !policy.rawLocalExport)) blocked.push('선택한 원시 증거·결과·조건을 내보낼 현재 정책 권한이 없습니다. 결과 JSON도 익명화 자료로 간주하지 않습니다');
    if (operation === 'export' && rows.some(row => !Terminal[row.execution] && row.execution !== 'unknown')) blocked.push('실행·증거 저장 중인 결과는 최종 export로 만들지 않습니다');
    if (operation === 'delete') {
      if (!policy.delete) blocked.push('현재 삭제 정책이 허용하지 않습니다');
      if (!artifacts.length) blocked.push('삭제할 실제 관리 증거를 선택하세요');
      blocked.push(...this.nativeDownloads.deletionBlockers(artifacts));
      for (const item of artifacts) {
        if (!item.deletable) blocked.push(`${item.relativePath}: 활성·복구·소유권·복사본 상태로 삭제할 수 없습니다`);
        const copies = library.artifacts.filter(copy => copy.runID === item.runID && copy.deletable);
        if (copies.some(copy => !selection.artifactIDs.includes(copy.id))) blocked.push(`${item.attemptID}: 관리 원본·썸네일·내장 리포트·진단 복사본 전체를 같은 작업으로 선택해야 합니다`);
        if (library.limitations.some(message => message.startsWith(`${item.attemptID}:`))) blocked.push(`${item.attemptID}: manifest·worker spool·진단 복사본의 완전한 삭제 범위를 확인하지 못했습니다`);
      }
    }
    return { artifacts, rows, blocked: [...new Set(blocked)], policyDigest, scopeDigest: evidenceJSONDigest({ project: evidenceJSONDigest(this.root), operation, selection: { requestIDs: [...selection.requestIDs].sort(), artifactIDs: [...selection.artifactIDs].sort() }, artifacts, rows, policyDigest }) };
  }
  async dispatch(input: unknown, context: AgentCallContext = {}): Promise<ProductEvidenceReports | { artifacts: ProductArtifact[]; limitations: string[]; externalTransmission: 'denied' } | EvidenceOperationPreview | EvidenceConsent | EvidenceOperationResult | NativeDownloadLease | NativeDownloadPending | { revoked: true } | { retired: true } | { closed: true }> {
    const parsed = ProductEvidenceRequest.safeParse(input);
    if (!parsed.success) fault(400, 'request_invalid', '증거 요청 형식이 올바르지 않습니다');
    const request = parsed.data;
    if (request.method === 'library') return this.library(request);
    if (request.method === 'reports') return this.reports(request.requestID);
    const principal = this.principal(context);
    if (request.method === 'operation.preview') {
      for (const [id, item] of this.previews) if (this.expired(item.preview.expiresAt)) this.previews.delete(id);
      if (this.previews.size >= 100) fault(429, 'preview_limit', '범위 확인 요청이 너무 많습니다');
      const scope = await this.scope(request.operation, request.selection);
      const preview: EvidenceOperationPreview = { previewID: randomUUID(), operation: request.operation, selection: request.selection, scopeDigest: scope.scopeDigest, policyDigest: scope.policyDigest, expiresAt: new Date(this.now() + 120_000).toISOString(), artifacts: scope.artifacts, resultRows: scope.rows.length, warning, blocked: scope.blocked };
      this.previews.set(preview.previewID, { preview, rows: scope.rows, principal }); return preview;
    }
    for (const directory of ['consents', 'audit', 'tombstones', 'run-tombstones', 'revoked-digests', 'exports']) ensureDir(join(this.authorityRoot, directory));
    const lock = acquireFileLock(join(this.authorityRoot, 'operation.lock'), { purpose: '증거 동의·삭제·내보내기 권위' });
    try {
      this.refreshNativeFences();
      if (request.method === 'native-download.pending') return this.nativeDownloads.pending(principal);
      if (request.method === 'native-download.retire') return this.nativeDownloads.retire(request.id, request.secret, principal);
      if (request.method === 'native-download.acknowledge') return this.nativeDownloads.acknowledge(request.id, request.secret, principal);
      if (request.method === 'native-download.reserve') {
        const reader = this.openDownload(request.exportID, context);
        try {
          const metadata = this.exportMetadata(request.exportID);
          if (!metadata.projectDigest || !metadata.authorizedRunIDs) fault(409, 'export_scope_unavailable', '원래 프로젝트·실행 범위가 보존된 새 export를 생성해야 Native 임시 복사본을 예약할 수 있습니다');
          reader.assertUnchanged();
          return this.nativeDownloads.reserve({ ...metadata, projectDigest: metadata.projectDigest, runIDs: metadata.authorizedRunIDs, revocableRunIDs: metadata.runIDs });
        } finally { closeSync(reader.fd); }
      }
      if (request.method === 'consent.grant') {
        const state = this.previews.get(request.previewID);
        if (!state || state.principal !== principal || state.preview.scopeDigest !== request.scopeDigest || this.expired(state.preview.expiresAt)) fault(409, 'preview_expired', '범위 확인이 만료·변경됐습니다. 새로 확인하세요');
        const current = await this.scope(state.preview.operation, state.preview.selection);
        if (current.scopeDigest !== state.preview.scopeDigest || current.blocked.length) fault(409, 'scope_changed', current.blocked.join('\n') || '확인 뒤 증거·결과·정책이 변경됐습니다');
        if (!request.acknowledgeRaw) fault(403, 'privacy_acknowledgment_required', '원시 자료·결과·조건의 개인정보 경고를 확인해야 합니다');
        const consentID = randomUUID();
        writeJsonAtomic(join(this.authorityRoot, 'consents', `${consentID}.json`), { ...state, consentID, revoked: false, consumed: false, exportID: null });
        this.audit('consent.granted', { consentID, principal, scopeDigest: state.preview.scopeDigest, policyDigest: current.policyDigest, operation: state.preview.operation, selection: state.preview.selection });
        this.previews.delete(request.previewID);
        return { consentID, scopeDigest: state.preview.scopeDigest, expiresAt: state.preview.expiresAt };
      }
      const record = this.consent(request.consentID);
      if (record.principal !== principal) fault(403, 'consent_principal_mismatch', '동의한 로컬 사용자와 다릅니다');
      if (request.method === 'consent.revoke') {
        record.revoked = true; writeJsonAtomic(join(this.authorityRoot, 'consents', `${record.consentID}.json`), record);
        if (record.exportID) this.removeExport(record.exportID);
        this.audit('consent.revoked', { consentID: record.consentID, principal, scopeDigest: record.preview.scopeDigest }); return { revoked: true };
      }
      if (record.revoked || record.consumed || this.expired(record.preview.expiresAt) || record.preview.scopeDigest !== request.scopeDigest) fault(403, 'consent_unavailable', '동의가 만료·철회·사용됐거나 범위가 다릅니다. 새 작업별 확인이 필요합니다');
      const scope = await this.scope(record.preview.operation, record.preview.selection);
      if (scope.scopeDigest !== record.preview.scopeDigest || scope.blocked.length) fault(409, 'scope_changed', scope.blocked.join('\n') || '현재 증거·결과·정책이 동의한 범위와 다릅니다');
      record.consumed = true;
      writeJsonAtomic(join(this.authorityRoot, 'consents', `${record.consentID}.json`), record);
      this.audit('operation.started', { consentID: record.consentID, principal, scopeDigest: scope.scopeDigest });
      const result = record.preview.operation === 'delete' ? this.deleteArtifacts(scope.artifacts) : this.exportArtifacts(record, scope.artifacts, scope.rows);
      if (result.exportID) { record.exportID = result.exportID; writeJsonAtomic(join(this.authorityRoot, 'consents', `${record.consentID}.json`), record); }
      this.audit('operation.finished', { consentID: record.consentID, principal, scopeDigest: scope.scopeDigest, result });
      return result;
    } finally { lock.release(); }
  }
  private deleteArtifacts(artifacts: ProductArtifact[]): EvidenceOperationResult {
    const blocked = this.nativeDownloads.deletionBlockers(artifacts);
    if (blocked.length) fault(409, 'native_download_cleanup_required', blocked.join('\n'));
    const outcomes: EvidenceOperationResult['outcomes'] = [], groups = new Map<string, ProductArtifact[]>();
    for (const item of artifacts) groups.set(item.runID, [...(groups.get(item.runID) ?? []), item]);
    for (const [runID, items] of groups) {
      const marker = { schema: 'qautra/evidence-tombstone/v1', runID, paths: items.map(item => item.relativePath), digests: items.flatMap(item => item.sha256 ? [item.sha256] : []), at: new Date(this.now()).toISOString(), state: 'deletion-confirmation-needed' };
      const markerPath = join(this.authorityRoot, 'tombstones', `${evidenceRunKey(this.root, runID)}.json`);
      writeJsonAtomic(markerPath, marker);
      const globalMarker = join(this.authorityRoot, 'run-tombstones', `${evidenceJSONDigest(runID)}.json`);
      writeJsonAtomic(globalMarker, marker);
      for (const digest of marker.digests) writeJsonAtomic(join(this.authorityRoot, 'revoked-digests', `${digest}.json`), { at: marker.at, runID });
      for (const item of items) {
        try {
          if (item.state !== 'missing') {
            const actual = hashPrivateEvidence(this.runRoot(runID), item.relativePath);
            if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new Error('동의 후 증거 bytes가 달라졌습니다');
            const handle = openPrivateEvidence(this.runRoot(runID), item.relativePath);
            try { handle.assertUnchanged(); unlinkSync(join(this.runRoot(runID), item.relativePath)); commitDirectory(dirname(join(this.runRoot(runID), item.relativePath))); } finally { closeSync(handle.fd); }
          }
          outcomes.push({ artifactID: item.id, state: 'deleted', reason: null });
        } catch (error) { outcomes.push({ artifactID: item.id, state: 'deletion-confirmation-needed', reason: error instanceof Error ? error.message : '개별 복사본 삭제 확인 실패' }); }
      }
      marker.state = outcomes.filter(outcome => items.some(item => item.id === outcome.artifactID)).every(outcome => outcome.state === 'deleted') ? 'deleted' : 'deletion-confirmation-needed';
      writeJsonAtomic(markerPath, marker);
      writeJsonAtomic(globalMarker, marker);
    }
    this.cleanupExports(artifacts.map(item => item.runID));
    return { operation: 'delete', exportID: null, filename: null, outcomes, outsideCopies };
  }
  private removeExport(exportID: string): void {
    this.nativeDownloads.retireWhere(record => record.lease.exportID === exportID);
    for (const suffix of ['.tar', '.json']) { try { unlinkSync(join(this.authorityRoot, 'exports', `${UUID.parse(exportID)}${suffix}`)); } catch (error) { if (!missing(error)) throw error; } }
  }
  private cleanupExports(deletedRuns: string[] = []): void {
    const files = readdirSync(join(this.authorityRoot, 'exports'));
    if (files.length > 200) fault(507, 'export_storage_limit', '비공개 export 저장 수를 초과했습니다');
    for (const file of files) {
      if (/^[a-f0-9-]{36}\.tar$/.test(file) && !files.includes(`${file.slice(0, -4)}.json`)) {
        const handle = openPrivateEvidence(this.authorityRoot, `exports/${file}`, 2 * 1024 ** 3);
        try { handle.assertUnchanged(); unlinkSync(join(this.authorityRoot, 'exports', file)); commitDirectory(join(this.authorityRoot, 'exports')); }
        finally { closeSync(handle.fd); }
        continue;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const metadata = this.exportMetadata(file.slice(0, -5));
      if (this.expired(metadata.expiresAt) || metadata.runIDs.some(id => deletedRuns.includes(id))) this.removeExport(metadata.exportID);
    }
  }
  private exportMetadata(exportID: string) {
    try {
      return z.object({ exportID: UUID, consentID: UUID, principal: z.string(), projectDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), scopeDigest: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime({ offset: true }), runIDs: z.array(z.string()), authorizedRunIDs: z.array(z.string()).optional(), digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)), bytes: z.number().int().positive().max(2 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(readPrivateEvidenceJSON(this.authorityRoot, `exports/${UUID.parse(exportID)}.json`));
    } catch (error) {
      if (missing(error)) fault(410, 'export_unavailable', 'export가 삭제·만료·철회됐거나 더 이상 제공되지 않습니다. 새로운 작업별 확인이 필요합니다');
      throw error;
    }
  }
  private exportArtifacts(record: ConsentRecord, artifacts: ProductArtifact[], rows: ProductReportRow[]): EvidenceOperationResult {
    this.cleanupExports();
    const renderPortableHtml = this.dependencies.renderPortableHtml;
    if (!renderPortableHtml) fault(503, 'evidence_renderer_unavailable', '휴대용 리포트 생성기가 연결되지 않아 export를 만들지 않았습니다');
    const retained = readdirSync(join(this.authorityRoot, 'exports')).filter(file => file.endsWith('.tar'));
    if (retained.length >= 4) fault(507, 'export_storage_limit', '임시 export 4개 한도입니다. 만료 뒤 다시 생성하세요');
    const exportID = randomUUID(), filename = `qautra-${exportID}.tar`, file = join(this.authorityRoot, 'exports', `${exportID}.tar`);
    const outcomes: EvidenceOperationResult['outcomes'] = [];
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    const write = (buffer: Buffer): void => { bytes += buffer.length; if (bytes > 2 * 1024 ** 3) fault(413, 'export_byte_limit', '휴대용 export 2 GiB 한도를 초과합니다. 더 작은 범위를 선택하세요'); writeAll(fd, buffer); };
    let open = true;
    const entry = (name: string, content: Buffer | { root: string; path: string; expected: string }): void => {
      const handle = Buffer.isBuffer(content) ? null : openPrivateEvidence(content.root, content.path);
      try {
        const size = Buffer.isBuffer(content) ? content.length : handle!.size;
        const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8');
        const octal = (offset: number, width: number, value: number): void => { header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii'); };
        octal(100, 8, 0o600); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, Math.floor(this.now() / 1000)); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
        const checksum = header.reduce((sum, value) => sum + value, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8); write(header);
        if (Buffer.isBuffer(content)) write(content);
        else {
          assertEvidenceDigestReadable(content.expected, this.authorityRoot);
          const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
          while (offset < size) { const count = readSync(handle!.fd, buffer, 0, Math.min(buffer.length, size - offset), offset); if (!count) throw new Error('증거 복사 중 파일 길이 변경'); hash.update(buffer.subarray(0, count)); write(buffer.subarray(0, count)); offset += count; }
          handle!.assertUnchanged();
          if (hash.digest('hex') !== content.expected) throw new Error('증거 복사 중 digest 변경');
        }
        if (size % 512) write(Buffer.alloc(512 - size % 512));
      } finally { if (handle) closeSync(handle.fd); }
    };
    try {
      const manifestEntries: (ProductArtifact & { included: boolean; portablePath: string | null })[] = [];
      for (const [index, item] of artifacts.entries()) {
        if (!item.exportable || !item.sha256) { outcomes.push({ artifactID: item.id, state: 'blocked', reason: item.reason ?? `최종화된 공유 허용 증거가 아닙니다: ${item.state}` }); manifestEntries.push({ ...item, included: false, portablePath: null }); continue; }
        assertProductEvidenceRead(this.root, item.runID, item.relativePath, this.authorityRoot);
        const extension = item.kind === 'video' ? '.mp4' : item.kind === 'screenshot' ? '.png' : '.bin';
        const path = `evidence/${String(index + 1).padStart(4, '0')}-${item.id.slice(0, 16)}${extension}`;
        entry(path, { root: this.runRoot(item.runID), path: item.relativePath, expected: item.sha256 });
        manifestEntries.push({ ...item, included: true, portablePath: path }); outcomes.push({ artifactID: item.id, state: 'included', reason: null });
      }
      const manifest = { schema: 'qautra/portable-evidence/v1', createdAt: new Date(this.now()).toISOString(), scopeDigest: record.preview.scopeDigest, policyDigest: record.preview.policyDigest, consentID: record.consentID, privacy: warning, outsideCopies, entries: manifestEntries };
      entry('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      entry('results.json', Buffer.from(JSON.stringify({ schema: 'qautra/product-results/v1', rows, groups: groupProductSymptoms(rows) }, null, 2)));
      entry('index.html', Buffer.from(renderPortableHtml(rows, manifestEntries, { warning, outsideCopies })));
      write(Buffer.alloc(1024)); fsyncSync(fd);
      open = false; closeSync(fd);
    } catch (error) {
      if (open) try { closeSync(fd); } catch {}
      try { unlinkSync(file); } catch {}
      throw error;
    }
    try {
      const digest = hashPrivateEvidence(this.authorityRoot, `exports/${exportID}.tar`);
      writeJsonAtomic(join(this.authorityRoot, 'exports', `${exportID}.json`), { exportID, consentID: record.consentID, principal: record.principal, projectDigest: evidenceJSONDigest(this.root), scopeDigest: record.preview.scopeDigest, policyDigest: record.preview.policyDigest, expiresAt: new Date(this.now() + 600_000).toISOString(), ...exportContentScope(artifacts, rows), ...digest });
      return { operation: 'export', exportID, filename, outcomes, outsideCopies };
    } catch (error) { this.removeExport(exportID); throw error; }
  }
  private refreshNativeFences(): void {
    const projectDigest = evidenceJSONDigest(this.root), policy = this.policy(), policyDigest = evidenceJSONDigest(policy);
    this.nativeDownloads.retireWhere(record => {
      if (this.expired(record.expiresAt)) return true;
      if (record.projectDigest === projectDigest && (record.lease.policyDigest !== policyDigest || !policy.localExport || !policy.rawLocalExport)) return true;
      try {
        const consent = this.consent(record.consentID);
        return consent.revoked || !consent.consumed || consent.exportID !== record.lease.exportID || consent.principal !== record.principal || consent.preview.scopeDigest !== record.lease.scopeDigest || consent.preview.policyDigest !== record.lease.policyDigest
          || record.revocableRunIDs.some(runID => evidenceTombstone(this.root, runID, this.authorityRoot) !== null)
          || record.digests.some(digest => { try { assertEvidenceDigestReadable(digest, this.authorityRoot); return false; } catch { return true; } });
      } catch { return true; }
    });
  }
  openDownload(exportID: string, context: AgentCallContext): { fd: number; bytes: number; filename: string; assertUnchanged(): void } {
    this.refreshNativeFences();
    const principal = this.principal(context), metadata = this.exportMetadata(exportID);
    const record = this.consent(metadata.consentID);
    const policy = this.policy();
    if (metadata.exportID !== exportID || principal !== metadata.principal || metadata.projectDigest !== undefined && metadata.projectDigest !== evidenceJSONDigest(this.root) || record.consentID !== metadata.consentID || record.preview.operation !== 'export' || record.principal !== principal || record.revoked || !record.consumed || record.exportID !== exportID || record.preview.scopeDigest !== metadata.scopeDigest || record.preview.policyDigest !== metadata.policyDigest || metadata.policyDigest !== evidenceJSONDigest(policy) || !policy.localExport || !policy.rawLocalExport || this.expired(metadata.expiresAt)) fault(403, 'export_unavailable', 'export가 만료·철회됐거나 현재 정책·사용자가 다릅니다');
    if (metadata.projectDigest !== undefined || metadata.authorizedRunIDs !== undefined) {
      const expected = exportContentScope(record.preview.artifacts, record.rows);
      if (metadata.projectDigest !== evidenceJSONDigest(this.root) || !metadata.authorizedRunIDs || evidenceJSONDigest({ runIDs: [...metadata.runIDs].sort(), authorizedRunIDs: [...metadata.authorizedRunIDs].sort(), digests: [...metadata.digests].sort() }) !== evidenceJSONDigest(expected)) fault(409, 'export_scope_changed', '원래 export의 프로젝트·실행·내용 범위가 변경됐습니다');
    }
    for (const runID of metadata.runIDs) if (evidenceTombstone(this.root, runID, this.authorityRoot)) fault(410, 'evidence_deleted', '삭제한 증거를 포함한 export는 다시 다운로드할 수 없습니다');
    for (const digest of metadata.digests) assertEvidenceDigestReadable(digest, this.authorityRoot);
    const handle = openPrivateEvidence(this.authorityRoot, `exports/${UUID.parse(exportID)}.tar`, 2 * 1024 ** 3);
    try {
      if (handle.size !== metadata.bytes || hashOpenPrivateEvidence(handle).sha256 !== metadata.sha256) fault(409, 'export_changed', 'export 파일 또는 digest가 변경됐습니다');
      this.audit('export.download', { exportID, principal, scopeDigest: metadata.scopeDigest });
    } catch (error) { closeSync(handle.fd); throw error; }
    return { ...handle, bytes: handle.size, filename: `qautra-${exportID}.tar`, assertUnchanged: () => {
      handle.assertUnchanged();
      this.refreshNativeFences();
      const current = this.consent(metadata.consentID);
      if (current.revoked || metadata.policyDigest !== evidenceJSONDigest(this.policy()) || this.expired(metadata.expiresAt)) fault(403, 'export_unavailable', '전송 중 export 동의·정책이 만료·철회됐습니다');
      for (const runID of metadata.runIDs) if (evidenceTombstone(this.root, runID, this.authorityRoot)) fault(410, 'evidence_deleted', '전송 중 증거가 삭제됐습니다');
      for (const digest of metadata.digests) assertEvidenceDigestReadable(digest, this.authorityRoot);
    } };
  }
  openRunFile(runID: string, relativePath: string, maximum = 4 * 1024 ** 3): RunEvidenceReader {
    evidenceRelativePath(runID); evidenceRelativePath(relativePath);
    if (runID.includes('/')) fault(403, 'evidence_path_unsafe', '실행 ID에는 경로를 사용할 수 없습니다');
    const immutable = immutableProductEvidencePath(relativePath);
    const assertAuthority = (): void => {
      if (!immutable && evidenceTombstone(this.root, runID, this.authorityRoot)) fault(410, 'evidence_deleted', '삭제 또는 삭제 확인 대기 증거는 복원한 복사본도 제공하지 않습니다');
    };
    assertAuthority();
    const handle = openPrivateRunEvidence(this.runRoot(runID), relativePath, maximum);
    try {
      const digest = hashOpenPrivateEvidence(handle).sha256;
      const assertUnchanged = (): void => {
        assertAuthority();
        assertEvidenceDigestReadable(digest, this.authorityRoot);
        handle.assertUnchanged();
      };
      assertUnchanged();
      return { fd: handle.fd, bytes: handle.size, assertUnchanged };
    } catch (error) { closeSync(handle.fd); throw error; }
  }
}

export function groupProductSymptoms(rows: ProductReportRow[]): ProductSymptomGroup[] {
  const groups = new Map<string, ProductSymptomGroup>();
  for (const row of rows) {
    const categories: ProductSymptomGroup['category'][] = [];
    if (row.business === 'FAIL') categories.push('product-fail');
    if (row.execution === 'unknown') categories.push('unknown');
    else if (row.business === 'NOT_RUN') categories.push('not-run');
    else if (row.execution === 'blocked' || row.code && row.business !== 'FAIL') categories.push('infra');
    if (row.evidence !== 'ready') categories.push('evidence');
    if (row.cleanup !== 'confirmed') categories.push('cleanup');
    for (const category of categories) {
      const actual = z.object({ code: z.string().nullable().optional(), message: z.string().nullable().optional(), tests: z.array(z.object({ id: z.string(), steps: z.array(z.object({ index: z.number(), kind: z.string(), phase: z.string(), verdict: z.string(), code: z.string().nullable(), reason: z.string() })) })).optional() }).safeParse(row.actual);
      const symptom = category === 'product-fail' ? JSON.stringify(actual.success ? { code: actual.data.code, message: actual.data.message, failures: actual.data.tests?.map(test => ({ testID: test.id, steps: test.steps.filter(step => step.verdict === 'FAIL') })) } : row.actual) : category === 'evidence' ? row.evidence : category === 'cleanup' ? row.cleanup : row.code ?? row.execution;
      const conditions = z.object({ status: z.literal('verified'), materialSha256: z.string() }).safeParse(row.conditions);
      const identity = { category, revisionID: row.revisionID, testID: row.testID, target: row.target, requiredChecks: [...row.requiredChecks].sort(), conditionDigest: conditions.success ? conditions.data.materialSha256 : row.attemptID, symptom };
      const id = evidenceJSONDigest(identity), existing = groups.get(id);
      if (existing) { if (!existing.attemptIDs.includes(row.attemptID)) existing.attemptIDs.push(row.attemptID); if (!existing.requestIDs.includes(row.requestID)) existing.requestIDs.push(row.requestID); }
      else groups.set(id, { id, category, revisionID: row.revisionID, testID: row.testID, target: row.target, requiredChecks: identity.requiredChecks, symptom, attemptIDs: [row.attemptID], requestIDs: [row.requestID] });
    }
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}
