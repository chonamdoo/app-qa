// Evidence files may contain screen content: directories 0700, files 0600.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeSecure(file: string, data: string | Uint8Array): void {
  ensureDir(dirname(file));
  writeFileSync(file, data, { mode: 0o600 });
}

export function writeJson(file: string, value: unknown): void {
  writeSecure(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Appends one JSON line and fsyncs, so a crash never loses a recorded intent. */
export function appendJsonl(file: string, value: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Sortable, collision-free run id: 2026-09-26T06-40-12-345Z-1a2b3c. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
}
