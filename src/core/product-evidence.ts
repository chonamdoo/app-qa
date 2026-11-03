import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentCallContext, AgentReply, AgentRequestInput } from './agent.ts';
import type { RequiredCheck, RegressionTarget } from './regression.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NATIVE_DOWNLOAD_BYTE_LIMIT = 2 * 1024 ** 3;
export const NativeDownloadIdentity = z.strictObject({
  device: z.string().regex(/^(0|[1-9][0-9]*)$/),
  inode: z.string().regex(/^(0|[1-9][0-9]*)$/),
  uid: z.number().int().nonnegative().max(0xffff_ffff),
});
const NativeDownloadSecret = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeDownloadLease = z.strictObject({
  id: z.uuid(), exportID: z.uuid(), directory: z.string().min(1), path: z.string().min(1),
  secret: NativeDownloadSecret, identity: NativeDownloadIdentity,
  bytes: z.number().int().positive().max(NATIVE_DOWNLOAD_BYTE_LIMIT), sha256: Digest,
  scopeDigest: Digest, policyDigest: Digest,
});
export type NativeDownloadLease = z.infer<typeof NativeDownloadLease>;
export const NativeDownloadPending = z.strictObject({
  root: z.string().min(1), records: z.array(NativeDownloadLease.extend({ retired: z.boolean() })),
});
export type NativeDownloadPending = z.infer<typeof NativeDownloadPending>;
export const NativeDownloadCleanupReceipt = z.strictObject({
  schema: z.literal('qautra/native-export-cleanup/v1'), id: z.uuid(), secret: NativeDownloadSecret,
  identity: NativeDownloadIdentity, payloadRemoved: z.literal(true),
  localStaging: z.enum(['none', 'removed', 'promoted']), closedAt: z.iso.datetime({ offset: true }),
});
export type NativeDownloadCleanupReceipt = z.infer<typeof NativeDownloadCleanupReceipt>;
export const NativeDownloadRetired = z.strictObject({ retired: z.literal(true) });
export type NativeDownloadRetired = z.infer<typeof NativeDownloadRetired>;
export const NativeDownloadAcknowledged = z.strictObject({ closed: z.literal(true) });
export type NativeDownloadAcknowledged = z.infer<typeof NativeDownloadAcknowledged>;
export const EvidenceSelection = z.strictObject({ requestIDs: z.array(z.uuid()).min(1).max(100), artifactIDs: z.array(Digest).max(2000) })
  .refine(value => new Set(value.requestIDs).size === value.requestIDs.length && new Set(value.artifactIDs).size === value.artifactIDs.length, 'duplicate selection');
export const ProductEvidenceRequest = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('library'), requestID: z.uuid().optional(), attemptID: z.uuid().optional(), target: z.string().max(200).optional(), kind: z.string().max(100).optional(), capturedFrom: z.iso.datetime({ offset: true }).optional(), capturedTo: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ method: z.literal('reports'), requestID: z.uuid().optional() }),
  z.strictObject({ method: z.literal('operation.preview'), operation: z.enum(['export', 'delete']), selection: EvidenceSelection }),
  z.strictObject({ method: z.literal('consent.grant'), previewID: z.uuid(), scopeDigest: Digest, acknowledgeRaw: z.boolean() }),
  z.strictObject({ method: z.literal('consent.revoke'), consentID: z.uuid() }),
  z.strictObject({ method: z.literal('operation.execute'), consentID: z.uuid(), scopeDigest: Digest }),
  z.strictObject({ method: z.literal('native-download.reserve'), exportID: z.uuid() }),
  z.strictObject({ method: z.literal('native-download.pending') }),
  z.strictObject({ method: z.literal('native-download.retire'), id: z.uuid(), secret: NativeDownloadSecret }),
  z.strictObject({ method: z.literal('native-download.acknowledge'), id: z.uuid(), secret: NativeDownloadSecret }),
]);
export type ProductEvidenceRequest = z.infer<typeof ProductEvidenceRequest>;
export type EvidenceSelection = z.infer<typeof EvidenceSelection>;
export interface EvidenceQuery { call(request: AgentRequestInput, context?: AgentCallContext): Promise<AgentReply> }
export interface ProductArtifact {
  id: string; requestID: string; attemptID: string; runID: string; revisionID: string; testID: string;
  target: RegressionTarget; kind: string; relativePath: string; capturedAt: string;
  captureClock: 'source' | 'encoder-observed' | 'manifest-update';
  privacy: 'raw' | 'sanitized-text-not-shared';
  state: 'ready' | 'finalizing' | 'incomplete' | 'missing' | 'deleted' | 'deletion-confirmation-needed' | 'blocked';
  sha256: string | null; bytes: number | null; reason: string | null;
  deletable: boolean; exportable: boolean; gaps: unknown[];
}
export type PortableEvidenceRenderer = (
  rows: readonly ProductReportRow[],
  artifacts: readonly (ProductArtifact & { included: boolean; portablePath: string | null })[],
  privacy: { warning: string; outsideCopies: string },
) => string;
export interface ProductReportRow {
  requestID: string; runName: string; attemptID: string; runID: string | null; revisionID: string;
  testID: string; target: RegressionTarget; createdAt: string;
  originalCaseIDs?: string[];
  business: string; execution: string; evidence: string; cleanup: string; code: string | null;
  expected: RequiredCheck[]; requiredChecks: string[]; completedChecks: string[];
  actual: unknown; conditions: unknown; limitations: string[];
}
export interface ProductSymptomGroup {
  id: string; category: 'product-fail' | 'infra' | 'unknown' | 'not-run' | 'evidence' | 'cleanup';
  revisionID: string; testID: string; target: RegressionTarget; requiredChecks: string[];
  symptom: string; attemptIDs: string[]; requestIDs: string[];
}
export interface ProductEvidenceReports { rows: ProductReportRow[]; groups: ProductSymptomGroup[] }
export interface EvidenceOperationPreview {
  previewID: string; operation: 'export' | 'delete'; selection: EvidenceSelection; scopeDigest: string;
  policyDigest: string; expiresAt: string; artifacts: ProductArtifact[]; resultRows: number;
  warning: string; blocked: string[];
}
export interface EvidenceConsent { consentID: string; scopeDigest: string; expiresAt: string }
export interface EvidenceOperationResult {
  operation: 'export' | 'delete'; exportID: string | null; filename: string | null;
  outcomes: { artifactID: string; state: string; reason: string | null }[];
  outsideCopies: string;
}
export class ProductEvidenceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const evidenceDigest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const evidenceJSONDigest = (value: unknown): string => evidenceDigest(JSON.stringify(value));
export const defaultEvidenceAuthorityRoot = (): string => join(homedir(), 'Library', 'Application Support', 'QAutra', 'product-evidence');
export function evidenceRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new ProductEvidenceError(403, 'evidence_path_unsafe', '증거 상대 경로가 안전하지 않습니다');
  return value;
}

export interface PrivateEvidenceHandle { fd: number; size: number; assertUnchanged(): void }
export interface RunEvidenceReader { fd: number; bytes: number; assertUnchanged(): void }

function hashEvidenceDescriptor(fd: number, size: number): string {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!count) throw new ProductEvidenceError(409, 'evidence_changed', '증거 bytes가 기록보다 짧습니다');
    hash.update(buffer.subarray(0, count)); offset += count;
  }
  return hash.digest('hex');
}

function openEvidenceFile(rootInput: string, relativePath: string, maximum: number, appendEvents: boolean): PrivateEvidenceHandle {
  const requested = resolve(rootInput);
  if (lstatSync(requested).isSymbolicLink()) throw new ProductEvidenceError(403, 'evidence_boundary_unsafe', '증거 디렉터리의 소유권·비공개 경계를 확인하지 못했습니다');
  // Ancestors above the storage root may be OS aliases such as macOS /var -> /private/var; walk the canonical path.
  const root = realpathSync(requested), file = join(root, evidenceRelativePath(relativePath));
  const directories: { path: string; ino: number; dev: number; birthtimeMs: number; uid: number; mode: number }[] = [];
  let cursor = dirname(file);
  while (true) {
    const stat = lstatSync(cursor);
    const local = cursor === root || cursor.startsWith(`${root}/`);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (local && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new ProductEvidenceError(403, 'evidence_boundary_unsafe', '증거 디렉터리의 소유권·비공개 경계를 확인하지 못했습니다');
    directories.push({ path: cursor, ino: stat.ino, dev: stat.dev, birthtimeMs: stat.birthtimeMs, uid: stat.uid, mode: stat.mode });
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new ProductEvidenceError(404, 'evidence_not_regular', '일반 증거 파일이 아닙니다');
    if (before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > maximum) throw new ProductEvidenceError(403, 'evidence_file_unsafe', '한도 이내의 소유한 비공개 일반 파일만 읽을 수 있습니다');
    let verified = before, prefixDigest: string | null = null;
    const assertUnchanged = (): void => {
      const named = lstatSync(file), after = fstatSync(fd);
      if (!named.isFile() || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev || named.birthtimeMs !== before.birthtimeMs || named.uid !== before.uid || named.mode !== before.mode || named.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || after.uid !== before.uid || after.nlink !== 1 || after.mode !== before.mode) throw new ProductEvidenceError(409, 'evidence_changed', '증거 파일의 소유권·경로가 변경됐습니다');
      for (const directory of directories) {
        const current = lstatSync(directory.path);
        if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== directory.ino || current.dev !== directory.dev || current.birthtimeMs !== directory.birthtimeMs || current.uid !== directory.uid || current.mode !== directory.mode) throw new ProductEvidenceError(409, 'evidence_changed', '증거 디렉터리가 변경됐습니다');
      }
      if (realpathSync(file) !== file || relative(root, file).startsWith('../')) throw new ProductEvidenceError(403, 'evidence_path_unsafe', '증거 경계가 변경됐습니다');
      const changed = named.size !== verified.size || named.mtimeMs !== verified.mtimeMs || named.ctimeMs !== verified.ctimeMs || after.size !== verified.size || after.mtimeMs !== verified.mtimeMs || after.ctimeMs !== verified.ctimeMs;
      if (!changed) return;
      if (!appendEvents || prefixDigest === null || after.size <= verified.size || after.size > maximum || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs || hashEvidenceDescriptor(fd, before.size) !== prefixDigest) throw new ProductEvidenceError(409, 'evidence_changed', '증거 파일이 읽는 동안 변경됐습니다');
      const checked = fstatSync(fd);
      if (checked.size !== after.size || checked.mtimeMs !== after.mtimeMs || checked.ctimeMs !== after.ctimeMs) throw new ProductEvidenceError(409, 'evidence_changed', '이벤트의 원래 bytes를 안정적으로 확인하지 못했습니다');
      verified = checked;
    };
    assertUnchanged();
    if (appendEvents) { prefixDigest = hashEvidenceDescriptor(fd, before.size); assertUnchanged(); }
    return { fd, size: before.size, assertUnchanged };
  } catch (error) { closeSync(fd); throw error; }
}

export function openPrivateEvidence(root: string, relativePath: string, maximum = 4 * 1024 ** 3): PrivateEvidenceHandle {
  return openEvidenceFile(root, relativePath, maximum, false);
}
export function openPrivateRunEvidence(root: string, relativePath: string, maximum = 4 * 1024 ** 3): PrivateEvidenceHandle {
  return openEvidenceFile(root, relativePath, maximum, relativePath === 'events.jsonl');
}
export function hashOpenPrivateEvidence(handle: PrivateEvidenceHandle): { sha256: string; bytes: number } {
  handle.assertUnchanged();
  const sha256 = hashEvidenceDescriptor(handle.fd, handle.size);
  handle.assertUnchanged();
  return { sha256, bytes: handle.size };
}
export function hashPrivateEvidence(root: string, path: string): { sha256: string; bytes: number } {
  const handle = openPrivateEvidence(root, path);
  try { return hashOpenPrivateEvidence(handle); }
  finally { closeSync(handle.fd); }
}
export function readOpenPrivateEvidenceJSON(handle: PrivateEvidenceHandle, maximum = 16 * 1024 ** 2): unknown {
  if (handle.size > maximum) throw new ProductEvidenceError(403, 'evidence_record_limit', '증거 기록이 읽기 한도를 초과했습니다');
  handle.assertUnchanged();
  const bytes = Buffer.allocUnsafe(handle.size); let offset = 0;
  while (offset < bytes.length) { const count = readSync(handle.fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new ProductEvidenceError(409, 'evidence_changed', '증거 기록이 읽는 동안 잘렸습니다'); offset += count; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ProductEvidenceError(409, 'evidence_record_invalid', '증거 기록의 UTF-8 JSON 형식을 확인하지 못했습니다'); }
  handle.assertUnchanged();
  return value;
}
export function readPrivateEvidenceJSON(root: string, path: string, maximum = 16 * 1024 ** 2): unknown {
  const handle = openPrivateEvidence(root, path, maximum);
  try { return readOpenPrivateEvidenceJSON(handle, maximum); }
  finally { closeSync(handle.fd); }
}
const Tombstone = z.strictObject({ schema: z.literal('qautra/evidence-tombstone/v1'), runID: z.string(), paths: z.array(z.string()), digests: z.array(z.string()), at: z.string(), state: z.enum(['deleted', 'deletion-confirmation-needed']) });
export function evidenceRunKey(projectRoot: string, runID: string): string { return evidenceJSONDigest([resolve(projectRoot), runID]); }
export function evidenceTombstone(projectRoot: string, runID: string, authorityRoot = defaultEvidenceAuthorityRoot()): z.infer<typeof Tombstone> | null {
  for (const path of [`tombstones/${evidenceRunKey(projectRoot, runID)}.json`, `run-tombstones/${evidenceJSONDigest(runID)}.json`]) {
    try { return Tombstone.parse(readPrivateEvidenceJSON(authorityRoot, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}
export function immutableProductEvidencePath(path: string): boolean {
  return /(^|\/)(summary\.json|attempt-result\.json|conditions-receipt\.json|target-receipt\.json|fixture-(initial|final)\.json|journal\.jsonl|events\.jsonl|manifest\.json|scenario-revision\.json|verdict\.json|jev\.json|junit\.xml)$/.test(path)
    || /^web-qa\/(plan|result)\.json$/.test(path)
    || /\.(integrity|validation|source)\.json$/.test(path) || /\.ya?ml$/.test(path);
}
export function assertProductEvidenceRead(projectRoot: string, runID: string, relativePath: string, authorityRoot = defaultEvidenceAuthorityRoot()): void {
  evidenceRelativePath(runID); evidenceRelativePath(relativePath);
  const marker = evidenceTombstone(projectRoot, runID, authorityRoot);
  if (marker && !immutableProductEvidencePath(relativePath)) throw new ProductEvidenceError(410, 'evidence_deleted', '이 실행의 증거가 삭제 또는 삭제 확인 대기 상태입니다. 복원한 복사본도 다시 노출하지 않습니다');
  try { assertEvidenceDigestReadable(hashPrivateEvidence(join(projectRoot, '.qa', 'runs', runID), relativePath).sha256, authorityRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function assertEvidenceDigestReadable(sha256: string, authorityRoot = defaultEvidenceAuthorityRoot()): void {
  try { readPrivateEvidenceJSON(authorityRoot, `revoked-digests/${Digest.parse(sha256)}.json`, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new ProductEvidenceError(410, 'evidence_deleted', '삭제된 증거 bytes는 복원·다른 경로에서도 다시 공유하지 않습니다');
}
