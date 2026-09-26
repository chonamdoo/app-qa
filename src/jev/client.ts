// Thin System One client: pinned model, bounded time, narrow retries, strict validation, record/replay.
// Never logs or embeds the API key, request bodies or response bodies in errors.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JevReceipt } from '../core/types.ts';
import { sha256, writeJson } from '../core/fsx.ts';
import { JevError, type JevConfig } from './config.ts';
import { MAX_CHOICE_OPTIONS, type Questions } from './questions.ts';
import { validateResponse, type JevAnswer } from './validate.ts';

export const REQUEST_ID_HEADER = 'x-typesafe-request-id';

export interface JevClientOptions {
  /** Injectable transport (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per attempt, default 3000. */
  attemptTimeoutMs?: number;
  /** Whole call including backoff, default 8000. */
  totalTimeoutMs?: number;
  /** Default 3 (1 + 2 retries). */
  maxAttempts?: number;
  /** Injectable backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SystemOneResult {
  answers: Record<string, JevAnswer>;
  receipt: JevReceipt;
}

/** A failed call: the error plus the receipt describing it (for evidence files). */
export class JevCallError extends JevError {
  readonly receipt: JevReceipt;
  constructor(cause: JevError, receipt: JevReceipt) {
    super(cause.kind, cause.message, { status: cause.status, requestId: cause.requestId });
    this.receipt = receipt;
  }
}

/** Stored per request digest by record mode; replay serves `response` through the same validation as live. */
export interface JevRecording {
  key: string;
  model: string;
  questionVersion: string;
  requestId: string | null;
  latencyMs: number;
  request: { state: unknown; questions: Questions };
  response: unknown;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2000;
/** Do not start an attempt that cannot plausibly finish (typical latency ~0.7 s). */
const MIN_ATTEMPT_MS = 500;

export class JevClient {
  readonly config: JevConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly attemptTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: JevConfig, opts: JevClientOptions = {}) {
    this.config = config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 3000;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 8000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
  }

  get model(): string {
    return this.config.model;
  }

  /**
   * One System One call. Resolves only with fully validated answers; every failure throws `JevCallError`
   * (a `JevError` carrying a receipt with `error` set).
   */
  async systemOne(state: unknown, questions: Questions, questionVersion: string, opts: { signal?: AbortSignal } = {}): Promise<SystemOneResult> {
    const started = performance.now();
    const stateDigest = sha256(canonicalJson(state));
    const key = requestKey(this.model, questionVersion, state, questions);
    let requestId: string | null = null;
    let raw: unknown;
    try {
      checkQuestions(questions);
      if (this.config.mode === 'replay') {
        const rec = this.readRecording(key);
        requestId = rec.requestId;
        raw = rec.response;
      } else {
        ({ raw, requestId } = await this.send({ model: this.model, state, questions }, opts.signal));
        if (this.config.mode === 'record') {
          const recording: JevRecording = {
            key,
            model: this.model,
            questionVersion,
            requestId,
            latencyMs: Math.round(performance.now() - started),
            request: { state, questions },
            response: raw,
          };
          writeJson(join(this.config.recordingsDir, `${key}.json`), recording);
        }
      }
      const valid = validateResponse(raw, questions, this.model);
      return {
        answers: valid.answers,
        receipt: {
          questionVersion,
          model: valid.model,
          requestId,
          stateDigest,
          latencyMs: Math.round(performance.now() - started),
          inputTokens: valid.inputTokens,
          answers: rawAnswers(raw),
          error: null,
        },
      };
    } catch (err) {
      if (!(err instanceof JevError)) throw err;
      const echoed = typeof raw === 'object' && raw !== null && 'model' in raw && typeof raw.model === 'string' ? raw.model : null;
      throw new JevCallError(err, {
        questionVersion,
        model: echoed,
        requestId: err.requestId ?? requestId,
        stateDigest,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: null,
        answers: rawAnswers(raw),
        error: `${err.kind}: ${err.message}`,
      });
    }
  }

  private readRecording(key: string): JevRecording {
    const file = join(this.config.recordingsDir, `${key}.json`);
    if (!existsSync(file)) throw new JevError('replay_miss', `재생할 Jev 응답 녹화가 없습니다 (${key.slice(0, 12)})`);
    return JSON.parse(readFileSync(file, 'utf8')) as JevRecording;
  }

  private async send(body: { model: string; state: unknown; questions: Questions }, signal?: AbortSignal): Promise<{ raw: unknown; requestId: string | null }> {
    if (!this.config.apiKey) throw new JevError('config', 'TypeSafe API 키가 없습니다');
    const payload = JSON.stringify(body);
    const deadline = performance.now() + this.totalTimeoutMs;
    let lastStatus = 0;
    let lastRequestId: string | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining < MIN_ATTEMPT_MS) break;
      const timeout = AbortSignal.timeout(Math.min(this.attemptTimeoutMs, remaining));
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'app-qa/0.1.0',
      };
      if (attempt > 0) headers['x-typesafe-retry-count'] = String(attempt);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(`${this.config.baseUrl}/systemone`, {
          method: 'POST',
          headers,
          body: payload,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        text = await res.text();
      } catch (err) {
        if (signal?.aborted) throw new JevError('timeout', 'Jev 호출이 취소되었습니다');
        if (timeout.aborted) throw new JevError('timeout', `Jev 응답 시간 초과 (${Math.round(Math.min(this.attemptTimeoutMs, remaining))}ms)`);
        throw new JevError('network', `Jev 연결 실패: ${(err as Error).name}`);
      }
      const requestId = res.headers.get(REQUEST_ID_HEADER);
      if (res.ok) {
        try {
          return { raw: JSON.parse(text), requestId };
        } catch {
          throw new JevError('invalid_response', 'Jev 응답이 JSON이 아닙니다', { requestId });
        }
      }
      // 408/429/5xx (incl. 529 overloaded) are transient; everything else (400/401/403/422…) fails at once.
      const retryable = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (!retryable) throw new JevError('http', `Jev HTTP ${res.status}${errorFields(text)}`, { status: res.status, requestId });
      lastStatus = res.status;
      lastRequestId = requestId;
      const wait = Math.min(retryAfterMs(res.headers) ?? BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
      if (attempt + 1 >= this.maxAttempts || deadline - performance.now() - wait < MIN_ATTEMPT_MS) break;
      await this.sleep(wait);
    }
    if (lastStatus === 0) throw new JevError('timeout', `Jev 총 시간 예산(${this.totalTimeoutMs}ms) 초과`);
    throw new JevError('http', `Jev HTTP ${lastStatus} (재시도 후에도 실패)`, { status: lastStatus, requestId: lastRequestId });
  }
}

/** Replay/record key: sha256 over model, question version and the canonical request. */
export function requestKey(model: string, questionVersion: string, state: unknown, questions: Questions): string {
  return sha256(`${model}\n${questionVersion}\n${canonicalJson({ state, questions })}`);
}

/** JSON with object keys sorted at every depth, so equal requests hash equally regardless of construction order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function checkQuestions(questions: Questions): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new JevError('request', 'Jev 질문이 없습니다');
  for (const [id, q] of entries) {
    if (q.type !== 'choice') continue;
    const n = Object.keys(q.criteria).length;
    if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new JevError('request', `Jev Choice '${id}' 선택지 수 ${n} (허용 2..${MAX_CHOICE_OPTIONS})`);
  }
}

/** Server delay hint: `retry-after-ms`, else `retry-after` in seconds. */
function retryAfterMs(headers: Headers): number | null {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

/** Validation-error field paths only (FastAPI `detail[].loc`); the body itself may echo request content and is never shown. */
function errorFields(text: string): string {
  try {
    const detail: unknown = (JSON.parse(text) as { detail?: unknown }).detail;
    if (!Array.isArray(detail)) return '';
    const locs = detail.flatMap((d: { loc?: unknown }) => (Array.isArray(d?.loc) ? [d.loc.join('.')] : []));
    return locs.length ? ` (${locs.slice(0, 3).join(', ')})` : '';
  } catch {
    return '';
  }
}

/** Receipts keep the answers exactly as returned (also for rejected responses, as evidence). */
function rawAnswers(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || !('answers' in raw)) return null;
  const answers = raw.answers;
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null;
}
