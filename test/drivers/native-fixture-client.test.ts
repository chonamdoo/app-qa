import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AppiumClient } from '../../src/appium/client.ts';
import { ProjectFixtureError, type ProjectFixtureNativeBootstrap, type ProjectFixtureNativeClaim, type ProjectFixtureNativeIdentity } from '../../src/core/project-fixture.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import type { NativeFixtureMailbox } from '../../src/drivers/base.ts';
import { nativeBuildManifestSha256, nativeBundleSha256, readNativeMailboxFile, writeNativeMailboxFile } from '../../src/drivers/native-fixture-mailbox.ts';

it('uses the actual owned Appium session and build, refuses replacement sessions, and does not resend mailbox claims', async t => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ value: request.method === 'DELETE' ? null : { platformName: 'Android', 'appium:udid': 'owned-device' } }));
  });
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const writes = new Map<string, string>();
  let closed = false;
  let cleanupFails = false;
  let build = '1'.repeat(64);
  class Driver extends AndroidDriver {
    constructor() {
      super('owned-device');
      this.client = new AppiumClient(`http://127.0.0.1:${port}`);
      this.client.sessionId = 'owned-session';
      this.opened = { kind: 'app', appId: 'qa.example.shop', platform: 'android' };
    }
    replaceSession(id = 'replacement-session'): void { this.client!.sessionId = id; }
    protected override async nativeFixtureBuildSha256(app: string): Promise<string> { assert.equal(app, 'qa.example.shop'); return build; }
    protected override async openNativeFixtureMailbox(identity: ProjectFixtureNativeIdentity): Promise<NativeFixtureMailbox> {
      assert.equal(identity.deviceId, 'owned-device');
      return {
        async write(name, value) { if (writes.has(name)) throw new ProjectFixtureError('fixture_request_reused'); writes.set(name, value); },
        async read(name) {
          const request = name.replace('.response.', '.request.');
          const value = writes.get(request);
          if (value !== undefined) { writes.delete(request); writes.set(name.replace('.response.', '.claimed.'), value); }
          return '{"signed":"witness"}';
        },
        async close() { if (cleanupFails) throw new Error('unconfirmed private mailbox cleanup'); closed = true; },
      };
    }
  }
  const driver = new Driver();
  const nativeClient = await driver.nativeProjectFixtureIdentity();
  assert.equal(nativeClient.sessionId, 'owned-session');
  const bootstrap: ProjectFixtureNativeBootstrap = { kind: 'native-private-mailbox', nativeClient, clientEndpoint: 'https://qa.example.test/client', mailbox: 'qautra-fixture', token: '2'.repeat(64), clientAuthorityId: 'actual-enforcer-principal', lease: { id: 'original-lease', generation: 3, fence: 9, expiresAt: new Date(Date.now() + 60000).toISOString() }, attemptId: 'original-attempt', ownerId: 'original-owner', subjectSha256: '3'.repeat(64), scopeSha256: '4'.repeat(64) };
  await driver.applyNativeProjectFixture(bootstrap);
  await assert.rejects(driver.applyNativeProjectFixture(bootstrap), ProjectFixtureError);
  const claim: ProjectFixtureNativeClaim = { schema: 'qautra/project-fixture-native-claim/v1', token: bootstrap.token, nativeClient, challenge: '5'.repeat(64), receiptSha256: '6'.repeat(64) };
  await driver.nativeProjectFixtureWitness(claim);
  await assert.rejects(driver.nativeProjectFixtureWitness(claim), ProjectFixtureError);
  build = '7'.repeat(64);
  await assert.rejects(driver.nativeProjectFixtureWitness({ ...claim, challenge: '8'.repeat(64) }), ProjectFixtureError);
  assert.equal(writes.size, 2);
  build = nativeClient.buildSha256;
  driver.replaceSession();
  await assert.rejects(driver.nativeProjectFixtureWitness({ ...claim, challenge: '9'.repeat(64) }), ProjectFixtureError);
  assert.equal(writes.size, 2);
  await assert.rejects(driver.close(), ProjectFixtureError);
  assert.equal(requests.some(request => request.startsWith('DELETE')), false);
  driver.replaceSession('owned-session');
  cleanupFails = true;
  await assert.rejects(driver.close());
  assert.ok(requests.includes('DELETE /session/owned-session'));
  cleanupFails = false;
  await driver.close();
  assert.equal(closed, true);
  assert.ok(requests.every(request => request === 'GET /session/owned-session' || request === 'DELETE /session/owned-session'));
});

it('hashes actual complete bundle contents and atomically exchanges bounded, private, non-replayable mailbox files', t => {
  const root = mkdtempSync(join(tmpdir(), 'qautra-native-mailbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'qa.app');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'binary'), 'original executable');
  writeFileSync(join(bundle, 'config.json'), '{"qa":true}');
  const original = nativeBundleSha256(bundle);
  writeFileSync(join(bundle, 'config.json'), '{"qa":false}');
  assert.notEqual(nativeBundleSha256(bundle), original);
  assert.equal(nativeBuildManifestSha256([{ name: 'base.apk', sha256: '1'.repeat(64) }, { name: 'split.apk', sha256: '2'.repeat(64) }]), nativeBuildManifestSha256([{ name: 'split.apk', sha256: '2'.repeat(64) }, { name: 'base.apk', sha256: '1'.repeat(64) }]));
  symlinkSync(join(bundle, 'binary'), join(bundle, 'alias'));
  assert.throws(() => nativeBundleSha256(bundle), ProjectFixtureError);
  const mailbox = join(root, 'owned-session');
  mkdirSync(mailbox, { mode: 0o700 });
  const file = join(mailbox, 'claim.json');
  writeNativeMailboxFile(file, '{"challenge":"original"}');
  assert.equal(readNativeMailboxFile(file), '{"challenge":"original"}');
  assert.throws(() => writeNativeMailboxFile(file, '{}'));
  assert.equal(readNativeMailboxFile(file), '{"challenge":"original"}');
  unlinkSync(file);
  rmdirSync(mailbox);
  assert.equal(existsSync(mailbox), false);
  const target = join(root, 'target');
  writeFileSync(target, 'unchanged', { mode: 0o600 });
  symlinkSync(target, join(root, 'untrusted'));
  assert.throws(() => readNativeMailboxFile(join(root, 'untrusted')));
  writeFileSync(join(root, 'oversized'), 'x'.repeat(262145), { mode: 0o600 });
  assert.throws(() => readNativeMailboxFile(join(root, 'oversized')), ProjectFixtureError);
});
