import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { commitDirectory, ensureDir, writeJsonAtomic } from '../core/fsx.ts';
import {
  NATIVE_DOWNLOAD_BYTE_LIMIT, NativeDownloadCleanupReceipt, NativeDownloadLease, ProductEvidenceError,
  evidenceJSONDigest, openPrivateEvidence, readOpenPrivateEvidenceJSON, readPrivateEvidenceJSON,
  type NativeDownloadPending, type ProductArtifact,
} from '../core/product-evidence.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Record = z.strictObject({
  schema: z.literal('qautra/native-export-lease/v1'), lease: NativeDownloadLease,
  projectDigest: Digest, principal: z.string().min(1), consentID: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }), runIDs: z.array(z.string()).max(10000),
  revocableRunIDs: z.array(z.string()).max(10000), digests: z.array(Digest).max(20001),
});
export type NativeDownloadRecord = z.infer<typeof Record>;
export interface NativeDownloadAuthorization {
  exportID: string; consentID: string; principal: string; projectDigest: string; scopeDigest: string; policyDigest: string;
  expiresAt: string; runIDs: string[]; revocableRunIDs: string[]; digests: string[]; bytes: number; sha256: string;
}
const Retired = z.strictObject({ schema: z.literal('qautra/native-export-retired/v1'), id: z.uuid(), secret: z.string(), retiredAt: z.iso.datetime({ offset: true }) });
const Closed = z.strictObject({ schema: z.literal('qautra/native-export-closed/v1'), id: z.uuid(), receiptDigest: Digest });
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
function refuse(message: string): never { throw new ProductEvidenceError(409, 'native_download_cleanup_required', message); }
function sameSecret(first: string, second: string): boolean {
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class NativeDownloadRegistry {
  readonly root: string;
  private readonly now: () => number;
  constructor(authorityRoot: string, now: () => number) {
    this.root = join(authorityRoot, 'native-downloads');
    this.now = now;
  }

  private ids(): string[] {
    let names: string[];
    try {
      const directory = lstatSync(this.root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) refuse('Native 임시 내보내기 디렉터리 경계를 확인하지 못했습니다');
      names = readdirSync(this.root);
    } catch (error) {
      if (missing(error)) return [];
      if (error instanceof ProductEvidenceError) throw error;
      refuse('Native 임시 내보내기 디렉터리를 읽지 못했습니다');
    }
    if (names.some(id => !z.uuid().safeParse(id).success)) refuse('Native 임시 내보내기 목록에 미확인 기록이 있습니다');
    return names.sort();
  }
  private read(id: string): NativeDownloadRecord {
    z.uuid().parse(id);
    let value: unknown;
    try { value = readPrivateEvidenceJSON(this.root, `${id}/lease.json`, 2 * 1024 ** 2); }
    catch (error) {
      if (!missing(error)) refuse(`Native 임시 내보내기 원 기록을 읽지 못해 내보내기·삭제를 진행하지 않습니다. 해당 항목을 확인해 정리하세요: ${id}`);
      try { lstatSync(join(this.root, id)); } catch (absent) { if (missing(absent)) throw new ProductEvidenceError(404, 'native_download_missing', 'Native 임시 내보내기 기록이 없습니다'); refuse(`Native 임시 내보내기 항목을 확인하지 못했습니다: ${id}`); }
      refuse(`Native 임시 내보내기 원 기록이 없는 미확인 항목이 남아 있어 내보내기·삭제를 진행하지 않습니다. 해당 항목을 확인해 정리하세요: ${id}`);
    }
    const parsed = Record.safeParse(value);
    if (!parsed.success) refuse(`Native 임시 내보내기 원 기록 형식을 확인하지 못했습니다: ${id}`);
    const record = parsed.data;
    if (record.lease.id !== id || record.lease.directory !== join(this.root, id) || record.lease.path !== join(this.root, id, 'payload.tar')) refuse(`Native 임시 내보내기 원래 경로가 다릅니다: ${id}`);
    return record;
  }
  private retired(record: NativeDownloadRecord): boolean {
    let value: unknown;
    try { value = readPrivateEvidenceJSON(this.root, `${record.lease.id}/retired.json`, 4096); }
    catch (error) { if (missing(error)) return false; refuse(`Native 임시 내보내기 철회 fence를 읽지 못했습니다: ${record.lease.id}`); }
    const parsed = Retired.safeParse(value);
    if (!parsed.success) refuse(`Native 임시 내보내기 철회 fence 형식을 확인하지 못했습니다: ${record.lease.id}`);
    const fence = parsed.data;
    if (fence.id !== record.lease.id || !sameSecret(fence.secret, record.lease.secret)) refuse('Native 임시 내보내기 철회 fence가 원 기록과 다릅니다');
    return true;
  }
  private fence(record: NativeDownloadRecord): void {
    if (this.retired(record)) return;
    writeJsonAtomic(join(record.lease.directory, 'retired.json'), { schema: 'qautra/native-export-retired/v1', id: record.lease.id, secret: record.lease.secret, retiredAt: new Date(this.now()).toISOString() } satisfies z.infer<typeof Retired>);
  }
  private receiptDigest(record: NativeDownloadRecord): string {
    if (!this.retired(record)) refuse('Native 임시 내보내기를 먼저 retire해야 합니다');
    let handle: ReturnType<typeof openPrivateEvidence>;
    try { handle = openPrivateEvidence(this.root, `${record.lease.id}/cleanup.json`, 4096); }
    catch { refuse(`Native 정리 receipt를 읽지 못했습니다: ${record.lease.id}`); }
    try {
      let value: unknown;
      try { value = readOpenPrivateEvidenceJSON(handle, 4096); } catch { refuse(`Native 정리 receipt를 읽지 못했습니다: ${record.lease.id}`); }
      const parsed = NativeDownloadCleanupReceipt.safeParse(value);
      if (!parsed.success) refuse(`Native 정리 receipt 형식을 확인하지 못했습니다: ${record.lease.id}`);
      const receipt = parsed.data;
      if (receipt.id !== record.lease.id || !sameSecret(receipt.secret, record.lease.secret) || receipt.identity.device !== record.lease.identity.device || receipt.identity.inode !== record.lease.identity.inode || receipt.identity.uid !== record.lease.identity.uid) refuse('Native 정리 receipt의 원래 identity·secret이 다릅니다');
      let present = true;
      try { lstatSync(record.lease.path); } catch (error) { if (!missing(error)) throw error; present = false; }
      if (present) refuse('Native payload가 남아 있어 정리 완료로 인정할 수 없습니다');
      handle.assertUnchanged();
      return evidenceJSONDigest(receipt);
    } finally { closeSync(handle.fd); }
  }
  /** The engine's closed marker, or null before acknowledgement; one it cannot read or parse blocks like the other records. */
  private closedMarker(record: NativeDownloadRecord): z.infer<typeof Closed> | null {
    let value: unknown;
    try { value = readPrivateEvidenceJSON(this.root, `${record.lease.id}/closed.json`, 4096); }
    catch (error) { if (missing(error)) return null; refuse(`Native 임시 내보내기 종료 기록을 읽지 못했습니다: ${record.lease.id}`); }
    const parsed = Closed.safeParse(value);
    if (!parsed.success) refuse(`Native 임시 내보내기 종료 기록 형식을 확인하지 못했습니다: ${record.lease.id}`);
    return parsed.data;
  }
  private closed(record: NativeDownloadRecord): boolean {
    const marker = this.closedMarker(record);
    if (!marker) return false;
    // A receipt that no longer matches (for example a restored payload) returns the lease to pending.
    try { return marker.id === record.lease.id && marker.receiptDigest === this.receiptDigest(record); }
    catch { return false; }
  }
  private authorized(id: string, secret: string, principal: string): NativeDownloadRecord {
    const record = this.read(id);
    if (record.principal !== principal || !sameSecret(secret, record.lease.secret)) throw new ProductEvidenceError(403, 'native_download_authority_mismatch', 'Native 임시 내보내기의 원래 사용자·secret과 다릅니다');
    return record;
  }
  reserve(authorization: NativeDownloadAuthorization): NativeDownloadLease {
    const pending = this.ids().map(id => this.read(id)).filter(record => !this.closed(record));
    if (pending.length >= 4) throw new ProductEvidenceError(507, 'native_download_limit', 'Native 임시 내보내기 4개 정리 확인 한도입니다');
    if (!Number.isSafeInteger(authorization.bytes) || authorization.bytes <= 0 || authorization.bytes > NATIVE_DOWNLOAD_BYTE_LIMIT) throw new ProductEvidenceError(413, 'export_byte_limit', 'Native 임시 내보내기는 2 GiB 이내여야 합니다');
    ensureDir(this.root);
    const id = randomUUID(), directory = join(this.root, id), path = join(directory, 'payload.tar');
    mkdirSync(directory, { mode: 0o700 });
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        const original = fstatSync(fd, { bigint: true });
        const handle = openPrivateEvidence(this.root, `${id}/payload.tar`, NATIVE_DOWNLOAD_BYTE_LIMIT);
        try {
          const checked = fstatSync(handle.fd, { bigint: true });
          if (checked.dev !== original.dev || checked.ino !== original.ino || checked.uid !== original.uid || checked.size !== 0n) refuse('Native 예약 파일의 원래 identity를 확인하지 못했습니다');
          const lease = NativeDownloadLease.parse({ id, exportID: authorization.exportID, directory, path, secret: randomBytes(32).toString('hex'), identity: { device: original.dev.toString(), inode: original.ino.toString(), uid: Number(original.uid) }, bytes: authorization.bytes, sha256: authorization.sha256, scopeDigest: authorization.scopeDigest, policyDigest: authorization.policyDigest });
          handle.assertUnchanged(); fsyncSync(fd); commitDirectory(directory);
          writeJsonAtomic(join(directory, 'lease.json'), Record.parse({ schema: 'qautra/native-export-lease/v1', lease, projectDigest: authorization.projectDigest, principal: authorization.principal, consentID: authorization.consentID, expiresAt: authorization.expiresAt, runIDs: authorization.runIDs, revocableRunIDs: authorization.revocableRunIDs, digests: authorization.digests }));
          return lease;
        } finally { closeSync(handle.fd); }
      } finally { closeSync(fd); }
    } catch (error) {
      // The lease was never returned; anything left behind is refused by read() until an operator resolves it.
      try {
        for (const name of ['payload.tar', 'lease.json']) { try { unlinkSync(join(directory, name)); } catch (absent) { if (!missing(absent)) throw absent; } }
        rmdirSync(directory); commitDirectory(this.root);
      } catch {}
      throw error;
    }
  }
  pending(principal: string): NativeDownloadPending {
    const records: NativeDownloadPending['records'] = [];
    for (const id of this.ids()) {
      const record = this.read(id);
      if (record.principal === principal && !this.closed(record)) records.push({ ...record.lease, retired: this.retired(record) });
    }
    return { root: this.root, records };
  }
  retire(id: string, secret: string, principal: string): { retired: true } {
    this.fence(this.authorized(id, secret, principal));
    return { retired: true };
  }
  acknowledge(id: string, secret: string, principal: string): { closed: true } {
    const record = this.authorized(id, secret, principal), receiptDigest = this.receiptDigest(record);
    const existing = this.closedMarker(record);
    if (existing && (existing.id !== id || existing.receiptDigest !== receiptDigest)) refuse('원래 Native 정리 receipt가 변경됐습니다');
    if (!existing) writeJsonAtomic(join(record.lease.directory, 'closed.json'), { schema: 'qautra/native-export-closed/v1', id, receiptDigest } satisfies z.infer<typeof Closed>);
    return { closed: true };
  }
  retireWhere(predicate: (record: NativeDownloadRecord) => boolean): void {
    for (const id of this.ids()) { const record = this.read(id); if (predicate(record)) this.fence(record); }
  }
  deletionBlockers(artifacts: ProductArtifact[]): string[] {
    const runs = new Set(artifacts.map(item => item.runID)), digests = new Set(artifacts.flatMap(item => item.sha256 ? [item.sha256] : []));
    const blocked: string[] = [];
    for (const id of this.ids()) {
      const record = this.read(id);
      if (!this.closed(record) && (record.runIDs.some(run => runs.has(run)) || record.digests.some(digest => digests.has(digest)))) blocked.push(`Native 임시 내보내기 정리 확인 필요: ${id}`);
    }
    return blocked;
  }
}
