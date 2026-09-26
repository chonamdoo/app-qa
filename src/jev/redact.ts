// Masks sensitive text before anything is sent to Jev. Applied to every dynamic string of a request (rows, texts,
// intent, claim, options, review payloads); frozen question wording is ours and never contains screen content.
import { JevError } from './config.ts';

export type Redactor = (text: string) => string;

export const REDACTED = '[REDACTED]';

/**
 * Always masked, whatever the app profile says: e-mail, KR mobile number, KR resident registration number, card number,
 * and the value of a sensitive URL query/fragment parameter (`?token=…`, `&code=…`, `#access_token=…`; the name stays).
 */
const BUILTIN: readonly RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  /(?<!\d)01[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,
  /(?<!\d)\d{6}-[1-8]\d{6}(?!\d)/g,
  /(?<!\d)\d{4}(?:[- ]\d{4}){3}(?!\d)/g,
  /(?<=[?&#;](?:token|access_token|id_token|code|session|sid|auth|key|api_key|secret|password|sig|signature)=)[^&#\s"'<>]+/gi,
];

/** Compiles app-profile `redact` regexes (plus the built-ins) into one redactor. Invalid patterns are a config error. */
export function createRedactor(patterns: readonly string[] = []): Redactor {
  const compiled = patterns.map((source) => {
    try {
      return new RegExp(source, 'gu');
    } catch {
      try {
        // Profiles may use escapes that are legal only without the `u` flag (e.g. `\-`).
        return new RegExp(source, 'g');
      } catch {
        throw new JevError('config', `앱 프로필 redact 정규식이 올바르지 않습니다: ${source}`);
      }
    }
  });
  const all = [...BUILTIN, ...compiled];
  return (text) => all.reduce((out, re) => out.replace(re, (m) => (m.length === 0 ? m : REDACTED)), text.normalize('NFC'));
}

/** Deep-copies JSON-like data, redacting every string value (object keys are ids and stay as they are). */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}
