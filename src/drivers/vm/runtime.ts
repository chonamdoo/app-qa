import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ensureDir } from '../../core/fsx.ts';
import { InstanceExecutionError } from '../../core/instances.ts';

const RuntimeManifest = z.strictObject({
  schema: z.literal('qautra/guest-runtime/v1'), platform: z.literal('darwin'), arch: z.literal('arm64'),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/), agentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const Reply = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), id: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ version: z.literal(1), id: z.uuid(), ok: z.literal(false), error: z.strictObject({
    code: z.string(), message: z.string(), effect: z.enum(['not_started', 'unknown']),
  }) }),
]);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function guestRuntimeSourceHash(root: string): string {
  const files: string[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new InstanceExecutionError('guest_runtime_invalid', 'VM 소스에 symlink가 있어 빌드 identity를 확인할 수 없습니다.');
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.push(relative(root, file));
    }
  };
  collect(join(root, 'src/drivers/vm/native'));
  collect(join(root, 'src/drivers/vm/guest'));
  const digest = createHash('sha256');
  for (const file of files.sort()) digest.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  return digest.digest('hex');
}

export interface GuestRuntimeFiles { directory: string; helper: string; helperSha256: string; agent: string }

export function loadGuestRuntime(root: string): GuestRuntimeFiles {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new InstanceExecutionError('guest_host_unsupported', '실제 macOS guest 실행에는 지원되는 Apple Silicon Mac이 필요합니다. 호스트 브라우저로 대체하지 않습니다.');
  }
  const directory = join(root, '.tools/mac-build/Build/Products/Debug/QAutra.app/Contents/Resources/GuestRuntime');
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) throw new InstanceExecutionError('guest_runtime_missing', 'QAutra VM 실행기가 빌드되지 않았습니다. scripts/build-mac.sh로 Mac 앱을 빌드하세요.');
  const manifest = RuntimeManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const helper = join(directory, 'QAutraGuestHost');
  const agent = join(directory, 'QAutraGuestAgent.app');
  const agentExecutable = join(agent, 'Contents/MacOS/QAutraGuestAgent');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.sourceSha256 !== guestRuntimeSourceHash(root)
    || hash(readFileSync(helper)) !== manifest.helperSha256 || hash(readFileSync(agentExecutable)) !== manifest.agentSha256) {
    throw new InstanceExecutionError('guest_runtime_stale', 'VM 실행기의 소스·플랫폼·binary identity가 일치하지 않습니다. Mac 앱을 다시 빌드하세요. 호스트로 우회하지 않습니다.');
  }
  return { directory, helper, helperSha256: manifest.helperSha256, agent };
}

export function privateGuestDirectory(directory: string, create = true): string {
  if (create) ensureDir(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new InstanceExecutionError('guest_storage_unsafe', 'VM 저장소가 현재 사용자 전용 디렉터리가 아닙니다. 기존 경로의 권한이나 데이터를 자동 변경하지 않습니다.');
  }
  return realpathSync(directory);
}

function cachedNativeHelper(projectRoot: string, runtime: GuestRuntimeFiles): string {
  const directory = privateGuestDirectory(join(projectRoot, '.qa/instances/executables', runtime.helperSha256));
  const executable = join(directory, 'QAutraGuestHost');
  const verify = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o700 || hash(readFileSync(path)) !== runtime.helperSha256) {
      throw new InstanceExecutionError('guest_helper_cache_invalid', 'VM 실행기의 전용 immutable 사본을 확인할 수 없습니다. 기존 사본을 덮어쓰지 않습니다.');
    }
  };
  if (existsSync(executable)) {
    verify(executable);
    return executable;
  }
  const temporary = join(directory, `.stage-${randomUUID()}`);
  try {
    copyFileSync(runtime.helper, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o700);
    verify(temporary);
    renameSync(temporary, executable);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return executable;
}

export class NativeGuestClient {
  readonly root: string;
  readonly socket: string;
  readonly projectRoot: string;
  #starting: Promise<void> | null = null;
  #child: ChildProcess | null = null;

  constructor(projectRoot: string, machinesRoot: string, readOnly = false) {
    this.projectRoot = resolve(projectRoot);
    this.root = privateGuestDirectory(resolve(machinesRoot), !readOnly);
    this.socket = join(this.root, 'runtime/control.sock');
  }

  async ensureStarted(): Promise<void> {
    this.#starting ??= this.#start().catch(error => { this.#starting = null; throw error; });
    await this.#starting;
  }

  #validSocket(): boolean {
    if (!existsSync(this.socket)) return false;
    const stat = lstatSync(this.socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new InstanceExecutionError('guest_owner_unsafe', 'VM 제어 소켓 소유권을 확인할 수 없습니다. 기존 소켓을 채택하거나 삭제하지 않습니다.');
    }
    return true;
  }

  async #start(): Promise<void> {
    const runtime = loadGuestRuntime(this.projectRoot);
    if (this.#validSocket()) {
      try {
        await this.request('list', undefined, undefined, 5000, false);
        return;
      } catch (error) {
        if (!(error instanceof InstanceExecutionError) || error.code !== 'guest_owner_absent') throw error;
      }
    }
    const logDirectory = privateGuestDirectory(join(this.projectRoot, '.qa/logs'));
    const log = openSync(join(logDirectory, 'native-owner.log'), 'a', 0o600);
    try {
      this.#child = spawn(cachedNativeHelper(this.projectRoot, runtime), ['--root', this.root], {
        cwd: this.projectRoot, detached: true, stdio: ['ignore', log, log],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8' },
      });
      this.#child.unref();
    } finally { closeSync(log); }
    const launch: { error?: Error } = {};
    this.#child.once('error', error => { launch.error = error; });
    const until = Date.now() + 15_000;
    while (true) {
      if (launch.error) throw new InstanceExecutionError('guest_owner_start_failed', launch.error.message);
      if (this.#child.exitCode !== null) throw new InstanceExecutionError('guest_owner_start_failed', 'VM 실행기가 제어 소켓을 준비하기 전에 종료되었습니다.');
      if (Date.now() >= until) throw new InstanceExecutionError('guest_owner_start_unknown', 'VM 실행기 시작 결과를 확인할 수 없습니다. 중복 실행하지 않습니다.', 'unknown');
      if (this.#validSocket()) {
        try {
          await this.request('list', undefined, undefined, 500, false);
          return;
        } catch (error) {
          if (!(error instanceof InstanceExecutionError) || !['guest_owner_absent', 'guest_owner_timeout'].includes(error.code)) throw error;
        }
      }
      await delay(50);
    }
  }

  async request(action: string, instanceId?: string, payload?: Record<string, unknown>, timeoutMs = 30_000, start = true): Promise<unknown> {
    if (start) await this.ensureStarted();
    else if (!this.#validSocket()) throw new InstanceExecutionError('guest_owner_absent', 'The original native owner socket is absent; observation cannot start a replacement.');
    const id = randomUUID();
    const message = `${JSON.stringify({ version: 1, id, action, ...(instanceId ? { instanceId } : {}), ...(payload ? { payload } : {}) })}\n`;
    if (Buffer.byteLength(message) > 65_536) throw new InstanceExecutionError('guest_request_too_large', 'VM 제어 요청 상한을 초과했습니다.');
    const socketPath = relative(process.cwd(), this.socket);
    if (Buffer.byteLength(socketPath) >= 104) throw new InstanceExecutionError('guest_socket_path_too_long', '현재 작업 디렉터리에서 VM 제어 경로가 너무 깁니다. 프로젝트 루트에서 실행하세요.');
    return await new Promise((resolveReply, reject) => {
      let sent = false;
      let settled = false;
      const chunks: Buffer[] = [];
      let byteLength = 0;
      const socket = createConnection({ path: socketPath });
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolveReply(result);
      };
      const fail = (code: string, message: string): void => finish(new InstanceExecutionError(code, message, sent ? 'unknown' : 'not_started'));
      const timer = setTimeout(() => fail('guest_owner_timeout', 'VM 제어 응답 기한 초과 — 요청을 재전송하지 않습니다.'), timeoutMs);
      socket.once('connect', () => { sent = true; socket.write(message); });
      socket.on('data', chunk => {
        if (settled) return;
        if (typeof chunk === 'string') { fail('guest_owner_protocol', 'VM 제어 응답 byte 형식 오류'); return; }
        const end = chunk.indexOf(10);
        const piece = end < 0 ? chunk : chunk.subarray(0, end);
        byteLength += piece.length;
        if (byteLength > 2 * 1024 * 1024) { fail('guest_owner_protocol', 'VM 제어 응답 상한 초과'); return; }
        chunks.push(piece);
        if (end < 0) return;
        try {
          const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, byteLength);
          const reply = Reply.parse(JSON.parse(bytes.toString('utf8')));
          if (reply.id !== id) { fail('guest_owner_protocol', '다른 VM 제어 요청의 응답입니다.'); return; }
          if (reply.ok) finish(undefined, reply.result);
          else finish(new InstanceExecutionError(reply.error.code, reply.error.message, reply.error.effect));
        } catch { fail('guest_owner_protocol', 'VM 제어 응답 형식을 확인할 수 없습니다.'); }
      });
      socket.once('error', error => {
        if (!sent && ['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          if (start) this.#starting = null;
          fail('guest_owner_absent', '기존 VM 소켓의 실행기가 없습니다. native 소유권 잠금을 확보하기 전에는 소켓을 삭제하거나 요청을 재전송하지 않습니다.');
        } else fail('guest_owner_disconnected', 'VM 제어 연결 실패 — 기존 요청의 효과를 추정하지 않습니다.');
      });
      socket.once('close', () => { if (!settled) fail('guest_owner_disconnected', 'VM 제어 연결이 응답 전에 종료되었습니다.'); });
    });
  }
}
