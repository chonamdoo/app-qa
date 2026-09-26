// Engine HTTP server (`qa serve`): 127.0.0.1 only, bearer-token auth on every route, SSE events, job queue, file views.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fstatSync, openSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream';
import { PATHS } from '../core/config.ts';
import { EventBus } from '../core/events.ts';
import { writeSecure } from '../core/fsx.ts';
import { PLATFORM_INFO, PLATFORMS } from '../core/platform.ts';
import type { DeviceInfo, Platform } from '../core/types.ts';
import { loadAppProfile } from '../spec/load.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';
import { JobQueue, JobRequest, type JobHandlers } from './jobs.ts';
import { SseHub } from './sse.ts';
import { DOC_EXTENSIONS, listAppProfiles, listPlans, listRuns, PathRejected, readPlanView, resolveInside, resolvePlanDocs, runDirFor } from './store.ts';

export interface ServerHandlers extends JobHandlers {
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
  ringSize?: number;
  heartbeatMs?: number;
  maxUploadBytes?: number;
}

export interface QaServer {
  readonly token: string;
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
  const hub = new SseHub(bus, { capacity: opts.ringSize ?? 5000, heartbeatMs: opts.heartbeatMs ?? 15_000 });
  const maxUpload = opts.maxUploadBytes ?? 50 * 1024 * 1024;
  const startedAt = new Date().toISOString();
  /** `<platform>:<deviceId>` → recording file. */
  const recordings = new Map<string, { platform: Platform; deviceId: string; file: string; startedAt: string }>();

  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handle: (_req, res) => sendJson(res, 200, { ok: true, pid: process.pid, startedAt, root: paths.root }) },
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
        const png = await handlers.screen(platformParam(platform, '데스크톱 브라우저는 실시간 화면이 없습니다 — 실행 중에는 스텝 스크린샷을 보세요'), id!);
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
      handle: async (_req, res, [runId]) => {
        const summary = join(existingRunDir(runId!), 'summary.json');
        if (!existsSync(summary)) throw new HttpError(404, 'summary.json 이 없습니다 (실행 중이거나 중단된 실행)');
        sendJson(res, 200, JSON.parse(await readFile(summary, 'utf8')));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runs\/([^/]+)\/events$/,
      handle: (_req, res, [runId]) => {
        const file = join(existingRunDir(runId!), 'events.jsonl');
        if (!existsSync(file)) throw new HttpError(404, 'events.jsonl 이 없습니다');
        streamFile(res, file);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runs\/([^/]+)\/files\/(.+)$/,
      rawParams: true,
      handle: (_req, res, [runId, rest]) => {
        const file = resolveInside(existingRunDir(decodeURIComponent(runId!)), rest!);
        if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, '파일이 없습니다');
        streamFile(res, file);
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

  /**
   * Opens first and sizes the response from the open descriptor, so a delete/rename after the existence check cannot
   * crash the stream, and a file still being appended to (events.jsonl during a run) is sent exactly up to that size.
   */
  function streamFile(res: ServerResponse, file: string): void {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') throw new HttpError(404, '파일이 없습니다');
      throw err;
    }
    let size: number;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new HttpError(404, '파일이 없습니다');
      size = stat.size;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (size === 0) {
      closeSync(fd);
      res.end();
      return;
    }
    // pipeline destroys both sides on failure: a read error closes the connection instead of an unhandled 'error'.
    pipeline(createReadStream(file, { fd, start: 0, end: size - 1 }), res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') bus.emit({ type: 'log', level: 'error', source: 'server', message: `${basename(file)} 전송 실패: ${err.message}` });
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.setHeader('www-authenticate', 'Bearer');
      throw new HttpError(401, '인증 토큰이 필요합니다');
    }
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
      const status = err instanceof HttpError ? err.status : err instanceof PathRejected || err instanceof URIError ? 400 : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) bus.emit({ type: 'log', level: 'error', source: 'server', message: `${req.method} ${req.url?.split('?', 1)[0]}: ${message}` });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: message, ...(err instanceof HttpError && err.details !== undefined ? { details: err.details } : {}) });
    });
  });

  return {
    token,
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
    async close() {
      hub.close();
      await jobs.shutdown();
      await Promise.allSettled(
        [...recordings.values()].map(({ platform, deviceId, file }) => handlers.stopRecording(platform, deviceId, file)),
      );
      recordings.clear();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      server.closeAllConnections();
      await promise;
    },
  };
}
