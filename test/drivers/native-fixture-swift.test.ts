import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const project = fileURLToPath(new URL('../../', import.meta.url));
const Output = z.strictObject({ state: z.literal('initialized'), support: z.string() });

describe('compiled app-private Swift fixture SDK restart', {
  skip: process.platform === 'darwin' ? false : 'This Foundation app-bundle fixture requires macOS and xcrun.',
}, () => {
  let root: string | undefined;
  let executable: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-swift-fixture-restart-')));
    const contents = join(root, 'Fixture.app', 'Contents');
    executable = join(contents, 'MacOS', 'Fixture');
    mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
    writeFileSync(join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.qautra.fixture.client-restart</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>', { mode: 0o600 });
    const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-DDEBUG', '-parse-as-library', '-O',
      join(project, 'src/drivers/native/client/QAutraFixtureClient.swift'),
      fileURLToPath(new URL('./fixtures/NativeFixtureClientFixture.swift', import.meta.url)), '-o', executable,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.ifError(compiled.error); assert.equal(compiled.signal, null, compiled.stderr); assert.equal(compiled.status, 0, compiled.stderr);
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function runSDK(home: string) {
    const result = spawnSync(executable, [home], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CFFIXED_USER_HOME: home },
    });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
    return result;
  }

  it('reopens the original mailbox in a new process without replacing claimed requests or ready identity', () => {
    const home = join(root!, 'home');
    mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true, mode: 0o700 });
    function initialize() {
      const result = runSDK(home);
      assert.equal(result.status, 0, result.stderr);
      const output = Output.parse(JSON.parse(result.stdout));
      assert.equal(realpathSync(output.support), join(home, 'Library', 'Application Support'));
      return output;
    }
    initialize();
    const mailbox = join(home, 'Library', 'Application Support', 'qautra-fixture');
    const readyPath = join(mailbox, 'ready.json'), ready = readFileSync(readyPath), identity = statSync(readyPath);
    assert.deepEqual(JSON.parse(ready.toString('utf8')), { schema: 'qautra/native-private-mailbox/v1', applicationId: 'dev.qautra.fixture.client-restart' });
    const original = join(mailbox, 'original-session'); mkdirSync(original, { mode: 0o700 });
    const claim = join(original, `${'a'.repeat(64)}.claimed.json`), bytes = Buffer.from('unconfirmed original request; do not replay or replace');
    writeFileSync(claim, bytes, { flag: 'wx', mode: 0o600 });
    const claimed = statSync(claim);
    initialize();
    assert.deepEqual(readFileSync(readyPath), ready);
    assert.deepEqual([statSync(readyPath).dev, statSync(readyPath).ino], [identity.dev, identity.ino]);
    assert.deepEqual(readFileSync(claim), bytes);
    assert.deepEqual([statSync(claim).dev, statSync(claim).ino], [claimed.dev, claimed.ino]);
    assert.equal(statSync(mailbox).mode & 0o777, 0o700); assert.equal(statSync(readyPath).mode & 0o777, 0o600);
  });

  it('refuses a non-directory mailbox without changing the original file or permissions', () => {
    const home = join(root!, 'conflicting-home'), support = join(home, 'Library', 'Application Support');
    mkdirSync(support, { recursive: true, mode: 0o700 });
    const path = join(support, 'qautra-fixture'), bytes = Buffer.from('original unrelated file');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    const identity = statSync(path);
    const result = runSDK(home);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).state, 'rejected');
    const after = statSync(path);
    assert.deepEqual([after.dev, after.ino, after.mode], [identity.dev, identity.ino, identity.mode]);
    assert.deepEqual(readFileSync(path), bytes);
  });
});
