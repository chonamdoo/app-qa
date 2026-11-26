import type { PublishedRevision } from '../core/regression.ts';
import { EvidenceSanitizer } from './sanitize.ts';

export function publishedRevisionEvidence(
  revision: PublishedRevision,
  clean = new EvidenceSanitizer([...new Set(revision.definition.tests.flatMap(test => test.profile.redact))]),
): unknown {
  const register = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const secret = process.env[match[1]!];
        if (secret !== undefined) clean.addSecret(secret);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) register(item);
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // This snapshot precedes observation: an unmarked type step may target a password field.
      if (typeof record.type === 'string') {
        clean.addSecret(record.type);
        clean.addSecret(record.type.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name: string) => process.env[name] ?? reference));
      }
      for (const [key, item] of Object.entries(record)) { register(key); register(item); }
    }
  };
  register(revision);
  const project = (value: unknown): unknown => {
    if (typeof value === 'string') return clean.text(value);
    if (Array.isArray(value)) return value.map(project);
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value).map(([key, item]) => [clean.text(key), project(item)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return { redactedEntries: entries };
    return Object.fromEntries(entries);
  };
  return {
    schema: 'qautra/scenario-revision-evidence/v1', executable: false,
    revisionId: clean.text(revision.revisionId), publishedAt: clean.text(revision.publishedAt),
    review: project(revision.review), evidence: project(revision.definition),
  };
}
