// Per-device exclusive lock: .qa/locks/<deviceId>.lock, an owner lock file (`src/core/lock.ts`).
import { join } from 'node:path';
import { PATHS } from '../core/config.ts';
import { acquireFileLock, FileLockedError, type FileLock, type LockHooks, type LockRecord } from '../core/lock.ts';
import type { ProcessProbe } from '../core/process.ts';

export class DeviceLockedError extends Error {
  /** Recorded owner; null when the lock file is unreadable. */
  readonly owner: LockRecord | null;
  constructor(deviceId: string, owner: LockRecord | null, detail?: string, options?: ErrorOptions) {
    super(
      detail ??
        (owner
          ? `디바이스 ${deviceId}는 다른 qa 프로세스(pid ${owner.pid}, ${owner.acquiredAt}부터)가 사용 중입니다.`
          : `디바이스 ${deviceId}의 잠금을 얻지 못했습니다 (다른 qa 프로세스와 경합).`),
      options,
    );
    this.name = 'DeviceLockedError';
    this.owner = owner;
  }
}

export type DeviceLock = FileLock;

/**
 * Acquires `.qa/locks/<deviceId>.lock` atomically (write temp file, hard-link into place).
 * Throws DeviceLockedError when a live process holds it or another process is reclaiming it.
 * Released on `release()` or process exit.
 */
export function acquireDeviceLock(deviceId: string, opts: { dir?: string; probe?: ProcessProbe; pid?: number; startedAt?: string; hooks?: LockHooks } = {}): DeviceLock {
  const file = join(opts.dir ?? PATHS.locks, `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  try {
    return acquireFileLock(file, { purpose: `디바이스 ${deviceId}`, probe: opts.probe, pid: opts.pid, startedAt: opts.startedAt, hooks: opts.hooks });
  } catch (err) {
    if (!(err instanceof FileLockedError)) throw err;
    const detail = err.reason === 'reclaiming' ? `디바이스 ${deviceId}의 오래된 잠금을 다른 qa 프로세스가 회수하는 중입니다. 계속 실패하면 ${file}.*.reclaim 파일을 지우세요.` : undefined;
    throw new DeviceLockedError(deviceId, err.owner, detail, { cause: err });
  }
}
