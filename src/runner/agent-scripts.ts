import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentExecutionError, ScriptRequestSchema, SessionRequestSchema, type AgentCallContext, type AgentError, type AgentReply, type AgentScriptView, type AgentSessionView, type Effect, type ScriptDisposition, type ScriptRequest } from '../core/agent.ts';
import { appendJsonl, readPrivateFile, sha256, writeJsonAtomic, writeSecure } from '../core/fsx.ts';
import type { AgentSessions } from './agent-sessions.ts';
import { acquireFileLock, FileLockedError, type FileLock } from '../core/lock.ts';
import { disposeScriptSource, legacyScriptSource } from './script-source.ts';

export interface AgentScripts {
  call(request: ScriptRequest, context?: AgentCallContext): Promise<AgentReply>;
  shutdown(): Promise<void>;
}
interface ActiveScript {
  view: AgentScriptView;
  done: Promise<AgentScriptView>;
  cancel(code: string, message: string, state: ScriptDisposition): void;
}
const MAX_FRAME = 1_048_576;
const MAX_RECORD = 8_388_608;
const MAX_CALLS = 512;
const WireMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('call'), id: z.uuid(), request: SessionRequestSchema }),
  z.strictObject({ type: z.literal('cancel'), id: z.uuid() }),
  z.strictObject({ type: z.literal('done'), result: z.unknown() }),
  z.strictObject({ type: z.literal('failed'), message: z.string().max(65_536) }),
]);
const StoredView = z.strictObject({
  scriptId: z.uuid(), sessionIds: z.array(z.uuid()).min(1).max(16), state: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), stdout: z.string(), stderr: z.string(), result: z.unknown(),
  error: z.strictObject({ code: z.string(), message: z.string(), effect: z.enum(['not_started', 'completed', 'unknown']) }).nullable(),
  trustBoundary: z.literal('authorized-test-code-not-malicious-code-sandbox'),
});
const StoredFields = { owner: z.uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), view: StoredView };
const StoredScript = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('app-qa/script/v1'), ...StoredFields }),
  z.strictObject({ schema: z.literal('app-qa/script/v2'), ...StoredFields, sourceFile: z.enum(['script.mjs', 'script.mts']), sourceDisposedAt: z.iso.datetime().nullable() }),
]);

const LAUNCH = `seconds=$1
cpu=$2
shift 2
(
  ulimit -t "$cpu" || exit 126
  ulimit -f 0 || exit 126
  ulimit -n 64 || exit 126
  ulimit -u 1 || exit 126
  exec "$@"
) &
worker=$!
( /bin/sleep "$seconds"; kill -KILL 0 ) &
wait "$worker"
kill -KILL 0
`;

function privateDirectory(root: string, path: string): string {
  const base = realpathSync(root);
  const rel = relative(base, resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AgentExecutionError('storage_scope', '코드 저장소가 프로젝트 범위 밖임');
  let current = base;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new AgentExecutionError('storage_scope', '코드 저장소 디렉터리를 신뢰할 수 없음');
  }
  return current;
}
function sandboxProfile(node: string, codeRoot: string, source: string): string {
  const system = ['/System', '/usr/lib', '/private/var/db/dyld', '/Library/Apple/System/Library', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib'];
  const readDirectories = [...system, join(codeRoot, 'src', 'core'), realpathSync(join(codeRoot, 'node_modules', 'zod'))];
  // dyld reads the root directory during bootstrap; a literal grant does not expose its subtrees.
  const files = ['/', node, source, join(codeRoot, 'src', 'runner', 'agent-worker.ts'), join(codeRoot, 'package.json'), '/dev/null', '/dev/urandom', '/dev/random'];
  return `(version 1)
(deny default)
(allow file-read-metadata)
(allow file-read* ${readDirectories.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')} ${files.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')})
(allow file-map-executable ${system.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')} (literal ${JSON.stringify(node)}))
(allow process-exec (literal ${JSON.stringify(node)}))
(allow sysctl-read)
(allow signal (target self))
(allow mach-lookup (global-name "com.apple.system.logger"))
`;
}
function validateResult(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 16_384 || item.depth > 64) throw new AgentExecutionError('output_limit', '코드 결과의 구조 한도를 초과함');
    if (item.value !== null && typeof item.value === 'object') for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
}

export function createAgentScripts(sessions: AgentSessions, options: { root: string }): AgentScripts {
  const owner = randomUUID();
  const codeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const root = realpathSync(options.root);
  const directory = privateDirectory(root, join(root, '.qa', 'agent-scripts'));
  const active = new Map<string, ActiveScript>();
  let stopping = false;
  const sourceLocks = new Map<string, FileLock>();
  const reconciliationErrors = new Map<string, AgentExecutionError>();

  const recordPath = (id: string): string => join(directory, id, 'status.json');
  const readRecord = (id: string): z.infer<typeof StoredScript> => {
    try {
      const stored = StoredScript.parse(JSON.parse(readPrivateFile(recordPath(id), MAX_RECORD).toString('utf8')));
      if (stored.view.scriptId !== id) throw new AgentExecutionError('script_record_invalid', '실행 기록 identity 불일치');
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentExecutionError('script_not_found', '명시한 코드 실행 기록 없음');
      if (error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError('script_record_invalid', '코드 실행 기록을 안전하게 읽을 수 없음');
    }
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!z.uuid().safeParse(entry.name).success) continue;
    const dir = join(directory, entry.name);
    let lease: FileLock | null = null;
    try {
      lease = acquireFileLock(join(dir, 'source.lock'), { purpose: '일시 실행 원본 정리' });
      let stored: z.infer<typeof StoredScript>;
      try { stored = readRecord(entry.name); }
      catch (error) {
        if (error instanceof AgentExecutionError && error.code === 'script_not_found' && !legacyScriptSource(dir)) continue;
        throw error;
      }
      const sourceFile = stored.schema === 'app-qa/script/v2' ? stored.sourceFile : legacyScriptSource(dir);
      if (!sourceFile) continue;
      if (stored.schema === 'app-qa/script/v1' && (stored.view.state === 'running' || stored.view.endedAt === null)) {
        throw new AgentExecutionError('source_disposal_failed', '이전 형식 실행의 원 소유자 종료 근거가 없어 활성 원본을 삭제하지 않았습니다', 'unknown');
      }
      disposeScriptSource(dir, sourceFile, stored.sourceSha256);
      if (stored.schema === 'app-qa/script/v2' && !stored.sourceDisposedAt) writeJsonAtomic(recordPath(entry.name), { ...stored, sourceDisposedAt: new Date().toISOString() });
    } catch (error) {
      if (!(error instanceof FileLockedError)) reconciliationErrors.set(entry.name, new AgentExecutionError('source_disposal_failed', '이전 코드 실행 원본의 소유권·digest·제거를 확인하지 못했습니다. 원 결과와 파일을 보존했습니다', 'unknown'));
    } finally {
      try { lease?.release(); }
      catch { reconciliationErrors.set(entry.name, new AgentExecutionError('source_disposal_failed', '이전 원본 정리 mutex의 해제를 기록하지 못했습니다', 'unknown')); }
    }
  }
  const readStored = (id: string): AgentScriptView => {
    const stored = readRecord(id);
    const error = reconciliationErrors.get(id);
    if (error && stored.owner !== owner) throw error;
    if (stored.view.state === 'running') return { ...stored.view, state: 'unknown', endedAt: null, error: { code: 'UNKNOWN_OUTCOME', message: '이 관리자가 소유한 활성 실행이 아님 — 재전송하지 않음', effect: 'unknown' } };
    return stored.view;
  };

  const run = async (request: Extract<ScriptRequest, { method: 'script.run' }>, context: AgentCallContext): Promise<AgentScriptView> => {
    if (stopping) throw new AgentExecutionError('engine_stopping', '엔진 종료 중');
    if (reconciliationErrors.size) throw new AgentExecutionError('source_reconciliation_required', '미확인 실행 원본이 남아 새 코드 실행을 시작하지 않습니다. 기존 결과·파일을 보존하고 원본 정리 오류를 확인하세요');
    if (context.scriptId) throw new AgentExecutionError('scope_denied', '코드 묶음에서 새 코드 실행 권한을 만들 수 없음');
    if (context.signal?.aborted) throw new AgentExecutionError('cancelled', '시작 전 취소됨');
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new AgentExecutionError('unsupported_worker_host', '이 실행 경로는 macOS sandbox-exec가 필요함 — 비격리 실행으로 대체하지 않음');
    if (active.size >= 8) throw new AgentExecutionError('capacity_exceeded', '동시 코드 묶음 상한 8개');
    const dir = join(directory, request.scriptId);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentExecutionError('duplicate_script', '이미 기록된 scriptId — 변경 동작을 재전송하지 않음');
      throw error;
    }
    const sourceFile = request.language === 'typescript' ? 'script.mts' : 'script.mjs';
    const source = join(dir, sourceFile);
    const sourceLock = acquireFileLock(join(dir, 'source.lock'), { purpose: '활성 코드 실행 원본' });
    sourceLocks.set(request.scriptId, sourceLock);
    let sourceDisposedAt: string | null = null;
    const policy = join(dir, 'worker.sb');
    const node = realpathSync(process.execPath);
    const sourceSha256 = sha256(request.source);
    const view: AgentScriptView = { scriptId: request.scriptId, sessionIds: request.sessionIds, state: 'running', startedAt: new Date().toISOString(), endedAt: null, stdout: '', stderr: '', result: null, error: null, trustBoundary: 'authorized-test-code-not-malicious-code-sandbox' };
    const save = (): void => writeJsonAtomic(recordPath(request.scriptId), { schema: 'app-qa/script/v2', owner, sourceSha256, sourceFile, sourceDisposedAt, view });
    const completion = Promise.withResolvers<AgentScriptView>();
    const controllers = new Map<string, AbortController>();
    const seen = new Set<string>();
    const out: Buffer[] = []; const err: Buffer[] = [];
    let outputBytes = 0;
    let reserved = false;
    let child: ChildProcess | undefined;
    let decision: { state: ScriptDisposition; result: unknown; error: AgentError | null } | null = null;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };
    const cancel = (code: string, message: string, state: ScriptDisposition): void => {
      if (decision) return;
      const effect = sessions.scriptEffect(request.scriptId);
      decision = { state: effect === 'unknown' ? 'unknown' : state, result: null, error: { code: effect === 'unknown' ? 'UNKNOWN_OUTCOME' : code, message, effect } };
      try { sessions.stopScript(request.scriptId, message); }
      catch (error) { decision.error!.message += `; 세션 증거 기록 실패: ${String(error)}`; }
      for (const controller of controllers.values()) controller.abort();
      try { kill(); }
      catch (error) {
        decision.state = 'unknown';
        decision.error!.code = 'worker_termination_unconfirmed';
        decision.error!.message += `; worker 종료 미확인: ${String(error)}`;
      }
    };
    const onAbort = () => cancel('cancelled', '클라이언트 요청이 취소됨', 'cancelled');
    const finish = async (): Promise<void> => {
      if (closed) return;
      closed = true; clearTimeout(timer); context.signal?.removeEventListener('abort', onAbort);
      let effect = sessions.scriptEffect(request.scriptId);
      const fail = (error: unknown): void => {
        const current = sessions.scriptEffect(request.scriptId);
        if (current === 'unknown' || (error instanceof AgentExecutionError && error.effect === 'unknown')) effect = 'unknown';
        else if (current === 'completed' && effect !== 'unknown') effect = 'completed';
        const message = error instanceof Error ? error.message : String(error);
        const previous = view.error;
        view.state = effect === 'unknown' ? 'unknown' : 'failed';
        view.stdout = ''; view.stderr = ''; view.result = null;
        view.error = {
          code: effect === 'unknown' ? 'UNKNOWN_OUTCOME' : previous?.code ?? (error instanceof AgentExecutionError ? error.code : 'execution_error'),
          message: sessions.sanitize(previous ? `${previous.message}; ${message}` : message, request.sessionIds),
          effect,
        };
      };
      try {
        decision ??= { state: 'failed', result: null, error: { code: 'worker_exit', message: '완료 frame 없이 코드 실행이 종료됨', effect } };
        if (decision.state === 'completed') {
          for (const sessionId of request.sessionIds) {
            const status = await sessions.call({ method: 'session.status', sessionId });
            if (!status.ok) throw new AgentExecutionError(status.error.code, status.error.message, status.error.effect);
            const session = status.result as AgentSessionView;
            if ((session.state !== 'ready' && session.state !== 'closed') || session.stopReason) {
              decision = { state: effect === 'unknown' ? 'unknown' : 'failed', result: null, error: { code: effect === 'unknown' ? 'UNKNOWN_OUTCOME' : 'session_stopped', message: session.stopReason ?? '세션 실행이 정상 완료되지 않음', effect } };
              break;
            }
          }
        }
        if (effect === 'unknown') decision = { state: 'unknown', result: null, error: { code: 'UNKNOWN_OUTCOME', message: decision.error?.message ?? '기기 변경 효과 미확인 — 자동 재전송 금지', effect } };
        validateResult(decision.result);
        view.state = decision.state;
        view.stdout = sessions.sanitize(Buffer.concat(out).toString('utf8'), request.sessionIds);
        view.stderr = sessions.sanitize(Buffer.concat(err).toString('utf8'), request.sessionIds);
        view.result = sessions.sanitize(decision.result, request.sessionIds);
        view.error = decision.error ? { ...decision.error, effect, message: sessions.sanitize(decision.error.message, request.sessionIds) } : null;
        if (Buffer.byteLength(JSON.stringify({ stdout: view.stdout, stderr: view.stderr, result: view.result })) > request.maxOutputBytes) {
          view.state = effect === 'unknown' ? 'unknown' : 'failed'; view.stdout = ''; view.stderr = ''; view.result = null;
          view.error = { code: 'output_limit', message: '정제된 출력이 한도를 초과하여 출력 전체를 보류함', effect };
        }
      } catch (error) {
        fail(error);
      } finally {
        try { disposeScriptSource(dir, sourceFile, sourceSha256); sourceDisposedAt = new Date().toISOString(); }
        catch {
          const previous = view.error;
          view.state = effect === 'unknown' ? 'unknown' : 'failed';
          view.error = { code: previous?.code ?? 'source_disposal_failed', message: sessions.sanitize(`${previous ? `${previous.message}; ` : ''}source_disposal_failed: 일시 실행 원본의 제거를 확인하지 못했습니다`, request.sessionIds), effect };
          reconciliationErrors.set(request.scriptId, new AgentExecutionError('source_disposal_failed', '일시 실행 원본의 제거를 확인하지 못했습니다', effect));
        }
        if (reserved) {
          reserved = false;
          try { await sessions.endScript(request.scriptId, view.state === 'running' ? 'failed' : view.state); }
          catch (error) { fail(error); }
        }
        view.endedAt = new Date().toISOString();
        try { save(); }
        catch (error) { fail(new AgentExecutionError('evidence_unavailable', `코드 실행 기록 실패: ${String(error)}`, effect)); }
        try { sourceLock.release(); sourceLocks.delete(request.scriptId); }
        catch {
          view.state = effect === 'unknown' ? 'unknown' : 'failed';
          view.error = { code: view.error?.code ?? 'source_disposal_failed', message: sessions.sanitize(`${view.error ? `${view.error.message}; ` : ''}source_disposal_failed: 실행 원본 mutex 해제 기록 실패`, request.sessionIds), effect };
          try { save(); } catch (error) { fail(error); }
        }
        active.delete(request.scriptId);
        completion.resolve(view);
      }
    };
    const item: ActiveScript = { view, done: completion.promise, cancel };
    active.set(request.scriptId, item);
    try {
      context.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel('deadline_exceeded', '코드 실행 기한 초과', 'cancelled'), request.deadlineMs);
      save();
      writeSecure(source, request.source);
      writeSecure(policy, sandboxProfile(node, codeRoot, source));
      await sessions.beginScript(request.scriptId, request.sessionIds);
      reserved = true;
      if (context.signal?.aborted) onAbort();
      if (decision) { await finish(); return completion.promise; }
      const reads = [source, join(codeRoot, 'src', 'runner', 'agent-worker.ts'), join(codeRoot, 'src', 'core'), join(codeRoot, 'package.json'), realpathSync(join(codeRoot, 'node_modules', 'zod'))];
      const args = ['-c', LAUNCH, 'qautra-worker', String((request.deadlineMs + 500) / 1000), String(Math.ceil(request.deadlineMs / 1000) + 1), '/usr/bin/sandbox-exec', '-f', policy, node, '--permission', '--max-old-space-size=128', '--max-semi-space-size=4', ...reads.map((path) => `--allow-fs-read=${path}`), join(codeRoot, 'src', 'runner', 'agent-worker.ts'), source, JSON.stringify(request.sessionIds)];
      child = spawn('/bin/sh', args, { cwd: dir, detached: true, env: { HOME: dir, TMPDIR: dir, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', OPENSSL_CONF: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
      const replies = child.stdio[4] as Writable;
      const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
        if (closed) return;
        outputBytes += chunk.length;
        if (outputBytes > request.maxOutputBytes) {
          out.length = 0; err.length = 0;
          if (decision?.state === 'completed') decision = null;
          cancel('output_limit', '코드 stdout/stderr 한도 초과', 'failed');
          return;
        }
        chunks.push(chunk);
      };
      child.stdout!.on('data', collect(out)); child.stderr!.on('data', collect(err));
      const decoder = new StringDecoder('utf8'); let buffered = '';
      const receive = async (message: z.infer<typeof WireMessage>): Promise<void> => {
        if (decision) return;
        if (message.type === 'done') {
          if (controllers.size) { cancel('unfinished_requests', 'await하지 않은 기기 호출이 남아 있음', 'failed'); return; }
          if (Buffer.byteLength(JSON.stringify(message.result)) + outputBytes > request.maxOutputBytes) { cancel('output_limit', '코드 반환값 한도 초과', 'failed'); return; }
          decision = { state: 'completed', result: message.result, error: null }; kill(); return;
        }
        if (message.type === 'failed') { cancel('script_error', message.message, 'failed'); return; }
        if (message.type === 'cancel') { cancel('cancelled', '코드의 세션 요청이 취소됨', 'cancelled'); return; }
        if (seen.has(message.id) || seen.size >= MAX_CALLS || controllers.size >= request.sessionIds.length) { cancel('protocol_limit', '중복 요청 또는 코드 호출 한도 초과', 'failed'); return; }
        seen.add(message.id);
        if (!('sessionId' in message.request) || !request.sessionIds.includes(message.request.sessionId)) { cancel('scope_denied', '코드 묶음의 허용 세션 밖 요청', 'failed'); return; }
        const controller = new AbortController(); controllers.set(message.id, controller);
        try {
          const reply = await sessions.call(message.request, { scriptId: request.scriptId, allowedSessionIds: request.sessionIds, signal: controller.signal });
          if (decision) return;
          appendJsonl(join(dir, 'calls.jsonl'), sessions.sanitize({ requestId: reply.meta.requestId, sessionId: message.request.sessionId, method: message.request.method, ok: reply.ok, error: reply.ok ? null : reply.error, meta: reply.meta }, request.sessionIds));
          const frame = `${JSON.stringify({ type: 'reply', id: message.id, reply })}\n`;
          if (Buffer.byteLength(frame) > MAX_FRAME || replies.writableLength > MAX_FRAME * 2) { cancel('output_limit', '세션 응답 한도 초과', 'failed'); return; }
          replies.write(frame);
        } catch (error) { cancel('execution_error', error instanceof Error ? error.message : String(error), 'failed'); }
        finally { controllers.delete(message.id); }
      };
      (child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
        if (decision) return;
        buffered += decoder.write(chunk);
        let end: number;
        while ((end = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > MAX_FRAME) { cancel('protocol_limit', '코드 frame 한도 초과', 'failed'); return; }
          let value: unknown;
          try { value = JSON.parse(line); } catch { cancel('invalid_protocol', '코드 frame 형식 오류', 'failed'); return; }
          const parsed = WireMessage.safeParse(value);
          if (!parsed.success) { cancel('invalid_protocol', '코드 요청 계약 위반', 'failed'); return; }
          void receive(parsed.data).catch((error: unknown) => cancel('execution_error', error instanceof Error ? error.message : String(error), 'failed'));
        }
        if (Buffer.byteLength(buffered) > MAX_FRAME) cancel('protocol_limit', '코드 frame 한도 초과', 'failed');
      });
      replies.on('error', () => cancel('manager_connection_lost', '관리자 응답 연결 종료', 'failed'));
      (child.stdio[3] as Readable).on('error', () => cancel('manager_connection_lost', '코드 요청 연결 종료', 'failed'));
      child.on('error', (error) => { cancel('worker_start_failed', error.message, 'failed'); void finish(); });
      child.on('close', () => { void finish(); });
    } catch (error) {
      cancel('worker_start_failed', error instanceof Error ? error.message : String(error), 'failed');
      await finish();
    }
    return completion.promise;
  };
  return {
    call: async (input, context = {}) => {
      const meta = { requestId: randomUUID(), at: new Date().toISOString(), jobId: input.scriptId };
      try {
        const request = ScriptRequestSchema.parse(input);
        if (context.scriptId) throw new AgentExecutionError('scope_denied', '코드 묶음에서 실행 관리 권한을 요청할 수 없음');
        if (request.method === 'script.run') return { ok: true, result: await run(request, context), meta };
        const item = active.get(request.scriptId);
        if (request.method === 'script.cancel') {
          if (!item) return { ok: true, result: readStored(request.scriptId), meta };
          item.cancel('cancelled', '사용자가 코드 실행을 취소함', 'cancelled');
          return { ok: true, result: await item.done, meta };
        }
        return { ok: true, result: item ? { ...item.view, stdout: '', stderr: '', result: null } : readStored(request.scriptId), meta };
      } catch (error) {
        return { ok: false, error: { code: error instanceof AgentExecutionError ? error.code : 'execution_error', message: sessions.sanitize(error instanceof Error ? error.message : String(error)), effect: error instanceof AgentExecutionError ? error.effect : 'not_started' }, meta };
      }
    },
    shutdown: async () => {
      stopping = true;
      const running = [...active.values()];
      for (const item of running) item.cancel('engine_stopping', '엔진 연결 종료', 'cancelled');
      await Promise.all(running.map((item) => item.done));
      for (const [id, lease] of sourceLocks) {
        try { lease.release(); sourceLocks.delete(id); }
        catch { reconciliationErrors.set(id, new AgentExecutionError('source_disposal_failed', '실행 원본 mutex의 해제를 확인하지 못했습니다', 'unknown')); }
      }
    },
  };
}
