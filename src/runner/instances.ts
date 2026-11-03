import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { writeAtomic } from '../core/fsx.ts';
import { GuestPlatform, InstanceExecutionError, InstanceRequestSchema, InstanceResources, NativeMachineView, type GuestInstanceView, type GuestMachineBackend, type GuestMachineConnection, type InstanceHostCapabilities, type GuestInstanceList, type InstanceProfile, type InstanceRequest } from '../core/instances.ts';
import { acquireFileLock } from '../core/lock.ts';
import type { DeviceInfo } from '../core/types.ts';

export interface InstanceLease {
  /** Call only after exact native resource closure is confirmed; unknown effects remain fenced. */
  ended(): void;
  unknown(reason?: string): void;
}
export interface GuestExecution {
  runtime: 'macos-guest';
  instanceId: string;
  machineId: string;
  workerId: string;
  generation: number;
}

export interface GuestInstances {
  owns(instanceId: string): boolean;
  hasInstances(): boolean;
  call(request: InstanceRequest): Promise<GuestInstanceList | GuestInstanceView>;
  devices(platform?: GuestPlatform): Promise<DeviceInfo[]>;
  pick(platform: GuestPlatform, deviceId?: string): Promise<DeviceInfo>;
  acquire(deviceId: string, runId: string | null, sessionId: string, owner?: 'direct' | 'run' | 'screen'): InstanceLease;
  prepare(deviceId: string, origins: readonly string[]): Promise<string>;
  execution(deviceId: string, cleanup?: boolean): GuestExecution | null;
  shutdown(): Promise<void>;
}

const ID = z.uuid();
const Positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Binding = z.strictObject({ generation: Positive, epoch: Positive, guestPid: Positive });
const Lease = z.strictObject({
  token: ID, sessionId: ID, runId: z.string().min(1).max(240).nullable(), owner: z.enum(['direct', 'run', 'screen']), generation: Positive,
  epoch: Positive, guestPid: Positive, state: z.enum(['active', 'closed', 'unknown']), prepared: z.boolean(),
});
const Machine = z.strictObject({
  schema: z.literal('qautra/instance-machine/v1'), projectRoot: z.string(), id: ID, name: z.string().min(1).max(80),
  platform: GuestPlatform, resources: InstanceResources, createdAt: z.iso.datetime(),
  creation: z.enum(['pending', 'created', 'rejected']), native: NativeMachineView.nullable(),
  pending: z.enum(['create', 'start', 'stop']).nullable(), quarantine: z.string().nullable(),
});
const Context = z.strictObject({
  schema: z.literal('qautra/instance-context/v1'), projectRoot: z.string(), id: ID, profileId: ID,
  name: z.string().min(1).max(80), platform: GuestPlatform, machineId: ID, generation: Positive,
  createdAt: z.iso.datetime(), request: z.strictObject({ profileId: ID, name: z.string().nullable(), resources: InstanceResources.nullable() }),
  binding: Binding.nullable(), verified: z.boolean(), pendingPrepare: z.boolean(), lease: Lease.nullable(),
  osVersion: z.string().nullable(), browserVersion: z.string().nullable(), reason: z.string().nullable(),
  ports: z.array(z.number().int().min(1).max(65535)),
});
const Connection = z.strictObject({ machineId: ID, epoch: Positive, guestPid: Positive, osVersion: z.string().min(1).max(256), connected: z.boolean() });
const Capabilities = z.strictObject({
  supported: z.boolean(), reason: z.string().nullable(), minimumCPUCount: Positive, minimumMemoryMiB: Positive,
  physicalMemoryMiB: Positive, logicalCPUCount: Positive, maximumMachines: z.number().int().nonnegative(),
  availableMemoryMiB: z.number().int().nonnegative(),
});
const BrowserProbe = z.strictObject({ browserVersion: z.string().trim().min(1).max(128), osVersion: z.string().min(1).max(256) });
const GuestStatus = z.object({
  instanceId: ID, epoch: Positive, connected: z.boolean(), quarantined: z.boolean(),
  browser: z.object({ quarantined: z.boolean(), revoked: z.boolean(), contexts: z.array(z.object({
    contextId: ID, sessionId: z.string().nullable(), driverRunning: z.boolean(), commandInFlight: z.boolean(),
  })) }),
});
type MachineRecord = z.infer<typeof Machine>;
type ContextRecord = z.infer<typeof Context>;

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
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    fail('guest_storage_unsafe', 'Guest storage must be a private, owned directory without symbolic links.');
  }
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      fail('guest_storage_unsafe', 'Guest ownership records must be private regular files owned by this user.');
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function increment(value: number): number {
  if (!Number.isSafeInteger(value + 1)) fail('guest_generation_exhausted', 'Guest generation cannot be advanced safely.');
  return value + 1;
}
function originPorts(origins: readonly string[]): number[] {
  const ports = new Set<number>();
  for (const origin of origins) {
    if (origin !== origin.trim() || /[\\?#]/.test(origin)) fail('guest_origin_invalid', 'An approved origin must not contain a path, credentials, query, or fragment.');
    let url: URL;
    try { url = new URL(origin); } catch { fail('guest_origin_invalid', 'An approved origin must be an absolute HTTP or HTTPS origin.'); }
    const authority = /^https?:\/\/([^/]+)\/?$/i.exec(origin)?.[1];
    if (!authority || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      fail('guest_origin_invalid', 'An approved origin must not contain a path, credentials, query, or fragment.');
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (loopback) {
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(authority)) fail('guest_origin_invalid', 'Only literal localhost, 127.0.0.1, and [::1] loopback origins can be forwarded.');
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('guest_origin_invalid', 'An approved loopback port is outside the TCP port range.');
      ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export function createGuestInstances(options: {
  root: string;
  backend: GuestMachineBackend;
  profiles: () => readonly InstanceProfile[];
  cancelExecution?: (executionId: string) => Promise<void>;
}): GuestInstances {
  const root = resolve(options.root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || realpathSync(root) !== root) {
    fail('guest_storage_unsafe', 'The project root must be an owned real directory.');
  }
  const qa = join(root, '.qa');
  const directory = join(qa, 'instances');
  const contextsDirectory = join(directory, 'contexts');
  const machinesDirectory = join(contextsDirectory, 'machines');
  for (const path of [qa, directory, contextsDirectory, machinesDirectory]) privateDirectory(path);
  const owner = acquireFileLock(join(contextsDirectory, 'manager.lock'), { purpose: 'Guest 인스턴스 관리자' });
  const contexts = new Map<string, ContextRecord>();
  const machines = new Map<string, MachineRecord>();
  const written = new Map<string, string>();
  const observed = new Set<string>();
  const busy = new Set<string>();
  const revocations = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  let foreignMachines = false;
  let creating = false;
  let closing = false;
  let storageFailed = false;
  let shutdownPromise: Promise<void> | null = null;

  function assertOwner(): void {
    if (storageFailed) fail('guest_storage_unconfirmed', 'Guest ownership could not be persisted; execution is fenced.', 'unknown');
    try {
      const record: unknown = JSON.parse(privateRead(owner.path));
      if (!record || typeof record !== 'object' || !('token' in record) || record.token !== owner.record.token) throw new Error('owner_changed');
    } catch {
      storageFailed = true;
      fail('guest_owner_changed', 'The guest manager ownership lock is no longer this process\'s lock.', 'unknown');
    }
  }
  function assertOpen(effect: 'not_started' | 'unknown' = 'not_started'): void {
    assertOwner();
    if (closing) fail('guest_engine_stopping', 'The guest manager is shutting down.', effect);
  }
  function persist(path: string, value: unknown): void {
    assertOwner();
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (written.get(path) === text) return;
    try { writeAtomic(path, text); written.set(path, text); }
    catch { storageFailed = true; fail('guest_storage_unconfirmed', 'Guest ownership could not be persisted; execution is fenced.', 'unknown'); }
  }
  const saveContext = (context: ContextRecord): void => persist(join(contextsDirectory, `${context.id}.json`), context);
  const saveMachine = (machine: MachineRecord): void => persist(join(machinesDirectory, `${machine.id}.json`), machine);
  const residents = (machineId: string): ContextRecord[] => [...contexts.values()].filter(context => context.machineId === machineId);
  function connection(machine: MachineRecord): GuestMachineConnection | null {
    const result = Connection.safeParse(options.backend.connection(machine.id));
    return result.success && result.data.connected && result.data.machineId === machine.id ? result.data : null;
  }
  function matchingConnection(context: ContextRecord, machine: MachineRecord): GuestMachineConnection | null {
    const current = connection(machine);
    return current && context.binding && current.epoch === context.binding.epoch && current.guestPid === context.binding.guestPid && context.generation === context.binding.generation ? current : null;
  }
  function revoke(context: ContextRecord): void {
    if (!context.binding) return;
    const key = `${context.id}:${context.binding.generation}`;
    if (revocations.has(key)) return;
    const work = Promise.resolve().then(() => options.backend.revokeBrowser(context.id));
    revocations.set(key, work);
    void work.catch(() => undefined);
  }
  function quarantine(machine: MachineRecord, reason: string, revokeBindings = true): void {
    const newlyFenced = machine.quarantine === null;
    machine.quarantine ??= reason;
    saveMachine(machine);
    for (const context of residents(machine.id)) {
      if (newlyFenced) context.generation = increment(context.generation);
      context.verified = false;
      context.reason = machine.quarantine;
      if (context.lease?.state === 'active') context.lease.state = 'unknown';
      saveContext(context);
      if (revokeBindings) revoke(context);
    }
  }
  function confirmedStopped(machine: MachineRecord): void {
    for (const context of residents(machine.id)) {
      if (context.binding || context.lease || context.pendingPrepare) context.generation = increment(context.generation);
      context.binding = null; context.lease = null; context.pendingPrepare = false; context.verified = false;
      context.ports = []; context.reason = null;
      saveContext(context);
    }
    machine.pending = null; machine.quarantine = null;
    saveMachine(machine);
  }
  function acceptNative(machine: MachineRecord, input: unknown): NativeMachineView {
    const result = NativeMachineView.safeParse(input);
    if (!result.success || result.data.id !== machine.id || result.data.platform !== machine.platform || result.data.name !== machine.name
      || result.data.cpuCount !== machine.resources.cpuCount || result.data.memoryMiB !== machine.resources.memoryMiB || result.data.diskGiB !== machine.resources.diskGiB
      || machine.creation === 'rejected') {
      quarantine(machine, 'The native VM identity does not match its durable ownership record.');
      fail('guest_machine_identity', 'The native VM identity does not match its durable ownership record.', 'unknown');
    }
    machine.native = result.data;
    machine.creation = 'created';
    observed.add(machine.id);
    if (machine.pending === 'create') { machine.pending = null; machine.quarantine = null; }
    if (result.data.state === 'stopped') confirmedStopped(machine);
    else {
      saveMachine(machine);
      if (result.data.state === 'unknown') quarantine(machine, 'The native VM reports an unknown outcome.');
    }
    return result.data;
  }
  function getContext(id: string): ContextRecord {
    const parsed = ID.safeParse(id);
    if (!parsed.success) fail('guest_instance_invalid', 'A guest context UUID is required.');
    const context = contexts.get(parsed.data.toLowerCase());
    if (!context) fail('guest_instance_not_found', 'The requested browser context is not owned by this project.');
    return context;
  }
  function deviceContext(deviceId: string): ContextRecord {
    if (!deviceId.startsWith('guest:')) fail('guest_device_required', 'An explicit guest:<context UUID> device is required; host browsers are not a fallback.');
    return getContext(deviceId.slice(6));
  }
  function machineFor(context: ContextRecord): MachineRecord {
    const machine = machines.get(context.machineId);
    if (!machine) fail('guest_machine_not_owned', 'The browser context has no durable owned VM record.');
    return machine;
  }
  function view(context: ContextRecord): GuestInstanceView {
    const machine = machineFor(context);
    const native = observed.has(machine.id) ? machine.native : null;
    const current = connection(machine);
    let state: GuestInstanceView['state'];
    if (machine.quarantine) state = 'unknown';
    else if (machine.creation === 'rejected') state = 'error';
    else if (context.pendingPrepare) state = 'preparing';
    else if (!native || native.state === 'unknown') state = 'unknown';
    else if (machine.pending === 'stop' || context.lease?.state === 'closed' || native.state === 'stopping') state = 'stopping';
    else if (native.state === 'error') state = 'error';
    else if (native.state === 'stopped') state = 'stopped';
    else if (native.state === 'preparing' || native.state === 'installing' || native.state === 'starting') state = 'preparing';
    else if (native.state === 'running' && context.verified && matchingConnection(context, machine)) state = context.lease?.state === 'active' ? 'running' : 'ready';
    else state = 'setup-required';
    return {
      id: context.id, profileId: context.profileId, name: context.name, platform: context.platform, runtime: 'macos-guest', machineId: machine.id,
      generation: context.generation, state, nativeState: native?.state ?? 'unknown', progress: native?.progress ?? null,
      ...machine.resources, osVersion: current?.osVersion ?? context.osVersion, browserVersion: context.browserVersion,
      requestedResources: context.request.resources,
      activeSessionId: context.lease?.owner === 'direct' ? context.lease.sessionId : null,
      activeRunId: context.lease?.runId ?? null, createdAt: context.createdAt,
      reason: machine.quarantine ?? context.reason ?? native?.error ?? (state === 'setup-required' ? 'Complete setup inside this guest, then explicitly prepare its browser.' : null),
      hostGlobalInput: false, isolation: context.platform === 'desktop-chrome' ? 'guest-browser-session' : 'guest-desktop',
      frameAvailable: false, recordingReady: false,
    };
  }
  function toDevice(context: ContextRecord): DeviceInfo {
    const current = view(context);
    return {
      platform: context.platform, id: `guest:${context.id}`, name: context.name, osVersion: current.osVersion ?? '', kind: 'browser',
      state: current.state === 'ready' || current.state === 'running' ? 'booted' : current.nativeState === 'stopped' || current.nativeState === 'installed' ? 'shutdown' : 'offline',
    };
  }
  async function refresh(): Promise<void> {
    assertOwner();
    let native: NativeMachineView[];
    try { native = z.array(NativeMachineView).parse(await options.backend.list()); }
    catch {
      for (const machine of machines.values()) if (residents(machine.id).some(context => context.binding || context.lease || context.pendingPrepare)) quarantine(machine, 'The owned native VM status could not be confirmed.');
      fail('guest_status_unavailable', 'The owned native VM status could not be confirmed.');
    }
    assertOwner();
    const ids = new Set<string>();
    for (const item of native) {
      if (ids.has(item.id)) fail('guest_machine_identity', 'The native VM list contains duplicate machine identities.', 'unknown');
      ids.add(item.id);
    }
    foreignMachines = native.some(item => !machines.has(item.id));
    for (const machine of machines.values()) {
      const item = native.find(candidate => candidate.id === machine.id);
      if (!item) {
        observed.delete(machine.id);
        if (machine.creation !== 'rejected') quarantine(machine, 'The durable owned VM is absent from the native owner; it will not be recreated or adopted automatically.');
        continue;
      }
      acceptNative(machine, item);
      if (machine.native?.state !== 'running' || machine.quarantine) continue;
      const bound = residents(machine.id).filter(context => context.binding);
      if (!bound.length) continue;
      const current = connection(machine);
      if (!current || bound.some(context => !matchingConnection(context, machine))) {
        quarantine(machine, 'The guest connection or boot identity changed; stop the VM before preparing again.');
        continue;
      }
      try {
        const reply = await options.backend.request(machine.id, { version: 1, id: randomUUID(), epoch: current.epoch, deadlineAt: Date.now() + 5000, operation: 'status', payload: {} });
        assertOwner();
        if (!reply.ok) throw new Error('guest_status_rejected');
        const status = GuestStatus.parse(reply.result);
        if (status.instanceId !== machine.id || status.epoch !== current.epoch || !status.connected || status.quarantined || status.browser.quarantined || status.browser.revoked
          || connection(machine)?.guestPid !== current.guestPid || connection(machine)?.epoch !== current.epoch) throw new Error('guest_status_identity');
        const seen = new Set<string>();
        for (const browser of status.browser.contexts) {
          const context = contexts.get(browser.contextId);
          if (seen.has(browser.contextId) || !context || context.machineId !== machine.id || (browser.sessionId !== null && !context.lease && !context.pendingPrepare)) throw new Error('unleased_browser');
          seen.add(browser.contextId);
        }
      } catch {
        quarantine(machine, 'The guest browser ownership status could not be confirmed.');
      }
    }
  }
  function hostLimit(capabilities: InstanceHostCapabilities): InstanceHostCapabilities {
    const cpuBudget = Math.max(0, capabilities.logicalCPUCount - 2);
    const memoryBudget = Math.max(0, capabilities.physicalMemoryMiB - Math.max(2048, Math.ceil(capabilities.physicalMemoryMiB / 4)));
    return { ...capabilities, maximumMachines: capabilities.supported ? Math.max(0, Math.min(2, capabilities.maximumMachines,
      Math.floor(cpuBudget / Math.max(2, capabilities.minimumCPUCount)), Math.floor(memoryBudget / Math.max(4096, capabilities.minimumMemoryMiB)))) : 0 };
  }
  async function capabilities(): Promise<InstanceHostCapabilities> {
    const result = Capabilities.safeParse(await options.backend.probe());
    assertOwner();
    if (!result.success) fail('guest_probe_invalid', 'The host resource probe did not return valid actual capabilities.');
    return hostLimit(result.data);
  }
  function reserveResources(resources: z.infer<typeof InstanceResources>, capabilities: InstanceHostCapabilities): void {
    if (!capabilities.supported) fail('guest_host_unsupported', capabilities.reason ?? 'This host does not support owned macOS guests.');
    const allocated = [...machines.values()].filter(machine => machine.creation !== 'rejected');
    if (foreignMachines || allocated.length >= capabilities.maximumMachines) fail('guest_capacity', 'The conservative owned-VM limit is reached, or an unowned native VM requires reconciliation.');
    const cpuBudget = Math.max(0, capabilities.logicalCPUCount - 2);
    const reserveMiB = Math.max(2048, Math.ceil(capabilities.physicalMemoryMiB / 4));
    const memoryBudget = Math.max(0, capabilities.physicalMemoryMiB - reserveMiB);
    const disk = statfsSync(directory);
    const availableGiB = disk.bavail * disk.bsize / 1024 ** 3;
    if (allocated.reduce((sum, machine) => sum + machine.resources.cpuCount, resources.cpuCount) > cpuBudget
      || allocated.reduce((sum, machine) => sum + machine.resources.memoryMiB, resources.memoryMiB) > memoryBudget
      || resources.memoryMiB + reserveMiB > capabilities.availableMemoryMiB
      || allocated.reduce((sum, machine) => sum + machine.resources.diskGiB, resources.diskGiB) + 16 > availableGiB) {
      fail('guest_resource_budget', 'Available host CPU, memory, or disk cannot safely accommodate another physical VM.');
    }
  }
  async function waitFor(machine: MachineRecord, target: 'running' | 'stopped'): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (true) {
      await refresh();
      assertOpen('unknown');
      if (machine.native?.state === target && observed.has(machine.id)) return;
      if (machine.native?.state === 'error' || machine.native?.state === 'unknown' || Date.now() >= deadline) {
        quarantine(machine, 'The requested native VM transition was not confirmed; it will not be retried.');
        fail('guest_transition_unknown', 'The requested native VM transition was not confirmed; it will not be retried.', 'unknown');
      }
      await delay(250);
    }
  }
  async function create(request: Extract<InstanceRequest, { method: 'instance.create' }>): Promise<GuestInstanceView> {
    if (creating) fail('guest_creation_busy', 'Another instance creation owns the resource reservation.');
    creating = true;
    try {
      const id = request.requestId.toLowerCase();
      const parameters = { profileId: request.profileId.toLowerCase(), name: request.name ?? null, resources: request.resources ?? null };
      const previous = contexts.get(id);
      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(parameters)) fail('guest_create_conflict', 'This request UUID already belongs to different instance creation parameters.');
        await refresh();
        return view(previous);
      }
      if (machines.has(id)) fail('guest_id_conflict', 'A browser context UUID must be distinct from every physical VM UUID.');
      const profiles = options.profiles().filter(profile => profile.id.toLowerCase() === parameters.profileId);
      const profile = profiles[0];
      if (profiles.length !== 1 || !profile || !GuestPlatform.safeParse(profile.platform).success) fail('guest_profile_not_found', 'A single trusted desktop-browser profile is required.');
      const platform = profile.platform;
      const name = (request.name ?? profile.name).trim();
      if (!name || name.length > 80) fail('guest_name_invalid', 'An instance name must contain 1–80 characters.');
      await refresh();
      const host = await capabilities();
      assertOpen();
      if (!host.supported) fail('guest_host_unsupported', host.reason ?? 'This host does not support owned macOS guests.');
      const resources = InstanceResources.parse(request.resources ?? { cpuCount: Math.max(2, host.minimumCPUCount), memoryMiB: Math.max(4096, host.minimumMemoryMiB), diskGiB: 64 });
      if (resources.cpuCount < host.minimumCPUCount || resources.memoryMiB < host.minimumMemoryMiB) fail('guest_resources_below_minimum', 'The requested VM resources are below the actual compatible restore image minimum.');
      let machine = platform === 'desktop-chrome' ? [...machines.values()].find(candidate => candidate.platform === 'desktop-chrome'
        && candidate.creation === 'created' && candidate.native?.state === 'running' && observed.has(candidate.id) && !candidate.quarantine && !candidate.pending && !busy.has(candidate.id)
        && candidate.resources.cpuCount >= resources.cpuCount && candidate.resources.memoryMiB >= resources.memoryMiB && candidate.resources.diskGiB >= resources.diskGiB
        && residents(candidate.id).length < 8 && residents(candidate.id).every(context => context.profileId === parameters.profileId)
        && residents(candidate.id).some(context => context.verified && !context.pendingPrepare && matchingConnection(context, candidate))) : undefined;
      const allocating = !machine;
      if (!machine) {
        reserveResources(resources, host);
        let machineId = randomUUID();
        while (machineId === id || machines.has(machineId) || contexts.has(machineId)) machineId = randomUUID();
        machine = { schema: 'qautra/instance-machine/v1', projectRoot: root, id: machineId, name, platform, resources,
          createdAt: new Date().toISOString(), creation: 'pending', native: null, pending: 'create', quarantine: null };
        machines.set(machine.id, machine);
        saveMachine(machine);
      }
      const context: ContextRecord = {
        schema: 'qautra/instance-context/v1', projectRoot: root, id, profileId: parameters.profileId, name, platform,
        machineId: machine.id, generation: 1, createdAt: new Date().toISOString(), request: parameters, binding: null, verified: false,
        pendingPrepare: false, lease: null, osVersion: null, browserVersion: null, reason: null, ports: [],
      };
      contexts.set(id, context); saveContext(context);
      if (allocating) {
        busy.add(machine.id);
        try {
          const native = await options.backend.create(machine.id, machine.name, machine.platform, machine.resources);
          assertOpen('unknown');
          acceptNative(machine, native);
        } catch (error) {
          if (error instanceof InstanceExecutionError && error.effect === 'not_started') {
            machine.creation = 'rejected'; machine.pending = null;
            context.reason = 'The native owner rejected VM creation before it started.';
            saveMachine(machine); saveContext(context);
          } else quarantine(machine, 'VM creation has an unconfirmed outcome; the creation request will not be replayed.');
          throw error;
        } finally { busy.delete(machine.id); }
      }
      return view(context);
    } finally { creating = false; }
  }
  async function start(context: ContextRecord): Promise<GuestInstanceView> {
    const machine = machineFor(context);
    if (busy.has(machine.id)) fail('guest_machine_busy', 'Another operation owns this physical VM.');
    busy.add(machine.id);
    try {
      await refresh(); assertOpen();
      if (machine.quarantine) fail('guest_machine_unknown', 'Stop the quarantined VM before starting a fresh boot.', 'unknown');
      if (machine.native?.state === 'running') return view(context);
      if (machine.pending || residents(machine.id).some(resident => resident.lease || resident.pendingPrepare)) fail('guest_machine_busy', 'This physical VM still has active or unconfirmed ownership.');
      if (!observed.has(machine.id) || (machine.native?.state !== 'installed' && machine.native?.state !== 'stopped')) fail('guest_start_unavailable', 'Only an actually installed or stopped owned VM can start.');
      machine.pending = 'start'; saveMachine(machine);
      try {
        acceptNative(machine, await options.backend.start(machine.id));
        assertOpen('unknown');
        await waitFor(machine, 'running');
        machine.pending = null; saveMachine(machine);
        return view(context);
      } catch (error) {
        if (error instanceof InstanceExecutionError && error.effect === 'not_started') { machine.pending = null; saveMachine(machine); }
        else quarantine(machine, 'The VM boot outcome is unconfirmed; the start request will not be replayed.');
        throw error;
      }
    } finally { busy.delete(machine.id); }
  }
  async function stop(context: ContextRecord, cancelActive: boolean, force: boolean): Promise<GuestInstanceView> {
    const machine = machineFor(context);
    if (busy.has(machine.id)) fail('guest_machine_busy', 'Another operation owns this physical VM.');
    busy.add(machine.id);
    try {
      await refresh(); assertOpen();
      if (observed.has(machine.id) && machine.native?.state === 'stopped') return view(context);
      if (!observed.has(machine.id) || machine.creation !== 'created') fail('guest_stop_unavailable', 'The native owner has not confirmed this VM exists.');
      if (machine.native?.state === 'preparing' || machine.native?.state === 'installing') fail('guest_install_active', 'An active macOS installation cannot safely be interrupted.');
      const held = residents(machine.id).filter(resident => resident.lease);
      if (held.length && !cancelActive) fail('guest_instance_active', 'Stopping this VM affects every co-resident context; explicit cancelActive is required.');
      if (machine.quarantine && !force) fail('guest_machine_unknown', 'An unconfirmed VM requires explicit force poweroff, not a repeated graceful request.', 'unknown');
      if (held.some(resident => resident.lease?.state === 'active') && !options.cancelExecution && !force) fail('guest_cancel_unavailable', 'Active executions require the injected cancellation handler before graceful shutdown.');
      machine.pending = 'stop'; saveMachine(machine);
      try {
        for (const resident of held) {
          const lease = resident.lease;
          if (!lease || lease.state === 'closed') continue;
          if (options.cancelExecution) {
            try { await options.cancelExecution(lease.sessionId); }
            catch {
              quarantine(machine, 'A session cancellation did not confirm browser closure.');
              if (!force) fail('guest_cancel_unknown', 'Session cancellation did not confirm browser closure; explicit force poweroff is required.', 'unknown');
            }
          }
          assertOpen('unknown');
        }
        if (residents(machine.id).some(resident => resident.lease && resident.lease.state !== 'closed')) {
          if (!force) fail('guest_cancel_unknown', 'Session cancellation did not release every co-resident browser; explicit force poweroff is required.', 'unknown');
          quarantine(machine, 'Explicit poweroff is terminating active or unconfirmed guest ownership.');
        }
        acceptNative(machine, await options.backend.stop(machine.id, force));
        assertOpen('unknown');
        await waitFor(machine, 'stopped');
        return view(context);
      } catch (error) {
        if (error instanceof InstanceExecutionError && error.effect === 'not_started') { machine.pending = null; saveMachine(machine); }
        else quarantine(machine, 'The VM stop outcome is unconfirmed; active ownership is retained until native stopped confirmation.');
        throw error;
      }
    } finally { busy.delete(machine.id); }
  }
  async function prepare(context: ContextRecord, origins: readonly string[], explicit: boolean): Promise<string> {
    const ports = originPorts(origins);
    const machine = machineFor(context);
    if (busy.has(machine.id) || context.pendingPrepare) fail('guest_machine_busy', 'Another operation owns this physical VM.');
    busy.add(machine.id);
    try {
      await refresh(); assertOpen();
      if (machine.quarantine) fail('guest_machine_unknown', 'Stop the quarantined VM before preparing another browser.', 'unknown');
      if (machine.pending || machine.native?.state !== 'running' || !observed.has(machine.id)) fail('guest_setup_required', 'Start this owned VM and complete guest setup before preparing its browser.');
      if (context.lease && (explicit || context.lease.state !== 'active')) fail('guest_instance_active', 'This context already has active or unconfirmed session ownership.');
      const current = connection(machine);
      if (!current) fail('guest_setup_required', 'The actual guest agent is not connected; complete setup inside the guest.');
      if (context.binding && !matchingConnection(context, machine)) {
        quarantine(machine, 'The guest boot identity changed before browser preparation.');
        fail('guest_generation_changed', 'The guest boot identity changed before browser preparation.', 'unknown');
      }
      if (!context.binding) {
        context.generation = increment(context.generation);
        context.binding = { generation: context.generation, epoch: current.epoch, guestPid: current.guestPid };
      }
      context.pendingPrepare = true; context.verified = false; saveContext(context);
      const generation = context.generation;
      const check = (): void => {
        assertOpen('unknown');
        if (machine.quarantine || context.generation !== generation || !matchingConnection(context, machine)) fail('guest_generation_changed', 'Browser preparation lost its exact guest connection or generation.', 'unknown');
      };
      try {
        await options.backend.bindBrowser({ contextId: context.id, machineId: machine.id, generation, platform: context.platform }); check();
        await options.backend.grantRoutes(context.id, ports); check();
        const result = BrowserProbe.parse(await options.backend.verifyBrowser(context.id)); check();
        if (result.osVersion !== current.osVersion) fail('guest_os_identity', 'The browser probe does not match the actual guest hello OS version.', 'unknown');
        const endpoint = options.backend.endpoint(context.id, generation);
        context.osVersion = current.osVersion; context.browserVersion = result.browserVersion; context.ports = ports;
        context.pendingPrepare = false; context.verified = true; context.reason = null;
        if (context.lease) context.lease.prepared = true;
        saveContext(context);
        return endpoint;
      } catch (error) {
        if (error instanceof InstanceExecutionError && error.effect === 'not_started') {
          context.pendingPrepare = false; context.verified = false;
          context.reason = 'Guest browser preparation was rejected; review setup and permissions inside this guest.';
          saveContext(context);
        } else quarantine(machine, 'Browser preparation or its confirmed blank-session close has an unknown outcome.');
        throw error;
      }
    } finally { busy.delete(machine.id); }
  }
  function execution(deviceId: string, cleanup = false, acquiring = false): GuestExecution | null {
    assertOwner();
    if (closing) return null;
    const context = deviceContext(deviceId);
    const machine = machineFor(context);
    if (machine.quarantine || (machine.pending && !(cleanup && machine.pending === 'stop')) || !observed.has(machine.id) || machine.native?.state !== 'running' || !context.verified || context.pendingPrepare || !context.binding || (!acquiring && !context.lease)) return null;
    const current = matchingConnection(context, machine);
    if (!current) { quarantine(machine, 'The execution connection or boot identity is no longer confirmed.'); return null; }
    if (context.lease && (context.lease.state !== 'active' || context.lease.generation !== context.generation || context.lease.epoch !== current.epoch || context.lease.guestPid !== current.guestPid)) return null;
    return { runtime: 'macos-guest', instanceId: context.id, machineId: machine.id, workerId: `guest:${machine.id}:${current.guestPid}:${current.epoch}`, generation: context.generation };
  }
  function acquire(deviceId: string, runId: string | null, sessionId: string, owner: 'direct' | 'run' | 'screen' = 'direct'): InstanceLease {
    assertOpen();
    const context = deviceContext(deviceId);
    const machine = machineFor(context);
    if ((owner !== 'screen' && !runId) || (runId !== null && (!runId || runId.length > 240)) || !ID.safeParse(sessionId).success) fail('guest_lease_invalid', 'A real execution owner, run ID for QA runs, and unique execution UUID are required.');
    if (context.lease || context.pendingPrepare || busy.has(machine.id)) fail('guest_instance_active', 'The exact browser context already has session ownership or a pending operation.');
    if (!execution(deviceId, false, true)) fail('guest_not_ready', 'Explicit browser preparation and its confirmed close are required before acquiring a guest context.');
    const current = matchingConnection(context, machine);
    if (!current) fail('guest_connection_unavailable', 'The guest connection is unavailable.');
    context.generation = increment(context.generation);
    context.binding = { generation: context.generation, epoch: current.epoch, guestPid: current.guestPid };
    const lease: z.infer<typeof Lease> = { token: randomUUID(), sessionId: sessionId.toLowerCase(), runId, owner,
      generation: context.generation, epoch: current.epoch, guestPid: current.guestPid, state: 'active', prepared: false };
    context.lease = lease; saveContext(context);
    const exact = (): boolean => context.lease?.token === lease.token && context.lease.sessionId === lease.sessionId && context.lease.generation === lease.generation;
    return {
      ended(): void {
        assertOwner();
        if (!exact() || context.lease?.state === 'closed') return;
        if (machine.quarantine || context.generation !== lease.generation || context.lease?.state === 'unknown') fail('guest_lease_unknown', 'Unknown guest ownership can only be released after the native VM confirms stopped.', 'unknown');
        if (machine.pending === 'stop' || machine.native?.state === 'stopping') {
          context.lease!.state = 'closed'; saveContext(context); return;
        }
        if (!matchingConnection(context, machine)) {
          quarantine(machine, 'The session ended without a matching live guest connection.');
          fail('guest_lease_unknown', 'Session closure lost its exact guest identity.', 'unknown');
        }
        context.lease!.state = 'closed'; saveContext(context);
        const cleanup = Promise.resolve().then(async () => {
          if (!exact() || closing) return;
          try {
            await options.backend.revokeBrowser(context.id);
            assertOwner();
            if (!exact()) return;
            if (machine.quarantine || context.generation !== lease.generation || !matchingConnection(context, machine)) {
              quarantine(machine, 'Confirmed browser closure lost its route-cleanup or boot identity.');
              return;
            }
            context.ports = [];
            if (machine.pending !== 'stop' && machine.native?.state !== 'stopping') context.lease = null;
            saveContext(context);
          } catch (error) {
            if (exact()) quarantine(machine, 'Browser closure was confirmed, but its guest route cleanup remains unconfirmed.');
            throw error;
          }
        });
        inFlight.add(cleanup);
        void cleanup.then(() => inFlight.delete(cleanup), () => inFlight.delete(cleanup));
      },
      unknown(reason?: string): void {
        assertOwner();
        if (!exact()) return;
        const code = reason && /^[a-z][a-z0-9_:-]{0,127}$/.test(reason) ? ` (${reason})` : '';
        quarantine(machine, `An exact guest session has an unknown outcome${code}; all co-resident contexts remain fenced.`);
      },
    };
  }
  function tracked<T>(work: () => Promise<T>): Promise<T> {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const promise = work();
    inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  }

  try {
    function load<T extends { id: string; projectRoot: string }>(path: string, schema: z.ZodType<T>, target: Map<string, T>, rootDirectory: boolean): void {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (rootDirectory && entry.name === 'machines' && entry.isDirectory()) continue;
        if (rootDirectory && entry.name === 'manager.lock' && entry.isFile()) continue;
        if (entry.name.startsWith('.') && entry.name.endsWith('.tmp') && entry.isFile()) { privateRead(join(path, entry.name)); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.json')) fail('guest_storage_unsafe', 'Unexpected entries exist in the private guest ownership records.');
        const file = join(path, entry.name);
        const text = privateRead(file);
        const record = schema.parse(JSON.parse(text));
        if (record.projectRoot !== root || record.id !== record.id.toLowerCase() || entry.name !== `${record.id}.json`) fail('guest_storage_unsafe', 'A durable guest record has a foreign root or mismatched identity.');
        target.set(record.id, record); written.set(file, text);
      }
    }
    load(machinesDirectory, Machine, machines, false);
    load(contextsDirectory, Context, contexts, true);
    for (const context of contexts.values()) {
      const machine = machineFor(context);
      if (machines.has(context.id) || context.platform !== machine.platform || context.profileId !== context.request.profileId
        || (context.verified && !context.binding) || (context.binding && context.binding.generation > context.generation)
        || (context.lease && (!context.binding || context.lease.generation !== context.binding.generation || context.lease.epoch !== context.binding.epoch || context.lease.guestPid !== context.binding.guestPid))) {
        fail('guest_storage_unsafe', 'A durable browser context violates its machine, generation, or lease ownership contract.');
      }
    }
    for (const machine of machines.values()) {
      if (machine.platform === 'desktop-safari' && residents(machine.id).length > 1) fail('guest_storage_unsafe', 'Safari cannot share one guest desktop between multiple browser contexts.');
      if (residents(machine.id).some(context => context.lease || context.pendingPrepare) || (machine.pending && machine.pending !== 'create')
        || machine.native?.state === 'running' || machine.native?.state === 'starting' || machine.native?.state === 'stopping') {
        quarantine(machine, 'A previous engine left active or unconfirmed guest ownership; native stopped confirmation is required.', false);
      } else {
        for (const context of residents(machine.id)) if (context.binding) {
          context.generation = increment(context.generation); context.binding = null; context.verified = false; context.ports = [];
          context.reason = 'This engine must explicitly prepare the guest browser again.';
          saveContext(context);
        }
      }
    }
  } catch (error) { owner.release(); throw error; }

  return {
    owns: instanceId => { assertOwner(); return contexts.has(instanceId.toLowerCase()); },
    hasInstances: () => { assertOwner(); return contexts.size > 0; },
    call: input => tracked(async () => {
      const request = InstanceRequestSchema.parse(input);
      if (request.method === 'instance.create') return await create(request);
      if (request.method === 'instance.list') {
        await refresh();
        return { instances: [...contexts.values()].map(view), profiles: options.profiles(), capabilities: await capabilities() };
      }
      const context = getContext(request.instanceId);
      if (request.method === 'instance.start') return await start(context);
      if (request.method === 'instance.stop') return await stop(context, request.cancelActive, request.force);
      if (request.method === 'instance.prepare') { await prepare(context, [], true); return view(context); }
      if (request.method === 'instance.status') { await refresh(); return view(context); }
      const machine = machineFor(context);
      await refresh(); assertOpen();
      if (!observed.has(machine.id)) fail('guest_machine_not_owned', 'The physical VM is not confirmed by its native owner.');
      if (request.method === 'instance.show') await options.backend.show(machine.id);
      else await options.backend.hide(machine.id);
      await refresh();
      return view(context);
    }),
    devices: platform => tracked(async () => {
      if (platform !== undefined) GuestPlatform.parse(platform);
      await refresh();
      return [...contexts.values()].filter(context => platform === undefined || context.platform === platform).map(toDevice);
    }),
    pick: (platform, deviceId) => tracked(async () => {
      GuestPlatform.parse(platform);
      await refresh();
      const candidates = deviceId ? [deviceContext(deviceId)] : [...contexts.values()].filter(context => context.platform === platform && toDevice(context).state === 'booted' && !context.lease);
      const context = candidates[0];
      if (!context || candidates.length !== 1 || context.platform !== platform || toDevice(context).state !== 'booted' || context.lease) fail('guest_device_unavailable', 'Select one explicit, prepared, idle guest browser context.');
      return toDevice(context);
    }),
    acquire,
    prepare: (deviceId, origins) => tracked(async () => await prepare(deviceContext(deviceId), origins, false)),
    execution,
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = (async () => {
        const failures: unknown[] = [];
        try {
          for (const machine of machines.values()) if (residents(machine.id).some(context => context.binding || context.lease || context.pendingPrepare) || machine.pending) {
            try { quarantine(machine, 'The engine is shutting down; unconfirmed guest ownership remains fenced until native stopped confirmation.'); }
            catch (error) { failures.push(error); }
          }
          const operations = await Promise.allSettled([...inFlight]);
          for (const operation of operations) if (operation.status === 'rejected') failures.push(operation.reason);
          const revoked = await Promise.allSettled([...revocations.values()]);
          for (const result of revoked) if (result.status === 'rejected') failures.push(result.reason);
          try { await options.backend.shutdown(); } catch (error) { failures.push(error); }
        } finally { owner.release(); }
        if (failures.length) throw new AggregateError(failures, 'Guest shutdown retained unconfirmed ownership; no VM or browser completion was inferred.');
      })();
      return shutdownPromise;
    },
  };
}
