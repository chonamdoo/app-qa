// Engine HTTP server (`qa serve`): 127.0.0.1 only, bearer-token auth on every route, SSE events, job queue, file views.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, existsSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { AgentRequestSchema, type AgentCallContext, type AgentService } from '../core/agent.ts';
import { PATHS } from '../core/config.ts';
import { EventBus } from '../core/events.ts';
import { writeSecure } from '../core/fsx.ts';
import { PLATFORM_INFO, PLATFORMS } from '../core/platform.ts';
import type { DeviceInfo, Platform } from '../core/types.ts';
import type { SourceIngestor } from '../core/product.ts';
import type { ProductAuthoringAdapter } from '../core/product-authoring.ts';
import { ProductEvidenceError, type PortableEvidenceRenderer, type RunEvidenceReader } from '../core/product-evidence.ts';
import { loadAppProfile } from '../spec/load.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';
import { JobQueue, JobRequest, type JobHandlers } from './jobs.ts';
import { ProductStore, ProductStoreError } from './product-store.ts';
import { ProductAuthoringService } from './product-authoring.ts';
import { ProductEvidenceService, type ProductEvidencePolicy } from './product-evidence.ts';
import { SseHub } from './sse.ts';
import { DOC_EXTENSIONS, listAppProfiles, listPlans, listRuns, PathRejected, readPlanView, resolveInside, resolvePlanDocs, runDirFor } from './store.ts';

export interface ServerHandlers extends JobHandlers {
  agent: AgentService;
  devices(): Promise<DeviceInfo[]>;
  /** PNG of the device screen (Android px, iOS pixels). */
  screen(platform: Platform, deviceId: string): Promise<Uint8Array>;
  /** Installed (user) apps on a device. */
  apps(platform: Platform, deviceId: string): Promise<unknown[]>;
  startRecording(platform: Platform, deviceId: string, file: string): Promise<void>;
  stopRecording(platform: Platform, deviceId: string, file: string): Promise<string>;
}

export interface ServerPaths {
  root: string;
  runs: string;
  apps: string;
  /** Where `qa plan` writes `<app>/plan.json`. */
  generated: string;
  uploads: string;
  recordings: string;
}

export interface ServerOptions {
  handlers: ServerHandlers;
  paths?: Partial<ServerPaths>;
  bus?: EventBus;
  token?: string;
  /** Operator review secret delivered only by the launching app; absent → every operator-only action is refused. */
  reviewToken?: string;
  ingestSource?: SourceIngestor;
  authoringAdapter?: ProductAuthoringAdapter;
  evidenceAuthorityRoot?: string;
  evidencePolicy?: () => ProductEvidencePolicy;
  evidenceHtml?: PortableEvidenceRenderer;
  ringSize?: number;
  heartbeatMs?: number;
  maxUploadBytes?: number;
}

export interface QaServer {
  readonly token: string;
  readonly startedAt: string;
  readonly bus: EventBus;
  readonly jobs: JobQueue;
  readonly paths: ServerPaths;
  /** Binds 127.0.0.1:`port` (0 = ephemeral) and returns the bound port. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.mp4': 'video/mp4',
};

const MAX_JSON_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `요청 본문이 너무 큽니다 (최대 ${limit} 바이트)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<object> {
  const body = await readBody(req, MAX_JSON_BYTES);
  if (body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 본문을 해석할 수 없습니다');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'JSON 본문은 객체여야 합니다');
  return value;
}

/** A platform path/query value; `desktopRefusal` = why a device-only route refuses desktop browsers (409). */
function platformParam(value: string | undefined, desktopRefusal?: string): Platform {
  const platform = PLATFORMS.find((p) => p === value);
  if (!platform) throw new HttpError(400, `알 수 없는 플랫폼: ${value}`);
  if (desktopRefusal && PLATFORM_INFO[platform].host === 'desktop') throw new HttpError(409, `${PLATFORM_INFO[platform].label}: ${desktopRefusal}`);
  return platform;
}

/** Upload names keep letters (incl. Hangul), digits, `._ -`; everything else becomes `_`. */
function sanitizeFileName(raw: string): string {
  const name = basename(raw.normalize('NFC'))
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^[.\s]+/, '')
    .slice(-120);
  if (!name) throw new HttpError(400, '파일 이름이 비어 있습니다');
  return name;
}

type Route = {
  method: string;
  pattern: RegExp;
  /** Pass captured groups still percent-encoded (the handler validates segments itself). */
  rawParams?: true;
  handle: (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void> | void;
};

export function createServer(opts: ServerOptions): QaServer {
  const paths: ServerPaths = {
    root: PATHS.root,
    runs: PATHS.runs,
    apps: PATHS.apps,
    generated: join(PATHS.tests, 'generated'),
    uploads: join(PATHS.state, 'uploads'),
    recordings: join(PATHS.state, 'recordings'),
    ...opts.paths,
  };
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const reviewToken = opts.reviewToken;
  if (reviewToken !== undefined && (!reviewToken || reviewToken === token)) throw new Error('로컬 검토 권한은 일반 API 인증과 분리해야 합니다');
  const expectedReview = reviewToken === undefined ? undefined : Buffer.from(reviewToken);
  const principal = userInfo();
  const reviewer = Object.freeze({ principalId: `local-user:${principal.uid}:${principal.username}`, channel: 'local-ui' as const });
  const operatorReview = (req: IncomingMessage): AgentCallContext['operatorReview'] => {
    const header = req.headers['x-qautra-review-token'];
    if (header === undefined) return undefined;
    if (typeof header !== 'string') throw new HttpError(403, '단일 로컬 검토 권한이 필요합니다');
    if (!expectedReview) throw new HttpError(403, '이 엔진에는 로컬 검토 채널이 없습니다. QAutra 앱이 시작한 엔진에서만 검토 작업을 할 수 있습니다');
    const supplied = Buffer.from(header);
    if (supplied.length !== expectedReview.length || !timingSafeEqual(supplied, expectedReview)) throw new HttpError(403, '유효한 로컬 검토 권한이 필요합니다');
    return reviewer;
  };
  const bus = opts.bus ?? new EventBus();
  const handlers = opts.handlers;
  const profileOf = (app: string): AppProfile | null => {
    try {
      return loadAppProfile(app, paths.apps);
    } catch {
      return null;
    }
  };
  const jobs = new JobQueue(handlers, bus, profileOf);
  const product = new ProductStore(paths, { ingestSource: opts.ingestSource });
  const authoring = new ProductAuthoringService({ root: paths.root, apps: paths.apps, store: product, adapter: opts.authoringAdapter });
  const evidence = new ProductEvidenceService({ root: paths.root, runsDir: paths.runs, query: handlers.agent, authorityRoot: opts.evidenceAuthorityRoot, policy: opts.evidencePolicy, renderPortableHtml: opts.evidenceHtml });
  const hub = new SseHub(bus, { capacity: opts.ringSize ?? 5000, heartbeatMs: opts.heartbeatMs ?? 15_000 });
  const maxUpload = opts.maxUploadBytes ?? 50 * 1024 * 1024;
  const startedAt = new Date().toISOString();
  /** `<platform>:<deviceId>` → recording file. */
  const recordings = new Map<string, { platform: Platform; deviceId: string; file: string; startedAt: string }>();
  let stopping = false;
  let closing: Promise<void> | null = null;
  const agentCalls = new Set<AbortController>();

  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handle: (_req, res) => sendJson(res, 200, { ok: true, pid: process.pid, startedAt, root: paths.root, productProtocol: 'qautra/product/v2' }) },
    { method: 'GET', pattern: /^\/api\/product$/, handle: async (_req, res) => sendJson(res, 200, await product.read()) },
    {
      method: 'POST',
      pattern: /^\/api\/product\/authoring$/,
      handle: async (req, res) => {
        if (stopping) throw new HttpError(503, 'Engine is stopping');
        sendJson(res, 200, await authoring.dispatch(await readJson(req), { operatorReview: operatorReview(req) }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/product\/evidence$/,
      handle: async (req, res) => {
        if (stopping) throw new HttpError(503, 'Engine is stopping');
        sendJson(res, 200, await evidence.dispatch(await readJson(req), { operatorReview: operatorReview(req) }));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/product\/evidence\/exports\/([a-fA-F0-9-]{36})$/,
      handle: (req, res, [exportID]) => {
        const download = evidence.openDownload(exportID!, { operatorReview: operatorReview(req) });
        streamOwnedFile(res, download, 'application/x-tar', download.filename);
      },
    },
    ...(['scenarios', 'documents', 'document-rows', 'environments', 'settings'] as const).map((kind): Route => ({
      method: 'POST',
      pattern: new RegExp(`^/api/product/${kind}$`),
      handle: async (req, res) => {
        const snapshot = await product.update(kind, await readJson(req), { reviewer: operatorReview(req) });
        bus.emit({ type: 'log', level: 'info', source: 'workspace', message: `작업 공간 저장 · ${kind} · revision ${snapshot.revision}` });
        sendJson(res, kind === 'settings' ? 200 : 201, snapshot);
      },
    })),
    {
      method: 'POST',
      pattern: /^\/api\/agent$/,
      handle: async (req, res) => {
        const parsed = AgentRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'Agent request does not match the shared schema');
        if (stopping) throw new HttpError(503, 'Engine is stopping');
        const review = operatorReview(req);
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        if (req.aborted || res.destroyed) controller.abort();
        agentCalls.add(controller);
        try {
          const reply = await handlers.agent.call(parsed.data, { signal: controller.signal, operatorReview: review });
          if (!res.destroyed) sendJson(res, 200, reply);
        } catch {
          throw new HttpError(500, 'Agent service failed; reconcile the request before retrying');
        } finally {
          agentCalls.delete(controller);
          req.off('aborted', abort);
          res.off('close', abort);
        }
      },
    },
    { method: 'GET', pattern: /^\/api\/events$/, handle: (req, res) => hub.attach(req, res) },
    { method: 'GET', pattern: /^\/api\/jobs$/, handle: (_req, res) => sendJson(res, 200, { jobs: jobs.list() }) },
    {
      method: 'POST',
      pattern: /^\/api\/jobs$/,
      handle: async (req, res) => {
        const parsed = JobRequest.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, '작업 요청이 올바르지 않습니다', parsed.error.issues);
        const request = parsed.data;
        if (request.kind === 'plan') {
          // `docRoots` belongs to the server: a client value is dropped, and set only for the files resolved here.
          request.params.docRoots = undefined;
          if (request.params.docs.length) {
            const profile = (await listAppProfiles(paths.apps)).profiles.find((p) => p.id === request.params.app);
            Object.assign(request.params, resolvePlanDocs(request.params.docs, { root: paths.root, roots: [paths.root, paths.uploads], allowed: profile?.docs ?? [] }));
          }
        }
        sendJson(res, 201, jobs.enqueue(request));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/jobs\/([^/]+)$/,
      handle: (_req, res, [id]) => {
        const job = jobs.get(id!);
        if (!job) throw new HttpError(404, '작업을 찾을 수 없습니다');
        sendJson(res, 200, job);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/jobs\/([^/]+)\/output$/,
      handle: (_req, res, [id]) => {
        const job = jobs.get(id!);
        if (!job) throw new HttpError(404, '작업을 찾을 수 없습니다');
        if (job.state !== 'succeeded') throw new HttpError(409, '성공한 작업의 결과만 조회할 수 있습니다');
        const output = jobs.output(id!);
        if (!output) throw new HttpError(404, '이 작업에는 별도 화면 조회·캡처 결과가 없습니다');
        sendJson(res, 200, output);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/jobs\/([^/]+)\/cancel$/,
      handle: (_req, res, [id]) => {
        const result = jobs.cancel(id!);
        if (result === 'not_found') throw new HttpError(404, '작업을 찾을 수 없습니다');
        if (result === 'finished') throw new HttpError(409, '이미 끝난 작업입니다');
        sendJson(res, 202, result);
      },
    },
    { method: 'GET', pattern: /^\/api\/devices$/, handle: async (_req, res) => sendJson(res, 200, { devices: await handlers.devices() }) },
    {
      method: 'GET',
      pattern: /^\/api\/devices\/([^/]+)\/([^/]+)\/screen$/,
      handle: async (_req, res, [platform, id]) => {
        const png = await handlers.screen(platformParam(platform), id!);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.byteLength, 'cache-control': 'no-store' });
        res.end(png);
      },
    },
    { method: 'GET', pattern: /^\/api\/recordings$/, handle: (_req, res) => sendJson(res, 200, { recordings: [...recordings.values()] }) },
    {
      method: 'POST',
      pattern: /^\/api\/devices\/([^/]+)\/([^/]+)\/recording$/,
      handle: async (req, res, [rawPlatform, deviceId]) => {
        const platform = platformParam(rawPlatform, '데스크톱 브라우저는 화면 녹화를 지원하지 않습니다');
        const body = await readJson(req);
        if (!('on' in body) || typeof body.on !== 'boolean') throw new HttpError(400, '{"on": true|false} 가 필요합니다');
        const key = `${platform}:${deviceId}`;
        const active = recordings.get(key);
        if (body.on) {
          if (active) throw new HttpError(409, '이미 녹화 중입니다');
          const file = join(paths.recordings, `${new Date().toISOString().replace(/[:.]/g, '-')}-${platform}-${deviceId!.replace(/[^\w.-]/g, '_')}.mp4`);
          await handlers.startRecording(platform, deviceId!, file);
          const entry = { platform, deviceId: deviceId!, file, startedAt: new Date().toISOString() };
          recordings.set(key, entry);
          bus.emit({ type: 'log', level: 'info', source: 'recording', message: `녹화 시작 · ${platform} ${deviceId}` });
          sendJson(res, 200, { recording: true, ...entry });
        } else {
          if (!active) throw new HttpError(409, '녹화 중이 아닙니다');
          recordings.delete(key);
          const file = await handlers.stopRecording(platform, deviceId!, active.file);
          bus.emit({ type: 'log', level: 'info', source: 'recording', message: `녹화 저장 · ${file}` });
          sendJson(res, 200, { recording: false, ...active, file });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/apps$/,
      handle: async (_req, res, _params, url) => {
        const deviceId = url.searchParams.get('device');
        if (!deviceId) throw new HttpError(400, 'device 쿼리가 필요합니다');
        sendJson(res, 200, { apps: await handlers.apps(platformParam(url.searchParams.get('platform') ?? undefined, '데스크톱 브라우저에는 설치 앱 목록이 없습니다'), deviceId) });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/app-profiles$/,
      handle: async (_req, res) => {
        const { profiles, errors } = await listAppProfiles(paths.apps);
        // `platforms` = where the profile runs (app: configured android/ios; web: its browsers), so clients never re-derive it.
        sendJson(res, 200, { profiles: profiles.map((p) => ({ ...p, platforms: profilePlatforms(p) })), errors });
      },
    },
    { method: 'GET', pattern: /^\/api\/plans$/, handle: async (_req, res) => sendJson(res, 200, { plans: await listPlans(paths.generated) }) },
    {
      method: 'GET',
      pattern: /^\/api\/plans\/([^/]+)$/,
      handle: async (_req, res, [app]) => {
        const view = await readPlanView({ root: paths.root, generatedDir: paths.generated, runsDir: paths.runs, appsDir: paths.apps, app: app! });
        if (view === null) throw new HttpError(404, `${app} 계획(plan.json)이 없습니다`);
        if ('error' in view) throw new HttpError(422, `plan.json 검증 실패: ${view.error}`);
        sendJson(res, 200, view);
      },
    },
    { method: 'GET', pattern: /^\/api\/runs$/, handle: async (_req, res) => sendJson(res, 200, { runs: await listRuns(paths.runs) }) },
    {
      method: 'GET',
      pattern: /^\/api\/runs\/([^/]+)$/,
      handle: (_req, res, [runId]) => {
        const directory = existingRunDir(runId!);
        if (!existsSync(join(directory, 'summary.json'))) throw new HttpError(404, 'summary.json 이 없습니다 (실행 중이거나 중단된 실행)');
        streamOwnedFile(res, evidence.openRunFile(runId!, 'summary.json', 16 * 1024 ** 2), 'application/json; charset=utf-8');
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runs\/([^/]+)\/events$/,
      handle: (_req, res, [runId]) => {
        const directory = existingRunDir(runId!);
        if (!existsSync(join(directory, 'events.jsonl'))) throw new HttpError(404, 'events.jsonl 이 없습니다');
        streamOwnedFile(res, evidence.openRunFile(runId!, 'events.jsonl'), CONTENT_TYPES['.jsonl']!);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runs\/([^/]+)\/files\/(.+)$/,
      rawParams: true,
      handle: (_req, res, [runId, rest]) => {
        const decodedRunID = decodeURIComponent(runId!);
        const runRoot = existingRunDir(decodedRunID);
        const file = resolveInside(runRoot, rest!);
        const path = relative(runRoot, file);
        streamOwnedFile(res, evidence.openRunFile(decodedRunID, path), CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/docs$/,
      handle: async (req, res) => {
        const header = req.headers['x-filename'];
        if (typeof header !== 'string' || !header) throw new HttpError(400, 'X-Filename 헤더(퍼센트 인코딩된 파일 이름)가 필요합니다');
        let decoded: string;
        try {
          decoded = decodeURIComponent(header);
        } catch {
          throw new HttpError(400, 'X-Filename 인코딩이 잘못되었습니다');
        }
        const name = sanitizeFileName(decoded);
        const ext = extname(name).toLowerCase();
        if (!DOC_EXTENSIONS[ext]) throw new HttpError(415, `지원하지 않는 문서 형식입니다: ${ext || '(확장자 없음)'} — md, txt, csv, tsv, json, yaml, xlsx, docx, pdf`);
        const body = await readBody(req, maxUpload);
        const file = join(paths.uploads, `${randomUUID()}-${name}`);
        writeSecure(file, body);
        sendJson(res, 201, { path: file, name, bytes: body.length });
      },
    },
  ];

  function existingRunDir(runId: string): string {
    const dir = runDirFor(paths.runs, runId);
    if (!dir || !existsSync(dir)) throw new HttpError(404, '실행을 찾을 수 없습니다');
    return dir;
  }

  /** Keep the verified descriptor alive until every buffered chunk has passed the current read authority. */
  function streamOwnedFile(res: ServerResponse, reader: RunEvidenceReader, contentType: string, filename?: string): void {
    let closed = false;
    let source: ReturnType<typeof createReadStream> | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (source) source.close(); else closeSync(reader.fd);
    };
    try {
      reader.assertUnchanged();
      res.writeHead(200, {
        'content-type': contentType, 'content-length': reader.bytes, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', ...(filename ? { 'content-disposition': `attachment; filename="${filename}"` } : {}),
      });
      if (reader.bytes === 0) { close(); res.end(); return; }
      source = createReadStream('', { fd: reader.fd, autoClose: false, start: 0, end: reader.bytes - 1 });
      const gate = new Transform({
        transform(chunk, _encoding, callback) {
          try { reader.assertUnchanged(); callback(null, chunk); }
          catch (error) { callback(error instanceof Error ? error : new Error('증거 읽기 권위를 확인하지 못했습니다')); }
        },
      });
      pipeline(source, gate, res, error => {
        close();
        if (error) res.destroy(error);
      });
    } catch (error) { close(); throw error; }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.setHeader('www-authenticate', 'Bearer');
      throw new HttpError(401, '인증 토큰이 필요합니다');
    }
    if (stopping) throw new HttpError(503, 'Engine is stopping');
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) throw new HttpError(403, 'Loopback Host is required');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin requests are not allowed');
    // Match on the raw path: WHATWG URL parsing would silently collapse `..` segments before the traversal check.
    const rawPath = (req.url ?? '/').split('?', 1)[0]!;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let methodMismatch = false;
    for (const route of routes) {
      const match = route.pattern.exec(rawPath);
      if (!match) continue;
      if (route.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      const params = route.rawParams ? match.slice(1) : match.slice(1).map((p) => decodeURIComponent(p));
      await route.handle(req, res, params, url);
      return;
    }
    throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? '허용되지 않는 메서드' : '알 수 없는 경로');
  }

  const server: Server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof ProductStoreError || err instanceof ProductEvidenceError ? err.status : err instanceof PathRejected || err instanceof URIError ? 400 : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) bus.emit({ type: 'log', level: 'error', source: 'server', message: `${req.method} ${req.url?.split('?', 1)[0]}: ${message}` });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: message, ...(err instanceof ProductEvidenceError ? { code: err.code } : {}), ...(err instanceof HttpError && err.details !== undefined ? { details: err.details } : {}) });
    });
  });

  return {
    token,
    startedAt,
    bus,
    jobs,
    paths,
    listen(port = 0) {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
      return promise;
    },
    close() {
      if (closing) return closing;
      stopping = true;
      for (const controller of agentCalls) controller.abort();
      const agentStopped = handlers.agent.shutdown();
      hub.close();
      closing = (async () => {
        try {
          await Promise.all([agentStopped, jobs.shutdown(), authoring.close()]);
          await Promise.allSettled(
            [...recordings.values()].map(({ platform, deviceId, file }) => handlers.stopRecording(platform, deviceId, file)),
          );
          recordings.clear();
        } finally {
          const { promise, resolve } = Promise.withResolvers<void>();
          server.close(() => resolve());
          server.closeAllConnections();
          await promise;
        }
      })();
      return closing;
    },
  };
}
