import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AgentExecutionError } from './agent.ts';
import { isProcessAlive, PROCESS_STARTED_AT_MS, systemProbe } from './process.ts';
import { ensureDir, readPrivateFile, writeJsonAtomic } from './fsx.ts';
import { ExecutionRecoveryReceiptSchema, ExecutionRecoverySourceSchema, ExecutionRecoverySourcesSchema, type ExecutionRecoveryReceipt, type ExecutionRecoveryScope, type ExecutionRecoverySource } from './recovery.ts';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const LockSchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.iso.datetime(), acquiredAt: z.iso.datetime(), token: z.string().min(1).max(160) });
const LegacySchema = z.strictObject({ schema: z.literal('qautra/execution-owner/v1'), ownerId: Id, state: z.enum(['active', 'unknown']), resources: z.array(Id).min(1).max(128), updatedAt: z.iso.datetime() });
const OwnerSchema = z.strictObject({
  schema: z.literal('qautra/execution-owner/v2'), ownerId: Id, generation: z.uuid(), lockToken: z.string().min(1).max(160),
  pid: z.number().int().positive(), startedAt: z.iso.datetime(), state: z.enum(['active', 'unknown']), phase: z.enum(['running', 'closing']),
  resources: z.array(Id).min(1).max(128), updatedAt: z.iso.datetime(),
  recoverySources: ExecutionRecoverySourcesSchema.default([]),
});
const RecordSchema = z.union([OwnerSchema, LegacySchema]).refine(record => new Set(record.resources).size === record.resources.length);
const TicketSchema = z.strictObject({ token: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ownerId: Id, resourceId: Id, pid: z.number().int().positive(), startedAt: z.iso.datetime() });
const QueueSchema = z.strictObject({ schema: z.literal('qautra/execution-pending/v1'), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), tickets: z.array(TicketSchema).max(128) });
const RecoveryAuthorizationSchema = z.strictObject({
  schema: z.literal('qautra/execution-recovery-authorization/v1'),
  authorizedAt: z.iso.datetime(), receipt: ExecutionRecoveryReceiptSchema,
});


export interface ExecutionAdmissionOptions {
  /** Trusted composition code must confirm actual stop/finalization and effects; isolation requires durable non-reuse fences in the resource/backend authority. */
  verifyRecovery?: (scope: Readonly<ExecutionRecoveryScope>) => Promise<ExecutionRecoveryReceipt>;
  pollIntervalMs?: number;
}
export interface ExecutionReservation {
  /** Prevents new nested joins while existing resources finish evidence and cleanup. */
  closing(): void;
  unknown(reason: string): void;
  /** Call only after confirmed native cleanup and required evidence finalization; unknown reservations remain quarantined. */
  ended(): void;
}
export interface ExecutionAdmissionStatus {
  state: 'idle' | 'active' | 'unknown';
  ownerId: string | null;
  resources: string[];
  ownership: 'none' | 'live' | 'orphan' | 'unverified';
  phase: 'running' | 'closing' | null;
  reason: string | null;
}
export interface ExecutionOwnerContext {
  readonly ownerId: string;
  readonly generation: string;
  readonly resources: readonly string[];
}
export interface ExecutionAdmission {
  readonly directory: string;
  ownerContext(): ExecutionOwnerContext | null;
  /** Retains the original evidence reference until the entire owner epoch ends, even when an individual lease ends. */
  registerRecoverySource(expected: ExecutionOwnerContext, source: ExecutionRecoverySource): void;
  acquire(ownerId: string, resourceId: string): ExecutionReservation;
  /** Waits only for a local execution slot, never retries a business operation. FIFO begins at durable ticket registration. */
  wait(ownerId: string, resourceId: string, signal?: AbortSignal): Promise<ExecutionReservation>;
  status(): ExecutionAdmissionStatus;
  /** No request-supplied proof is accepted; the constructor-injected verifier runs under the exclusive authority lock. */
  reconcile(): Promise<ExecutionRecoveryReceipt>;
  /** Rejects this admission object's pending/new requests without releasing active resources. */
  close(): void;
}

type OwnerRecord = z.infer<typeof OwnerSchema>;
type LockRecord = z.infer<typeof LockSchema>;
type Ticket = z.infer<typeof TicketSchema>;
interface Snapshot { dev: number; ino: number; bytes: Buffer; hash: string }
interface Held { record: OwnerRecord; marker: Snapshot | null; lock: Snapshot; resources: Map<string, number>; unknown: boolean }
interface Shared { held: Held | null; gate: Snapshot | null; gateBusy: boolean }
interface QueueState { value: z.infer<typeof QueueSchema>; snapshot: Snapshot | null }
const authorities = new Map<string, Shared>();
const MAX_BYTES = 64 * 1024;
const coordinationPause = new Int32Array(new SharedArrayBuffer(4));
const STARTED_AT = new Date(PROCESS_STARTED_AT_MS).toISOString();
const uid = process.getuid?.();
const error = (code: string, message: string): AgentExecutionError => new AgentExecutionError(code, message);
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const errno = (cause: unknown): string | undefined => (cause as NodeJS.ErrnoException)?.code;
const same = (a: Snapshot | null, b: Snapshot | null): boolean => a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino && a.hash === b.hash;
const live = (record: Pick<LockRecord, 'pid' | 'startedAt'>): boolean => record.pid === process.pid
  ? Math.abs(Date.parse(record.startedAt) - PROCESS_STARTED_AT_MS) < 2000
  : isProcessAlive(record.pid, Date.parse(record.startedAt), systemProbe);

function privateNode(stat: Stats, directory: boolean, publishingLock = false): void {
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0 || (directory ? !stat.isDirectory() : !stat.isFile() || (stat.nlink !== 1 && !(publishingLock && stat.nlink === 2)))) {
    throw error('execution_storage_unsafe', '실행 소유권 저장소의 종류·소유자·권한을 확인할 수 없습니다');
  }
}
export function readExecutionRecoveryAuthorization(directory: string, generation: string): ExecutionRecoveryReceipt | null {
  const folder = join(directory, 'recovery-authorizations');
  try {
    privateNode(lstatSync(directory), true);
    privateNode(lstatSync(folder), true);
    const bytes = readPrivateFile(join(folder, `${hash(Buffer.from(generation))}.json`), 1024 * 1024);
    const value = RecoveryAuthorizationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const receipt = value.receipt, expected = [...receipt.scope.resources].sort(), actual = receipt.resources.map(item => item.resourceId).sort();
    if (receipt.scope.generation !== generation || new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('recovery_scope_changed');
    return receipt;
  } catch (cause) {
    if (errno(cause) === 'ENOENT') return null;
    throw error('recovery_authorization_unverified', '원 실행의 자원 복구 승인 기록을 확인할 수 없습니다');
  }
}


/** Keep the default per-user authority in every entry point; directory overrides are for isolated test authorities, not project slots. */
export function createExecutionAdmission(directory = join(homedir(), 'Library', 'Application Support', 'QAutra', 'execution'), options: ExecutionAdmissionOptions = {}): ExecutionAdmission {
  const requested = resolve(directory);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  try { mkdirSync(requested, { mode: 0o700 }); } catch (cause) { if (errno(cause) !== 'EEXIST') throw cause; }
  const rootStat = lstatSync(requested);
  privateNode(rootStat, true);
  const root = realpathSync(requested);
  const key = `${root}:${rootStat.dev}:${rootStat.ino}`;
  let shared = authorities.get(key);
  if (!shared) { shared = { held: null, gate: null, gateBusy: false }; authorities.set(key, shared); }
  const authority = shared;
  const markerPath = join(root, 'owner.json');
  const lockPath = join(root, 'owner.lock');
  const gatePath = join(root, 'admission.lock');
  const reclaimPath = join(root, 'admission.reclaim');
  const queuePath = join(root, 'pending.json');
  const interval = options.pollIntervalMs ?? 100;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) throw error('invalid_reservation', '실행 대기 확인 간격이 범위를 벗어났습니다');
  let closed = false;

  function assertRoot(): void {
    const stat = lstatSync(root);
    privateNode(stat, true);
    if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino || realpathSync(requested) !== root) throw error('execution_storage_changed', '실행 소유권 저장소가 교체되었습니다');
  }
  function syncRoot(): void {
    assertRoot();
    const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      privateNode(stat, true);
      if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino) throw error('execution_storage_changed', '실행 소유권 저장소가 교체되었습니다');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  function readSnapshot(path: string): Snapshot | null {
    assertRoot();
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (cause) { if (errno(cause) === 'ENOENT') return null; throw error('execution_storage_unsafe', '실행 소유권 파일을 안전하게 열 수 없습니다'); }
    try {
      const stat = fstatSync(fd);
      const publishingLock = path === lockPath || path === gatePath || path === reclaimPath;
      if (publishingLock && stat.nlink === 0) throw error('execution_snapshot_changed', '읽던 coordination lock 세대가 종료되었습니다');
      privateNode(stat, false, publishingLock);
      if (stat.size > MAX_BYTES) throw error('execution_record_invalid', '실행 소유권 기록이 크기 제한을 넘었습니다');
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      for (;;) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        length += count;
        if (length > MAX_BYTES) throw error('execution_record_invalid', '실행 소유권 기록이 크기 제한을 넘었습니다');
        if (!count) break;
      }
      const after = fstatSync(fd);
      let named: Stats;
      try { named = lstatSync(path); }
      catch (cause) { if (errno(cause) === 'ENOENT') return null; throw cause; }
      privateNode(named, false, publishingLock);
      if (after.size !== length || after.mtimeMs !== stat.mtimeMs || named.dev !== stat.dev || named.ino !== stat.ino || named.isSymbolicLink()) throw error('execution_snapshot_changed', '실행 소유권 파일이 읽는 동안 바뀌었습니다');
      privateNode(after, false, publishingLock);
      const bytes = buffer.subarray(0, length);
      return { dev: stat.dev, ino: stat.ino, bytes, hash: hash(bytes) };
    } finally { closeSync(fd); }
  }
  function parse<T>(schema: z.ZodType<T>, snapshot: Snapshot): T {
    try { return schema.parse(JSON.parse(snapshot.bytes.toString('utf8'))); }
    catch { throw error('execution_record_invalid', '실행 소유권 기록이 손상되었거나 지원하지 않는 형식입니다'); }
  }
  function remove(path: string, seen: Snapshot): void {
    if (!same(readSnapshot(path), seen)) throw error('execution_scope_changed', '실행 소유권 세대가 바뀌어 제거하지 않았습니다');
    unlinkSync(path);
    syncRoot();
  }
  function persist(path: string, value: unknown, expected: Snapshot | null): Snapshot {
    if (!same(readSnapshot(path), expected)) throw error('execution_scope_changed', '실행 소유권 세대가 바뀌어 저장하지 않았습니다');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_BYTES) throw error('execution_record_invalid', '실행 소유권 기록이 크기 제한을 넘었습니다');
    const temporary = join(root, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let installed = false;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      if (!same(readSnapshot(path), expected)) throw error('execution_scope_changed', '실행 소유권 세대가 바뀌어 저장하지 않았습니다');
      assertRoot();
      renameSync(temporary, path);
      installed = true;
      syncRoot();
      return readSnapshot(path)!;
    } finally {
      if (!installed) {
        try { closeSync(fd); } catch { /* The descriptor may already be closed before a failed rename. */ }
        try { unlinkSync(temporary); } catch (cause) { if (errno(cause) !== 'ENOENT') throw cause; }
      }
    }
  }
  function newLock(): LockRecord { return { pid: process.pid, startedAt: STARTED_AT, acquiredAt: new Date().toISOString(), token: randomUUID() }; }
  function exclusive(path: string, record: LockRecord): Snapshot | null {
    assertRoot();
    const temporary = join(root, `${record.token}.lock.tmp`);
    let linked = false;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      assertRoot();
      try { linkSync(temporary, path); linked = true; } catch (cause) { if (errno(cause) !== 'EEXIST') throw cause; }
    } finally {
      try { unlinkSync(temporary); } catch (cause) { if (errno(cause) !== 'ENOENT') throw cause; }
    }
    if (!linked) return null;
    const snapshot = readSnapshot(path);
    if (path === gatePath) authority.gate = snapshot;
    syncRoot();
    return snapshot;
  }
  function takeGate(): Snapshot {
    if (authority.gateBusy) throw error('execution_busy', '실행 소유권 확인이 진행 중입니다');
    if (authority.gate) {
      remove(gatePath, authority.gate);
      authority.gate = null;
    }
    if (readSnapshot(reclaimPath)) throw error('execution_reconciliation_required', '중단된 소유권 잠금 복구를 확인해야 합니다');
    for (let attempt = 0; attempt < 2; attempt++) {
      const installed = exclusive(gatePath, newLock());
      if (installed) { authority.gate = installed; authority.gateBusy = true; return installed; }
      let seen: Snapshot | null;
      try { seen = readSnapshot(gatePath); }
      catch (cause) {
        if (cause instanceof AgentExecutionError && cause.code === 'execution_snapshot_changed') continue;
        throw cause;
      }
      if (!seen) continue;
      const record = parse(LockSchema, seen);
      if (live(record)) throw error('execution_busy', '다른 요청이 실행 소유권을 갱신하거나 복구 중입니다');
      // Process death permits reclaiming only this coordination gate, never an execution claim or its effects.
      const guard = exclusive(reclaimPath, newLock());
      if (!guard) throw error('execution_busy', '다른 요청이 실행 소유권 잠금을 확인 중입니다');
      try {
        if (same(readSnapshot(gatePath), seen)) remove(gatePath, seen);
      } finally { remove(reclaimPath, guard); }
    }
    throw error('execution_busy', '다른 요청이 실행 소유권을 갱신 중입니다');
  }
  function releaseGate(gate: Snapshot): void {
    try { remove(gatePath, gate); authority.gate = null; }
    finally { authority.gateBusy = false; }
  }
  function transaction<T>(action: () => T, ownerUpdate = false): T {
    let gate: Snapshot | null = null;
    try {
      const deadline = performance.now() + 1000;
      for (;;) {
        try { gate = takeGate(); break; }
        catch (cause) {
          if (!ownerUpdate || authority.gateBusy || !(cause instanceof AgentExecutionError) || cause.code !== 'execution_busy' || performance.now() >= deadline) throw cause;
          // Only serialize metadata with another process; no native command or business effect is retried.
          Atomics.wait(coordinationPause, 0, 0, 1);
        }
      }
      return action();
    }
    catch (cause) {
      throw cause instanceof AgentExecutionError ? cause : error('execution_storage_unavailable', '실행 소유권 저장소에 접근할 수 없습니다');
    }
    finally {
      try { if (gate) releaseGate(gate); }
      catch {
        if (authority.held) quarantine(authority.held);
        throw error('execution_persistence_failed', '실행 소유권 갱신 잠금을 반환하지 못해 격리를 유지합니다');
      }
    }
  }
  function readQueue(): QueueState {
    const snapshot = readSnapshot(queuePath);
    const value = snapshot ? parse(QueueSchema, snapshot) : { schema: 'qautra/execution-pending/v1' as const, sequence: 0, tickets: [] };
    if (new Set(value.tickets.map(ticket => ticket.token)).size !== value.tickets.length || value.tickets.some((ticket, index) => ticket.sequence > value.sequence || (index > 0 && ticket.sequence <= value.tickets[index - 1]!.sequence))) throw error('execution_record_invalid', '실행 대기 순서 기록이 손상되었습니다');
    return { value, snapshot };
  }
  function pruneQueue(): QueueState {
    const queue = readQueue();
    const tickets = queue.value.tickets.filter(live);
    if (tickets.length !== queue.value.tickets.length) {
      queue.value.tickets = tickets;
      queue.snapshot = persist(queuePath, queue.value, queue.snapshot);
    }
    return queue;
  }
  function requireOpen(ownerId: string, resourceId: string): void {
    if (closed) throw error('execution_closing', '종료 중인 실행기는 새 실행을 받지 않습니다');
    if (!Id.safeParse(ownerId).success || !Id.safeParse(resourceId).success) throw error('invalid_reservation', '실행과 자원에는 비밀값 없는 160자 이내 식별자가 필요합니다');
  }
  function retainWrittenMarker(current: Held, record: OwnerRecord): void {
    try {
      const actual = readSnapshot(markerPath);
      if (actual?.hash === hash(Buffer.from(`${JSON.stringify(record)}\n`))) { current.marker = actual; current.record = record; }
    } catch { /* An unreadable generation must remain fenced, not replaced. */ }
  }
  function quarantine(current: Held, attempted?: OwnerRecord): void {
    current.unknown = true;
    if (attempted) retainWrittenMarker(current, attempted);
    const record: OwnerRecord = { ...current.record, state: 'unknown', resources: [...current.resources.keys()].sort(), updatedAt: new Date().toISOString() };
    try {
      const actual = readSnapshot(markerPath);
      if (!actual || same(actual, current.marker)) { current.marker = persist(markerPath, record, actual); current.record = record; }
    } catch { retainWrittenMarker(current, record); }
  }
  function save(current: Held, resources: Map<string, number>, phase = current.record.phase, recoverySources = current.record.recoverySources): void {
    const record: OwnerRecord = { ...current.record, resources: [...resources.keys()].sort(), phase, recoverySources, updatedAt: new Date().toISOString() };
    try {
      if (!same(readSnapshot(lockPath), current.lock)) throw error('execution_scope_changed', '실행 소유권 잠금이 바뀌었습니다');
      const marker = persist(markerPath, record, current.marker);
      current.marker = marker;
      current.record = record;
      current.resources = resources;
    } catch {
      for (const [resource, count] of resources) current.resources.set(resource, Math.max(count, current.resources.get(resource) ?? 0));
      quarantine(current, record);
      throw error('execution_persistence_failed', '실행 소유권 저장에 실패하여 자원을 격리했습니다');
    }
  }
  function consumeTicket(token: string, current: Held, resourceId: string): void {
    const queue = readQueue();
    const entry = queue.value.tickets.find(ticket => ticket.token === token);
    if (!entry || entry.ownerId !== current.record.ownerId || entry.resourceId !== resourceId || entry.pid !== process.pid || entry.startedAt !== STARTED_AT) {
      quarantine(current);
      throw error('execution_ticket_lost', '실행 대기 기록이 바뀌어 자동 배정하지 않습니다');
    }
    const tickets = queue.value.tickets.filter(ticket => ticket.token !== token);
    try { persist(queuePath, { ...queue.value, tickets }, queue.snapshot); }
    catch {
      quarantine(current);
      throw error('execution_persistence_failed', '배정 기록 저장에 실패하여 실행을 시작하지 않고 격리했습니다');
    }
  }
  function reservation(current: Held, resourceId: string): ExecutionReservation {
    let ended = false;
    return {
      closing: () => {
        if (ended || authority.held !== current || current.unknown) return;
        transaction(() => save(current, current.resources, 'closing'), true);
      },
      unknown: (_reason: string) => {
        if (ended || authority.held !== current) return;
        current.unknown = true;
        transaction(() => {
          try {
            quarantine(current);
            if (current.record.state !== 'unknown' || !same(readSnapshot(markerPath), current.marker)) throw error('execution_scope_changed', '미확인 소유권 기록이 바뀌었습니다');
          } catch { throw error('execution_persistence_failed', '미확인 실행의 소유권을 저장하지 못해 잠금을 유지합니다'); }
        }, true);
      },
      ended: () => {
        if (ended || authority.held !== current || current.unknown) return;
        transaction(() => {
          if (authority.held !== current || current.unknown) return;
          const resources = new Map(current.resources);
          const count = resources.get(resourceId)!;
          if (count > 1) resources.set(resourceId, count - 1); else resources.delete(resourceId);
          if (resources.size) { save(current, resources); ended = true; return; }
          try {
            if (!same(readSnapshot(lockPath), current.lock)) throw error('execution_scope_changed', '실행 소유권 잠금이 바뀌었습니다');
            if (!current.marker) throw error('execution_scope_changed', '실행 소유권 기록이 없습니다');
            remove(markerPath, current.marker);
            remove(lockPath, current.lock);
            authority.held = null;
            ended = true;
          } catch {
            quarantine(current);
            throw error('execution_persistence_failed', '종료 기록을 확정하지 못해 실행 자원을 격리했습니다');
          }
        }, true);
      },
    };
  }
  function acquireLocked(ownerId: string, resourceId: string, ticketToken?: string): ExecutionReservation {
    requireOpen(ownerId, resourceId);
    const current = authority.held;
    if (current) {
      if (current.unknown) throw error('execution_reconciliation_required', '미확인 실행은 실제 종료·증거·효과 확인 전 재사용하지 않습니다');
      if (current.record.ownerId !== ownerId) throw error('execution_busy', '다른 실행이 준비·동작·증거 정리 중입니다');
      if (current.record.phase === 'closing') throw error('execution_closing', '정리 중인 실행에는 자원을 추가할 수 없습니다');
      const resources = new Map(current.resources);
      resources.set(resourceId, (resources.get(resourceId) ?? 0) + 1);
      if (resources.size > 128) throw error('invalid_reservation', '한 실행의 자원 수가 제한을 넘었습니다');
      save(current, resources);
      if (ticketToken) consumeTicket(ticketToken, current, resourceId);
      return reservation(current, resourceId);
    }
    const marker = readSnapshot(markerPath);
    const lock = readSnapshot(lockPath);
    if (marker || lock) {
      if (marker && lock) {
        const record = parse(RecordSchema, marker);
        const owner = parse(LockSchema, lock);
        if (record.schema === 'qautra/execution-owner/v2' && record.state === 'active' && record.lockToken === owner.token && record.pid === owner.pid && record.startedAt === owner.startedAt && live(owner)) throw error('execution_busy', '다른 프로세스가 실행과 필수 증거·정리를 소유 중입니다');
      }
      throw error('execution_reconciliation_required', '이전 실행의 종료·증거·fixture·지연 효과를 확인해야 합니다');
    }
    const queue = pruneQueue();
    if (ticketToken && !queue.value.tickets.some(ticket => ticket.token === ticketToken && ticket.ownerId === ownerId && ticket.resourceId === resourceId && ticket.pid === process.pid && ticket.startedAt === STARTED_AT)) throw error('execution_ticket_lost', '실행 대기 기록이 바뀌어 자동 배정하지 않습니다');
    if (queue.value.tickets.length && queue.value.tickets[0]!.token !== ticketToken) throw error('execution_busy', '먼저 접수된 실행이 슬롯을 기다리고 있습니다');
    const ownerLock = newLock();
    const ownerSnapshot = exclusive(lockPath, ownerLock);
    if (!ownerSnapshot) throw error('execution_busy', '다른 실행이 슬롯을 소유 중입니다');
    const record: OwnerRecord = { schema: 'qautra/execution-owner/v2', ownerId, generation: randomUUID(), lockToken: ownerLock.token, pid: process.pid, startedAt: STARTED_AT, state: 'active', phase: 'running', resources: [resourceId], recoverySources: [], updatedAt: new Date().toISOString() };
    const held: Held = { record, marker: null, lock: ownerSnapshot, resources: new Map([[resourceId, 1]]), unknown: false };
    authority.held = held;
    try {
      held.marker = persist(markerPath, record, null);
      if (ticketToken) consumeTicket(ticketToken, held, resourceId);
      return reservation(held, resourceId);
    } catch {
      quarantine(held, record);
      throw error('execution_persistence_failed', '실행 점유 기록을 저장하지 못해 자원과 잠금을 유지합니다');
    }
  }
  async function removeTicket(token: string): Promise<void> {
    for (;;) {
      try {
        transaction(() => {
          const queue = readQueue();
          const tickets = queue.value.tickets.filter(ticket => ticket.token !== token);
          if (tickets.length !== queue.value.tickets.length) persist(queuePath, { ...queue.value, tickets }, queue.snapshot);
        });
        return;
      } catch (cause) {
        if (!(cause instanceof AgentExecutionError) || cause.code !== 'execution_busy') throw cause;
        await delay(interval);
      }
    }
  }

  return {
    directory: root,
    ownerContext: () => transaction(() => {
      const current = authority.held;
      if (closed || !current || current.unknown || current.record.phase !== 'running') return null;
      if (!same(readSnapshot(markerPath), current.marker) || !same(readSnapshot(lockPath), current.lock)) throw error('execution_scope_changed', '실제 점유 세대와 잠금이 달라 native 자원을 시작하지 않습니다');
      return Object.freeze({ ownerId: current.record.ownerId, generation: current.record.generation, resources: Object.freeze([...current.resources.keys()].sort()) });
    }, true),
    registerRecoverySource: (expected, input) => transaction(() => {
      const source = ExecutionRecoverySourceSchema.safeParse(input), current = authority.held;
      if (!source.success) throw error('invalid_reservation', '복구 증거에는 원 native 종류·ID·binding hash가 필요합니다');
      if (closed || !current || current.unknown || current.record.phase !== 'running' || current.record.ownerId !== expected.ownerId || current.record.generation !== expected.generation || expected.resources.some(resource => !current.resources.has(resource))) throw error('execution_scope_changed', '원 점유 세대에만 native 복구 증거를 연결할 수 있습니다');
      if (!same(readSnapshot(markerPath), current.marker) || !same(readSnapshot(lockPath), current.lock)) throw error('execution_scope_changed', '원 점유 기록·잠금이 변경되어 native 자원을 시작하지 않습니다');
      const existing = current.record.recoverySources.find(item => item.id === source.data.id);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(source.data)) return;
        quarantine(current);
        throw error('execution_scope_changed', '원 native 증거를 다른 binding으로 바꾸지 않습니다');
      }
      if (current.record.recoverySources.length >= 128) throw error('invalid_reservation', '한 실행의 native 복구 증거 수 상한을 초과했습니다');
      save(current, current.resources, current.record.phase, [...current.record.recoverySources, source.data]);
    }, true),
    acquire: (ownerId, resourceId) => { requireOpen(ownerId, resourceId); return transaction(() => acquireLocked(ownerId, resourceId), authority.held?.record.ownerId === ownerId); },
    wait: async (ownerId, resourceId, signal) => {
      requireOpen(ownerId, resourceId);
      let ticketToken: string | undefined;
      try {
        for (;;) {
          if (signal?.aborted) throw error('execution_cancelled', '배정 전 실행 대기가 취소되었습니다');
          requireOpen(ownerId, resourceId);
          try {
            const result = transaction(() => {
              if (signal?.aborted) throw error('execution_cancelled', '배정 전 실행 대기가 취소되었습니다');
              return acquireLocked(ownerId, resourceId, ticketToken);
            });
            ticketToken = undefined;
            return result;
          } catch (cause) {
            if (!(cause instanceof AgentExecutionError) || cause.code !== 'execution_busy') throw cause;
          }
          if (!ticketToken) {
            try {
              transaction(() => {
                const queue = pruneQueue();
                if (queue.value.tickets.length >= 128 || queue.value.sequence === Number.MAX_SAFE_INTEGER) throw error('execution_queue_full', '실행 대기 수가 제한을 넘었습니다');
                const entry: Ticket = { token: randomUUID(), sequence: queue.value.sequence + 1, ownerId, resourceId, pid: process.pid, startedAt: STARTED_AT };
                queue.value.sequence = entry.sequence;
                queue.value.tickets.push(entry);
                ticketToken = entry.token;
                persist(queuePath, queue.value, queue.snapshot);
              });
            } catch (cause) {
              if (!(cause instanceof AgentExecutionError) || cause.code !== 'execution_busy') throw cause;
            }
          }
          try { await delay(interval, undefined, { signal }); }
          catch { if (!signal?.aborted) throw error('execution_wait_failed', '실행 대기를 계속할 수 없습니다'); }
        }
      } finally { if (ticketToken) await removeTicket(ticketToken); }
    },
    status: () => {
      try {
        const marker = readSnapshot(markerPath);
        const lock = readSnapshot(lockPath);
        const gate = readSnapshot(gatePath);
        if (!marker && !lock && gate && (!live(parse(LockSchema, gate)) || (authority.gate && !authority.gateBusy))) return { state: 'unknown', ownerId: null, resources: [], ownership: 'unverified', phase: null, reason: 'execution_coordination_interrupted' };
        if (readSnapshot(reclaimPath)) throw error('execution_reconciliation_required', '중단된 소유권 잠금 복구를 확인해야 합니다');
        if (!marker && !lock && !authority.held) return { state: 'idle', ownerId: null, resources: [], ownership: 'none', phase: null, reason: null };
        if (!marker) return { state: 'unknown', ownerId: authority.held?.record.ownerId ?? null, resources: [...(authority.held?.resources.keys() ?? [])], ownership: 'unverified', phase: null, reason: 'execution_marker_missing' };
        const record = parse(RecordSchema, marker);
        const owner = lock ? parse(LockSchema, lock) : null;
        const ownership = owner ? (live(owner) ? 'live' : 'orphan') : 'orphan';
        const matching = record.schema === 'qautra/execution-owner/v2' && owner && record.lockToken === owner.token && record.pid === owner.pid && record.startedAt === owner.startedAt;
        const localMatching = !authority.held || (same(marker, authority.held.marker) && same(lock, authority.held.lock));
        const active = matching && localMatching && ownership === 'live' && record.state === 'active' && !authority.held?.unknown;
        return { state: active ? 'active' : 'unknown', ownerId: record.ownerId, resources: authority.held ? [...authority.held.resources.keys()].sort() : record.resources, ownership: matching ? ownership : 'unverified', phase: record.schema === 'qautra/execution-owner/v2' ? record.phase : null, reason: active ? null : 'execution_reconciliation_required' };
      } catch (cause) {
        return { state: 'unknown', ownerId: authority.held?.record.ownerId ?? null, resources: [...(authority.held?.resources.keys() ?? [])], ownership: 'unverified', phase: null, reason: cause instanceof AgentExecutionError ? cause.code : 'execution_storage_unavailable' };
      }
    },
    reconcile: async () => {
      if (!options.verifyRecovery) throw error('reconciliation_verifier_required', '신뢰된 실행기 복구 확인기가 연결되지 않았습니다');
      let gate: Snapshot | null = null;
      try {
        gate = takeGate();
        let marker = readSnapshot(markerPath);
        if (!marker && authority.held?.unknown) { quarantine(authority.held); marker = readSnapshot(markerPath); }
        if (!marker) throw error('reconciliation_scope_unavailable', '정확한 실행·자원 기록이 없어 복구를 확정할 수 없습니다');
        const record = parse(RecordSchema, marker);
        const lock = readSnapshot(lockPath);
        const owner = lock ? parse(LockSchema, lock) : null;
        if (owner && live(owner) && (!authority.held?.unknown || !same(lock, authority.held.lock))) throw error('execution_active', '다른 활성 실행의 소유권은 복구로 지울 수 없습니다');
        if (authority.held && !authority.held.unknown) throw error('execution_active', '진행 중인 실행은 먼저 입력을 중지하고 격리해야 합니다');
        if (authority.held && !same(marker, authority.held.marker)) throw error('reconciliation_scope_mismatch', '복구 대상 기록과 보유 중인 실행 세대가 다릅니다');
        if (owner && record.schema === 'qautra/execution-owner/v2' && (record.lockToken !== owner.token || record.pid !== owner.pid || record.startedAt !== owner.startedAt)) throw error('reconciliation_scope_mismatch', '실행 기록과 잠금 세대가 달라 격리를 유지합니다');
        const resources = [...new Set(record.resources)].sort();
        if (resources.length !== record.resources.length || (authority.held && resources.join('\n') !== [...authority.held.resources.keys()].sort().join('\n'))) throw error('reconciliation_scope_mismatch', '저장된 자원 범위와 실제 보유 범위가 달라 격리를 유지합니다');
        const recoverySources = record.schema === 'qautra/execution-owner/v2' ? record.recoverySources : [];
        const scope: ExecutionRecoveryScope = { ownerId: record.ownerId, generation: record.schema === 'qautra/execution-owner/v2' ? record.generation : `legacy:${marker.hash}`, resources, markerSha256: marker.hash, lockSha256: lock?.hash ?? null, recoverySources };
        const frozen = Object.freeze({ ...scope, resources: Object.freeze([...resources]), recoverySources: Object.freeze(recoverySources) });
        let verification: ExecutionRecoveryReceipt;
        try { verification = await options.verifyRecovery(frozen); }
        catch { throw error('reconciliation_verification_failed', '실제 종료·증거·fixture·지연 효과 확인에 실패하여 격리를 유지합니다'); }
        const receipt = ExecutionRecoveryReceiptSchema.safeParse(verification);
        if (!receipt.success || JSON.stringify(receipt.data.scope) !== JSON.stringify(scope) || receipt.data.resources.length !== resources.length || [...receipt.data.resources.map(item => item.resourceId)].sort().join('\n') !== resources.join('\n')) throw error('reconciliation_incomplete', '모든 자원의 실제 종료·증거·fixture·지연 효과 확인이 필요합니다');
        if (!same(readSnapshot(markerPath), marker) || !same(readSnapshot(lockPath), lock)) throw error('reconciliation_scope_mismatch', '복구 확인 중 소유권이나 자원 범위가 바뀌어 격리를 유지합니다');
        try {
          assertRoot();
          const folder = ensureDir(join(root, 'recovery-authorizations'));
          privateNode(lstatSync(folder), true);
          writeJsonAtomic(join(folder, `${hash(Buffer.from(scope.generation))}.json`), RecoveryAuthorizationSchema.parse({
            schema: 'qautra/execution-recovery-authorization/v1', authorizedAt: new Date().toISOString(), receipt: receipt.data,
          }));
          assertRoot();
        } catch { throw error('execution_persistence_failed', '원 자원의 복구 승인을 보존하지 못해 격리를 유지합니다'); }
        try {
          if (lock) remove(lockPath, lock);
          remove(markerPath, marker);
        } catch { throw error('execution_persistence_failed', '복구 종료 기록을 확정하지 못해 격리를 유지합니다'); }
        authority.held = null;
        return receipt.data;
      } catch (cause) {
        throw cause instanceof AgentExecutionError ? cause : error('execution_storage_unavailable', '실행 소유권 저장소에 접근할 수 없습니다');
      } finally {
        try { if (gate) releaseGate(gate); }
        catch {
          if (authority.held) quarantine(authority.held);
          throw error('execution_persistence_failed', '복구 확인 잠금을 반환하지 못해 격리를 유지합니다');
        }
      }
    },
    close: () => { closed = true; },
  };
}
