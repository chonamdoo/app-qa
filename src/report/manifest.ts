// Run artifact manifest (`.qa/runs/<runId>/manifest.json`, v1): lets the server/UI list evidence without scanning.
// Kinds are fixed up front — adding one is a schema change (new `$schema` version).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../core/fsx.ts';

export const MANIFEST_SCHEMA = 'app-qa/manifest/v1';

export type ManifestKind = 'screenshot' | 'source' | 'elements' | 'jev' | 'verdict' | 'log' | 'crash' | 'report' | 'junit' | 'events';

export interface ManifestEntry {
  kind: ManifestKind;
  /** Posix path relative to the run dir. */
  relativePath: string;
  sizeBytes: number;
}

export interface Manifest {
  $schema: typeof MANIFEST_SCHEMA;
  runId: string;
  updatedAt: string;
  entries: ManifestEntry[];
}

/** Merges `entries` (by relativePath) into the run's manifest, re-reading every size; missing files are dropped. */
export function updateManifest(runDir: string, runId: string, entries: Iterable<{ kind: ManifestKind; relativePath: string }>): Manifest {
  const file = join(runDir, 'manifest.json');
  const byPath = new Map<string, ManifestKind>();
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
    for (const e of prev.entries ?? []) byPath.set(e.relativePath, e.kind);
  }
  for (const e of entries) byPath.set(e.relativePath, e.kind);
  const manifest: Manifest = { $schema: MANIFEST_SCHEMA, runId, updatedAt: new Date().toISOString(), entries: [] };
  for (const [relativePath, kind] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = join(runDir, relativePath);
    if (existsSync(abs)) manifest.entries.push({ kind, relativePath, sizeBytes: statSync(abs).size });
  }
  writeJson(file, manifest);
  return manifest;
}
