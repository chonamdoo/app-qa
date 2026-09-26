// Evidence sanitizer (architecture §5 증거 정제, invariant 7): the one boundary every journal/event/SSE/source/elements/
// log/inventory write of a test session passes. Masks observed secure-input values (whatever the DSL `secure` flag says),
// every value that came from `${ENV}` expansion, and app-profile `redact` matches (plus the built-in PII patterns).
import type { QaEventBody } from '../core/events.ts';
import type { ScreenModel, Snapshot } from '../core/types.ts';
import { createRedactor, type Redactor } from '../jev/redact.ts';
import type { ManifestKind } from '../report/manifest.ts';
import type { RunStore } from './store.ts';

/** `•` × length: how secure values appear everywhere (Observe masks secure candidate values the same way). */
export const maskValue = (value: string): string => '•'.repeat([...value].length);

/** A value that is already only mask characters (a password field shows bullets) is not a secret worth tracking. */
const MASKED = /^[•●*]+$/u;

/**
 * Fields the deep sanitizer never rewrites: run-relative evidence paths (masking them would break the links; they carry
 * no screen text) and structural fields — enums, ids, keys, counters, timestamps. A secret that happens to equal
 * `ERROR`, `tap` or `android` must not corrupt verdicts, event kinds or platforms; only free text is masked.
 */
const VERBATIM_KEYS: Record<string, true> = {
  screenshot: true,
  evidenceDir: true,
  before: true,
  after: true,
  logs: true,
  crash: true,
  file: true,
  plan: true,
  $schema: true,
  type: true,
  kind: true,
  verdict: true,
  status: true,
  code: true,
  platform: true,
  platforms: true,
  source: true,
  role: true,
  state: true,
  region: true,
  level: true,
  severity: true,
  phase: true,
  runId: true,
  testId: true,
  jobId: true,
  planId: true,
  deviceId: true,
  requestId: true,
  nodeId: true,
  id: true,
  key: true,
  app: true,
  model: true,
  seq: true,
  index: true,
  step: true,
  ts: true,
  takenAt: true,
  startedAt: true,
  finishedAt: true,
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };

function decodeXml(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity]! : whole;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** A start tag (quote-aware, so `>` inside a value does not end it), any other markup, or a text run. */
const MARKUP = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)(\s*\/?)>|<[^>]*>|[^<]+/g;
const ATTRIBUTE = /(\s+)([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
/** Android `password="true"` nodes and iOS `SecureTextField` elements hold the typed secret in `text` / `value`. */
const SECURE_ATTRS = /\s(?:password\s*=\s*["']true["']|type\s*=\s*["']XCUIElementTypeSecureTextField["'])/;

export class EvidenceSanitizer {
  private readonly redact: Redactor;
  /** NFC, longest first so a secret that contains another is masked whole. */
  private secrets: string[] = [];

  /** Throws a config error for an invalid profile `redact` regex (same rule as the Jev redactor). */
  constructor(redactPatterns: readonly string[]) {
    this.redact = createRedactor(redactPatterns);
  }

  /** Masks `value` in every later write: an `${ENV}` expansion, text typed into a secure field, an observed password value. */
  addSecret(value: string): void {
    const secret = value.normalize('NFC');
    if (!secret || MASKED.test(secret) || this.secrets.includes(secret)) return;
    this.secrets = [...this.secrets, secret].sort((a, b) => b.length - a.length);
  }

  /** Tracks what password nodes of an observation expose (some apps put the plain value in the tree). */
  observe(snapshot: Snapshot): void {
    for (const node of snapshot.nodes) {
      if (!node.flags.password) continue;
      if (node.value) this.addSecret(node.value);
      if (node.text) this.addSecret(node.text);
    }
  }

  /** Secrets → `•`, then profile `redact` + built-in PII → `[REDACTED]`. Also the session's Jev redactor. */
  text = (value: string): string => {
    let out = value.normalize('NFC');
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(maskValue(secret));
    return this.redact(out);
  };

  /** Deep copy with every free-text string sanitized; object keys and `VERBATIM_KEYS` fields stay as they are. */
  deep<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v: unknown) => this.deep(v)) as T;
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = Object.hasOwn(VERBATIM_KEYS, key) ? v : this.deep(v);
    return out as T;
  }

  /** Page source with password-field values masked structurally and every attribute value / text run sanitized. */
  source(xml: string): string {
    return xml.replace(MARKUP, (whole, tag: string | undefined, attrs: string | undefined, close: string | undefined) => {
      if (tag === undefined || attrs === undefined) return whole.startsWith('<') ? whole : this.xmlText(whole);
      const secure = tag === 'XCUIElementTypeSecureTextField' || SECURE_ATTRS.test(attrs);
      const cleaned = attrs.replace(ATTRIBUTE, (_a, space: string, name: string, eq: string, dq: string | undefined, sq: string | undefined) => {
        const raw = dq ?? sq ?? '';
        const quote = dq === undefined ? "'" : '"';
        const value = secure && (name === 'text' || name === 'value') ? maskValue(decodeXml(raw)) : this.xmlText(raw);
        return `${space}${name}${eq}${quote}${value}${quote}`;
      });
      return `<${tag}${cleaned}${close ?? ''}>`;
    });
  }

  /** Sanitizes one XML attribute value or text run; untouched bytes stay byte-identical. */
  private xmlText(raw: string): string {
    const decoded = decodeXml(raw);
    const clean = this.text(decoded);
    return clean === decoded ? raw : clean.replace(/[&<>"'\n\r\t]/g, (c) => ESCAPES[c]!);
  }
}

/**
 * A test session's view of the run store: every write is sanitized first, so execution code cannot reach the store
 * (journal, events.jsonl + SSE sink, evidence files) around the sanitizer. Screenshots are the only unsanitized bytes.
 */
export class SanitizedStore {
  private readonly store: RunStore;
  readonly clean: EvidenceSanitizer;

  constructor(store: RunStore, clean: EvidenceSanitizer) {
    this.store = store;
    this.clean = clean;
  }

  emit(event: QaEventBody): void {
    this.store.emit(this.clean.deep(event));
  }

  journal(entry: Record<string, unknown>): void {
    this.store.journal(this.clean.deep(entry));
  }

  json(rel: string, value: unknown, kind: ManifestKind): string {
    return this.store.writeJson(rel, this.clean.deep(value), kind);
  }

  text(rel: string, text: string, kind: ManifestKind): string {
    return this.store.write(rel, this.clean.text(text), kind);
  }

  png(rel: string, png: Uint8Array): string {
    return this.store.write(rel, png, 'screenshot');
  }

  source(rel: string, xml: string): string {
    return this.store.write(rel, this.clean.source(xml), 'source');
  }

  /** Candidate table of an observation; field values are masked whole (they may hold what was typed). */
  elements(rel: string, model: ScreenModel): string {
    const s = model.snapshot;
    return this.json(
      rel,
      {
        platform: s.platform,
        takenAt: s.takenAt,
        screen: s.screen,
        foregroundApp: s.foregroundApp,
        keyboardShown: s.keyboardShown,
        depthCapped: s.depthCapped,
        sparse: model.sparse,
        overflow: model.overflow,
        occluded: model.occludedNodeIds.length,
        fingerprints: model.fingerprints,
        candidates: model.candidates.map((c) => ({ ...c, value: c.value !== null && (c.role === 'input' || c.role === 'secure-input') ? maskValue(c.value) : c.value })),
        texts: model.texts,
      },
      'elements',
    );
  }
}
