import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WebTarget } from '../../src/core/types.ts';
import { DesktopWebDriver } from '../../src/drivers/desktop.ts';
import { startTargetRecording } from '../../src/drivers/recording.ts';

test('owned headless Chrome inputs, playable page recording and fresh independent attempt', { skip: process.env.QA_OWNED_CHROME_FIXTURE !== '1', timeout: 120_000 }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body style="margin:0"><label style="position:absolute;left:10px;top:10px">Value<input id="value" style="display:block;width:250px;height:30px"></label><button style="position:absolute;left:10px;top:90px;width:200px;height:40px" onclick="localStorage.setItem('attempt',document.getElementById('value').value);document.getElementById('result').textContent='Submitted: '+document.getElementById('value').value">Apply fixture value</button><p id="result" style="position:absolute;top:160px">Initial: <script>document.write(localStorage.getItem('attempt')||'empty')</script></p></body></html>`);
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const target: WebTarget = { kind: 'web', platform: 'desktop-chrome', appId: 'chrome', url, origins: [new URL(url).origin], viewport: { width: 1280, height: 800 } };
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qautra-owned-chrome-fixture-')));
  let cleanupConfirmed = false;
  const nativeOwner = async () => ({ projectRoot: directory, registryRoot: join(directory, 'native-owners') });
  try {
    const first = new DesktopWebDriver('desktop-chrome', 'owned-fixture', { nativeOwner });
    try {
      await first.open(target);
      const recording = await startTargetRecording(first, { binding: { attemptId: 'fixture-first', runId: 'fixture', platform: 'desktop-chrome', deviceId: first.deviceId, generation: null }, file: join(directory, 'first.mp4'), signal: new AbortController().signal });
      first.setMutationGuard(() => recording.assertHealthy());
      await recording.beforeDispatch();
      const launched = await first.launch(target);
      assert.equal(launched.status, 'completed', JSON.stringify(launched));
      const typed = await first.typeText({ x: 100, y: 45 }, 'first-attempt');
      assert.equal(typed.status, 'completed', JSON.stringify(typed));
      const tapped = await first.tap({ x: 100, y: 110 });
      assert.equal(tapped.status, 'completed', JSON.stringify(tapped));
      const snapshot = await first.snapshot({ screenshot: true });
      assert.ok(snapshot.nodes.some(node => node.text?.includes('Submitted: first-attempt')));
      const video = await recording.stop();
      assert.equal(video.source, 'chrome-page');
      assert.ok(video.frames >= 2);
      assert.ok(video.durationSeconds > 0);
      assert.equal(video.width, target.viewport.width);
      assert.equal(video.height, target.viewport.height);
    } finally {
      await first.close();
    }
    const second = new DesktopWebDriver('desktop-chrome', 'owned-fixture', { nativeOwner });
    try {
      await second.open(target);
      const launched = await second.launch(target);
      assert.equal(launched.status, 'completed', JSON.stringify(launched));
      const snapshot = await second.snapshot({ screenshot: true });
      assert.ok(snapshot.nodes.some(node => node.text?.includes('Initial: empty')));
      assert.ok(!snapshot.nodes.some(node => node.text?.includes('first-attempt')));
    } finally {
      await second.close();
    }
    cleanupConfirmed = true;
  } finally {
    server.close();
    if (cleanupConfirmed) await rm(directory, { recursive: true });
  }
});
