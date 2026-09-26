// Process identity: a pid alone is not an owner — pids are reused — so owners are recorded as pid + start time.
import { execFileSync } from 'node:child_process';

/** Liveness and start time (ms, null when unknown) of a pid. */
export type ProcessProbe = (pid: number) => { alive: boolean; startedAtMs: number | null };

/** `ps` reports start time with 1 s resolution; allow slack for rounding when comparing it to a recorded time. */
export const START_SLACK_MS = 2000;

/** Start time of this process (ms since the epoch), as recorded next to `process.pid` by every owner record. */
export const PROCESS_STARTED_AT_MS = Math.floor(performance.timeOrigin);

export const systemProbe: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return { alive: false, startedAtMs: null };
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: process.env.TZ } }).trim();
    const ms = Date.parse(out);
    return { alive: true, startedAtMs: Number.isNaN(ms) ? null : ms };
  } catch {
    return { alive: true, startedAtMs: null };
  }
};

/**
 * Whether the process recorded as `pid` started at `startedAtMs` is still running: false for a dead pid and for a pid
 * reused by a process with another start time. An unknown start time (probe or record) keeps a live pid alive.
 */
export function isProcessAlive(pid: number, startedAtMs: number, probe: ProcessProbe): boolean {
  const p = probe(pid);
  if (!p.alive) return false;
  if (p.startedAtMs === null || Number.isNaN(startedAtMs)) return true;
  return Math.abs(p.startedAtMs - startedAtMs) <= START_SLACK_MS;
}
