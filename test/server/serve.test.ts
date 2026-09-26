import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { smokeJob, startEngine } from '../../src/cli/commands/serve.ts';
import type { Platform } from '../../src/core/types.ts';
import type { JobOutcome } from '../../src/server/jobs.ts';
import type { ServerHandlers } from '../../src/server/server.ts';

const ok = async (): Promise<JobOutcome> => ({ ok: true, message: 'ok', resultPath: null });
const handlers: ServerHandlers = {
  run: ok,
  smoke: ok,
  plan: ok,
  calibrate: ok,
  capture: ok,
  devices: async () => [],
  screen: async () => new Uint8Array(),
  apps: async () => [],
  startRecording: async () => {},
  stopRecording: async (_p, _d, file) => file,
};

test('server.json is swapped in atomically as a fresh 0600 file and removed on close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-serve-'));
  const infoFile = join(dir, 'server.json');
  try {
    writeFileSync(infoFile, '{"pid":1}');
    chmodSync(infoFile, 0o644);
    const previous = statSync(infoFile).ino;
    const engine = await startEngine({ port: 0, infoFile, handlers });
    try {
      const stat = statSync(infoFile);
      // A new inode means readers saw the old file or the complete new one — never an in-place rewrite at 0644.
      assert.notEqual(stat.ino, previous);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ['server.json']);
      const info: unknown = JSON.parse(readFileSync(infoFile, 'utf8'));
      assert.ok(typeof info === 'object' && info !== null && 'token' in info && 'port' in info && 'pid' in info);
      assert.equal(info.port, engine.port);
      assert.equal(info.pid, process.pid);
      const health = await fetch(`http://127.0.0.1:${engine.port}/api/health`, { headers: { authorization: `Bearer ${String(info.token)}` } });
      assert.equal(health.status, 200);
    } finally {
      await engine.close();
    }
    assert.equal(existsSync(infoFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke over several platforms never opens another browser after a desktop smoke leaves the display unknown', async () => {
  const zero = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 };
  const smoke = (lost: Platform | null) => {
    const opened: Platform[] = [];
    const runSmoke = async ({ platform }: { platform: Platform }) => {
      opened.push(platform);
      const code = platform === lost ? 'display_unknown' : null;
      return { runId: platform, counts: { ...zero, ...(code ? { ERROR: 1 } : { PASS: 1 }) }, tests: [{ code }], reportPath: `${platform}.html` };
    };
    const ctx = { jobId: 'j', events: { emit: () => {} }, signal: new AbortController().signal };
    return { opened, outcome: smokeJob(runSmoke, ['desktop-chrome', 'android', 'desktop-safari'], { app: 'shop', platform: 'all', deviceIds: {} }, ctx) };
  };

  const lost = smoke('desktop-chrome');
  const outcome = await lost.outcome;
  assert.deepEqual(lost.opened, ['desktop-chrome', 'android']);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /^PASS 1 · ERROR 2 · Safari \(macOS\): Chrome \(macOS\) 스모크 뒤 데스크톱 화면 상태를 알 수 없어 실행하지 않음$/);

  const fine = smoke(null);
  assert.deepEqual(await fine.outcome, { ok: true, message: 'PASS 3', resultPath: 'desktop-safari.html' });
  assert.deepEqual(fine.opened, ['desktop-chrome', 'android', 'desktop-safari']);
});
