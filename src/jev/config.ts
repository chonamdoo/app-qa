// Jev (TypeSafe System One) connection settings and the typed error every Jev failure maps to.
// The API key never appears in enumerable fields, logs or errors.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, loadEnv, PATHS } from '../core/config.ts';

/** The only model id the gates are calibrated for unless `QA_JEV_MODEL` names another versioned id. */
export const JEV_MODEL = 'jev-1.13.0';
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';

export type JevErrorKind =
  | 'config' // missing/unsafe key, bad settings
  | 'request' // our request violates API limits (e.g. >255 choice options) — never sent
  | 'timeout' // attempt or total budget exceeded
  | 'network' // connection failure
  | 'http' // non-retryable status, or retryable status after the budget ran out
  | 'invalid_response' // 2xx body failed strict validation
  | 'model_mismatch' // response model differs from the pinned model
  | 'replay_miss'; // replay mode without a recording for this request digest

/** Messages carry status codes and field paths only — never keys, request bodies or response bodies. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(kind: JevErrorKind, message: string, opts: { status?: number | null; requestId?: string | null } = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
  }
}

export type JevMode = 'live' | 'record' | 'replay';
const MODES: Record<string, JevMode> = { live: 'live', record: 'record', replay: 'replay' };

export interface JevConfig {
  baseUrl: string;
  /** Versioned model id sent with every request; the response must echo it exactly. */
  model: string;
  mode: JevMode;
  /** Directory of recorded responses (record writes, replay reads). */
  recordingsDir: string;
  /** Non-enumerable: invisible to JSON.stringify and console.log. Null only in replay mode. */
  readonly apiKey: string | null;
}

/**
 * Reads `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` (must be mode 0600), `TYPESAFE_BASE_URL`, `QA_JEV_MODEL`,
 * `QA_JEV_MODE` (live|record|replay) and `QA_JEV_RECORDINGS`. Replay needs no key.
 */
export function loadJevConfig(env: NodeJS.ProcessEnv = process.env, overrides: { mode?: JevMode; recordingsDir?: string } = {}): JevConfig {
  if (env === process.env) loadEnv();
  const requested = overrides.mode ?? env.QA_JEV_MODE ?? 'live';
  const mode = MODES[requested];
  if (!mode) throw new JevError('config', `QA_JEV_MODE는 live|record|replay 중 하나여야 합니다 (현재: ${requested})`);
  const model = env.QA_JEV_MODEL?.trim() || JEV_MODEL;
  // Aliases (jev-latest) resolve server-side to a versioned id, which would then fail the model check on every call.
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new JevError('config', `QA_JEV_MODEL은 버전이 고정된 모델 id여야 합니다 (예: ${JEV_MODEL})`);
  const baseUrl = (env.TYPESAFE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new JevError('config', 'TYPESAFE_BASE_URL은 http(s) URL이어야 합니다');
  const recordingsDir = overrides.recordingsDir ?? (env.QA_JEV_RECORDINGS ? expandHome(env.QA_JEV_RECORDINGS) : join(PATHS.state, 'jev', 'recordings'));
  const apiKey = mode === 'replay' ? null : readKey(env);
  const config = { baseUrl, model, mode, recordingsDir } as JevConfig;
  Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false, writable: false });
  return config;
}

function readKey(env: NodeJS.ProcessEnv): string {
  let key = env.TYPESAFE_API_KEY?.trim();
  if (!key && env.TYPESAFE_API_KEY_FILE?.trim()) {
    const file = expandHome(env.TYPESAFE_API_KEY_FILE.trim());
    let mode: number;
    try {
      mode = statSync(file).mode;
    } catch {
      throw new JevError('config', 'TYPESAFE_API_KEY_FILE 파일을 읽을 수 없습니다');
    }
    if ((mode & 0o077) !== 0) throw new JevError('config', `TYPESAFE_API_KEY_FILE 권한이 너무 넓습니다 (${(mode & 0o777).toString(8)}); chmod 600 필요`);
    key = readFileSync(file, 'utf8').trim();
  }
  if (!key) throw new JevError('config', 'TYPESAFE_API_KEY 또는 TYPESAFE_API_KEY_FILE을 .env에 설정하세요');
  // Same rule as the official Python SDK: printable ASCII without inner whitespace.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new JevError('config', 'TypeSafe API 키 형식이 올바르지 않습니다 (공백·비ASCII 문자 포함)');
  return key;
}
