// Run directory writer: evidence files (0600 in 0700 dirs), events.jsonl mirror of the event stream, the fsynced
// action journal, and the manifest of everything written.
import { join, sep } from 'node:path';
import type { EventSink, QaEvent, QaEventBody } from '../core/events.ts';
import { appendJsonl, ensureDir, writeJsonAtomic, writeSecure } from '../core/fsx.ts';
import { updateManifest, type ManifestKind } from '../report/manifest.ts';

export class RunStore implements EventSink {
  readonly runId: string;
  readonly runDir: string;
  private readonly sink: EventSink | undefined;
  private readonly tracked = new Map<string, ManifestKind>();
  private seq = 0;

  constructor(runDir: string, runId: string, sink?: EventSink) {
    this.runDir = ensureDir(runDir);
    this.runId = runId;
    this.sink = sink;
  }

  /** Forwards to the caller's sink and appends to events.jsonl (paths in events are relative to the run dir). */
  emit(event: QaEventBody): void {
    const full = { ...event, ts: new Date().toISOString(), seq: ++this.seq } as QaEvent;
    appendJsonl(join(this.runDir, 'events.jsonl'), full);
    this.tracked.set('events.jsonl', 'events');
    try {
      this.sink?.emit(event);
    } catch {
      // Subscribers must not throw; a broken UI stream never aborts a run.
    }
  }

  /** Writes a file under the run dir and records it for the manifest; returns the posix relative path. */
  write(rel: string, data: string | Uint8Array, kind: ManifestKind): string {
    writeSecure(join(this.runDir, rel), data);
    const posix = rel.split(sep).join('/');
    this.tracked.set(posix, kind);
    return posix;
  }

  writeJson(rel: string, value: unknown, kind: ManifestKind): string {
    return this.write(rel, `${JSON.stringify(value, null, 2)}\n`, kind);
  }

  /** Durable record rewritten later (`summary.json`): temp file → fsync → rename, never a torn file. */
  writeRecord(rel: string, value: unknown, kind: ManifestKind): string {
    writeJsonAtomic(join(this.runDir, rel), value);
    const posix = rel.split(sep).join('/');
    this.tracked.set(posix, kind);
    return posix;
  }

  /** Intent/outcome record, fsynced before the action is dispatched. */
  journal(entry: Record<string, unknown>): void {
    appendJsonl(join(this.runDir, 'journal.jsonl'), { ts: new Date().toISOString(), ...entry });
    this.tracked.set('journal.jsonl', 'log');
  }

  writeManifest(): void {
    updateManifest(this.runDir, this.runId, [...this.tracked].map(([relativePath, kind]) => ({ relativePath, kind })));
  }
}
