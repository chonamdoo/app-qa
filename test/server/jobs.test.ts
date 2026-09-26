import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventBus } from '../../src/core/events.ts';
import { deviceClaims, JobQueue, JobRequest, type JobHandlers, type JobOutcome } from '../../src/server/jobs.ts';
import { AppProfile } from '../../src/spec/schema.ts';

const webProfile = AppProfile.parse({ id: 'shop', name: '상점', web: { url: 'http://localhost:4173/', platforms: ['desktop-chrome', 'android'] } });
const appProfile = AppProfile.parse({ id: 'tteonam', name: '떠남', android: { package: 'kr.tteonam.app' } });

const request = (body: unknown): JobRequest => JobRequest.parse(body);

describe('job request validation', () => {
  test('every platform and `all` are accepted for run/smoke; capture takes one platform', () => {
    for (const platform of ['android', 'ios', 'desktop-chrome', 'desktop-safari', 'all']) {
      assert.ok(JobRequest.safeParse({ kind: 'run', params: { platform } }).success, platform);
      assert.ok(JobRequest.safeParse({ kind: 'smoke', params: { app: 'shop', platform } }).success, platform);
    }
    assert.ok(JobRequest.safeParse({ kind: 'capture', params: { app: 'shop', platform: 'desktop-safari', name: 'home' } }).success);
    assert.equal(JobRequest.safeParse({ kind: 'capture', params: { app: 'shop', platform: 'all', name: 'home' } }).success, false);
  });

  test('deviceIds takes any platform key and rejects unknown keys or empty ids', () => {
    assert.ok(JobRequest.safeParse({ kind: 'run', params: { deviceIds: { 'desktop-chrome': 'desktop-chrome', android: 'emulator-5554' } } }).success);
    assert.equal(JobRequest.safeParse({ kind: 'run', params: { deviceIds: { windows: 'pc' } } }).success, false);
    assert.equal(JobRequest.safeParse({ kind: 'run', params: { deviceIds: { ios: '' } } }).success, false);
  });
});

describe('device claims', () => {
  test('smoke `all` claims exactly the profile platforms; desktop claims its one browser', () => {
    const smoke = request({ kind: 'smoke', params: { app: 'shop', platform: 'all', deviceIds: { android: 'emulator-5554' } } });
    assert.deepEqual(deviceClaims(smoke, webProfile), ['android:emulator-5554', 'desktop-chrome:desktop-chrome']);
    assert.deepEqual(deviceClaims(request({ kind: 'smoke', params: { app: 'tteonam' } }), appProfile), ['android:*']);
  });

  test('`all` without a known profile (runs, unloadable profile) claims every platform', () => {
    assert.deepEqual(deviceClaims(request({ kind: 'run', params: {} })), ['android:*', 'ios:*', 'desktop-chrome:desktop-chrome', 'desktop-safari:desktop-safari']);
    assert.deepEqual(deviceClaims(request({ kind: 'smoke', params: { app: 'gone' } }), null).length, 4);
  });

  test('capture on desktop claims the browser', () => {
    assert.deepEqual(deviceClaims(request({ kind: 'capture', params: { app: 'shop', platform: 'desktop-safari', name: 'home' } })), ['desktop-safari:desktop-safari']);
  });
});

describe('job queue with web targets', () => {
  /** Queue whose run handler parks until the test releases it; profiles resolve from the table above. */
  function parkedQueue() {
    const gates: PromiseWithResolvers<JobOutcome>[] = [];
    const park = () => {
      const gate = Promise.withResolvers<JobOutcome>();
      gates.push(gate);
      return gate.promise;
    };
    const handlers: JobHandlers = { run: park, smoke: park, plan: park, calibrate: park, capture: park };
    const profiles: Record<string, AppProfile> = { shop: webProfile, tteonam: appProfile };
    const queue = new JobQueue(handlers, new EventBus(), (app) => profiles[app] ?? null);
    /** Releases parked handlers until nothing is queued or running (released jobs start the queued ones). */
    const drain = async () => {
      while (queue.list().some((j) => j.state === 'queued' || j.state === 'running')) {
        for (const gate of gates) gate.resolve({ ok: true, message: 'ok', resultPath: null });
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    return { queue, drain };
  }

  test('devices whose ids share a prefix before `:` (adb over Wi-Fi) do not block each other', async () => {
    const { queue, drain } = parkedQueue();
    const a = queue.enqueue(request({ kind: 'run', params: { platform: 'android', deviceIds: { android: '192.168.0.2:5555' } } }));
    const b = queue.enqueue(request({ kind: 'run', params: { platform: 'android', deviceIds: { android: '192.168.0.2:5556' } } }));
    const c = queue.enqueue(request({ kind: 'run', params: { platform: 'android', deviceIds: { android: '192.168.0.2:5555' } } }));
    assert.deepEqual([a, b, c].map((j) => queue.get(j.id)?.state), ['running', 'running', 'queued']);
    await drain();
  });

  test('a web smoke on desktop runs beside an Android app job; a smoke `all` of the same site waits for its Android device', async () => {
    const { queue, drain } = parkedQueue();
    const app = queue.enqueue(request({ kind: 'smoke', params: { app: 'tteonam', platform: 'android' } }));
    const desktop = queue.enqueue(request({ kind: 'smoke', params: { app: 'shop', platform: 'desktop-chrome' } }));
    const all = queue.enqueue(request({ kind: 'smoke', params: { app: 'shop', platform: 'all' } }));
    assert.deepEqual([app, desktop, all].map((j) => queue.get(j.id)?.state), ['running', 'running', 'queued']);
    assert.equal(desktop.title, '스모크 · shop · Chrome (macOS)');
    assert.equal(all.title, '스모크 · shop · Android Chrome + Chrome (macOS)');
    await drain();
  });
});
