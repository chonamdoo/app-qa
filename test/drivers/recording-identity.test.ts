import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { AppiumClient } from '../../src/appium/client.ts';
import type { AppTarget, WebTarget } from '../../src/core/types.ts';
import { IosDriver } from '../../src/drivers/ios.ts';
import { startDeviceRecording, startTargetRecording } from '../../src/drivers/recording.ts';

const target: WebTarget = { kind: 'web', platform: 'ios', appId: 'com.apple.mobilesafari', url: 'https://example.test/', origins: ['https://example.test'], viewport: { width: 800, height: 600 } };

class PreparedIos extends IosDriver {
  endpoint: AppiumClient | null = null;
  protected override get api(): AppiumClient { if (!this.endpoint) throw new Error('no test session'); return this.endpoint; }
  recordingCapabilities(app: AppTarget) { return this.capabilities(app); }
}

describe('recording device/session identity', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      const done = Promise.withResolvers<void>();
      server.close(error => error ? done.reject(error) : done.resolve());
      server.closeAllConnections(); await done.promise;
    }
  });
  async function listen(server: Server, port = 0) {
    const ready = once(server, 'listening'); server.listen(port, '127.0.0.1'); await ready; servers.push(server);
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
  }

  it('does not turn an unprepared physical iOS target into Simulator or host capture', async () => {
    await assert.rejects(async () => startDeviceRecording({ binding: { attemptId: 'a', runId: 'r', platform: 'ios', deviceId: 'physical-iphone-udid', generation: null }, file: '/unused/video.mp4', signal: new AbortController().signal }), { code: 'device_recording_preparation_required' });
  });

  it('rejects another device before contacting its MJPEG stream', async () => {
    const driver = new PreparedIos('owned-iphone-udid');
    await driver.prepareRecordingTarget();
    const caps = { ...driver.recordingCapabilities(target), 'appium:udid': 'someone-elses-device' };
    const server = createServer((_request, response) => response.end(JSON.stringify({ value: caps })));
    driver.endpoint = new AppiumClient(`http://127.0.0.1:${await listen(server)}`);
    driver.endpoint.sessionId = 'owned-appium-session';
    await assert.rejects(driver.ownedRecordingSource(), /UDID/);
  });

  it('binds the stream to explicit WDA/MJPEG ports and refuses a later WDA session switch', async () => {
    const driver = new PreparedIos('owned-iphone-udid');
    await driver.prepareRecordingTarget();
    const caps = driver.recordingCapabilities(target);
    let wdaSession = 'owned-wda-session';
    const wda = createServer((_request, response) => response.end(JSON.stringify({ sessionId: wdaSession, value: { ready: true } })));
    await listen(wda, Number(caps['appium:wdaLocalPort']));
    const appium = createServer((_request, response) => response.end(JSON.stringify({ value: caps })));
    driver.endpoint = new AppiumClient(`http://127.0.0.1:${await listen(appium)}`); driver.endpoint.sessionId = 'owned-appium-session';
    const source = await driver.ownedRecordingSource();
    assert.equal(source.url, `http://127.0.0.1:${caps['appium:mjpegServerPort']}`);
    wdaSession = 'new-unowned-wda-session';
    await assert.rejects(source.assertIdentity(), /WDA session identity/);
    driver.endpoint.sessionId = 'another-appium-session';
    await assert.rejects(source.assertIdentity(), /session이 변경/);
  });

  it('rejects a recording binding for another device without opening any capture backend', async () => {
    const driver = new PreparedIos('owned-iphone-udid');
    await assert.rejects(startTargetRecording(driver, { binding: { attemptId: 'a', runId: 'r', platform: 'ios', deviceId: 'other-device', generation: null }, file: '/unused/video.mp4', signal: new AbortController().signal }), { code: 'recording_binding_refused' });
  });
});
