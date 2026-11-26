import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChromeNativeStatusSchema } from '../../src/core/chrome-owner.ts';
import { OwnedChromeStartupError, startOwnedChromeEndpoint } from '../../src/drivers/owned-chrome.ts';

const enabled = process.env.QA_OWNED_CHROME_FIXTURE === '1';

test('a failed profile removal never becomes a successful close acknowledgement', { skip: !enabled || process.getuid?.() === 0, timeout: 30_000 }, async () => {
  const endpoint = await startOwnedChromeEndpoint();
  const blocked = join(endpoint.profile, 'retained');
  await mkdir(blocked);
  await writeFile(join(blocked, 'fixture.txt'), 'owned cleanup fixture');
  await chmod(blocked, 0);
  try {
    await assert.rejects(endpoint.close(), { code: 'EACCES' });
    await assert.rejects(endpoint.close(), { code: 'EACCES' });
    const retained = ChromeNativeStatusSchema.parse(endpoint.nativeStatus());
    assert.equal(retained.browser.state, 'stopped');
    assert.equal(retained.driver.state, 'stopped');
    assert.equal(retained.profile, 'retained');
    await access(endpoint.profile);
  } finally {
    await chmod(blocked, 0o700);
    try {
      await endpoint.close();
      const closed = ChromeNativeStatusSchema.parse(endpoint.nativeStatus());
      assert.equal(closed.browser.state, 'stopped');
      assert.equal(closed.driver.state, 'stopped');
      assert.equal(closed.profile, 'removed');
      await assert.rejects(access(endpoint.profile), { code: 'ENOENT' });
    } finally {
      await rm(endpoint.profile, { recursive: true, force: true });
    }
  }
});

for (const fault of ['fetch-rejection', 'malformed-json'] as const) {
  test(`startup ${fault} confirms native termination and removes its private profile`, { skip: !enabled, timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'qautra-endpoint-startup-'));
    const previousTmp = process.env.TMPDIR;
    const originalSpawn = childProcess.spawn;
    const originalFetch = globalThis.fetch;
    const children: { process: ChildProcess; stopped: boolean }[] = [];
    let statusCalls = 0;
    const injected = new Error('Injected readiness transport failure');
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof originalSpawn>) => {
      const process = originalSpawn(...args);
      const child = { process, stopped: false };
      process.once('exit', () => { child.stopped = true; });
      children.push(child);
      return process;
    });
    syncBuiltinESMExports();
    process.env.TMPDIR = directory;
    t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof originalFetch>) => {
      statusCalls++;
      const response = await originalFetch(...args);
      await response.arrayBuffer();
      if (fault === 'fetch-rejection') throw injected;
      return new Response('not-json', { status: 200 });
    });
    try {
      await assert.rejects(startOwnedChromeEndpoint(), error => {
        assert.ok(error instanceof OwnedChromeStartupError);
        assert.ok(fault === 'fetch-rejection' ? error.cause === injected : error.cause instanceof SyntaxError);
        const native = ChromeNativeStatusSchema.parse(error.nativeStatus);
        assert.equal(native.browser.state, 'stopped');
        assert.equal(native.driver.state, 'stopped');
        assert.equal(native.profile, 'removed');
        return true;
      });
      assert.equal(statusCalls, 1);
      assert.equal(children.every(child => child.stopped), true);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      for (const child of children) {
        if (!child.stopped) {
          // Native exit needs the real OS clock; fake timers cannot terminate this fixture child.
          const exited = once(child.process, 'exit', { signal: AbortSignal.timeout(5000) });
          child.process.kill('SIGTERM');
          await exited;
        }
      }
      await rm(directory, { recursive: true });
    }
  });
}
