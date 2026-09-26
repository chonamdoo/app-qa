import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import type { Snapshot } from '../../src/core/types.ts';
import { buildScreenModel } from '../../src/observe/index.ts';
import type { Manifest } from '../../src/report/manifest.ts';
import { checkHealth } from '../../src/runner/health.ts';
import { dHash, decodePng, hammingHex } from '../../src/runner/image.ts';
import { FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { commitSafe } from '../helpers/jev-stub.ts';
import { runYaml } from '../helpers/run.ts';

/** Minimal RGB PNG with one colour (filter 0 rows). */
function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function health(snap: Snapshot, appId = 'kr.tteonam.app') {
  const model = buildScreenModel(snap, {});
  return checkHealth(model, snap.screenshotPng ? decodePng(snap.screenshotPng) : null, appId);
}

describe('health rules', () => {
  it('detects the RN RedBox on android/ticketestimate', () => {
    const kinds = health(fixtureSnapshot('android', 'ticketestimate', 'launch'), 'com.ticketestimate').map((f) => `${f.kind}:${f.severity}`);
    assert.deepEqual(kinds, ['rn_redbox:fail']);
  });

  it('is clean on a healthy tteonam screen', () => {
    assert.deepEqual(health(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' })), []);
  });

  it('flags a blank screen only when tree, OCR and pixels are all empty', () => {
    const empty = { ...fixtureSnapshot('android', 'tteonam', 'launch'), nodes: [], screenshotPng: solidPng(90, 200, [255, 255, 255]) };
    assert.deepEqual(health(empty).map((f) => f.kind), ['blank_screen']);
    const logo = solidPng(90, 200, [255, 255, 255]);
    assert.deepEqual(health({ ...fixtureSnapshot('android', 'tteonam', 'launch'), screenshotPng: logo }), [], 'a solid screenshot with content in the tree is not blank');
  });

  it('keeps a collapsed LogBox warning a WARN', () => {
    const snap = fixtureSnapshot('android', 'tteonam', 'launch', { patch: [['text="출발했어요"', 'text="Open debugger to view warnings."']] });
    assert.deepEqual(health(snap).map((f) => `${f.kind}:${f.severity}`), ['rn_logbox_warning:warn']);
  });

  it('dHash separates different screens and matches identical ones', () => {
    const a = decodePng(readFileSync('fixtures/android/tteonam/launch.png'))!;
    const b = decodePng(readFileSync('fixtures/android/tteonam/tab-departures.png'))!;
    assert.equal(hammingHex(dHash(a), dHash(a)), 0);
    assert.ok(hammingHex(dHash(a), dHash(b)) >= 7);
  });

  it('fails app_not_foreground after a tap and attaches the log slice and crash artifacts', async () => {
    const launch = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' });
    const driver = new FakeDriver(launch);
    driver.crashes = [{ name: 'crash-1.txt', content: 'FATAL EXCEPTION: main' }];
    driver.onTap = (p) => (hits(launch, '출국장', p) ? { ...fixtureSnapshot('android', 'settings', 'launch'), foregroundApp: 'com.android.settings' } : null);
    const { result } = await runYaml({ 'tests/crash.e2e.yaml': 'name: crash\napp: tteonam\nstart: attach\nsteps:\n  - tap: 출국장\n  - tap: 주차\n' }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'app_not_foreground');
    assert.equal(driver.called('tap').length, 1, 'the test stops at the failing step');
    assert.ok(t.logs && existsSync(join(result.runDir, t.logs)));
    assert.equal(t.crash.length, 1);
    assert.equal(readFileSync(join(result.runDir, t.crash[0]!), 'utf8'), 'FATAL EXCEPTION: main');
    const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.ok(manifest.entries.some((e) => e.kind === 'crash'));
    assert.ok(manifest.entries.some((e) => e.kind === 'log' && e.relativePath.endsWith('device.log')));
  });

  it('counts a canvas-only change (identical tree, different pixels) via dHash', async () => {
    const launch = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' });
    const driver = new FakeDriver(launch);
    const repainted = { ...launch, screenshotPng: new Uint8Array(readFileSync('fixtures/android/tteonam/tab-departures.png')) };
    driver.onTap = () => repainted;
    const { result } = await runYaml({ 'tests/canvas.e2e.yaml': 'name: canvas\napp: tteonam\nstart: attach\nsteps:\n  - tap: 출국장\n' }, driver, { jev: commitSafe().setup });
    const tap = result.tests[0]!.steps[1]!;
    assert.equal(tap.verdict, 'PASS', tap.reason);
    assert.equal(tap.settle?.changed, true);
  });
});
