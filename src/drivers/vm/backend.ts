import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer as createHTTPServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createTLSServer, type Server as TLSServer, type TLSSocket } from 'node:tls';
import { z } from 'zod';
import { acquireFileLock, type FileLock } from '../../core/lock.ts';
import { InstanceExecutionError, InstanceResources, NativeMachineView, type GuestBrowserBinding, type GuestControlReply, type GuestMachineBackend, type GuestMachineConnection, type GuestPlatform, type InstanceHostCapabilities } from '../../core/instances.ts';
import { GuestAttemptBindingSchema, GuestRecoveryRegistrationSchema, GuestRecoverySourceSchema } from '../../core/guest-recovery.ts';
import { GuestRuntimeRequestSchema, validateGuestBrowserEvidence } from '../../core/guest-runtime.ts';
import { guestAttemptRecovery } from './attempt-recovery.ts';
import { atomicJSON, BODY_LIMIT, canonicalDirectory, certificate, Control, Epoch, failure, forwardLoopback, GuestChannel, isMissing, Ports, prepareKit, privateDirectory, readFrame, readJSON, removeOwned, UUID, validateBridge } from './backend-io.ts';
import { loadGuestRuntime, NativeGuestClient } from './runtime.ts';
import { GuestRecordingCommand, GuestRecordingFinal, GuestRecordingIdentity, GuestRecordingStatus, sameRecordingIdentity, type VMControlRequest } from '../../core/guest-recording-protocol.ts';

const Binding = z.strictObject({ contextId: UUID, machineId: UUID, generation: Epoch, platform: z.enum(['desktop-chrome', 'desktop-safari']) });
const ContextFence = z.strictObject({
  contextId: UUID, generation: Epoch, state: z.enum(['idle', 'creating', 'live', 'closing']),
  sessionId: z.string().min(1).max(128).nullable(), ports: Ports,
  originalSessionId: z.string().min(1).max(128).nullable().default(null),
});
const MachineRecord = z.strictObject({
  version: z.literal(1), machineId: UUID, platform: z.enum(['desktop-chrome', 'desktop-safari']), epoch: Epoch,
  bootToken: z.string().regex(/^[0-9a-f]{64}$/), disposition: z.enum(['prepared', 'active', 'stopping', 'stopped', 'unknown']),
  reason: z.string().max(256).nullable(), contexts: z.array(ContextFence).max(8),
  inFlight: z.array(z.strictObject({ id: UUID, operation: z.string().max(32) })).max(32),
  recording: z.strictObject({ identity: GuestRecordingIdentity, state: z.enum(['starting', 'recording', 'stopping', 'finalized']) }).nullable().default(null),
  recoveries: z.array(z.strictObject({ source: GuestRecoverySourceSchema, nativeGeneration: UUID, identity: GuestRecordingIdentity })).max(128).default([]),
});
const HelloFile = z.strictObject({
  version: z.literal(1), instanceId: UUID, epoch: Epoch, bootTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  guestPid: z.number().int().min(1).max(2147483647), gatewayIPv4: z.string().max(15), guestIPv4: z.string().max(15), osVersion: z.string().min(1).max(1024),
});
const Authentication = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('control'), instanceId: UUID, epoch: Epoch, token: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ version: z.literal(1), kind: z.literal('forward'), instanceId: UUID, epoch: Epoch, token: z.string().regex(/^[0-9a-f]{64}$/), port: z.number().int().min(1).max(65535) }),
]);
const AgentHello = z.strictObject({ version: z.literal(1), type: z.literal('hello'), agentVersion: z.literal(1), osVersion: z.string().min(1).max(1024), safariDriverPresent: z.boolean(), chromeDriverPresent: z.boolean() });
const WebDriverPayload = z.strictObject({ contextId: UUID, method: z.enum(['GET', 'POST', 'DELETE']), path: z.string().min(1).max(2048), timeoutMs: z.number().int().min(1).max(240000), body: z.unknown().optional() });
const W3C = z.strictObject({ status: z.number().int().min(200).max(599), body: z.looseObject({ value: z.unknown() }) });
const GuestStatus = z.strictObject({
  instanceId: UUID, epoch: Epoch, connected: z.boolean(), quarantined: z.boolean(),
  browser: z.strictObject({
    quarantined: z.boolean(), quarantineReason: z.string().nullable(), revoked: z.boolean(), safariDriverPresent: z.boolean(), chromeDriverPresent: z.boolean(), chromeVersion: z.string().nullable(),
    contexts: z.array(z.strictObject({ contextId: UUID, sessionId: z.string().nullable(), driverRunning: z.boolean(), commandInFlight: z.boolean(), capabilities: z.record(z.string(), z.unknown()).nullable() })).max(8),
  }),
  routes: z.strictObject({ ports: Ports, activeStreams: z.number().int().min(0).max(64) }),
});
const Empty = z.strictObject({});
const RoutePayload = z.strictObject({ ports: Ports.refine(ports => ports.length > 0) });
const Probe = z.strictObject({
  supported: z.boolean(), minimumCPUCount: z.number().int().positive(), maximumCPUCount: z.number().int().positive(),
  minimumMemoryMiB: z.number().int().positive(), maximumMemoryMiB: z.number().int().positive(),
  availableMemoryMiB: z.number().int().nonnegative(),
  restore: z.strictObject({ url: z.string(), minimumCPUCount: z.number().int().positive(), minimumMemoryMiB: z.number().int().positive(), hardwareModelSupported: z.literal(true) }).nullable(),
});

type RecordData = z.infer<typeof MachineRecord>;
type Fence = z.infer<typeof ContextFence>;
type DriverPayload = z.infer<typeof WebDriverPayload>;
type DriverResult = z.infer<typeof W3C>;
interface SerialOwner { serial: Promise<void> }
interface BrowserContext extends SerialOwner {
  binding: GuestBrowserBinding;
  epoch: number;
  fence: Fence;
  revoked: boolean;
  server: HTTPServer | null;
  url: string | null;
  sockets: Set<Socket>;
}
interface Machine extends SerialOwner {
  record: RecordData;
  native: NativeMachineView;
  contexts: Map<string, BrowserContext>;
  channel: GuestChannel | null;
  listener: TLSServer | null;
  sockets: Set<Socket>;
  forwards: Map<TLSSocket, { port: number; close: () => void }>;
  hello: z.infer<typeof HelloFile> | null;
  connection: GuestMachineConnection | null;
  timer: NodeJS.Timeout | null;
  quarantined: boolean;
  stopping: boolean;
  acceptingControl: boolean;
}

function serial<T>(owner: SerialOwner, work: () => Promise<T>): Promise<T> {
  const result = owner.serial.then(work);
  owner.serial = result.then(() => undefined, () => undefined);
  return result;
}

function endpointPath(method: string, path: string): void {
  if (!path.startsWith('/') || path.endsWith('/') || /[\\%?#]/.test(path) || path.includes('//')) throw failure('invalid_webdriver_path');
  const parts = path.slice(1).split('/');
  if (parts.some(part => !/^[A-Za-z0-9_.:-]{1,512}$/.test(part) || part === '.' || part === '..')) throw failure('invalid_webdriver_path');
  if (method === 'GET' && path === '/status') return;
  if (method === 'POST' && path === '/session') return;
  if (parts[0] !== 'session' || !parts[1] || parts[1].length > 128) throw failure('unsupported_webdriver_endpoint');
  const suffix = parts.slice(2);
  const fixed: Record<string, readonly string[]> = {
    '': ['GET', 'DELETE'], timeouts: ['GET', 'POST'], url: ['GET', 'POST'], back: ['POST'], forward: ['POST'], refresh: ['POST'], title: ['GET'], source: ['GET'], screenshot: ['GET'], window: ['GET', 'POST', 'DELETE'], 'window/handles': ['GET'], 'window/new': ['POST'], 'window/rect': ['GET', 'POST'], 'window/maximize': ['POST'], 'window/minimize': ['POST'], 'window/fullscreen': ['POST'], frame: ['POST'], 'frame/parent': ['POST'], element: ['POST'], elements: ['POST'], 'element/active': ['GET'], 'execute/sync': ['POST'], 'execute/async': ['POST'], actions: ['POST', 'DELETE'], 'alert/dismiss': ['POST'], 'alert/accept': ['POST'], 'alert/text': ['GET', 'POST'], cookie: ['GET', 'POST', 'DELETE'], print: ['POST'], 'se/log': ['POST'],
  };
  if (fixed[suffix.join('/')]?.includes(method)) return;
  if (suffix.length === 2 && suffix[0] === 'cookie' && ['GET', 'DELETE'].includes(method)) return;
  if (suffix[0] === 'element' && suffix[1]) {
    if (suffix.length === 3 && ((method === 'POST' && ['element', 'elements', 'click', 'clear', 'value'].includes(suffix[2]!)) || (method === 'GET' && ['text', 'name', 'rect', 'selected', 'enabled', 'displayed', 'screenshot'].includes(suffix[2]!)))) return;
    if (suffix.length === 4 && method === 'GET' && ['attribute', 'property', 'css'].includes(suffix[2]!)) return;
  }
  throw failure('unsupported_webdriver_endpoint');
}

function validateDriverPayload(value: unknown): DriverPayload {
  const payload = WebDriverPayload.parse(value);
  endpointPath(payload.method, payload.path);
  if (payload.method === 'POST') {
    if (!payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)) throw failure('invalid_webdriver_body');
    if (Buffer.byteLength(JSON.stringify(payload.body)) > BODY_LIMIT) throw failure('webdriver_body_limit');
  } else if (payload.body !== undefined) throw failure('unexpected_webdriver_body');
  return payload;
}

function fulfilled(reply: GuestControlReply): unknown {
  if (!reply.ok) throw new InstanceExecutionError(reply.error.code, reply.error.message, reply.effect);
  return reply.result;
}

function closeServer(server: HTTPServer | TLSServer | null): void {
  if (!server) return;
  try { server.close(); } catch { /* Closing an unbound owned listener has no remote effect. */ }
}

async function body(request: IncomingMessage): Promise<unknown> {
  return await new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', abort);
      request.removeListener('error', abort);
      if (error) { reject(error); return; }
      try {
        const bytes = Buffer.concat(chunks, length);
        resolveBody(bytes.length === 0 ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
      } catch { reject(failure('invalid_webdriver_body')); }
    };
    const data = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > BODY_LIMIT) { request.pause(); finish(failure('webdriver_body_limit')); return; }
      chunks.push(chunk);
    };
    const end = (): void => finish();
    const abort = (): void => finish(failure('webdriver_proxy_interrupted'));
    const timer = setTimeout(() => { request.pause(); finish(failure('webdriver_body_timeout')); }, 10000);
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', abort);
    request.once('error', abort);
  });
}

class Backend implements GuestMachineBackend {
  readonly root: string;
  readonly machinesRoot: string;
  readonly transportRoot: string;
  readonly native: NativeGuestClient;
  readonly machines = new Map<string, Machine>();
  readonly contexts = new Map<string, BrowserContext>();
  lock: FileLock | null = null;
  initializing: Promise<void> | null = null;
  closed = false;

  constructor(root: string) {
    this.root = resolve(root);
    canonicalDirectory(this.root);
    privateDirectory(join(this.root, '.qa'), true);
    const instances = privateDirectory(join(this.root, '.qa/instances'), true);
    this.machinesRoot = privateDirectory(join(instances, 'machines'), true);
    this.transportRoot = privateDirectory(join(instances, 'transport'), true);
    this.native = new NativeGuestClient(this.root, this.machinesRoot);
  }

  async ensure(): Promise<void> {
    if (this.closed) throw failure('guest_backend_closed');
    this.initializing ??= this.initialize();
    await this.initializing;
    if (this.closed) throw failure('guest_backend_closed');
  }

  async initialize(): Promise<void> {
    const lockPath = join(this.transportRoot, 'owner.lock');
    try { readJSON(lockPath); } catch (error) { if (!isMissing(error)) throw error; }
    this.lock = acquireFileLock(lockPath, { purpose: 'QAutra guest transport' });
    await this.native.ensureStarted();
    const native = z.array(NativeMachineView).max(256).parse(await this.native.request('list'));
    const names = readdirSync(this.transportRoot);
    if (names.length > 1024) throw failure('guest_metadata_limit');
    const records = new Map<string, RecordData>();
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const record = MachineRecord.parse(readJSON(join(this.transportRoot, name), 256 * 1024));
      if (name !== `${record.machineId}.json` || records.has(record.machineId)) throw failure('guest_metadata_identity');
      records.set(record.machineId, record);
    }
    for (const view of native) {
      const record = records.get(view.id) ?? this.newRecord(view, 'unknown', 'native_transport_reconciliation_required');
      if (record.platform !== view.platform) throw failure('guest_metadata_identity');
      if (record.recording !== null || record.disposition === 'active' || record.disposition === 'stopping' || ['running', 'starting', 'stopping', 'unknown'].includes(view.state)) {
        record.disposition = 'unknown';
        record.reason = 'previous_transport_owner_requires_vm_stop';
      }
      const machine = this.addMachine(view, record);
      this.persist(machine);
      if (['running', 'starting', 'stopping', 'unknown'].includes(view.state)) this.schedule(machine);
    }
  }

  newRecord(view: NativeMachineView, disposition: RecordData['disposition'], reason: string | null): RecordData {
    return { version: 1, machineId: view.id, platform: view.platform, epoch: Date.now(), bootToken: randomBytes(32).toString('hex'), disposition, reason, contexts: [], inFlight: [], recording: null, recoveries: [] };
  }

  addMachine(view: NativeMachineView, record: RecordData): Machine {
    const machine: Machine = { record, native: view, contexts: new Map(), channel: null, listener: null, sockets: new Set(), forwards: new Map(), hello: null, connection: null, timer: null, quarantined: record.disposition === 'unknown', stopping: false, acceptingControl: false, serial: Promise.resolve() };
    this.machines.set(view.id, machine);
    for (const fence of record.contexts) {
      const context: BrowserContext = { binding: { contextId: fence.contextId, machineId: view.id, generation: fence.generation, platform: view.platform }, epoch: record.epoch, fence, revoked: false, server: null, url: null, sockets: new Set(), serial: Promise.resolve() };
      if (this.contexts.has(fence.contextId)) throw failure('guest_context_identity_conflict');
      machine.contexts.set(fence.contextId, context);
      this.contexts.set(fence.contextId, context);
    }
    return machine;
  }

  persist(machine: Machine): void {
    machine.record.contexts = [...machine.contexts.values()].map(context => context.fence);
    atomicJSON(join(this.transportRoot, `${machine.record.machineId}.json`), MachineRecord.parse(machine.record));
  }

  machine(id: string): Machine {
    UUID.parse(id);
    const machine = this.machines.get(id);
    if (!machine) throw failure('guest_machine_not_found');
    return machine;
  }

  context(id: string): BrowserContext {
    UUID.parse(id);
    const context = this.contexts.get(id);
    if (!context) throw failure('guest_context_not_found');
    return context;
  }

  usable(machine: Machine): void {
    if (this.closed) throw failure('guest_backend_closed');
    if (machine.quarantined || machine.record.disposition === 'unknown') throw failure(machine.record.reason ?? 'guest_machine_quarantined', 'unknown');
    if (machine.stopping || machine.native.state !== 'running' || !machine.channel || machine.channel.closed || !machine.connection?.connected) throw failure('guest_agent_unavailable');
  }

  closeProxy(context: BrowserContext, except?: Socket): void {
    closeServer(context.server);
    context.server = null;
    context.url = null;
    for (const socket of context.sockets) if (socket !== except) socket.destroy();
  }

  closeTransport(machine: Machine): void {
    closeServer(machine.listener);
    machine.listener = null;
    machine.channel?.close('guest_transport_closed', false);
    machine.channel = null;
    if (machine.connection) machine.connection.connected = false;
    for (const forward of [...machine.forwards.values()]) forward.close();
    machine.forwards.clear();
    for (const socket of machine.sockets) socket.destroy();
    machine.sockets.clear();
  }

  quarantine(machine: Machine, reason: string, except?: Socket): void {
    machine.quarantined = true;
    machine.record.disposition = 'unknown';
    machine.record.reason = /^[a-zA-Z0-9_.-]{1,256}$/.test(reason) ? reason : 'guest_machine_outcome_unknown';
    try { this.persist(machine); } catch { machine.record.reason = 'guest_quarantine_persistence_failed'; }
    for (const context of machine.contexts.values()) this.closeProxy(context, except);
    this.closeTransport(machine);
  }

  async nativeView(action: string, machine: Machine, payload?: Record<string, unknown>): Promise<NativeMachineView> {
    try {
      const view = NativeMachineView.parse(await this.native.request(action, machine.record.machineId, payload));
      if (view.id !== machine.record.machineId || view.platform !== machine.record.platform) throw failure('guest_native_identity_unknown', 'unknown');
      machine.native = view;
      return view;
    } catch (error) {
      if (!(error instanceof InstanceExecutionError) || error.effect === 'unknown') this.quarantine(machine, 'guest_native_outcome_unknown');
      throw error;
    }
  }

  schedule(machine: Machine): void {
    if (this.closed || machine.timer) return;
    machine.timer = setTimeout(() => {
      machine.timer = null;
      void this.poll(machine).finally(() => { if (!this.closed && !['stopped', 'installed', 'error'].includes(machine.native.state)) this.schedule(machine); });
    }, 750);
    machine.timer.unref();
  }

  stopped(machine: Machine, view: NativeMachineView): void {
    if (view.state !== 'stopped' && view.state !== 'installed') throw failure('guest_stop_unconfirmed', 'unknown');
    this.closeTransport(machine);
    for (const context of machine.contexts.values()) {
      this.closeProxy(context);
      this.contexts.delete(context.binding.contextId);
    }
    machine.contexts.clear();
    machine.record.contexts = [];
    machine.record.inFlight = [];
    machine.record.recording = null;
    machine.record.disposition = 'stopped';
    machine.record.reason = null;
    machine.quarantined = false;
    machine.stopping = false;
    machine.hello = null;
    machine.connection = null;
    this.persist(machine);
  }

  async poll(machine: Machine): Promise<void> {
    try {
      const view = await this.nativeView('status', machine);
      if (this.closed) return;
      if (view.state === 'stopped' || view.state === 'installed') { this.stopped(machine, view); return; }
      if (view.state === 'unknown' || view.state === 'error') { this.quarantine(machine, 'guest_native_state_unknown'); return; }
      if (view.state !== 'running' || machine.stopping || machine.quarantined || machine.listener || machine.channel) return;
      let hello: z.infer<typeof HelloFile>;
      try { hello = HelloFile.parse(readJSON(join(this.machinesRoot, view.id, 'status/hello.json'))); }
      catch (error) { if (isMissing(error)) return; throw error; }
      const expectedHash = createHash('sha256').update(machine.record.bootToken).digest('hex');
      if (hello.instanceId !== view.id || hello.epoch !== machine.record.epoch || !timingSafeEqual(Buffer.from(hello.bootTokenHash), Buffer.from(expectedHash))) throw failure('guest_hello_identity');
      validateBridge(hello.gatewayIPv4, hello.guestIPv4);
      await this.listen(machine, hello);
    } catch { if (!this.closed) this.quarantine(machine, 'guest_bootstrap_or_ownership_refused'); }
  }

  async listen(machine: Machine, hello: z.infer<typeof HelloFile>): Promise<void> {
    const material = await certificate(machine.record.machineId);
    if (this.closed || machine.stopping || machine.quarantined) return;
    const view = await this.nativeView('status', machine);
    if (view.state !== 'running') throw failure('guest_native_not_running');
    validateBridge(hello.gatewayIPv4, hello.guestIPv4);
    machine.hello = hello;
    const server = createTLSServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000, allowHalfOpen: true }, socket => {
      socket.on('error', () => socket.destroy());
      void this.accept(machine, socket).catch(() => socket.destroy());
    });
    server.maxConnections = 128;
    machine.listener = server;
    server.on('connection', socket => {
      machine.sockets.add(socket);
      socket.once('close', () => machine.sockets.delete(socket));
    });
    server.on('tlsClientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolveListening, reject) => {
      const failed = (error: Error): void => { server.removeListener('listening', ready); reject(error); };
      const ready = (): void => { server.removeListener('error', failed); resolveListening(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen({ host: hello.gatewayIPv4, port: 0, exclusive: true });
    });
    server.on('error', () => this.quarantine(machine, 'guest_tls_listener_failed'));
    if (this.closed || machine.stopping || machine.quarantined) { closeServer(server); return; }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== hello.gatewayIPv4) throw failure('guest_tls_binding_invalid');
    atomicJSON(join(this.machinesRoot, machine.record.machineId, 'kit/connection.json'), { version: 1, instanceId: machine.record.machineId, epoch: machine.record.epoch, host: hello.gatewayIPv4, port: address.port, certificateSha256: material.pin });
  }

  grantedPorts(machine: Machine): Set<number> {
    return new Set([...machine.contexts.values()].flatMap(context => context.fence.ports));
  }

  async accept(machine: Machine, socket: TLSSocket): Promise<void> {
    const hello = machine.hello;
    if (!hello || this.closed || machine.quarantined || machine.stopping || socket.remoteAddress !== hello.guestIPv4) throw failure('guest_peer_refused');
    const deadline = Date.now() + 10000;
    const authentication = Authentication.parse(await readFrame(socket, deadline));
    if (authentication.instanceId !== machine.record.machineId || authentication.epoch !== machine.record.epoch || !timingSafeEqual(Buffer.from(authentication.token), Buffer.from(machine.record.bootToken))) throw failure('guest_authentication_refused');
    validateBridge(hello.gatewayIPv4, hello.guestIPv4);
    if (authentication.kind === 'control') {
      if (machine.channel || machine.acceptingControl) throw failure('guest_control_already_owned');
      machine.acceptingControl = true;
      try {
        const view = await this.nativeView('status', machine);
        if (view.state !== 'running' || machine.quarantined || machine.stopping || this.closed) throw failure('guest_native_not_running');
        const agent = AgentHello.parse(await readFrame(socket, deadline));
        if (agent.osVersion !== hello.osVersion || socket.destroyed) throw failure('guest_hello_conflict');
        machine.record.disposition = 'active';
        machine.record.reason = null;
        this.persist(machine);
        machine.connection = { machineId: view.id, epoch: machine.record.epoch, guestPid: hello.guestPid, osVersion: agent.osVersion, connected: true };
        machine.channel = new GuestChannel(socket, machine.record.epoch, reason => this.quarantine(machine, reason));
      } catch (error) { this.quarantine(machine, 'guest_control_handshake_refused'); throw error; }
      finally { machine.acceptingControl = false; }
      return;
    }
    this.usable(machine);
    if (!this.grantedPorts(machine).has(authentication.port) || machine.forwards.size >= 64) throw failure('guest_forward_not_granted');
    const reservation: { port: number; close: () => void } = { port: authentication.port, close: () => { socket.destroy(); } };
    machine.forwards.set(socket, reservation);
    try {
      const view = await this.nativeView('status', machine);
      this.usable(machine);
      if (view.state !== 'running' || !this.grantedPorts(machine).has(authentication.port) || socket.destroyed) throw failure('guest_forward_revoked');
      reservation.close = forwardLoopback(socket, authentication.port, () => machine.forwards.delete(socket));
    } catch (error) { machine.forwards.delete(socket); socket.destroy(); throw error; }
  }

  async send(machine: Machine, input: VMControlRequest): Promise<GuestControlReply> {
    const request = Control.parse(input);
    this.usable(machine);
    if (request.epoch !== machine.record.epoch || request.deadlineAt <= Date.now() || request.deadlineAt > Date.now() + 300000) throw failure('guest_request_identity_or_deadline');
    if (machine.record.inFlight.some(item => item.id === request.id) || machine.record.inFlight.length >= 32) throw failure('guest_request_limit');
    machine.record.inFlight.push({ id: request.id, operation: request.operation });
    try { this.persist(machine); }
    catch { this.quarantine(machine, 'guest_dispatch_fence_failed'); throw failure('guest_dispatch_fence_failed'); }
    try {
      const reply = await machine.channel!.request(request);
      if (!reply.ok && reply.effect === 'unknown') { this.quarantine(machine, reply.error.code); return reply; }
      machine.record.inFlight = machine.record.inFlight.filter(item => item.id !== request.id);
      try { this.persist(machine); }
      catch { this.quarantine(machine, 'guest_reply_persistence_unknown'); throw failure('guest_reply_persistence_unknown', 'unknown'); }
      return reply;
    } catch (error) {
      if (!(error instanceof InstanceExecutionError) || error.effect === 'unknown') this.quarantine(machine, 'guest_request_outcome_unknown');
      else {
        machine.record.inFlight = machine.record.inFlight.filter(item => item.id !== request.id);
        try { this.persist(machine); } catch { this.quarantine(machine, 'guest_request_persistence_unknown'); throw failure('guest_request_persistence_unknown', 'unknown'); }
      }
      throw error;
    }
  }

  makeRequest(machine: Machine, operation: VMControlRequest['operation'], payload: Record<string, unknown>, timeoutMs = 60000): VMControlRequest {
    return { version: 1, id: randomUUID(), epoch: machine.record.epoch, deadlineAt: Date.now() + timeoutMs, operation, payload };
  }

  async setAutomation(machine: Machine, enabled: boolean): Promise<void> {
    const view = await this.nativeView('automation', machine, { enabled });
    if (view.state !== 'running' || view.automation !== enabled) {
      this.quarantine(machine, 'guest_input_gate_unknown');
      throw failure('guest_input_gate_unknown', 'unknown');
    }
  }

  async restoreManual(machine: Machine): Promise<void> {
    if (machine.quarantined || machine.stopping || machine.record.recording !== null || [...machine.contexts.values()].some(context => context.fence.state !== 'idle' || context.fence.sessionId !== null) || machine.record.inFlight.some(item => item.operation === 'webdriver')) return;
    try { await this.setAutomation(machine, false); }
    catch { this.quarantine(machine, 'guest_manual_input_restore_unknown'); throw failure('guest_manual_input_restore_unknown', 'unknown'); }
  }

  async resetNotStarted(machine: Machine, context: BrowserContext, creating: boolean, deleting: boolean): Promise<void> {
    if (machine.quarantined) return;
    await serial(machine, async () => {
      if (creating) context.fence.state = 'idle';
      if (deleting) context.fence.state = 'live';
      this.persist(machine);
      if (creating) await this.restoreManual(machine);
    });
  }

  checkRouteScope(context: BrowserContext, desired: readonly number[]): void {
    const machine = this.machine(context.binding.machineId);
    if ([...machine.contexts.values()].some(other => other !== context && !other.revoked
      && (other.fence.ports.length > 0 || other.fence.state !== 'idle')
      && (other.fence.ports.length !== desired.length || other.fence.ports.some(port => !desired.includes(port))))) {
      throw new InstanceExecutionError('guest_route_scope_conflict', '공유 Chrome VM의 모든 준비된 context는 동일한 localhost 포트 권한만 사용할 수 있습니다. 다른 포트 범위는 별도 프로필·VM을 사용하세요.');
    }
  }

  async dispatch(context: BrowserContext, request: VMControlRequest, keepSocket?: Socket, closing = false): Promise<GuestControlReply> {
    const machine = this.machine(context.binding.machineId);
    this.usable(machine);
    if ((context.revoked && !closing) || context.epoch !== machine.record.epoch) throw failure('guest_context_revoked');
    const payload = validateDriverPayload(request.payload);
    const recorder = machine.record.recording;
    if (payload.method !== 'GET' && !(payload.method === 'DELETE' && payload.path === `/session/${context.fence.sessionId ?? ''}`) && recorder !== null
      && (recorder.identity.contextId !== context.binding.contextId || recorder.state !== 'recording')) throw failure('guest_recording_not_ready');
    if (payload.contextId !== context.binding.contextId) throw failure('guest_context_identity');
    const creating = payload.method === 'POST' && payload.path === '/session';
    const deleting = payload.method === 'DELETE' && payload.path === `/session/${context.fence.sessionId ?? ''}`;
    if (creating && (context.fence.state !== 'idle' || context.fence.sessionId !== null)) throw failure('guest_context_session_conflict');
    if (payload.path !== '/status' && payload.path !== '/session') {
      if (!context.fence.sessionId || payload.path.split('/')[2] !== context.fence.sessionId || context.fence.state !== 'live') throw failure('guest_session_not_owned');
    }
    if (creating || deleting) {
      await serial(machine, async () => {
        this.usable(machine);
        if ((context.revoked && !closing) || this.contexts.get(context.binding.contextId) !== context) throw failure('guest_context_revoked');
        if (creating) this.checkRouteScope(context, context.fence.ports);
        context.fence.state = creating ? 'creating' : 'closing';
        this.persist(machine);
        if (creating) {
          try { await this.setAutomation(machine, true); }
          catch (error) {
            if (error instanceof InstanceExecutionError && error.effect === 'not_started' && !machine.quarantined) { context.fence.state = 'idle'; this.persist(machine); }
            throw error;
          }
        }
      });
    }
    let reply: GuestControlReply;
    try { reply = await this.send(machine, request); }
    catch (error) {
      if (error instanceof InstanceExecutionError && error.effect === 'not_started') await this.resetNotStarted(machine, context, creating, deleting);
      throw error;
    }
    if (!reply.ok) {
      if (reply.effect === 'not_started') await this.resetNotStarted(machine, context, creating, deleting);
      return reply;
    }
    const parsed = W3C.safeParse(reply.result);
    if (!parsed.success || !Object.hasOwn(parsed.data.body, 'value')) {
      this.quarantine(machine, 'guest_webdriver_response_unknown');
      throw failure('guest_webdriver_response_unknown', 'unknown');
    }
    const result = parsed.data;
    if (result.status >= 400) {
      const value = result.body.value;
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).error !== 'string') {
        this.quarantine(machine, 'guest_webdriver_error_unknown');
        throw failure('guest_webdriver_error_unknown', 'unknown');
      }
    }
    if (creating) {
      if (result.status < 200 || result.status >= 300) this.quarantine(machine, 'guest_session_creation_failed', keepSocket);
      else {
        const value = z.looseObject({ sessionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), capabilities: z.looseObject({ browserName: z.string(), browserVersion: z.string().min(1).max(128) }) }).safeParse(result.body.value);
        if (!value.success || value.data.capabilities.browserName.toLowerCase() !== (context.binding.platform === 'desktop-safari' ? 'safari' : 'chrome') || [...machine.contexts.values()].some(other => other !== context && other.fence.sessionId === value.data.sessionId)) {
          this.quarantine(machine, 'guest_session_identity_unknown');
          throw failure('guest_session_identity_unknown', 'unknown');
        }
        await serial(machine, async () => {
          if (machine.quarantined) throw failure('guest_machine_quarantined', 'unknown');
          context.fence.sessionId = value.data.sessionId;
          context.fence.originalSessionId ??= value.data.sessionId;
          context.fence.state = 'live';
          this.persist(machine);
        });
      }
    }
    if (deleting) {
      if (result.status >= 200 && result.status < 300 && result.body.value === null) {
        await serial(machine, async () => {
          if (machine.quarantined) throw failure('guest_machine_quarantined', 'unknown');
          context.fence.sessionId = null;
          context.fence.state = 'idle';
          this.persist(machine);
          await this.restoreManual(machine);
        });
      } else this.quarantine(machine, 'guest_session_close_unconfirmed', keepSocket);
    }
    return reply;
  }

  async driver(context: BrowserContext, method: DriverPayload['method'], path: string, value?: unknown, closing = false): Promise<DriverResult> {
    const machine = this.machine(context.binding.machineId);
    const payload: Record<string, unknown> = { contextId: context.binding.contextId, method, path, timeoutMs: 60000, ...(value === undefined ? {} : { body: value }) };
    return W3C.parse(fulfilled(await this.dispatch(context, this.makeRequest(machine, 'webdriver', payload), undefined, closing)));
  }

  async probe(): Promise<InstanceHostCapabilities> {
    const physicalMemoryMiB = Math.floor(totalmem() / 1048576);
    const logicalCPUCount = cpus().length;
    const unavailable = (reason: string): InstanceHostCapabilities => ({ supported: false, reason, minimumCPUCount: 2, minimumMemoryMiB: 4096, physicalMemoryMiB, availableMemoryMiB: 0, logicalCPUCount, maximumMachines: 0 });
    try {
      await this.ensure();
      const probe = Probe.parse(await this.native.request('probe', undefined, undefined, 60000));
      if (!probe.supported || !probe.restore) return unavailable('guest_virtualization_unsupported');
      const minimumCPUCount = Math.max(probe.minimumCPUCount, probe.restore.minimumCPUCount);
      const minimumMemoryMiB = Math.max(probe.minimumMemoryMiB, probe.restore.minimumMemoryMiB);
      return { supported: true, reason: null, minimumCPUCount, minimumMemoryMiB, physicalMemoryMiB, availableMemoryMiB: probe.availableMemoryMiB, logicalCPUCount, maximumMachines: Math.max(0, Math.min(2, Math.floor(logicalCPUCount / minimumCPUCount), Math.floor(physicalMemoryMiB / minimumMemoryMiB))) };
    } catch (error) { return unavailable(error instanceof InstanceExecutionError ? error.code : 'guest_host_probe_failed'); }
  }

  async list(): Promise<NativeMachineView[]> {
    await this.ensure();
    const views = z.array(NativeMachineView).max(256).parse(await this.native.request('list'));
    for (const view of views) {
      const machine = this.machines.get(view.id);
      if (!machine) continue;
      if (view.platform !== machine.record.platform) { this.quarantine(machine, 'guest_native_identity_unknown'); continue; }
      machine.native = view;
      if ((view.state === 'stopped' || view.state === 'installed') && (machine.connection || machine.stopping || machine.quarantined)) this.stopped(machine, view);
      else if (view.state === 'unknown' || view.state === 'error') this.quarantine(machine, 'guest_native_state_unknown');
    }
    return views;
  }

  async create(id: string, name: string, platform: GuestPlatform, resources: InstanceResources): Promise<NativeMachineView> {
    UUID.parse(id);
    Binding.shape.platform.parse(platform);
    InstanceResources.parse(resources);
    if (name.trim().length < 1 || [...name].length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw failure('invalid_guest_name');
    await this.ensure();
    if (this.machines.has(id)) throw failure('guest_machine_conflict');
    loadGuestRuntime(this.root);
    const view = NativeMachineView.parse(await this.native.request('create', id, { name, platform, ...resources }));
    if (view.id !== id || view.platform !== platform) throw failure('guest_native_identity_unknown', 'unknown');
    const machine = this.addMachine(view, this.newRecord(view, 'prepared', null));
    this.persist(machine);
    return view;
  }

  writeBoot(machine: Machine): void {
    atomicJSON(join(this.machinesRoot, machine.record.machineId, 'kit/instance.json'), { version: 1, instanceId: machine.record.machineId, epoch: machine.record.epoch, bootToken: machine.record.bootToken, platform: machine.record.platform });
  }

  async start(id: string): Promise<NativeMachineView> {
    await this.ensure();
    const machine = this.machine(id);
    return await serial(machine, async () => {
      const current = await this.nativeView('status', machine);
      if (current.state === 'running' && machine.connection?.connected && !machine.quarantined) return current;
      if (current.state !== 'installed' && current.state !== 'stopped') throw failure(machine.quarantined ? 'guest_vm_stop_required' : 'guest_machine_not_startable', machine.quarantined ? 'unknown' : 'not_started');
      this.stopped(machine, current);
      prepareKit(join(this.machinesRoot, id), id, loadGuestRuntime(this.root));
      removeOwned(join(this.machinesRoot, id, 'status/hello.json'));
      removeOwned(join(this.machinesRoot, id, 'kit/connection.json'));
      machine.record.epoch = Epoch.parse(Math.max(Date.now(), machine.record.epoch + 1));
      machine.record.bootToken = randomBytes(32).toString('hex');
      machine.record.disposition = 'prepared';
      machine.record.reason = null;
      this.persist(machine);
      this.writeBoot(machine);
      const view = await this.nativeView('start', machine);
      this.schedule(machine);
      return view;
    });
  }

  async stop(id: string, force: boolean): Promise<NativeMachineView> {
    await this.ensure();
    const machine = this.machine(id);
    return await serial(machine, async () => {
      let view = await this.nativeView('status', machine);
      if (view.state === 'stopped' || view.state === 'installed') { this.stopped(machine, view); return view; }
      machine.stopping = true;
      machine.record.disposition = 'stopping';
      this.persist(machine);
      for (const context of machine.contexts.values()) this.closeProxy(context);
      this.closeTransport(machine);
      try { view = await this.nativeView(force ? 'poweroff' : 'stop', machine); }
      catch (error) { this.quarantine(machine, 'guest_stop_unconfirmed'); this.schedule(machine); throw error; }
      if (view.state === 'stopped') this.stopped(machine, view);
      else this.schedule(machine);
      return view;
    });
  }

  async show(id: string): Promise<void> { await this.ensure(); await this.nativeView('show', this.machine(id)); }
  async hide(id: string): Promise<void> { await this.ensure(); await this.nativeView('hide', this.machine(id)); }

  async automation(id: string, enabled: boolean): Promise<void> {
    await this.ensure();
    const machine = this.machine(id);
    await serial(machine, async () => {
      if (!enabled && (machine.quarantined || machine.stopping || machine.record.inFlight.length > 0 || [...machine.contexts.values()].some(context => context.fence.state !== 'idle' || context.fence.sessionId !== null))) throw failure('guest_manual_input_not_safe', 'unknown');
      await this.setAutomation(machine, enabled);
    });
  }

  connection(id: string): GuestMachineConnection | null {
    const machine = this.machine(id);
    const connection = machine.connection;
    if (!connection) return null;
    return { ...connection, connected: !this.closed && !machine.quarantined && !machine.stopping && machine.native.state === 'running' && machine.channel !== null && !machine.channel.closed && connection.connected };
  }

  async bindBrowser(input: GuestBrowserBinding): Promise<string> {
    const binding = Binding.parse(input);
    await this.ensure();
    const machine = this.machine(binding.machineId);
    const previous = this.contexts.get(binding.contextId);
    if (previous && previous.binding.machineId === binding.machineId && binding.generation > previous.binding.generation) {
      if (previous.revoked || previous.fence.state !== 'idle' || previous.fence.sessionId !== null) throw failure('guest_context_generation_conflict');
      await this.revokeBrowser(binding.contextId);
    }
    return await serial(machine, async () => {
      this.usable(machine);
      if (binding.platform !== machine.record.platform) throw failure('guest_platform_conflict');
      const existing = this.contexts.get(binding.contextId);
      if (existing) {
        if (existing.binding.machineId !== binding.machineId || existing.binding.generation !== binding.generation || existing.revoked) throw failure('guest_context_generation_conflict');
        return this.endpoint(binding.contextId, binding.generation);
      }
      if (machine.contexts.size >= (binding.platform === 'desktop-safari' ? 1 : 8)) throw failure('guest_context_limit');
      const fence: Fence = { contextId: binding.contextId, generation: binding.generation, state: 'idle', sessionId: null, originalSessionId: null, ports: [] };
      const context: BrowserContext = { binding, epoch: machine.record.epoch, fence, revoked: false, server: null, url: null, sockets: new Set(), serial: Promise.resolve() };
      machine.contexts.set(binding.contextId, context);
      this.contexts.set(binding.contextId, context);
      try {
        this.persist(machine);
        await this.proxy(context);
        return this.endpoint(binding.contextId, binding.generation);
      } catch (error) {
        this.closeProxy(context);
        machine.contexts.delete(binding.contextId);
        this.contexts.delete(binding.contextId);
        try { this.persist(machine); } catch { this.quarantine(machine, 'guest_binding_persistence_unknown'); }
        throw error;
      }
    });
  }

  async proxy(context: BrowserContext): Promise<void> {
    const capability = randomBytes(32).toString('hex');
    const prefix = `/${capability}`;
    const server = createHTTPServer({ maxHeaderSize: 16384, requestTimeout: 250000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (request, response) => {
      void this.proxyRequest(context, prefix, request, response);
    });
    context.server = server;
    server.maxConnections = 32;
    server.on('connection', socket => { context.sockets.add(socket); socket.once('close', () => context.sockets.delete(socket)); });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.destroy());
    await new Promise<void>((resolveListening, reject) => {
      const ready = (): void => { server.removeListener('error', reject); resolveListening(); };
      server.once('error', reject);
      server.once('listening', ready);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    });
    server.on('error', () => this.quarantine(this.machine(context.binding.machineId), 'guest_proxy_listener_failed'));
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw failure('guest_proxy_binding_invalid');
    context.url = `http://127.0.0.1:${address.port}${prefix}`;
  }

  async proxyRequest(context: BrowserContext, prefix: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let dispatched = false;
    try {
      const machine = this.machine(context.binding.machineId);
      this.usable(machine);
      if (context.revoked || context.epoch !== machine.record.epoch || !context.url || request.headers.origin !== undefined || request.headers.host !== new URL(context.url).host || request.socket.remoteAddress !== '127.0.0.1' || !request.url?.startsWith(`${prefix}/`)) throw failure('guest_proxy_capability_refused');
      const method = z.enum(['GET', 'POST', 'DELETE']).parse(request.method);
      const path = request.url.slice(prefix.length);
      if (path === '/qautra/browser-evidence') {
        if (method !== 'POST') throw failure('guest_runtime_method_refused');
        const input = GuestRuntimeRequestSchema.parse(await body(request));
        const result = await serial(context, async () => {
          const fence = (): void => {
            this.usable(machine);
            const original = machine.record.recoveries.find(item => item.source.id === input.source.id);
            if (context.revoked || context.epoch !== machine.record.epoch || context.fence.state !== 'live' || !context.fence.sessionId
              || context.fence.originalSessionId !== context.fence.sessionId
              || input.identity.contextId !== context.binding.contextId || input.identity.machineId !== machine.record.machineId
              || input.identity.generation !== context.binding.generation || input.identity.epoch !== machine.record.epoch || input.identity.guestPid !== machine.connection?.guestPid
              || !original || original.source.root !== input.source.root || original.source.bindingSha256 !== input.source.bindingSha256 || original.nativeGeneration !== input.nativeGeneration
              || !sameRecordingIdentity(original.identity, input.identity) || request.aborted || response.destroyed) throw failure('guest_runtime_original_context_fenced');
          };
          const native = async () => {
            fence();
            const value = z.strictObject({ source: GuestRecoverySourceSchema, binding: GuestAttemptBindingSchema }).parse(await this.native.request('recovery.runtime', machine.record.machineId, { recorderId: input.source.id, nativeGeneration: input.nativeGeneration }, 5000, false));
            const binding = guestAttemptRecovery.read(join(this.root, '.qa/instances'), input.source, value.binding.execution);
            if (value.source.id !== input.source.id || value.source.root !== input.source.root || value.source.bindingSha256 !== input.source.bindingSha256 || binding.native.nativeGeneration !== input.nativeGeneration
              || !sameRecordingIdentity(binding.identity, input.identity)) throw failure('guest_runtime_original_native_fenced');
            return binding;
          };
          const binding = await native();
          const session = context.fence.sessionId;
          const reply = await this.send(machine, this.makeRequest(machine, 'browser.evidence', { identity: input.identity }, 30000));
          const evidence = validateGuestBrowserEvidence({ source: input.source, nativeGeneration: input.nativeGeneration, workerId: binding.workerId, runtime: fulfilled(reply) }, binding, input.source);
          await native();
          fence();
          if (evidence.runtime.sessionId !== session || context.fence.sessionId !== session) throw failure('guest_runtime_session_changed');
          return evidence;
        });
        const bytes = Buffer.from(JSON.stringify(result));
        if (bytes.length > 256 * 1024) throw failure('guest_runtime_response_limit');
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
        response.end(bytes);
        return;
      }
      if (path === '/qautra/recovery') {
        if (method !== 'POST') throw failure('guest_recovery_method_refused');
        const input = GuestRecoveryRegistrationSchema.parse(await body(request));
        const result = await serial(context, async () => await serial(machine, async () => {
          this.usable(machine);
          const identity = input.identity;
          if (context.revoked || request.aborted || response.destroyed || context.fence.state !== 'idle' || context.fence.sessionId !== null
            || identity.machineId !== machine.record.machineId || identity.contextId !== context.binding.contextId
            || identity.generation !== context.binding.generation || identity.epoch !== machine.record.epoch || identity.guestPid !== machine.connection?.guestPid
            || input.context.root !== this.root || input.context.target.platform !== machine.record.platform
            || machine.record.recording !== null || machine.record.inFlight.length !== 0 || machine.record.recoveries.length >= 128
            || machine.record.recoveries.some(item => item.identity.recorderId === identity.recorderId)) throw failure('guest_recovery_registration_refused');
          const registered = z.strictObject({ source: GuestRecoverySourceSchema, binding: GuestAttemptBindingSchema }).parse(await this.native.request('recovery.register', machine.record.machineId, input, 30000, false));
          if (!sameRecordingIdentity(registered.binding.identity, identity) || registered.source.id !== identity.recorderId) throw failure('guest_recovery_registration_unknown', 'unknown');
          machine.record.recoveries.push({ source: registered.source, nativeGeneration: registered.binding.native.nativeGeneration, identity });
          this.persist(machine);
          return registered;
        }));
        const bytes = Buffer.from(JSON.stringify(result));
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
        response.end(bytes);
        return;
      }
      if (path === '/qautra/recording') {
        if (method !== 'POST') throw failure('guest_recording_method_refused');
        const command = GuestRecordingCommand.parse(await body(request));
        const reply = await serial(context, async () => {
          if (request.aborted || response.destroyed) throw failure('guest_proxy_interrupted');
          const interrupted = (): void => { if (!response.writableFinished) this.quarantine(machine, 'guest_recording_proxy_ack_unknown'); };
          response.once('close', interrupted);
          dispatched = true;
          try { return await this.recording(context, command); }
          finally { response.removeListener('close', interrupted); }
        });
        const bytes = Buffer.from(JSON.stringify(reply));
        if (response.destroyed) return;
        response.writeHead(reply.ok ? 200 : 409, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
        response.end(bytes);
        return;
      }
      endpointPath(method, path);
      const value = await body(request);
      const payload = validateDriverPayload({ contextId: context.binding.contextId, method, path, timeoutMs: 240000, ...(value === undefined ? {} : { body: value }) });
      const reply = await serial(context, async () => {
        if (request.aborted || response.destroyed) throw failure('guest_proxy_interrupted');
        const onInterrupted = (): void => {
          if (!response.writableFinished) this.quarantine(machine, 'guest_proxy_disconnected_after_dispatch');
        };
        response.once('close', onInterrupted);
        dispatched = true;
        try { return await this.dispatch(context, this.makeRequest(machine, 'webdriver', payload, 240000), request.socket); }
        finally { response.removeListener('close', onInterrupted); }
      });
      if (!reply.ok) throw new InstanceExecutionError(reply.error.code, reply.error.message, reply.effect);
      const result = W3C.parse(reply.result);
      const bytes = Buffer.from(JSON.stringify(result.body));
      if (response.destroyed) return;
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
      if (machine.quarantined) response.once('finish', () => request.socket.destroy());
      response.end(bytes);
    } catch (error) {
      const machine = this.machines.get(context.binding.machineId);
      if ((error instanceof InstanceExecutionError && error.effect === 'unknown') || (dispatched && !(error instanceof InstanceExecutionError))) {
        if (machine) this.quarantine(machine, 'guest_proxy_outcome_unknown');
        response.destroy();
        return;
      }
      if (response.destroyed) return;
      const bytes = Buffer.from(JSON.stringify({ value: { error: 'unknown error', message: error instanceof InstanceExecutionError ? error.message : 'guest_proxy_request_refused', stacktrace: '' } }));
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' });
      response.end(bytes);
    }
  }

  endpoint(contextId: string, generation: number): string {
    Epoch.parse(generation);
    const context = this.context(contextId);
    const machine = this.machine(context.binding.machineId);
    this.usable(machine);
    if (context.binding.generation !== generation || context.epoch !== machine.record.epoch || context.revoked || !context.url) throw failure('guest_context_generation_conflict');
    return context.url;
  }

  async routes(context: BrowserContext, input: readonly number[], closing = false): Promise<void> {
    const desired = Ports.parse([...input]);
    const machine = this.machine(context.binding.machineId);
    await serial(machine, async () => {
      this.usable(machine);
      if (context.revoked && !closing) throw failure('guest_context_revoked');
      if (!closing) this.checkRouteScope(context, desired);
      const union = this.grantedPorts(machine);
      const otherPorts = new Set([...machine.contexts.values()].filter(other => other !== context).flatMap(other => other.fence.ports));
      if (new Set([...otherPorts, ...desired]).size > 32) throw failure('guest_route_limit');
      const additions = desired.filter(port => !union.has(port));
      const removals = context.fence.ports.filter(port => !desired.includes(port) && !otherPorts.has(port));
      const validateReply = (reply: GuestControlReply, ports: number[]): void => {
        const result = RoutePayload.safeParse(fulfilled(reply));
        if (!result.success || result.data.ports.length !== ports.length || result.data.ports.some(port => !ports.includes(port))) {
          this.quarantine(machine, 'guest_route_response_unknown');
          throw failure('guest_route_response_unknown', 'unknown');
        }
      };
      if (additions.length > 0) {
        validateReply(await this.send(machine, this.makeRequest(machine, 'route.bind', { ports: additions }, 15000)), additions);
        context.fence.ports = [...new Set([...context.fence.ports, ...desired])].sort((a, b) => a - b);
        this.persist(machine);
      }
      if (removals.length > 0) validateReply(await this.send(machine, this.makeRequest(machine, 'route.unbind', { ports: removals }, 15000)), removals);
      context.fence.ports = desired.sort((a, b) => a - b);
      this.persist(machine);
      const permitted = this.grantedPorts(machine);
      for (const forward of [...machine.forwards.values()]) if (!permitted.has(forward.port)) forward.close();
    });
  }

  async grantRoutes(contextId: string, ports: readonly number[]): Promise<void> {
    await this.ensure();
    const context = this.context(contextId);
    await serial(context, async () => { await this.routes(context, ports); });
  }

  async verifyBrowser(contextId: string): Promise<{ browserVersion: string; osVersion: string }> {
    await this.ensure();
    const context = this.context(contextId);
    return await serial(context, async () => {
      const machine = this.machine(context.binding.machineId);
      this.usable(machine);
      if (context.revoked || context.fence.state !== 'idle' || context.fence.sessionId !== null) throw failure('guest_browser_probe_requires_idle_context');
      let version: string | null = null;
      let probeError: unknown;
      try {
        const created = await this.driver(context, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: context.binding.platform === 'desktop-safari' ? 'safari' : 'chrome', platformName: 'mac', timeouts: { pageLoad: 30000, script: 15000 }, unhandledPromptBehavior: 'ignore' }, firstMatch: [{}] } });
        if (created.status >= 300) throw failure('guest_browser_preparation_failed');
        const value = z.looseObject({ capabilities: z.looseObject({ browserVersion: z.string().min(1).max(128) }) }).parse(created.body.value);
        version = value.capabilities.browserVersion;
        const session = context.fence.sessionId;
        if (!session) throw failure('guest_browser_probe_session_unknown', 'unknown');
        const navigated = await this.driver(context, 'POST', `/session/${session}/url`, { url: 'about:blank' });
        if (navigated.status >= 300) throw failure('guest_browser_blank_navigation_failed');
        const location = await this.driver(context, 'GET', `/session/${session}/url`);
        if (location.status >= 300 || location.body.value !== 'about:blank') throw failure('guest_browser_blank_navigation_unverified');
      } catch (error) { probeError = error; }
      if (!machine.quarantined && context.fence.sessionId !== null) {
        const deleted = await this.driver(context, 'DELETE', `/session/${context.fence.sessionId}`);
        if (deleted.status >= 300 || deleted.body.value !== null || context.fence.sessionId !== null) {
          this.quarantine(machine, 'guest_browser_probe_close_unconfirmed');
          throw failure('guest_browser_probe_close_unconfirmed', 'unknown');
        }
      }
      if (machine.quarantined || context.fence.state !== 'idle' || context.fence.sessionId !== null) throw failure('guest_browser_probe_outcome_unknown', 'unknown');
      if (probeError !== undefined) throw probeError;
      if (!version || !machine.connection?.osVersion) throw failure('guest_browser_probe_identity_missing');
      return { browserVersion: version, osVersion: machine.connection.osVersion };
    });
  }

  statusResult(machine: Machine, result: unknown): z.infer<typeof GuestStatus> {
    const parsed = GuestStatus.safeParse(result);
    if (!parsed.success || parsed.data.instanceId !== machine.record.machineId || parsed.data.epoch !== machine.record.epoch || new Set(parsed.data.browser.contexts.map(context => context.contextId)).size !== parsed.data.browser.contexts.length) {
      this.quarantine(machine, 'guest_status_identity_unknown');
      throw failure('guest_status_identity_unknown', 'unknown');
    }
    if (parsed.data.quarantined || parsed.data.browser.quarantined || parsed.data.browser.revoked || !parsed.data.connected) this.quarantine(machine, 'guest_reported_quarantine');
    return parsed.data;
  }

  async revokeBrowser(contextId: string): Promise<void> {
    await this.ensure();
    const context = this.contexts.get(contextId);
    if (!context) return;
    context.revoked = true;
    this.closeProxy(context);
    await serial(context, async () => {
      const machine = this.machine(context.binding.machineId);
      this.usable(machine);
      if (machine.record.recording?.identity.contextId === contextId) throw failure('guest_recording_recovery_required', 'unknown');
      if (context.fence.sessionId !== null && context.fence.state === 'live') {
        const deleted = await this.driver(context, 'DELETE', `/session/${context.fence.sessionId}`, undefined, true);
        if (deleted.status >= 300 || deleted.body.value !== null) throw failure('guest_context_close_unconfirmed', 'unknown');
      } else if (context.fence.state !== 'idle') {
        this.quarantine(machine, 'guest_context_close_unconfirmed');
        throw failure('guest_context_close_unconfirmed', 'unknown');
      }
      const status = this.statusResult(machine, fulfilled(await this.send(machine, this.makeRequest(machine, 'status', {}, 15000))));
      const remaining = status.browser.contexts.find(item => item.contextId === contextId);
      if (remaining && (remaining.sessionId !== null || remaining.driverRunning || remaining.commandInFlight)) {
        this.quarantine(machine, 'guest_context_process_close_unconfirmed');
        throw failure('guest_context_process_close_unconfirmed', 'unknown');
      }
      this.usable(machine);
      await this.routes(context, [], true);
      await serial(machine, async () => {
        if (context.fence.state !== 'idle' || context.fence.sessionId !== null) throw failure('guest_context_close_unconfirmed', 'unknown');
        machine.contexts.delete(contextId);
        this.contexts.delete(contextId);
        this.persist(machine);
        await this.restoreManual(machine);
      });
    });
  }

  async recording(context: BrowserContext, command: z.infer<typeof GuestRecordingCommand>, supplied?: VMControlRequest): Promise<GuestControlReply> {
    const machine = this.machine(context.binding.machineId);
    return await serial(machine, async () => {
      this.usable(machine);
      const identity = command.identity;
      if (context.revoked || context.epoch !== machine.record.epoch || identity.machineId !== machine.record.machineId
        || identity.contextId !== context.binding.contextId || identity.generation !== context.binding.generation
        || identity.epoch !== machine.record.epoch || identity.guestPid !== machine.connection?.guestPid) throw failure('guest_recording_identity_refused');
      if (command.action === 'start') {
        if (machine.record.recording !== null || [...machine.contexts.values()].some(other => other !== context && other.fence.state !== 'idle')) throw failure('guest_display_recorder_already_owned');
        if (!machine.record.recoveries.some(item => sameRecordingIdentity(item.identity, identity))) throw failure('guest_original_attempt_registration_required');
        machine.record.recording = { identity, state: 'starting' };
      } else {
        if (!machine.record.recording || !sameRecordingIdentity(machine.record.recording.identity, identity)) throw failure('guest_recorder_not_owned');
        if (command.action === 'stop') {
          if (machine.record.recording.state !== 'recording') throw failure('guest_recorder_stop_not_permitted');
          machine.record.recording.state = 'stopping';
        }
        if ((command.action === 'read' || command.action === 'release') && machine.record.recording.state !== 'finalized') throw failure('guest_recorder_not_finalized');
      }
      this.persist(machine);
      const request = supplied ?? this.makeRequest(machine, 'recording', command, command.action === 'stop' ? 240000 : 30000);
      let reply: GuestControlReply;
      try {
        if (command.action === 'start') await this.setAutomation(machine, true);
        reply = await this.send(machine, request);
      }
      catch (error) {
        if (command.action === 'start' && error instanceof InstanceExecutionError && error.effect === 'not_started' && !machine.quarantined) {
          machine.record.recording = null; this.persist(machine); await this.restoreManual(machine);
        }
        throw error;
      }
      if (!reply.ok) {
        if (command.action === 'start' && reply.effect === 'not_started' && !machine.quarantined) { machine.record.recording = null; this.persist(machine); await this.restoreManual(machine); }
        return reply;
      }
      let valid = false;
      if (command.action === 'start' || command.action === 'status') {
        const parsed = GuestRecordingStatus.safeParse(reply.result);
        valid = parsed.success && sameRecordingIdentity(parsed.data.identity, identity);
        if (command.action === 'start') {
          valid = valid && parsed.success && parsed.data.state === 'recording' && parsed.data.readyAt !== null && parsed.data.frames > 0 && parsed.data.width >= 2 && parsed.data.height >= 2;
          if (valid) machine.record.recording = { identity, state: 'recording' };
        }
      } else if (command.action === 'stop') {
        const parsed = GuestRecordingFinal.safeParse(reply.result);
        valid = parsed.success && sameRecordingIdentity(parsed.data.identity, identity);
        if (valid) machine.record.recording = { identity, state: 'finalized' };
      } else if (command.action === 'read') {
        const parsed = z.strictObject({ identity: GuestRecordingIdentity, offset: z.literal(command.offset), data: z.string().min(4).max(349528) }).safeParse(reply.result);
        valid = parsed.success && sameRecordingIdentity(parsed.data.identity, identity)
          && /^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data.data) && Buffer.from(parsed.data.data, 'base64').length === command.length;
      } else {
        const parsed = z.strictObject({ identity: GuestRecordingIdentity, released: z.literal(true) }).safeParse(reply.result);
        valid = parsed.success && sameRecordingIdentity(parsed.data.identity, identity);
        if (valid) machine.record.recording = null;
      }
      if (!valid) { this.quarantine(machine, 'guest_recording_reply_unknown'); throw failure('guest_recording_reply_unknown', 'unknown'); }
      try { this.persist(machine); }
      catch { this.quarantine(machine, 'guest_recording_persistence_unknown'); throw failure('guest_recording_persistence_unknown', 'unknown'); }
      if (command.action === 'release') await this.restoreManual(machine);
      return reply;
    });
  }

  async request(machineId: string, input: VMControlRequest): Promise<GuestControlReply> {
    const request = Control.parse(input);
    if (request.operation === 'browser.evidence') throw failure('guest_runtime_requires_original_attempt_endpoint');
    await this.ensure();
    const machine = this.machine(machineId);
    if (request.operation === 'recording') {
      const command = GuestRecordingCommand.parse(request.payload);
      const context = this.context(command.identity.contextId);
      if (context.binding.machineId !== machineId) throw failure('guest_context_identity');
      return await serial(context, async () => await this.recording(context, command, request));
    }
    if (request.operation === 'webdriver') {
      const payload = validateDriverPayload(request.payload);
      const context = this.context(payload.contextId);
      if (context.binding.machineId !== machineId) throw failure('guest_context_identity');
      return await serial(context, async () => await this.dispatch(context, request));
    }
    if (request.operation === 'status') {
      Empty.parse(request.payload);
      const reply = await this.send(machine, request);
      if (reply.ok) this.statusResult(machine, reply.result);
      return reply;
    }
    if (request.operation === 'route.bind' || request.operation === 'route.unbind') {
      const payload = RoutePayload.parse(request.payload);
      return await serial(machine, async () => {
        const granted = this.grantedPorts(machine);
        if (payload.ports.some(port => request.operation === 'route.bind' ? !granted.has(port) : granted.has(port))) throw failure('guest_routes_require_context_grant');
        const reply = await this.send(machine, request);
        if (reply.ok) {
          const result = RoutePayload.safeParse(reply.result);
          if (!result.success || result.data.ports.length !== payload.ports.length || result.data.ports.some(port => !payload.ports.includes(port))) {
            this.quarantine(machine, 'guest_route_response_unknown');
            throw failure('guest_route_response_unknown', 'unknown');
          }
        }
        return reply;
      });
    }
    Empty.parse(request.payload);
    return await serial(machine, async () => {
      for (const context of machine.contexts.values()) { context.revoked = true; this.closeProxy(context); if (context.fence.state !== 'idle') context.fence.state = 'closing'; }
      this.persist(machine);
      const reply = await this.send(machine, request);
      if (reply.ok && z.strictObject({ closed: z.literal(true) }).safeParse(reply.result).success) {
        for (const context of machine.contexts.values()) { context.fence.state = 'idle'; context.fence.sessionId = null; context.fence.ports = []; }
        this.persist(machine);
        await this.restoreManual(machine);
        this.quarantine(machine, 'guest_revoked_requires_fresh_boot');
      } else this.quarantine(machine, 'guest_revoke_close_unconfirmed');
      return reply;
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.initializing) { try { await this.initializing; } catch { /* Shutdown also releases a partially initialized owner. */ } }
    for (const machine of this.machines.values()) {
      if (machine.timer) clearTimeout(machine.timer);
      machine.timer = null;
      if (!['stopped', 'installed'].includes(machine.native.state) || [...machine.contexts.values()].some(context => context.fence.state !== 'idle')) this.quarantine(machine, 'node_transport_shutdown_requires_vm_stop');
      else {
        for (const context of machine.contexts.values()) this.closeProxy(context);
        this.closeTransport(machine);
      }
    }
    this.lock?.release();
    this.lock = null;
  }
}

export function createGuestMachineBackend(root: string): GuestMachineBackend {
  return new Backend(root);
}
