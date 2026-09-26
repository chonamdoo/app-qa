import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startEngine } from '../../src/cli/commands/serve.ts';
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
