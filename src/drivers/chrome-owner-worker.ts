import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import { AppiumClient, AppiumProtocolError, actionStatusOf } from '../appium/client.ts';
import { AgentExecutionError } from '../core/agent.ts';
import { ChromeOwnerLocatorSchema, ChromeOwnerRequestSchema, type ChromeOwnerRecording, type ChromeOwnerRequest, type ChromeOwnerState } from '../core/chrome-owner.ts';
import { chromeOwnerReplySignature } from '../core/chrome-owner-auth.ts';
import { commitDirectory } from '../core/fsx.ts';
import type { TargetRecording } from '../core/recording.ts';
import { RefusedError } from './base.ts';
import { archiveChromeOwnerEvidence, ChromeEvidenceArchiveError } from './chrome-owner-evidence.ts';
import { readChromeOwnerMaterial, assertChromeOwnerMaterial, writeChromeOwnerAddress, writeChromeOwnerState } from './chrome-owner-storage.ts';
import { resolveOwnedChromePage } from './chrome-page.ts';
import { startOwnedChromeEndpoint, OwnedChromeStartupError, type OwnedChromeEndpoint } from './owned-chrome.ts';
import { startOwnedChromeRecording, OwnedChromeRecordingStartError } from './owned-chrome-recording.ts';

type Problem = NonNullable<ChromeOwnerState['problem']>;
type Slot = { view: ChromeOwnerRecording; handle: TargetRecording | null; controller: AbortController; starting: Promise<void> | null; stopping: Promise<ChromeOwnerRecording> | null };
const failure = (code: string, message: string, effect: Problem['effect'] = 'unknown'): Problem => ({ code, message, effect });
const refused = (code: string, message: string): AgentExecutionError => new AgentExecutionError(code, message);
const idleCapture = (): ChromeOwnerRecording['status'] => ({ capture: 'unknown', encoder: 'unknown', spool: 'pending', file: 'pending', media: 'pending', diagnostics: [] });
function sameToken(actual: string | string[] | undefined, expected: string): boolean { return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); }
async function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const part: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > maximum) throw refused('native_request_too_large', 'Native 요청 크기 상한을 초과했습니다');
    chunks.push(part);
  }
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes))) as unknown;
}

async function main(): Promise<void> {
  const [directory, ownerId, seedSha256, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected native owner arguments');
  const material = readChromeOwnerMaterial(ChromeOwnerLocatorSchema.parse({ directory, ownerId, seedSha256 }));
  const claim = await open(join(material.locator.directory, 'runtime.claim'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await claim.writeFile(JSON.stringify({ ownerId, seedSha256, startedAt: new Date().toISOString() })); await claim.sync(); } finally { await claim.close(); }
  commitDirectory(material.locator.directory);
  const state: ChromeOwnerState = {
    schema: 'qautra/chrome-owner-state/v1', scope: material.seed.scope, seedSha256: material.locator.seedSha256,
    phase: 'preparing', native: { schema: 'qautra/owned-chrome-native/v1', browser: { state: 'not-started' }, driver: { state: 'not-started' }, profile: 'not-created' }, endpoint: null,
    browserSessionId: null, creationRequested: false, sessionDelete: 'not-requested', recordings: [], evidenceFinalized: false,
    evidenceFile: null, evidenceSha256: null, problem: null, observedAt: new Date().toISOString(), lastMutation: null,
  };
  const slots = new Map<string, Slot>();
  const seen = new Set<string>();
  const cancelled = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let proxyTail: Promise<void> = Promise.resolve();
  let endpoint: OwnedChromeEndpoint | null = null, client: AppiumClient | null = null;
  let boot: Promise<void> = Promise.resolve(), stopping: Promise<ChromeOwnerState> | null = null;
  let lastHeartbeat = performance.now(), previousMono = lastHeartbeat, previousWall = Date.now();
  let shutdown: NodeJS.Timeout | null = null;
  let automaticCleanupRequested = false;
  function publish(): void {
    if (endpoint) state.native = endpoint.nativeStatus();
    state.recordings = [...slots.values()].map(slot => slot.view);
    state.observedAt = new Date().toISOString();
    writeChromeOwnerState(material, state);
  }
  function publishCleanup(): void {
    try { publish(); }
    catch { state.problem ??= failure('native_journal_unavailable', '원 native 기록 저장이 미확인입니다. 정리·입력 차단은 유지합니다'); }
  }
  function fence(problem: Problem): void {
    if (state.phase === 'closed') return;
    if (state.phase !== 'stopping') state.phase = 'fenced';
    state.problem ??= problem;
    publishCleanup();
  }
  function ready(): { endpoint: OwnedChromeEndpoint; client: AppiumClient } {
    if (state.phase !== 'ready' || !endpoint || !client) throw refused('native_owner_fenced', '원 native 소유자가 새 동작을 허용하지 않습니다');
    endpoint.assertHealthy();
    return { endpoint, client };
  }
  async function refresh(slot: Slot): Promise<void> { if (slot.handle) slot.view.status = await slot.handle.status(); }
  async function finish(slot: Slot): Promise<ChromeOwnerRecording> {
    if (slot.stopping) return slot.stopping;
    slot.stopping = (async () => {
      await slot.starting;
      if (!slot.handle) { publishCleanup(); return slot.view; }
      slot.view.state = 'stopping'; publishCleanup();
      try {
        slot.view.segment = await slot.handle.stop();
        slot.view.state = 'stopped';
      } catch (error) {
        slot.view.state = 'failed';
        slot.view.problem ??= failure(error instanceof AgentExecutionError ? error.code : 'native_recording_stop_unknown', '원 녹화 종료·미디어 검증을 확정하지 못했습니다');
      } finally { await refresh(slot); publishCleanup(); }
      return slot.view;
    })();
    return slot.stopping;
  }
  async function stopNative(): Promise<ChromeOwnerState> {
    if (state.phase === 'closed') return state;
    if (stopping) return stopping;
    stopping = (async () => {
      state.phase = 'stopping'; publishCleanup();
      await boot;
      await Promise.allSettled([...pending]);
      for (const slot of slots.values()) await finish(slot);
      if (endpoint) await endpoint.close();
      publishCleanup();
      const archived = archiveChromeOwnerEvidence(material, state);
      state.evidenceFile = archived.file; state.evidenceSha256 = archived.sha256; state.evidenceFinalized = true;
      state.phase = 'closed'; publish();
      clearInterval(monitor);
      shutdown ??= setTimeout(() => server.close(() => { server.closeAllConnections(); }), 2000).unref();
      return state;
    })().catch(error => {
      state.phase = 'fenced';
      if (error instanceof ChromeEvidenceArchiveError) state.evidenceFile = error.file;
      state.problem ??= failure(error instanceof AgentExecutionError ? error.code : 'native_stop_unknown', '원 native 종료 또는 증거 저장이 미확인입니다');
      publishCleanup(); throw error;
    }).finally(() => { stopping = null; });
    return stopping;
  }
  function remember(id: string): void {
    if (seen.has(id)) throw refused('native_request_duplicate', '동일 native 요청을 다시 실행하지 않습니다');
    if (seen.size >= 100_000) throw refused('native_request_budget_exhausted', 'Native 요청 예산을 초과했습니다. 새 테스트를 시작하지 않습니다');
    seen.add(id);
  }
  async function startRecording(request: Extract<ChromeOwnerRequest, { method: 'recording.start' }>): Promise<ChromeOwnerRecording> {
    const owned = ready();
    if (!client?.sessionId || state.sessionDelete !== 'not-requested') throw refused('native_session_required', '원 browser 세션이 준비되지 않았습니다');
    if (cancelled.has(request.recordingId) || slots.has(request.recordingId) || slots.size >= 128 || [...slots.values()].some(slot => ['starting', 'recording', 'stopping'].includes(slot.view.state))) throw refused('native_recording_conflict', '취소·기존 capture를 중복 시작하거나 덮어쓰지 않습니다');
    const local = relative(state.scope.projectRoot, resolve(request.file));
    if (!local || local === '..' || local.startsWith(`..${sep}`) || local.startsWith(sep) || request.binding.deviceId !== state.scope.deviceId || request.binding.generation !== (state.scope.instance?.generation ?? null)) throw refused('native_recording_scope_changed', '원 capture 경로·기기·세대와 다릅니다');
    const original = slots.values().next().value as Slot | undefined;
    if (original && (JSON.stringify(original.view.binding) !== JSON.stringify(request.binding) || [...slots.values()].some(slot => slot.view.file === resolve(request.file)))) throw refused('native_recording_scope_changed', '원 attempt의 capture binding·파일을 재사용하지 않습니다');
    if (request.captureExpiresAt !== null && Date.parse(request.captureExpiresAt) <= Date.now()) throw refused('capture_permission_expired', '원 capture 권한이 만료되었습니다');
    const slot: Slot = {
      view: { id: request.recordingId, binding: request.binding, file: resolve(request.file), state: 'starting', readyAt: null, firstFrameAt: null, captureExpiresAt: request.captureExpiresAt, maxDurationMs: null, status: idleCapture(), segment: null, problem: null },
      handle: null, controller: new AbortController(), starting: null, stopping: null,
    };
    slots.set(slot.view.id, slot); publish();
    slot.starting = (async () => {
      try {
        const source = { platform: 'desktop-chrome' as const, deviceId: state.scope.deviceId, ownedChromePage: () => resolveOwnedChromePage(owned.endpoint, owned.client) };
        slot.handle = await startOwnedChromeRecording(source, { binding: request.binding, file: slot.view.file, signal: slot.controller.signal, ...(request.captureExpiresAt === null ? {} : { captureExpiresAt: request.captureExpiresAt }) });
        slot.view.readyAt = slot.handle.readyAt; slot.view.firstFrameAt = slot.handle.firstFrameAt; slot.view.maxDurationMs = slot.handle.maxDurationMs;
        slot.view.state = 'recording'; await refresh(slot); publish();
        void slot.handle.lost.then(error => {
          slot.view.problem ??= failure(error instanceof AgentExecutionError ? error.code : 'native_capture_lost', '원 capture가 중단되었습니다');
          fence(slot.view.problem);
        }).catch(() => { state.phase = 'fenced'; });
      } catch (error) {
        slot.view.state = 'failed';
        if (error instanceof OwnedChromeRecordingStartError) slot.view.status = error.recordingStatus;
        slot.view.problem = failure(error instanceof AgentExecutionError ? error.code : 'native_recording_start_unknown', '원 녹화 시작 결과를 확정하지 못했습니다', error instanceof AgentExecutionError && error.effect === 'not_started' ? 'not_started' : 'unknown');
        fence(slot.view.problem);
      }
    })();
    await slot.starting;
    return slot.view;
  }
  async function control(request: ChromeOwnerRequest, recovery: boolean): Promise<unknown> {
    if (request.ownerId !== state.scope.id || request.seedSha256 !== state.seedSha256) throw refused('native_scope_changed', '다른 native 소유자·세대의 요청입니다');
    remember(request.id);
    if (recovery && ['heartbeat', 'recording.start', 'recording.before'].includes(request.method)) throw refused('native_recovery_readonly', '복구 권한으로 새 실행·capture를 시작하지 않습니다');
    if (request.method === 'status') { for (const slot of slots.values()) await refresh(slot); publish(); return state; }
    if (request.method === 'heartbeat') { lastHeartbeat = performance.now(); return null; }
    if (request.method === 'native.stop') return stopNative();
    if (request.method === 'recording.start') return startRecording(request);
    if (request.method === 'recording.cancel') {
      cancelled.add(request.recordingId);
      const active = slots.get(request.recordingId);
      if (active && ['starting', 'recording', 'stopping'].includes(active.view.state)) {
        active.controller.abort(refused('capture_permission_withdrawn', '원 capture 권한이 철회되었습니다'));
        void finish(active).catch(() => {});
      }
      return null;
    }
    const slot = slots.get(request.recordingId);
    if (!slot) throw refused('native_recording_not_found', '원 capture ID를 찾을 수 없습니다');
    if (request.method === 'recording.stop') return finish(slot);
    if (request.method === 'recording.before') {
      ready();
      if (!slot.handle || slot.view.state !== 'recording' || slot.view.problem) throw refused('native_capture_not_ready', '원 capture가 새 동작을 기록할 수 없습니다');
      await slot.handle.beforeDispatch();
      return null;
    }
    await refresh(slot); publish(); return slot.view;
  }
  async function webdriver(method: 'GET' | 'POST' | 'DELETE', path: string, value: unknown, id: string, timeoutMs: number): Promise<unknown> {
    remember(id);
    const deletion = method === 'DELETE' && path === `/session/${state.browserSessionId}`;
    const owned = deletion && ['ready', 'fenced'].includes(state.phase) && endpoint && client ? { endpoint, client } : ready();
    if (method === 'POST' && path === '/session') {
      if (state.creationRequested) throw refused('native_session_duplicate', '원 browser 세션 생성을 반복하지 않습니다');
      const parsed = value as { capabilities?: { alwaysMatch?: Record<string, unknown>; firstMatch?: unknown } } | null;
      const capabilities = parsed?.capabilities?.alwaysMatch;
      const chrome = capabilities?.['goog:chromeOptions'];
      if (!capabilities || capabilities.browserName !== 'chrome' || JSON.stringify(chrome) !== JSON.stringify({ debuggerAddress: owned.endpoint.debuggerAddress }) || JSON.stringify(parsed?.capabilities?.firstMatch) !== '[{}]') throw refused('native_browser_scope_changed', '원 private Chrome debugger에만 연결할 수 있습니다');
      state.creationRequested = true; publish();
      const actual = await owned.client.createSession(capabilities, timeoutMs);
      state.browserSessionId = owned.client.sessionId; publish();
      for (const name of ['clipboard-read', 'clipboard-write']) await owned.client.cmd('POST', '/goog/cdp/execute', { cmd: 'Browser.setPermission', params: { permission: { name }, setting: 'denied' } });
      await owned.client.cmd('POST', '/goog/cdp/execute', { cmd: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } });
      return { sessionId: owned.client.sessionId, capabilities: actual };
    }
    if (!state.browserSessionId || (path !== `/session/${state.browserSessionId}` && !path.startsWith(`/session/${state.browserSessionId}/`))) throw refused('native_session_scope_changed', '다른 browser 세션을 제어하지 않습니다');
    if (deletion) {
      if (state.sessionDelete !== 'not-requested') throw refused('native_delete_duplicate', '응답이 유실된 browser 종료를 재전송하지 않습니다');
      state.sessionDelete = 'pending'; publish();
      try { await owned.client.deleteSession(timeoutMs); state.sessionDelete = 'confirmed'; publish(); return null; }
      catch (error) { state.sessionDelete = 'unknown'; publish(); throw error; }
    }
    if (state.sessionDelete !== 'not-requested') throw refused('native_session_ending', '종료 중인 browser에 동작을 보내지 않습니다');
    const mutation = method !== 'GET' && !(method === 'POST' && path.endsWith('/se/log'));
    if (mutation) {
      const latest = [...slots.values()].at(-1);
      if (latest) {
        if (!latest.handle || latest.view.state !== 'recording' || latest.view.problem) throw refused('native_capture_not_ready', '원 capture 종료·손실 후 새 동작을 보내지 않습니다');
        await latest.handle.beforeDispatch();
      }
      state.lastMutation = { id, path, state: 'pending' }; publish();
    }
    let result: unknown;
    try { result = await owned.client.request(method, path, value, timeoutMs); }
    catch (error) {
      if (mutation) {
        const rejected = actionStatusOf(error) === 'rejected';
        state.lastMutation = { id, path, state: rejected ? 'rejected' : 'unknown' };
        if (!rejected) fence(failure('native_command_unknown', '원 browser 동작 결과가 미확인이므로 새 입력을 차단했습니다'));
        else publishCleanup();
      }
      throw error;
    }
    if (mutation) {
      state.lastMutation = { id, path, state: 'completed' };
      try { publish(); }
      catch (error) { fence(failure('native_journal_unavailable', '원 동작 결과 저장이 미확인입니다')); throw error; }
    }
    return result;
  }
  let port = 0;
  function send(response: ServerResponse, id: string, status: number, value: unknown): void {
    let text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) { status = 500; text = JSON.stringify({ value: { error: 'unknown error', message: 'Native response exceeds its byte bound' } }); }
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-qautra-owner-signature': chromeOwnerReplySignature(material.seed.replyKey, id, status, text) });
    response.end(text);
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}` || request.socket.remoteAddress !== '127.0.0.1') { response.writeHead(403).end(); return; }
      const token = request.headers['x-qautra-owner-token'];
      const recovery = sameToken(token, material.seed.recoveryToken);
      if (!recovery && !sameToken(token, material.seed.controlToken)) { response.writeHead(403).end(); return; }
      const id = request.headers['x-qautra-owner-request'];
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) { response.writeHead(400).end(); return; }
      let rpc = false;
      try {
        assertChromeOwnerMaterial(material);
        if (request.url === '/control' && request.method === 'POST') {
          rpc = true;
          const command = ChromeOwnerRequestSchema.parse(await body(request, 65_536));
          if (command.id !== id) throw refused('native_request_identity_changed', 'Native 응답 challenge와 요청이 다릅니다');
          const result = await control(command, recovery);
          send(response, id, 200, { ok: true, id, ownerId: state.scope.id, result }); return;
        }
        if (recovery || !['GET', 'POST', 'DELETE'].includes(request.method ?? '') || !request.url?.startsWith('/webdriver/') || request.url.includes('?') || request.url.includes('#') || request.url.length > 4096) throw refused('native_route_refused', '허용된 원 browser 경로만 제어합니다');
        const timeout = Number(request.headers['x-qautra-owner-timeout']);
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 240_000) throw refused('native_timeout_invalid', 'Native 요청 제한 시간이 올바르지 않습니다');
        if (pending.size >= 8) throw refused('native_queue_full', '원 browser 대기 요청 상한을 초과했습니다');
        const value = await body(request, 16 * 1024 * 1024);
        const method = request.method as 'GET' | 'POST' | 'DELETE', path = request.url.slice('/webdriver'.length);
        const command = proxyTail.then(() => webdriver(method, path, value, id, timeout));
        proxyTail = command.then(() => undefined, () => undefined);
        pending.add(command);
        try { send(response, id, 200, { value: await command }); }
        finally { pending.delete(command); }
      } catch (error) {
        if (rpc) {
          const problem = error instanceof AgentExecutionError ? failure(error.code, error.message, error.effect === 'not_started' ? 'not_started' : 'unknown') : failure('native_control_unknown', '원 native 제어 결과가 미확인입니다');
          send(response, id, 200, { ok: false, id, ownerId: state.scope.id, error: problem });
        } else {
          const code = error instanceof AppiumProtocolError ? error.code : error instanceof AgentExecutionError && error.effect === 'not_started' ? 'unsupported operation' : 'unknown error';
          send(response, id, error instanceof AppiumProtocolError ? error.httpStatus : 500, { value: { error: code, message: error instanceof AppiumProtocolError ? error.message : '원 native browser 요청이 거부되었거나 미확인입니다' } });
        }
      }
    })().catch(() => { response.destroy(); });
  });
  server.headersTimeout = 5000; server.requestTimeout = 245_000; server.maxRequestsPerSocket = 1000;
  publish();
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native owner has no private loopback port');
  port = address.port; writeChromeOwnerAddress(material, port);
  const monitor = setInterval(() => {
    if (state.phase === 'closed' || state.phase === 'stopping') return;
    try {
      const now = performance.now(), wall = Date.now();
      const clockChanged = wall < previousWall || Math.abs((wall - previousWall) - (now - previousMono)) > 2000 || now - previousMono > 5000;
      previousMono = now; previousWall = wall;
      for (const slot of slots.values()) if (slot.view.captureExpiresAt && wall >= Date.parse(slot.view.captureExpiresAt) && ['starting', 'recording'].includes(slot.view.state)) {
        slot.controller.abort(refused('capture_permission_expired', '원 capture 권한이 만료되었습니다'));
        fence(failure('capture_permission_expired', '원 capture 권한 만료 후 새 동작을 차단했습니다'));
        void finish(slot).catch(() => {});
      }
      if (!automaticCleanupRequested && (clockChanged || now - lastHeartbeat > 6000)) {
        automaticCleanupRequested = true;
        try { fence(failure(clockChanged ? 'native_clock_unverified' : 'native_controller_lost', '원 controller 연결·시계를 확인할 수 없어 새 동작을 차단했습니다')); }
        finally { void stopNative().catch(() => {}); }
      } else if (state.phase === 'ready') endpoint?.assertHealthy();
    } catch { try { fence(failure('native_owner_unhealthy', '원 native 상태를 확인할 수 없어 새 동작을 차단했습니다')); } catch { state.phase = 'fenced'; } }
  }, 500).unref();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { try { fence(failure('native_owner_stopping', '원 native 소유자의 종료를 요청받았습니다')); } catch { state.phase = 'fenced'; } void stopNative().catch(() => {}); });
  boot = (async () => {
    try {
      endpoint = await startOwnedChromeEndpoint();
      client = new AppiumClient(endpoint.url, { responseByteLimit: 16 * 1024 * 1024 });
      state.endpoint = { profile: endpoint.profile, binary: endpoint.binary, args: [...endpoint.args], debuggerAddress: endpoint.debuggerAddress };
      if (state.phase === 'preparing') state.phase = 'ready';
    } catch (error) {
      if (error instanceof OwnedChromeStartupError) state.native = error.nativeStatus;
      else if (!(error instanceof RefusedError)) state.native = null;
      state.phase = 'failed';
      state.problem = failure('native_start_failed', '원 private Chrome 준비에 실패했습니다', error instanceof RefusedError ? 'not_started' : 'unknown');
    }
    publish();
  })();
  void boot.catch(() => {
    state.phase = 'fenced';
    state.problem ??= failure('native_journal_unavailable', '원 native 상태 저장이 불가능하여 새 동작을 차단했습니다');
  }).finally(() => { if (state.phase !== 'ready') void stopNative().catch(() => {}); }).catch(() => { state.phase = 'fenced'; });
}

await main();
