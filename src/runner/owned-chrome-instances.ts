import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { hostname, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ensureDir, writeAtomic } from '../core/fsx.ts';
import { InstanceExecutionError, InstanceRequestSchema, type InstanceProfile, type InstanceRequest, type InstanceRuntimeCapability, type OwnedChromeInstanceView } from '../core/instances.ts';
import { acquireFileLock } from '../core/lock.ts';
import type { DeviceInfo } from '../core/types.ts';
import type { InstanceLease } from './instances.ts';
import { readExecutionRecoveryAuthorization } from '../core/admission.ts';
import { type ChromeOwnerLocator, ChromeOwnerLocatorSchema } from '../core/chrome-owner.ts';
import type { ChromeAttemptRecovery, InstanceRecoverySummary } from '../core/recovery.ts';

const ID = z.uuid();
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OwnedChromeIdentity = z.strictObject({
  instanceId: ID, generation: Positive, workerId: z.string().min(1).max(512),
  browserSessionId: z.string().min(1).max(512).nullable(), profile: z.string().min(1).max(4096),
  browserVersion: z.string().min(1).max(256), osVersion: z.string().min(1).max(256),
});
export type OwnedChromeIdentity = z.infer<typeof OwnedChromeIdentity>;
export interface OwnedChromeResource {
  identity: OwnedChromeIdentity;
  assertHealthy(): void;
  /** Resolves only after the exact owned browser and its native endpoint have confirmed closure. */
  stop(): Promise<void>;
}
export interface OwnedChromeProbe {
  available: boolean;
  reason: string | null;
  workerId: string;
  osVersion: string;
}
export interface OwnedChromeExecution {
  runtime: 'owned-chrome';
  instanceId: string;
  machineId: null;
  workerId: string;
  generation: number;
}
export interface OwnedChromeInstances {
  owns(instanceId: string): boolean;
  call(request: InstanceRequest): Promise<OwnedChromeInstanceView | { instances: OwnedChromeInstanceView[]; capability: InstanceRuntimeCapability }>;
  devices(): Promise<DeviceInfo[]>;
  pick(deviceId?: string): Promise<DeviceInfo>;
  acquire(deviceId: string, runId: string | null, sessionId: string, owner?: 'direct' | 'run' | 'screen'): InstanceLease;
  prepare(deviceId: string, origins: readonly string[]): Promise<string>;
  execution(deviceId: string, cleanup?: boolean): OwnedChromeExecution | null;
  bind(deviceId: string, resource: OwnedChromeResource): void;
  bindNativeOwner(deviceId: string, locator: ChromeOwnerLocator): void;
  reconcile(): Promise<InstanceRecoverySummary>;
  shutdown(): Promise<void>;
}
const Lease = z.strictObject({
  token: ID, sessionId: ID, runId: z.string().min(1).max(240).nullable(), owner: z.enum(['direct', 'run', 'screen']),
  generation: Positive, workerId: z.string().min(1).max(512), state: z.enum(['active', 'unknown']),
  prepared: z.boolean(), identity: OwnedChromeIdentity.nullable(), nativeOwner: ChromeOwnerLocatorSchema.nullable().default(null),
});
const RecordSchema = z.strictObject({
  schema: z.literal('qautra/owned-chrome-instance/v1'), projectRoot: z.string(), id: ID, profileId: ID,
  name: z.string().min(1).max(80), createdAt: z.iso.datetime(), generation: Positive,
  request: z.strictObject({ profileId: ID, name: z.string().nullable() }),
  prepared: z.boolean(), enabled: z.boolean(), quarantine: z.string().nullable(),
  lease: Lease.nullable(), lastIdentity: OwnedChromeIdentity.nullable(),
  usedProfiles: z.array(z.string().min(1).max(4096)),
  usedSessions: z.array(z.string().min(1).max(512)),
});
type Record = z.infer<typeof RecordSchema>;

function fail(code: string, message: string, effect: 'not_started' | 'unknown' = 'not_started'): never {
  throw new InstanceExecutionError(code, message, effect);
}
function privateDirectory(path: string): void {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('chrome_storage_unsafe', 'Chrome ownership storage must be a private owned directory.');
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('chrome_storage_unsafe', 'Chrome ownership records must be private owned regular files.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function increment(value: number): number {
  if (!Number.isSafeInteger(value + 1)) fail('chrome_generation_exhausted', 'Chrome ownership generation is exhausted.');
  return value + 1;
}
function checkOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { fail('chrome_origin_invalid', 'An absolute approved HTTP(S) origin is required.'); }
    if (origin !== origin.trim() || !/^https?:\/\/[^/]+\/?$/i.test(origin) || /[\\?#]/.test(origin)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') fail('chrome_origin_invalid', 'Approved origins cannot contain credentials, paths, queries or fragments.');
  }
}

export function probeOwnedChrome(root: string): OwnedChromeProbe {
  const workerId = `local:${hostname()}:${process.getuid?.() ?? 'unknown'}:${process.platform}:${process.arch}`;
  const osVersion = release();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { available: false, workerId, osVersion, reason: 'This owned Chrome adapter requires macOS on Apple Silicon; another engine is not substituted.' };
  try {
    accessSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', constants.X_OK);
    accessSync(join(root, '.tools/chromedriver/chromedriver-mac-arm64_v156.0.8078.80'), constants.X_OK);
    return { available: true, workerId, osVersion, reason: null };
  } catch {
    return { available: false, workerId, osVersion, reason: 'Actual Chrome and the project-local ChromeDriver must be prepared. No VM or personal browser is adopted.' };
  }
}

export function createOwnedChromeInstances(options: {
  root: string;
  profiles: () => readonly InstanceProfile[];
  probe?: () => OwnedChromeProbe;
  cancelExecution?: (sessionId: string) => Promise<void>;
  maximumActiveContexts?: number;
  admissionDirectory?: string;
  nativeRecovery?: ChromeAttemptRecovery;
}): OwnedChromeInstances {
  const maximumActiveContexts = Positive.parse(options.maximumActiveContexts ?? 1);
  const requestedRoot = resolve(options.root);
  const stat = lstatSync(requestedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) fail('chrome_storage_unsafe', 'The Chrome project root must be an owned real directory.');
  try { ensureDir(requestedRoot); }
  catch { fail('chrome_storage_unsafe', 'The Chrome project root must have trusted directory ancestors and no other user’s write access.'); }
  const root = realpathSync(requestedRoot);
  const directory = join(root, '.qa', 'instances', 'owned-chrome');
  for (const path of [join(root, '.qa'), join(root, '.qa', 'instances'), directory]) privateDirectory(path);
  const owner = acquireFileLock(join(directory, 'manager.lock'), { purpose: 'Owned Chrome instance manager' });
  const records = new Map<string, Record>();
  const resources = new Map<string, { token: string; resource: OwnedChromeResource }>();
  const written = new Map<string, string>();
  const stopping = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  let closing = false;
  let storageFailed = false;
  let shutdownPromise: Promise<void> | null = null;

  function assertOwner(): void {
    if (storageFailed) fail('chrome_storage_unconfirmed', 'Chrome ownership could not be persisted; execution remains fenced.', 'unknown');
    try {
      const value: unknown = JSON.parse(privateRead(owner.path));
      if (!value || typeof value !== 'object' || !('token' in value) || value.token !== owner.record.token) throw new Error('owner_changed');
    } catch {
      storageFailed = true;
      fail('chrome_owner_changed', 'The Chrome manager no longer owns its exact durable lock.', 'unknown');
    }
  }
  function assertOpen(): void {
    assertOwner();
    if (closing) fail('chrome_engine_stopping', 'The owned Chrome manager is shutting down.');
  }
  function save(record: Record): void {
    assertOwner();
    const path = join(directory, `${record.id}.json`);
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (written.get(path) === text) return;
    try { writeAtomic(path, text); written.set(path, text); }
    catch { storageFailed = true; fail('chrome_storage_unconfirmed', 'Chrome ownership could not be persisted; execution remains fenced.', 'unknown'); }
  }
  function get(id: string): Record {
    if (!ID.safeParse(id).success) fail('chrome_instance_invalid', 'An owned Chrome instance UUID is required.');
    const record = records.get(id.toLowerCase());
    if (!record) fail('chrome_instance_not_found', 'This Chrome instance is not owned by this project.');
    return record;
  }
  function device(deviceId: string): Record {
    if (!deviceId.startsWith('chrome:')) fail('chrome_device_required', 'Select an explicit chrome:<instance UUID>; personal browsers are not a fallback.');
    return get(deviceId.slice(7));
  }
  function quarantine(record: Record, reason: string): void {
    record.quarantine ??= reason;
    record.prepared = false;
    if (record.lease) record.lease.state = 'unknown';
    save(record);
  }
  function probe(): OwnedChromeProbe {
    const result = z.strictObject({ available: z.boolean(), reason: z.string().nullable(), workerId: z.string().min(1).max(512), osVersion: z.string().min(1).max(256) }).parse(options.probe?.() ?? probeOwnedChrome(root));
    assertOwner();
    return result;
  }
  function view(record: Record): OwnedChromeInstanceView {
    const host = probe();
    const state = record.quarantine ? 'unknown' : stopping.has(record.id) ? 'stopping' : record.lease ? record.lease.identity ? 'running' : 'preparing'
      : !record.enabled ? 'stopped' : record.prepared && host.available ? 'ready' : 'setup-required';
    return {
      id: record.id, profileId: record.profileId, name: record.name, platform: 'desktop-chrome', runtime: 'owned-chrome',
      machineId: null, nativeState: null, generation: record.generation, state, progress: null,
      cpuCount: null, memoryMiB: null, diskGiB: null, requestedResources: null,
      osVersion: record.lease?.identity?.osVersion ?? host.osVersion, browserVersion: record.lease?.identity?.browserVersion ?? null,
      activeSessionId: record.lease?.owner === 'direct' ? record.lease.sessionId : null, activeRunId: record.lease?.runId ?? null,
      createdAt: record.createdAt, reason: record.quarantine ?? host.reason ?? (record.lease
        ? 'The attempt identity is available via activeRunId. Instance metadata does not establish live Space or recording readiness.'
        : 'Metadata only: a fresh headless Chrome profile and required video are created and checked inside the QA lease.'),
      hostGlobalInput: false, isolation: 'owned-browser-context', frameAvailable: false, recordingReady: false,
    };
  }
  function toDevice(record: Record): DeviceInfo {
    const current = view(record);
    return { platform: 'desktop-chrome', id: `chrome:${record.id}`, name: record.name, osVersion: current.osVersion ?? '', kind: 'browser',
      state: current.state === 'ready' || current.state === 'running' ? 'booted' : current.state === 'stopped' ? 'shutdown' : 'offline' };
  }
  function available(record: Record): OwnedChromeProbe {
    if (record.quarantine) fail('chrome_instance_unknown', 'Unconfirmed Chrome ownership requires explicit resource/effect reconciliation; PID or elapsed time cannot release it.', 'unknown');
    const host = probe();
    if (!host.available) fail('chrome_setup_required', host.reason ?? 'Owned Chrome is not prepared.');
    return host;
  }
  function prepare(record: Record, origins: readonly string[], explicit: boolean): string {
    checkOrigins(origins);
    available(record);
    if (stopping.has(record.id) || (record.lease && (explicit || record.lease.state !== 'active'))) fail('chrome_instance_active', 'Chrome preparation cannot replace active or unconfirmed ownership.');
    if (!record.enabled) fail('chrome_instance_stopped', 'Start this Chrome environment before preparing it.');
    if (record.lease) {
      if (record.lease.workerId !== probe().workerId) { quarantine(record, 'The actual Chrome worker identity changed.'); fail('chrome_worker_changed', 'The actual Chrome worker identity changed.', 'unknown'); }
      record.lease.prepared = true;
    }
    record.prepared = true;
    save(record);
    // This is an owned device locator, not an external W3C endpoint to adopt.
    return `chrome:${record.id}`;
  }
  function execution(deviceId: string, cleanup = false): OwnedChromeExecution | null {
    assertOwner();
    const record = device(deviceId);
    const lease = record.lease;
    if (closing || !lease || lease.generation !== record.generation || (!cleanup && (record.quarantine || lease.state !== 'active' || stopping.has(record.id)))) return null;
    const host = probe();
    if (host.workerId !== lease.workerId) {
      quarantine(record, 'The actual Chrome worker identity changed while leased.');
      return null;
    }
    const bound = resources.get(record.id);
    if (!cleanup && bound) {
      try { bound.resource.assertHealthy(); }
      catch { quarantine(record, 'The owned native Chrome resource no longer confirms health.'); return null; }
    }
    return { runtime: 'owned-chrome', instanceId: record.id, machineId: null, workerId: lease.workerId, generation: lease.generation };
  }
  async function stop(record: Record, cancelActive: boolean): Promise<OwnedChromeInstanceView> {
    if (stopping.has(record.id)) fail('chrome_instance_busy', 'This Chrome resource is already stopping.');
    if (!record.lease) {
      record.enabled = false; record.prepared = false; save(record); return view(record);
    }
    if (!cancelActive) fail('chrome_instance_active', 'Explicit cancelActive is required to stop a leased Chrome instance.');
    stopping.add(record.id);
    try {
      const token = record.lease.token;
      if (options.cancelExecution) {
        try { await options.cancelExecution(record.lease.sessionId); }
        catch { quarantine(record, 'Execution cancellation is unconfirmed; only exact native resource cleanup may continue.'); }
      }
      assertOwner();
      if (record.lease?.token === token) {
        const bound = resources.get(record.id);
        if (!bound || bound.token !== token) {
          quarantine(record, 'The exact owned native Chrome resource is unavailable for confirmed stop.');
          fail('chrome_stop_unknown', 'No exact native browser handle exists; no process or personal browser will be adopted.', 'unknown');
        }
        try { await bound.resource.stop(); }
        catch { quarantine(record, 'The exact owned Chrome native stop was not confirmed.'); fail('chrome_stop_unknown', 'The exact owned Chrome native stop was not confirmed.', 'unknown'); }
        assertOwner();
        if (record.lease?.token !== token) fail('chrome_lease_changed', 'Chrome ownership changed during native stop.', 'unknown');
        record.lastIdentity = record.lease.identity;
        record.lease = null;
        resources.delete(record.id);
      }
      record.enabled = false; record.prepared = false; save(record);
      stopping.delete(record.id);
      return view(record);
    } finally { stopping.delete(record.id); }
  }
  function tracked<T>(work: () => Promise<T>): Promise<T> {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const promise = work(); inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  }

  async function reconcile(): Promise<InstanceRecoverySummary> {
    const result: InstanceRecoverySummary = { recovered: [], blocked: [] };
    for (const record of records.values()) {
      if (!record.lease || (!record.quarantine && record.lease.state !== 'unknown')) continue;
      const token = record.lease.token, generation = record.generation;
      try {
        assertOpen();
        if (stopping.has(record.id)) fail('chrome_cleanup_in_progress', 'Exact Chrome cleanup is still in progress.', 'unknown');
        const locator = record.lease.nativeOwner;
        if (!locator || !options.admissionDirectory) fail('chrome_recovery_origin_missing', 'The original native and admission origins are unavailable.', 'unknown');
        const recovery = options.nativeRecovery;
        if (!recovery) fail('chrome_recovery_unavailable', 'The trusted native recovery adapter is not connected.', 'unknown');
        const nativeScope = recovery.scope(locator), execution = nativeScope.execution, instance = nativeScope.instance;
        if (!execution || !instance || nativeScope.projectRoot !== root || nativeScope.deviceId !== `chrome:${record.id}` || instance.instanceId !== record.id || instance.generation !== generation || instance.workerId !== record.lease.workerId) fail('chrome_recovery_scope_mismatch', 'The original Chrome generation does not match this lease.', 'unknown');
        const authorization = readExecutionRecoveryAuthorization(options.admissionDirectory, execution.generation);
        const source = authorization?.scope.recoverySources.find(source => source.id === locator.ownerId);
        if (!authorization || !source || authorization.scope.ownerId !== execution.ownerId) fail('chrome_recovery_not_authorized', 'Native stop alone cannot authorize resource reuse.', 'unknown');
        const binding = recovery.read(options.admissionDirectory, source, authorization.scope);
        if (JSON.stringify(binding.native) !== JSON.stringify(locator)) fail('chrome_recovery_scope_mismatch', 'The authorized native origin differs from this lease.', 'unknown');
        const native = await recovery.observe(locator);
        assertOpen();
        if (record.lease?.token !== token || record.generation !== generation) fail('chrome_lease_changed', 'Chrome ownership changed during recovery verification.', 'unknown');
        if (native.phase !== 'closed' || !native.evidenceFinalized || !native.evidenceSha256 || (record.lease.identity && (native.endpoint?.profile !== record.lease.identity.profile || native.browserSessionId !== record.lease.identity.browserSessionId))) fail('chrome_stop_unknown', 'The exact original native resource and evidence remain unconfirmed.', 'unknown');
        record.lastIdentity = record.lease.identity;
        record.lease = null; record.quarantine = null; record.prepared = false;
        save(record);
        resources.delete(record.id);
        result.recovered.push(record.id);
      } catch (error) {
        result.blocked.push({ instanceId: record.id, code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'chrome_recovery_unverified' });
      }
    }
    return result;
  }

  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'manager.lock' && entry.isFile()) continue;
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp') && entry.isFile()) { privateRead(join(directory, entry.name)); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) fail('chrome_storage_unsafe', 'Unexpected entries exist in owned Chrome storage.');
      const path = join(directory, entry.name);
      const text = privateRead(path);
      const record = RecordSchema.parse(JSON.parse(text));
      if (record.projectRoot !== root || record.id !== record.id.toLowerCase() || entry.name !== `${record.id}.json` || record.profileId !== record.request.profileId
        || (record.lease && (record.lease.generation !== record.generation || (record.lease.identity && (record.lease.identity.instanceId !== record.id || record.lease.identity.generation !== record.generation || record.lease.identity.workerId !== record.lease.workerId))))) fail('chrome_storage_unsafe', 'A durable Chrome record has mismatched ownership or identity.');
      records.set(record.id, record); written.set(path, text);
      if (record.lease) quarantine(record, 'A previous engine left active or unknown Chrome ownership. Exact native and effect reconciliation is required; it will not be replayed or adopted.');
      else if (record.prepared) { record.prepared = false; save(record); }
    }
  } catch (error) { owner.release(); throw error; }

  return {
    owns: id => { assertOwner(); return records.has(id.toLowerCase()); },
    call: input => tracked(async () => {
      const request = InstanceRequestSchema.parse(input);
      if (request.method === 'instance.list') {
        const host = probe();
        return { instances: [...records.values()].map(view), capability: { runtime: 'owned-chrome', platform: 'desktop-chrome', available: host.available,
          reason: host.reason, readiness: host.available ? 'adapter-available' : 'unavailable',
          preparation: 'metadata-only', capture: 'page', recordingReady: false, hostGlobalInput: false } satisfies InstanceRuntimeCapability };
      }
      if (request.method === 'instance.create') {
        const id = request.requestId.toLowerCase();
        if (request.resources) fail('chrome_vm_resources_invalid', 'Owned Chrome has no VM CPU, memory or disk allocation; choose an explicit macOS guest profile for VM resources.');
        const parameters = { profileId: request.profileId.toLowerCase(), name: request.name ?? null };
        const previous = records.get(id);
        if (previous) {
          if (JSON.stringify(previous.request) !== JSON.stringify(parameters)) fail('chrome_create_conflict', 'This creation UUID already belongs to different Chrome parameters.');
          return view(previous);
        }
        const profiles = options.profiles().filter(profile => profile.id.toLowerCase() === parameters.profileId);
        const profile = profiles[0];
        if (profiles.length !== 1 || !profile || profile.platform !== 'desktop-chrome' || profile.runtime === 'macos-guest') fail('chrome_profile_not_found', 'Select one trusted owned Chrome environment profile.');
        const name = (request.name ?? profile.name).trim();
        if (!name || name.length > 80) fail('chrome_name_invalid', 'A Chrome instance name must contain 1–80 characters.');
        const record: Record = { schema: 'qautra/owned-chrome-instance/v1', projectRoot: root, id, profileId: parameters.profileId, name,
          createdAt: new Date().toISOString(), generation: 1, request: parameters, prepared: false, enabled: true, quarantine: null, lease: null, lastIdentity: null, usedProfiles: [], usedSessions: [] };
        records.set(id, record); save(record); return view(record);
      }
      const record = get(request.instanceId);
      if (request.method === 'instance.status' || request.method === 'instance.show' || request.method === 'instance.hide') return view(record);
      if (request.method === 'instance.stop') return await stop(record, request.cancelActive);
      if (request.method === 'instance.start') {
        available(record);
        if (stopping.has(record.id)) fail('chrome_instance_active', 'The Chrome instance is still stopping.');
        if (record.enabled) return view(record);
        record.enabled = true; save(record); return view(record);
      }
      prepare(record, [], true); return view(record);
    }),
    devices: () => tracked(async () => [...records.values()].map(toDevice)),
    pick: deviceId => tracked(async () => {
      const candidates = deviceId ? [device(deviceId)] : [...records.values()].filter(record => toDevice(record).state === 'booted' && !record.lease);
      const record = candidates[0];
      if (!record || candidates.length !== 1 || record.lease || toDevice(record).state !== 'booted') fail('chrome_device_unavailable', 'Select one explicit prepared, idle owned Chrome instance.');
      return toDevice(record);
    }),
    acquire(deviceId, runId, sessionId, leaseOwner = 'direct') {
      assertOpen();
      const record = device(deviceId);
      const host = available(record);
      if (!ID.safeParse(sessionId).success || (leaseOwner !== 'screen' && !runId) || (runId !== null && (!runId || runId.length > 240))) fail('chrome_lease_invalid', 'A real execution UUID and run ID are required.');
      if (record.lease || stopping.has(record.id)) fail('chrome_instance_active', 'This Chrome instance already has exact execution ownership.');
      if ([...records.values()].filter(other => other.lease).length >= maximumActiveContexts) fail('chrome_capacity', 'The trusted Chrome resource budget is held, including unconfirmed ownership; metadata instances do not reserve a browser.');
      if (!record.prepared || !record.enabled) fail('chrome_not_ready', 'Prepare this Chrome environment before acquiring it.');
      record.generation = increment(record.generation);
      const lease: z.infer<typeof Lease> = { token: randomUUID(), sessionId: sessionId.toLowerCase(), runId, owner: leaseOwner,
        generation: record.generation, workerId: host.workerId, state: 'active', prepared: false, identity: null, nativeOwner: null };
      record.lease = lease; save(record);
      const exact = (): boolean => record.lease?.token === lease.token && record.generation === lease.generation;
      return {
        ended() {
          assertOwner();
          if (!exact()) return;
          if (record.quarantine || record.lease?.state === 'unknown') fail('chrome_lease_unknown', 'Native closure cannot clear unknown effects or the durable quarantine.', 'unknown');
          record.lastIdentity = record.lease?.identity ?? null;
          record.lease = null; resources.delete(record.id); save(record);
        },
        unknown(reason) {
          assertOwner();
          if (!exact()) return;
          const code = reason && /^[a-z][a-z0-9_:-]{0,127}$/.test(reason) ? ` (${reason})` : '';
          quarantine(record, `This exact Chrome lease has an unknown outcome${code}; native closure alone does not clear effect quarantine.`);
        },
      };
    },
    prepare: (deviceId, origins) => tracked(async () => prepare(device(deviceId), origins, false)),
    execution,
    bind(deviceId, resource) {
      assertOpen();
      const record = device(deviceId);
      const lease = record.lease;
      const identity = OwnedChromeIdentity.parse(resource.identity);
      if (!lease || !lease.prepared || lease.state !== 'active' || record.quarantine || stopping.has(record.id)) fail('chrome_bind_unavailable', 'Prepare the exact active QA lease before binding its native Chrome resource.');
      if (identity.instanceId !== record.id || identity.generation !== lease.generation || identity.workerId !== lease.workerId || !isAbsolute(identity.profile)) fail('chrome_identity_mismatch', 'The actual Chrome resource must match the exact instance, worker and ownership generation.');
      const previous = resources.get(record.id);
      if (previous) {
        if (previous.resource === resource && previous.token === lease.token) return;
        quarantine(record, 'A second native browser attempted to replace an owned Chrome lease.');
        fail('chrome_resource_conflict', 'An active Chrome lease cannot adopt another native resource.', 'unknown');
      }
      for (const other of records.values()) {
        if (other.usedProfiles.includes(identity.profile) || (identity.browserSessionId !== null && other.usedSessions.includes(identity.browserSessionId))) fail('chrome_storage_reused', 'A new Chrome attempt must use a fresh native session and fresh storage profile.');
      }
      resource.assertHealthy();
      lease.identity = identity;
      record.usedProfiles.push(identity.profile);
      if (identity.browserSessionId !== null) record.usedSessions.push(identity.browserSessionId);
      resources.set(record.id, { token: lease.token, resource }); save(record);
    },
    bindNativeOwner(deviceId, input) {
      assertOpen();
      const record = device(deviceId), lease = record.lease, locator = ChromeOwnerLocatorSchema.parse(input);
      if (!lease || !lease.prepared || lease.state !== 'active' || record.quarantine || stopping.has(record.id)) fail('chrome_bind_unavailable', 'The exact active Chrome lease must be prepared before native launch.');
      if (!options.nativeRecovery) fail('chrome_recovery_unavailable', 'The trusted native recovery adapter is not connected.');
      const nativeScope = options.nativeRecovery.scope(locator), instance = nativeScope.instance;
      if (!instance || nativeScope.projectRoot !== root || nativeScope.deviceId !== deviceId || instance.instanceId !== record.id || instance.generation !== lease.generation || instance.workerId !== lease.workerId) fail('chrome_identity_mismatch', 'The native launch origin must match the exact instance generation.');
      if (lease.nativeOwner && JSON.stringify(lease.nativeOwner) !== JSON.stringify(locator)) { quarantine(record, 'Another native launch attempted to replace the original resource.'); fail('chrome_resource_conflict', 'An original native owner cannot be replaced.', 'unknown'); }
      lease.nativeOwner = locator; save(record);
    },
    reconcile: () => tracked(reconcile),
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = (async () => {
        const failures: unknown[] = [];
        try {
          const operations = await Promise.allSettled([...inFlight]);
          for (const operation of operations) if (operation.status === 'rejected') failures.push(operation.reason);
          for (const record of records.values()) if (record.lease) {
            try { await stop(record, true); }
            catch (error) {
              try { quarantine(record, 'Engine shutdown did not confirm exact owned Chrome cleanup.'); } catch (persistError) { failures.push(persistError); }
              failures.push(error);
            }
          }
        } finally { owner.release(); }
        if (failures.length) throw new AggregateError(failures, 'Owned Chrome shutdown retains unconfirmed ownership; no backend cleanup is inferred.');
      })();
      return shutdownPromise;
    },
  };
}
