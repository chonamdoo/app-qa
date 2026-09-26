// Masks sensitive text before anything is sent to Jev. Applied to every dynamic string of a request (rows, texts,
// intent, claim, options, review payloads); frozen question wording is ours and never contains screen content.
import { JevError } from './config.ts';

export type Redactor = (text: string) => string;

export const REDACTED = '[REDACTED]';

/** Always masked, whatever the app profile says: e-mail, KR mobile number, KR resident registration number, card number. */
const BUILTIN: readonly RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  /(?<!\d)01[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,
  /(?<!\d)\d{6}-[1-8]\d{6}(?!\d)/g,
  /(?<!\d)\d{4}(?:[- ]\d{4}){3}(?!\d)/g,
];

/** URL query/fragment parameter names whose value is always masked (compared percent-decoded and lower-cased). */
const SENSITIVE_PARAMS: Record<string, true> = {
  token: true,
  access_token: true,
  id_token: true,
  code: true,
  session: true,
  sid: true,
  auth: true,
  key: true,
  api_key: true,
  secret: true,
  password: true,
  sig: true,
  signature: true,
};
/** A parameter name after `?`, `&`, `#` or `;`, up to its `=`. */
const PARAM_NAME = /[?&#;]([^=&#?;\s"'<>]+)=/g;
/** Where a parameter value ends. */
const VALUE_END = /[&#\s"'<>]/g;
const PERCENT_BYTE = /%([0-9a-f]{2})/gi;

/**
 * Masks the value of every sensitive URL query/fragment parameter (`?token=…`, `&code=…`, `#access_token=…`; the name
 * stays). Names are percent-decoded like a URL parser does (`?%74oken=`, `access%5Ftoken=` are `token`, `access_token`),
 * repeatedly so a doubly encoded name (`%2574oken`) is masked too; a value runs to the next `&`, `#`, whitespace, quote
 * or angle bracket, so a `;name=` inside it is masked with it.
 */
function redactQueryValues(text: string): string {
  let out = '';
  let copied = 0;
  for (const m of text.matchAll(PARAM_NAME)) {
    const start = m.index + m[0].length;
    if (start <= copied) continue;
    let name = m[1]!;
    for (let encoded = ''; encoded !== name; ) {
      encoded = name;
      name = name.replace(PERCENT_BYTE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (!Object.hasOwn(SENSITIVE_PARAMS, name.toLowerCase())) continue;
    VALUE_END.lastIndex = start;
    const end = VALUE_END.exec(text)?.index ?? text.length;
    if (end === start) continue;
    out += text.slice(copied, start) + REDACTED;
    copied = end;
  }
  return out + text.slice(copied);
}

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
  const mask = (out: string, re: RegExp) => out.replace(re, (m) => (m.length === 0 ? m : REDACTED));
  return (text) => compiled.reduce(mask, redactQueryValues(BUILTIN.reduce(mask, text.normalize('NFC'))));
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
