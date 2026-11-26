import { z } from 'zod';
import { sha256 } from './fsx.ts';
import { PLATFORMS } from './platform.ts';
import { patternGroups, ruleProblem, TestSpec } from '../spec/schema.ts';
import { jsonSourceLedger, type JSONSourceLedger } from './source-json.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Name = z.string().trim().min(1).max(200);
export const ProductRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const URLSetting = z.string().max(4096).refine((text) => {
  if (!text) return true;
  try { const url = new URL(text); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'http(s) URL without credentials is required');
export const ProductSettings = z.strictObject({
  frontendURL: URLSetting, apiURL: URLSetting,
  webLimit: z.number().int().min(1).max(12), androidLimit: z.number().int().min(1).max(12),
  iosLimit: z.number().int().min(1).max(12), totalLimit: z.number().int().min(1).max(12),
  retentionDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  codexEnabled: z.boolean(), claudeEnabled: z.boolean(),
});
export type ProductSettings = z.infer<typeof ProductSettings>;
export const PRODUCT_SUPPORT = {
  activeFlowCeiling: 1, ceilingScope: 'local-user',
  retention: 'preference-only-no-automatic-deletion', ai: 'authoring-preference-only',
} as const;
export const SCENARIO_NOTES_DOCUMENT_ID = '00000000-0000-4000-8000-000000000001';
export const SourceSegment = z.strictObject({
  id: z.string().min(1).max(1000), locator: z.string().min(1).max(4096),
  text: z.string().max(1_000_000), kind: z.enum(['text', 'cell', 'paragraph', 'table', 'image', 'metadata', 'unparsed']),
});
export const SourceIssue = z.strictObject({ code: z.string().min(1), locator: z.string().min(1), message: z.string().min(1) });
export const SourceJSONRow = z.strictObject({
  index: z.number().int().min(0).max(4999),
  startByte: z.number().int().min(0).max(100 * 1024 * 1024),
  endByte: z.number().int().min(1).max(100 * 1024 * 1024),
}).refine(row => row.endByte > row.startByte, 'invalid JSON row byte range');
export const SourceLedger = z.strictObject({
  segments: z.array(SourceSegment).max(100_000).refine(segments => new Set(segments.map(segment => segment.id)).size === segments.length, 'duplicate source segment id'),
  issues: z.array(SourceIssue).max(10_000),
  jsonRows: z.array(SourceJSONRow).min(1).max(5000).optional(),
});
export type SourceLedger = z.infer<typeof SourceLedger>;
export type SourceIngestor = (bytes: Buffer, name: string) => Promise<SourceLedger>;
export const JSONSourceDerivation = z.strictObject({
  kind: z.literal('qautra/json-object-row/v1'),
  documentID: z.uuid(), name: Name, path: z.string().min(1), sha256: Digest, ledgerDigest: Digest,
  rowCount: z.number().int().min(1).max(5000), row: SourceJSONRow,
});
export const ProductDocument = z.strictObject({
  id: z.string().uuid(), name: Name, path: z.string().min(1), sha256: Digest, createdAt: z.iso.datetime(),
  originalPath: z.string().min(1), ledgerDigest: Digest,
  segments: SourceLedger.shape.segments, issues: SourceLedger.shape.issues,
  jsonRows: SourceLedger.shape.jsonRows, derivation: JSONSourceDerivation.optional(),
});
export type ProductDocument = z.infer<typeof ProductDocument>;
export const SourceMapping = z.strictObject({
  documentID: z.string().uuid(), segmentID: z.string().min(1).max(1000),
  disposition: z.enum(['mapped', 'reference', 'unsupported']),
  stepPaths: z.array(z.string().min(1).max(1000)).max(5000),
  checkPaths: z.array(z.string().min(1).max(1000)).max(5000), reason: z.string().max(20_000),
  role: z.enum(['expected', 'precondition', 'step', 'identity', 'history', 'reference', 'transcribed']).optional(),
  logicalCaseID: z.string().min(1).max(1000).optional(), originalCaseID: z.string().max(1000).optional(),
});
export const ManualSourceResolution = z.strictObject({
  kind: z.literal('manual-full-transcript/v1'), documentID: z.uuid(),
  sourceSha256: Digest, sourceLedgerDigest: Digest,
  transcriptDocumentID: z.uuid(), transcriptSha256: Digest, transcriptLedgerDigest: Digest,
  coverage: z.string().trim().min(1).max(20_000),
});
export const ScenarioSource = z.strictObject({
  documentIDs: z.array(z.string().uuid()).max(5000), notes: z.string().max(1_000_000),
  mappings: z.array(SourceMapping).max(100_000), reviewed: z.boolean(),
  resolutions: z.array(ManualSourceResolution).max(5000).optional(),
});
export type ScenarioSource = z.infer<typeof ScenarioSource>;
export const SourceReview = z.strictObject({
  digest: Digest, principalId: z.string().min(1).max(200), channel: z.literal('local-ui'), reviewedAt: z.iso.datetime(),
});
export type ProductReviewer = { principalId: string; channel: 'local-ui' };
export const ProductScenario = z.strictObject({
  id: z.string().uuid(), name: Name, app: z.string().regex(/^[\w.-]+$/),
  platforms: z.array(z.enum(PLATFORMS)).min(1), createdAt: z.iso.datetime(), path: z.string().min(1),
  definition: TestSpec.nullable(), source: ScenarioSource.nullable(), executable: z.boolean(),
  problems: z.array(SourceIssue), review: SourceReview.nullable(), digest: Digest.nullable(),
  manifestPath: z.string().nullable(), legacy: z.record(z.string(), z.unknown()).nullable(),
});
export const ProductEnvironment = z.strictObject({
  id: z.string().uuid(), name: Name, platform: z.enum(PLATFORMS),
  deviceID: z.string().regex(/^[A-Za-z0-9._:@-]+$/).max(200).nullable(), createdAt: z.iso.datetime(),
});
export const ProductSnapshot = z.strictObject({
  schema: z.literal('qautra/workspace/v2'), revision: ProductRevision,
  scenarios: z.array(ProductScenario).max(5000), documents: z.array(ProductDocument).max(5000),
  environments: z.array(ProductEnvironment).max(5000), settings: ProductSettings,
  support: z.object({ activeFlowCeiling: z.literal(1), ceilingScope: z.literal('local-user'),
    retention: z.literal('preference-only-no-automatic-deletion'), ai: z.literal('authoring-preference-only') }),
  legacyCatalogPath: z.string().nullable(),
});
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;
export const ProductMutation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scenarios'), body: z.strictObject({
    revision: ProductRevision, id: z.string().uuid().optional(),
    definition: TestSpec.refine(definition => /^[\w.-]+$/.test(definition.app) && definition.name.trim().length > 0 && definition.name.length <= 200, 'invalid app id or scenario name'),
    source: ScenarioSource,
  }) }),
  z.strictObject({ kind: z.literal('documents'), body: z.strictObject({
    revision: ProductRevision, name: Name, path: z.string().min(1).max(4096).optional(), text: z.string().min(1).max(1_000_000).optional(),
  }).refine(body => (body.path === undefined) !== (body.text === undefined), 'provide path or text') }),
  z.strictObject({ kind: z.literal('document-rows'), body: z.strictObject({ revision: ProductRevision, documentID: z.uuid() }) }),
  z.strictObject({ kind: z.literal('environments'), body: z.strictObject({
    revision: ProductRevision, name: Name, platform: z.enum(PLATFORMS),
    deviceID: ProductEnvironment.shape.deviceID.optional(),
  }) }),
  z.strictObject({ kind: z.literal('settings'), body: z.strictObject({ revision: ProductRevision, settings: ProductSettings }) }),
]);
export type ProductMutationKind = z.infer<typeof ProductMutation>['kind'];

export function productDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)])) : item;
  return sha256(JSON.stringify(canonical(value)));
}

export function textSourceLedger(text: string): SourceLedger {
  const limit = (): SourceLedger => ({
    segments: [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }],
    issues: [{ code: 'source_text_limit', locator: 'file', message: '텍스트 원문 분석 한도를 초과했습니다. 원본은 보존하며 일부 줄을 전체로 표시하지 않습니다.' }],
  });
  if (text.length > 8_000_000) return limit();
  const segments: SourceLedger['segments'] = [];
  let start = 0, line = 1, bytes = 32;
  const append = (end: number): boolean => {
    if (end - start > 1_000_000) return false;
    const content = text.slice(start, end);
    if (!content.trim()) return true;
    if (segments.length >= 100_000) return false;
    const segment = { id: `line:${line}`, locator: `line:${line}`, text: content, kind: 'text' as const };
    bytes += Buffer.byteLength(JSON.stringify(segment)) + 1;
    if (bytes > 16 * 1024 * 1024) return false;
    segments.push(segment);
    return true;
  };
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\r' && text[index] !== '\n') continue;
    if (!append(index)) return limit();
    if (text[index] === '\r' && text[index + 1] === '\n') index++;
    start = index + 1; line++;
  }
  return { segments, issues: [] };
}

export function unsupportedSourceLedger(message: string): SourceLedger {
  return { segments: [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }],
    issues: [{ code: 'source_parser_unavailable', locator: 'file', message }] };
}

export function definitionCheckPaths(definition: TestSpec): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, path: string, optional = false): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, `${path}[${index}]`, optional)); return; }
    const row = value as Record<string, unknown>;
    const skipped = optional || row.optional === true;
    for (const [key, child] of Object.entries(row)) {
      if (!skipped && ['assertText', 'assertNoText', 'checkEach', 'see'].includes(key) && !path.startsWith('teardown')) paths.push(path);
      if (key === 'expect' && !skipped && !path.startsWith('teardown')) {
        if (Array.isArray(child)) child.forEach((_, index) => paths.push(`${path}.expect[${index}]`));
        else paths.push(`${path}.expect[0]`);
      }
      if (['repeat', 'steps', 'which'].includes(key)) walk(child, `${path}.${key}`, skipped);
    }
  };
  walk(definition.steps, 'steps');
  walk(definition.setup ?? [], 'setup');
  return [...new Set(paths)];
}

function atPath(definition: TestSpec, path: string): unknown {
  if (!/^(steps|setup|teardown)\[\d+\]/.test(path)) return undefined;
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  if (!/^(steps|setup|teardown)\.\d+(\.[A-Za-z0-9_-]+)*$/.test(normalized)) return undefined;
  return normalized.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    const row = value as Record<string, unknown>;
    return row[key];
  }, definition);
}

export function definitionQualificationProblems(definition: TestSpec): z.infer<typeof SourceIssue>[] {
  const problems: z.infer<typeof SourceIssue>[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    const checkEach = row.checkEach;
    if ('claim' in row || 'which' in row || 'seeNot' in row || 'use' in row || row.allowRisky === true ||
      (checkEach && typeof checkEach === 'object' && 'min' in checkEach && typeof checkEach.min === 'number' && checkEach.min < 1)) {
      problems.push({ code: 'definition_requires_qualification', locator: path, message: '모델 의존/외부 flow/위험 권한/빈 표본 검증은 별도 실행 정의 검증이 필요합니다.' });
    }
    if (checkEach && typeof checkEach === 'object' && 'pattern' in checkEach && typeof checkEach.pattern === 'string' && 'rule' in checkEach) {
      try {
        const problem = ruleProblem(checkEach.rule, patternGroups(checkEach.pattern));
        if (problem) problems.push({ code: 'definition_rule_invalid', locator: path, message: problem });
      } catch {
        problems.push({ code: 'definition_pattern_invalid', locator: path, message: '검증 정규식이 올바르지 않습니다.' });
      }
    }
    if (typeof row.regex === 'string') {
      try { new RegExp(row.regex, typeof row.flags === 'string' ? row.flags : undefined); }
      catch { problems.push({ code: 'definition_pattern_invalid', locator: path, message: '정규식이 올바르지 않습니다.' }); }
    }
    for (const key of ['tap', 'longPress', 'into', 'clear', 'see', 'until']) {
      const target = row[key];
      if (typeof target === 'string' || (target && typeof target === 'object' &&
        !['text', 'desc', 'id'].some(field => Object.hasOwn(target, field)))) {
        problems.push({ code: 'definition_semantic_target', locator: `${path}.${key}`, message: '결정적으로 식별할 대상 selector를 지정하세요.' });
      }
    }
    for (const [key, child] of Object.entries(row)) visit(child, `${path}.${key}`);
  };
  visit(definition.steps, 'steps');
  visit(definition.setup, 'setup');
  visit(definition.teardown, 'teardown');
  visit(definition.when, 'when');
  return problems;
}

export function sourceQualificationProblems(definition: TestSpec, source: ScenarioSource, documents: readonly ProductDocument[]): z.infer<typeof SourceIssue>[] {
  const problems: z.infer<typeof SourceIssue>[] = definitionQualificationProblems(definition);
  const issue = (code: string, locator: string, message: string) => problems.push({ code, locator, message });
  const checks = new Set(definitionCheckPaths(definition));
  if (!checks.size) issue('required_checks_empty', 'steps', '필수 검증이 없습니다.');
  if (!source.documentIDs.length) issue('source_scope_empty', 'source', '원문 문서 또는 수동 원문을 연결하세요.');
  if (new Set(source.documentIDs).size !== source.documentIDs.length) issue('source_document_duplicate', 'source', '원문 문서가 중복되었습니다.');
  const selected = documents.filter(doc => source.documentIDs.includes(doc.id));
  if (selected.length !== source.documentIDs.length) issue('source_document_missing', 'source', '연결한 원문 문서를 찾을 수 없습니다.');
  if (new Set(selected.map(doc => doc.path)).size !== selected.length) issue('source_document_duplicate', 'source', '같은 원문 파일을 중복 연결할 수 없습니다.');
  const resolved = new Set<string>();
  const resolvedDocuments = new Set<string>();
  const transcriptDocuments = new Set<string>();
  for (const resolution of source.resolutions ?? []) {
    const original = selected.find(doc => doc.id === resolution.documentID);
    const transcript = selected.find(doc => doc.id === resolution.transcriptDocumentID);
    let valid = true;
    const reject = (code: string, message: string) => { valid = false; issue(code, resolution.documentID, message); };
    if (!source.reviewed) reject('source_resolution_review_required', '원본 전체와 전사본의 대조를 현재 로컬 QA 검토에 결합하세요.');
    if (!original || !transcript) reject('source_resolution_document_missing', '원본과 전체 전사본을 모두 현재 원문 범위에 연결하세요.');
    if (resolvedDocuments.has(resolution.documentID) || transcriptDocuments.has(resolution.transcriptDocumentID)) reject('source_resolution_duplicate', '각 원본과 전체 전사본은 하나의 대조 관계로 연결하세요.');
    resolvedDocuments.add(resolution.documentID);
    transcriptDocuments.add(resolution.transcriptDocumentID);
    if (original && (original.sha256 !== resolution.sourceSha256 || original.ledgerDigest !== resolution.sourceLedgerDigest)) reject('source_resolution_original_changed', '대조한 원본 bytes 또는 원문 ledger가 다릅니다.');
    if (transcript && (transcript.sha256 !== resolution.transcriptSha256 || transcript.ledgerDigest !== resolution.transcriptLedgerDigest)) reject('source_resolution_transcript_changed', '대조한 전체 전사본 bytes 또는 구간 ledger가 다릅니다.');
    if (original && (/\.json$/i.test(original.originalPath) || original.issues.some(problem => problem.code.startsWith('source_json_')))) reject('source_resolution_original_incomplete', 'JSON의 미검증 문법·중복 필드·손상·분석 한도는 전체 전사 확인으로 해제하지 않습니다. 완전하고 검증 가능한 JSON 원본을 다시 연결하세요.');
    if (original && !original.issues.length && !original.segments.some(segment => ['unparsed', 'image'].includes(segment.kind))) reject('source_resolution_unnecessary', '미독해·구조 미확인 원본만 전체 전사 대조로 연결하세요.');
    if (transcript && (transcript.id === original?.id || !transcript.segments.length || transcript.issues.length || transcript.segments.some(segment => ['unparsed', 'image'].includes(segment.kind)))) reject('source_resolution_transcript_unreadable', '전체 전사본은 원본과 다른, 모든 구간을 읽을 수 있는 문서여야 합니다. 전사본의 경고를 다시 전사로 우회하지 않습니다.');
    if (valid) resolved.add(resolution.documentID);
  }
  const seen = new Set<string>();
  const mappedChecks = new Map<string, string>();
  for (const mapping of source.mappings) {
    const key = `${mapping.documentID}/${mapping.segmentID}`;
    if (seen.has(key)) issue('source_mapping_duplicate', key, '같은 원문 구간을 두 번 연결할 수 없습니다.');
    seen.add(key);
    const doc = selected.find(doc => doc.id === mapping.documentID);
    if (!doc?.segments.some(segment => segment.id === mapping.segmentID)) issue('source_segment_missing', key, '현재 문서에 없는 원문 구간입니다.');
    if (mapping.disposition === 'unsupported') issue('source_unsupported', key, mapping.reason || '지원되지 않는 필수 원문 구간입니다.');
    if (mapping.role === 'history' && mapping.disposition !== 'reference') issue('source_history_not_execution', key, '과거 Result는 새 실행 검증이 아닌 참고 이력으로만 연결하세요.');
    if (mapping.role === 'transcribed' && (!resolved.has(mapping.documentID) || mapping.disposition !== 'reference')) issue('source_transcript_unbound', key, '원본 보존 대응은 검토된 전체 전사 관계에만 사용하며 실행 단계로 대체하지 않습니다.');
    if (resolved.has(mapping.documentID) && mapping.role !== 'transcribed') issue('source_original_transcription_required', key, '전체 전사 대조한 원본의 모든 구간을 원본 보존 대응으로 남기고 실제 기대값은 전사본 구간별로 연결하세요.');
    if (mapping.disposition === 'reference') {
      if (!mapping.reason.trim() || !['identity', 'history', 'reference', 'transcribed'].includes(mapping.role ?? 'expected')) issue('source_reference_unqualified', key, '참고 이력/식별자/비필수 자료 또는 검토한 전사 관계의 분류와 근거를 명시하세요.');
      if (mapping.stepPaths.length || mapping.checkPaths.length) issue('source_reference_has_execution', key, '참고 이력은 새 실행의 단계나 검증으로 표시할 수 없습니다.');
    }
    if (mapping.disposition !== 'mapped') continue;
    if (!mapping.stepPaths.length && !mapping.checkPaths.length) issue('source_mapping_empty', key, '실제 단계 또는 필수 검증을 연결하세요.');
    if ((mapping.role ?? 'expected') === 'expected' && !mapping.checkPaths.length) issue('source_expectation_unmapped', key, '각 기대값에 필수 검증을 연결하세요.');
    for (const path of mapping.stepPaths) {
      const step = TestSpec.shape.steps.element.safeParse(atPath(definition, path));
      if (!step.success || step.data.optional || (mapping.role === 'precondition' && path.startsWith('teardown'))) issue('source_step_missing', path, '현재 정의의 필수 실행 단계가 아닙니다.');
    }
    for (const path of mapping.checkPaths) {
      if (!checks.has(path)) issue('source_check_missing', path, '현재 정의의 필수 검증이 아닙니다.');
      const previous = mappedChecks.get(path);
      if (previous && previous !== key && (mapping.role ?? 'expected') === 'expected') issue('source_expectation_check_reused', path, '서로 다른 기대값을 하나의 검증으로 축소할 수 없습니다.');
      if ((mapping.role ?? 'expected') === 'expected') mappedChecks.set(path, key);
    }
    if (new Set(mapping.stepPaths).size !== mapping.stepPaths.length || new Set(mapping.checkPaths).size !== mapping.checkPaths.length) issue('source_path_duplicate', key, '같은 단계/검증 연결이 중복되었습니다.');
  }
  for (const doc of selected) {
    if (productDigest({ segments: doc.segments, issues: doc.issues, jsonRows: doc.jsonRows }) !== doc.ledgerDigest) issue('source_ledger_changed', doc.id, '원문 구간 목록 digest가 다릅니다.');
    if (!resolved.has(doc.id)) for (const problem of doc.issues) issue(problem.code, `${doc.id}/${problem.locator}`, problem.message);
    if (!doc.segments.length) issue('source_segments_empty', doc.id, '원문 구간이 없습니다.');
    for (const segment of doc.segments) {
      if (!seen.has(`${doc.id}/${segment.id}`)) issue('source_scope_unmapped', `${doc.id}/${segment.id}`, '필수 원문 구간의 해석/대응이 없습니다.');
      if (!resolved.has(doc.id) && ['unparsed', 'image'].includes(segment.kind)) issue('source_segment_unsupported', `${doc.id}/${segment.id}`, '의미를 검증할 수 없는 원문 구간입니다.');
    }
  }
  for (const check of checks) if (!mappedChecks.has(check)) issue('check_source_missing', check, '필수 검증의 원 기대값 연결이 없습니다.');
  return problems;
}

export const ProductSourceManifest = z.strictObject({
  schema: z.literal('qautra/scenario-source/v2'), scenarioID: z.string().uuid(), createdAt: z.iso.datetime(),
  definition: TestSpec, source: ScenarioSource, documents: z.array(ProductDocument), digest: Digest,
  review: SourceReview.nullable(), problems: z.array(SourceIssue),
});
export type ProductSourceManifest = z.infer<typeof ProductSourceManifest>;
export function scenarioSourceDigest(definition: TestSpec, source: ScenarioSource, documents: readonly ProductDocument[]): string {
  const { source: _artifactSource, ...executableDefinition } = definition;
  return productDigest({ definition: executableDefinition, source: { ...source, reviewed: false }, documents });
}

/** Frozen closure validation requires the actual captured files, not declarations from the source manifest. */
export function validateProductSourceManifest(
  raw: unknown, actualSources: readonly { path: string; sha256: string }[], definition?: TestSpec,
  captured?: { bytes: ReadonlyMap<string, Buffer>; json: Map<string, JSONSourceLedger> },
): z.infer<typeof SourceIssue>[] {
  const parsed = ProductSourceManifest.safeParse(raw);
  if (!parsed.success) return [{ code: 'source_manifest_invalid', locator: 'source.plan', message: '원문 manifest 형식이 올바르지 않습니다.' }];
  const manifest = parsed.data;
  const problems = sourceQualificationProblems(manifest.definition, manifest.source, manifest.documents);
  const digest = scenarioSourceDigest(manifest.definition, manifest.source, manifest.documents);
  if (digest !== manifest.digest || manifest.review?.digest !== digest || !manifest.source.reviewed) problems.push({ code: 'source_review_invalid', locator: 'source.plan', message: '현재 정의와 원문에 결합된 검토가 없습니다.' });
  if (definition && scenarioSourceDigest(definition, manifest.source, manifest.documents) !== digest) problems.push({ code: 'source_definition_changed', locator: 'source.plan', message: '검토한 실행 정의가 변경되었습니다.' });
  for (const doc of manifest.documents) {
    if (!actualSources.some(file => file.path === doc.path && file.sha256 === doc.sha256)) problems.push({ code: 'source_bytes_unverified', locator: doc.path, message: '실제 frozen source closure에 원문 bytes가 없거나 digest가 다릅니다.' });
    if (!doc.derivation) continue;
    const parent = doc.derivation;
    const bytes = captured?.bytes.get(parent.sha256);
    if (!bytes || !actualSources.some(file => file.path === parent.path && file.sha256 === parent.sha256)) {
      problems.push({ code: 'source_parent_bytes_unverified', locator: doc.path, message: '분리 전 JSON 원본의 실제 고정 bytes와 해시를 확인하지 못했습니다.' });
      continue;
    }
    let ledger = captured!.json.get(parent.sha256);
    if (!ledger) {
      try { ledger = jsonSourceLedger(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
      catch { problems.push({ code: 'source_derivation_invalid', locator: doc.path, message: '분리 전 JSON 원본을 다시 확인하지 못했습니다.' }); continue; }
      captured!.json.set(parent.sha256, ledger);
    }
    const row = ledger.jsonRows?.[parent.row.index];
    if (ledger.issues.length || productDigest(ledger) !== parent.ledgerDigest || ledger.jsonRows?.length !== parent.rowCount ||
      !row || row.index !== parent.row.index || row.startByte !== parent.row.startByte || row.endByte !== parent.row.endByte ||
      sha256(bytes.subarray(parent.row.startByte, parent.row.endByte)) !== doc.sha256) {
      problems.push({ code: 'source_derivation_invalid', locator: doc.path, message: '객체행의 원본 위치·전체 행 수·구간 해시가 실제 고정 JSON과 다릅니다.' });
    }
  }
  return problems;
}
