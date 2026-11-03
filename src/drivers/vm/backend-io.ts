import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { writeAll } from '../../core/fsx.ts';
import { InstanceExecutionError, type GuestControlReply } from '../../core/instances.ts';
import type { GuestRuntimeFiles } from './runtime.ts';
import type { VMControlRequest } from '../../core/guest-recording-protocol.ts';

export const FRAME_LIMIT = 16 * 1024 * 1024;
export const BODY_LIMIT = 8 * 1024 * 1024;
export const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const Epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const Ports = z.array(z.number().int().min(1).max(65535)).max(32).refine(values => new Set(values).size === values.length);
export const Control = z.strictObject({
  version: z.literal(1), id: UUID, epoch: Epoch, deadlineAt: Epoch,
  operation: z.enum(['webdriver', 'browser.evidence', 'route.bind', 'route.unbind', 'status', 'revoke', 'recording']),
  payload: z.record(z.string(), z.unknown()),
});
const Reply = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), id: UUID, ok: z.literal(true), effect: z.literal('completed'), result: z.unknown() }),
  z.strictObject({ version: z.literal(1), id: UUID, ok: z.literal(false), effect: z.enum(['not_started', 'unknown']), error: z.strictObject({ code: z.string().min(1).max(256), message: z.string().max(16384) }) }),
]);

export function failure(code: string, effect: 'not_started' | 'unknown' = 'not_started'): InstanceExecutionError {
  return new InstanceExecutionError(code, code, effect);
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function canonicalDirectory(path: string): void {
  if (resolve(path) !== path || realpathSync(path) !== path) throw failure('guest_storage_unsafe');
  let cursor = path;
  while (true) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('guest_storage_unsafe');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function privateDirectory(path: string, create = false): string {
  canonicalDirectory(dirname(path));
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) throw failure('guest_storage_unsafe');
  return path;
}

export function readOwned(path: string, maximum = 65536, privateMode = true): Buffer {
  canonicalDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || before.size < 0 || before.size > maximum || (before.mode & (privateMode ? 0o077 : 0o022)) !== 0) throw failure('guest_file_unsafe');
    const bytes = Buffer.allocUnsafe(Math.min(maximum + 1, before.size + 1));
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (n === 0) break;
      count += n;
    }
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || count > maximum) throw failure('guest_file_changed');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

export function readJSON(path: string, maximum = 65536): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readOwned(path, maximum))) as unknown;
}

export function atomicJSON(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  try { readOwned(path, 256 * 1024); }
  catch (error) { if (!isMissing(error)) throw error; }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 256 * 1024) throw failure('guest_metadata_limit');
  const temporary = join(dirname(path), `.node-write-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
    renameSync(temporary, path);
    published = true;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    closeSync(fd);
    if (!published) { try { unlinkSync(temporary); } catch { /* An unpublished temporary file may already be absent. */ } }
  }
}

export function removeOwned(path: string, maximum = 65536): void {
  try { readOwned(path, maximum); }
  catch (error) { if (isMissing(error)) return; throw error; }
  unlinkSync(path);
}

const KitIdentity = z.strictObject({ version: z.literal(1), machineId: UUID, sourceSha256: z.string().regex(/^[0-9a-f]{64}$/) });

export function prepareKit(machineRoot: string, machineId: string, runtime: GuestRuntimeFiles): void {
  privateDirectory(machineRoot);
  const manifest = z.looseObject({ sourceSha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(JSON.parse(readOwned(join(runtime.directory, 'manifest.json'), 65536, false).toString('utf8')));
  const kit = join(machineRoot, 'kit');
  const status = join(machineRoot, 'status');
  privateDirectory(status, true);
  let existing = false;
  try { lstatSync(kit); existing = true; } catch (error) { if (!isMissing(error)) throw error; }
  if (existing) {
    privateDirectory(kit);
    const identity = KitIdentity.parse(readJSON(join(kit, '.qautra-kit.json')));
    if (identity.machineId !== machineId) throw failure('guest_kit_runtime_changed');
    for (const name of ['QAutraGuestAgent.app', 'setup-guest.sh', 'GuestSetup.txt']) {
      const stat = lstatSync(join(kit, name));
      if (stat.isSymbolicLink() || (name.endsWith('.app') ? !stat.isDirectory() : !stat.isFile())) throw failure('guest_kit_unsafe');
    }
    if (identity.sourceSha256 === manifest.sourceSha256) return;
  }
  const stage = join(machineRoot, `.kit-stage-${randomUUID()}`);
  privateDirectory(stage, true);
  let entries = 0;
  let total = 0;
  const copy = (source: string, target: string): void => {
    if (++entries > 8180) throw failure('guest_kit_limit');
    const stat = lstatSync(source);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) throw failure('guest_kit_source_unsafe');
    if (stat.isDirectory()) {
      privateDirectory(target, true);
      for (const name of readdirSync(source).sort()) copy(join(source, name), join(target, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > 512 * 1024 * 1024 - total) throw failure('guest_kit_source_unsafe');
    total += stat.size;
    const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (stat.mode & 0o111) !== 0 ? 0o700 : 0o600);
    try {
      const actual = fstatSync(input);
      if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size || !actual.isFile()) throw failure('guest_kit_source_changed');
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, stat.size)));
      let copied = 0;
      while (true) {
        const count = readSync(input, buffer, 0, buffer.length, null);
        if (count === 0) break;
        copied += count;
        if (copied > stat.size) throw failure('guest_kit_source_changed');
        writeAll(output, buffer.subarray(0, count));
      }
      const after = fstatSync(input);
      if (copied !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw failure('guest_kit_source_changed');
      fsyncSync(output);
    } finally { closeSync(input); closeSync(output); }
  };
  copy(runtime.agent, join(stage, 'QAutraGuestAgent.app'));
  copy(join(runtime.directory, 'setup-guest.sh'), join(stage, 'setup-guest.sh'));
  copy(join(runtime.directory, 'GuestSetup.txt'), join(stage, 'GuestSetup.txt'));
  atomicJSON(join(stage, '.qautra-kit.json'), { version: 1, machineId, sourceSha256: manifest.sourceSha256 });
  if (existing) {
    const retired = join(machineRoot, `kit-retired-${randomUUID()}`);
    renameSync(kit, retired);
    try { renameSync(stage, kit); }
    catch (error) { renameSync(retired, kit); throw error; }
  } else renameSync(stage, kit);
  const directory = openSync(machineRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function openssl(arguments_: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn('/usr/bin/openssl', arguments_, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' } });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const finishError = (): void => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(failure('guest_certificate_generation_failed'));
    };
    const timer = setTimeout(finishError, 15000);
    child.once('error', finishError);
    child.stdin.on('error', finishError);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) { finishError(); return; }
      chunks.push(chunk);
    });
    let diagnosticSize = 0;
    child.stderr.on('data', (chunk: Buffer) => { diagnosticSize += chunk.length; if (diagnosticSize > 65536) finishError(); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { finishError(); return; }
      resolveOutput(Buffer.concat(chunks, size));
    });
    child.stdin.end(input);
  });
}

export async function certificate(machineId: string): Promise<{ key: Buffer; cert: Buffer; pin: string }> {
  const key = await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']);
  const cert = await openssl(['req', '-new', '-x509', '-sha256', '-key', '/dev/stdin', '-days', '1', '-subj', `/CN=QAutra-${machineId}`], key);
  const parsed = new X509Certificate(cert);
  return { key, cert, pin: createHash('sha256').update(parsed.raw).digest('hex') };
}

function ipv4(value: string): number {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) throw failure('guest_network_invalid');
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

export function validateBridge(gateway: string, guest: string): void {
  const address = ipv4(guest);
  const gatewayAddress = ipv4(gateway);
  if (address === gatewayAddress || address >>> 24 === 0 || address >>> 24 === 127 || address >>> 24 >= 224) throw failure('guest_network_invalid');
  const matches = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => /^bridge[0-9]+$/.test(name) ? (addresses ?? []).filter(item => item.family === 'IPv4' && !item.internal && item.address === gateway) : []);
  if (matches.length !== 1) throw failure('guest_bridge_unverified');
  const mask = ipv4(matches[0]!.netmask);
  const hostBits = (~mask) >>> 0;
  if (hostBits < 3 || (hostBits & (hostBits + 1)) !== 0 || (address & mask) !== (gatewayAddress & mask) || (address & hostBits) === 0 || (address & hostBits) === hostBits) throw failure('guest_subnet_unverified');
}

async function readable(socket: TLSSocket, deadline: number): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      socket.removeListener('readable', ready);
      socket.removeListener('end', ended);
      socket.removeListener('close', ended);
      socket.removeListener('error', ended);
      if (timer) clearTimeout(timer);
    };
    const ready = (): void => { cleanup(); resolveReady(); };
    const ended = (): void => { cleanup(); reject(failure('guest_channel_disconnected', 'unknown')); };
    socket.once('readable', ready);
    socket.once('end', ended);
    socket.once('close', ended);
    socket.once('error', ended);
    if (deadline !== 0) timer = setTimeout(ended, Math.max(1, deadline - Date.now()));
    if (socket.destroyed || socket.readableEnded) ended();
  });
}

async function exact(socket: TLSSocket, length: number, deadline: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    if (deadline !== 0 && Date.now() >= deadline) throw failure('guest_channel_timeout', 'unknown');
    const chunk = socket.read(Math.min(65536, length - offset)) as Buffer | null;
    if (chunk) { chunk.copy(result, offset); offset += chunk.length; }
    else { if (socket.destroyed || socket.readableEnded) throw failure('guest_channel_disconnected', 'unknown'); await readable(socket, deadline); }
  }
  return result;
}

export async function readFrame(socket: TLSSocket, deadline = 0): Promise<unknown> {
  const header = await exact(socket, 4, deadline);
  const length = header.readUInt32BE(0);
  if (length < 1 || length > FRAME_LIMIT) throw failure('guest_frame_limit', 'unknown');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await exact(socket, length, deadline))) as unknown;
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 1 || body.length > FRAME_LIMIT) throw failure('guest_frame_limit');
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

interface Pending {
  request: VMControlRequest;
  timer: NodeJS.Timeout;
  resolve: (reply: GuestControlReply) => void;
  reject: (error: InstanceExecutionError) => void;
}

export class GuestChannel {
  readonly socket: TLSSocket;
  readonly epoch: number;
  readonly onUnknown: (reason: string) => void;
  readonly pending = new Map<string, Pending>();
  readonly seen = new Set<string>();
  closed = false;

  constructor(socket: TLSSocket, epoch: number, onUnknown: (reason: string) => void) {
    this.socket = socket;
    this.epoch = epoch;
    this.onUnknown = onUnknown;
    socket.on('error', () => this.close('guest_channel_disconnected'));
    socket.once('close', () => this.close('guest_channel_disconnected'));
    void this.receive();
  }

  async receive(): Promise<void> {
    try {
      while (!this.closed) {
        const reply = Reply.parse(await readFrame(this.socket));
        const pending = this.pending.get(reply.id);
        if (!pending || pending.request.epoch !== this.epoch || Date.now() >= pending.request.deadlineAt) throw failure('guest_reply_identity_or_deadline', 'unknown');
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        pending.resolve(reply);
        if (!reply.ok && reply.effect === 'unknown') this.close(reply.error.code);
      }
    } catch { if (!this.closed) this.close('guest_reply_invalid_or_disconnected'); }
  }

  request(request: VMControlRequest): Promise<GuestControlReply> {
    if (this.closed || this.socket.destroyed) return Promise.reject(failure('guest_agent_unavailable'));
    if (request.epoch !== this.epoch || request.deadlineAt <= Date.now() || request.deadlineAt > Date.now() + 300000 || this.seen.has(request.id)) return Promise.reject(failure('guest_request_identity_or_deadline'));
    if (this.seen.size >= 16384 || this.pending.size >= 32) return Promise.reject(failure('guest_request_limit'));
    const frame = encodeFrame(request);
    if (this.socket.writableLength + frame.length > 32 * 1024 * 1024) return Promise.reject(failure('guest_channel_backpressure'));
    this.seen.add(request.id);
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => this.close('guest_request_timeout'), Math.max(1, request.deadlineAt - Date.now()));
      this.pending.set(request.id, { request, timer, resolve: resolveReply, reject });
      try { this.socket.write(frame, error => { if (error) this.close('guest_request_write_unknown'); }); }
      catch { this.close('guest_request_write_unknown'); }
    });
  }

  close(reason: string, notify = true): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure(reason, 'unknown'));
    }
    this.pending.clear();
    if (notify) this.onUnknown(reason);
  }
}

export function forwardLoopback(guest: TLSSocket, port: number, onClose: () => void): () => void {
  const host = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
  let closed = false;
  const lifetime = setTimeout(() => close(), 86400000);
  const connectDeadline = setTimeout(() => close(), 10000);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    clearTimeout(connectDeadline);
    guest.destroy();
    host.destroy();
    onClose();
  };
  guest.setTimeout(120000, close);
  host.setTimeout(120000, close);
  guest.on('error', close);
  host.on('error', close);
  guest.once('close', close);
  host.once('close', close);
  host.once('connect', () => {
    clearTimeout(connectDeadline);
    if (closed) return;
    host.setNoDelay(true);
    guest.setNoDelay(true);
    guest.pipe(host);
    host.pipe(guest);
  });
  return close;
}
