import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import type { ChromeOwnerState } from '../core/chrome-owner.ts';
import { commitDirectory } from '../core/fsx.ts';
import { recordingCleanupConfirmed } from '../core/recording.ts';
import { assertChromeOwnerMaterial, type ChromeOwnerMaterial } from './chrome-owner-storage.ts';

export class ChromeEvidenceArchiveError extends AgentExecutionError {
  readonly file: string;
  constructor(file: string, cause: unknown) { super('chrome_evidence_finalize_failed', '원 native 증거 목록의 저장이 미완료입니다. 부분 기록을 보존했습니다', 'unknown'); this.file = file; this.cause = cause; }
}
export function archiveChromeOwnerEvidence(material: ChromeOwnerMaterial, state: ChromeOwnerState): { file: string; sha256: string } {
  assertChromeOwnerMaterial(material);
  const stopped = (value: NonNullable<ChromeOwnerState['native']>['browser']) => ['stopped', 'spawn-failed', 'not-started'].includes(value.state);
  if (!state.native || !stopped(state.native.browser) || !stopped(state.native.driver) || state.native.profile === 'retained' || state.recordings.some(record => ['starting', 'recording', 'stopping'].includes(record.state) || !recordingCleanupConfirmed(record.status))) throw new AgentExecutionError('chrome_evidence_owner_active', '실제 native 종료와 capture·encoder·spool 정리 전에는 증거 저장을 확정하지 않습니다', 'unknown');
  const file = `evidence-${randomUUID()}.jsonl`;
  const target = join(material.locator.directory, file);
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const manifestHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const seen = new Set<string>();
    let files = 0, totalBytes = 0, missing = 0, manifestBytes = 0;
    const row = (value: unknown): void => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      manifestBytes += bytes.length;
      if (manifestBytes > 64 * 1024 * 1024) throw new Error('Evidence inventory byte bound exceeded');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd!, bytes, offset, bytes.length - offset);
      manifestHash.update(bytes);
    };
    row({ schema: 'qautra/chrome-owner-evidence/v1', owner: state });
    const root = resolve(state.scope.projectRoot);
    function inspect(path: string, depth = 0, required = true): void {
      const absolute = resolve(path);
      const local = relative(root, absolute);
      if (!local || local === '..' || local.startsWith(`..${sep}`) || local.startsWith(sep) || depth > 4) throw new Error('Evidence path is outside the original capture root');
      if (seen.has(absolute)) return;
      seen.add(absolute);
      if (seen.size > 200_000) throw new Error('Evidence file count exceeded');
      let named;
      try { named = lstatSync(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!required) return;
        missing++; row({ kind: 'missing', file: absolute }); return;
      }
      if (named.isSymbolicLink() || named.uid !== process.getuid?.() || (named.mode & 0o077) !== 0) throw new Error('Evidence ownership or permissions changed');
      const handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (named.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        const before = fstatSync(handle);
        if (before.ino !== named.ino || before.dev !== named.dev || before.uid !== named.uid || before.mode !== named.mode) throw new Error('Evidence identity changed');
        if (before.isDirectory()) {
          for (const entry of readdirSync(absolute).sort()) inspect(join(absolute, entry), depth + 1);
          fsyncSync(handle);
          const after = lstatSync(absolute);
          if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Evidence directory changed');
          return;
        }
        if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024 * 1024) throw new Error('Evidence is not a bounded original regular file');
        totalBytes += before.size;
        if (totalBytes > 4 * 1024 * 1024 * 1024) throw new Error('Evidence archive byte bound exceeded');
        const hash = createHash('sha256');
        let offset = 0;
        while (offset < before.size) {
          const count = readSync(handle, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!count) throw new Error('Evidence ended before its recorded size');
          hash.update(buffer.subarray(0, count)); offset += count;
        }
        fsyncSync(handle);
        const after = fstatSync(handle), current = lstatSync(absolute);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.mode !== before.mode) throw new Error('Evidence changed while finalizing');
        files++; row({ kind: 'file', file: absolute, bytes: offset, sha256: hash.digest('hex') });
      } finally { closeSync(handle); }
    }
    for (const record of state.recordings) {
      inspect(record.file);
      for (const suffix of ['.integrity.json', '.validation.json']) inspect(`${record.file}${suffix}`, 0, false);
      for (const diagnostic of record.status.diagnostics) inspect(diagnostic);
    }
    row({ kind: 'complete', files, bytes: totalBytes, missing });
    fsyncSync(fd);
    closeSync(fd); fd = null;
    commitDirectory(material.locator.directory);
    return { file: basename(target), sha256: manifestHash.digest('hex') };
  } catch (cause) { throw new ChromeEvidenceArchiveError(file, cause); }
  finally { if (fd !== null) closeSync(fd); }
}
