import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;

describe('compiled GuestJSON consumer boundaries', {
  skip: process.platform === 'darwin' ? false : 'GuestSupport.swift imports Darwin and CryptoKit; compiling this fixture requires macOS and xcrun.',
}, () => {
  let scratch: string | undefined;
  let executable: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'qa-guest-json-'));
    executable = join(scratch, 'guest-json-fixture');
    const compiled = spawnSync('/usr/bin/xcrun', [
      'swiftc', '-parse-as-library', '-swift-version', '6', '-strict-concurrency=complete', '-O',
      fileURLToPath(new URL('../../src/drivers/vm/guest/GuestSupport.swift', import.meta.url)),
      fileURLToPath(new URL('./fixtures/GuestJSONFixture.swift', import.meta.url)),
      '-o', executable,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: MiB });
    assert.ifError(compiled.error);
    assert.equal(compiled.signal, null, compiled.stderr);
    assert.equal(compiled.status, 0, `Swift fixture compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
  });

  after(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  function run(scenario: string): unknown {
    const result = spawnSync(executable, [scenario], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: MiB,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, `${scenario} failed:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  }

  it('accepts an 8 MiB request string but rejects one byte more with the default parser limit', () => {
    assert.deepEqual(run('request-boundary'), {
      accepted: { keys: ['value'], bytes: 8 * MiB, allA: true },
      oversizedRejected: true,
    });
  });

  it('preserves a screenshot-like base64 string above the request cap with the response limit', () => {
    assert.deepEqual(run('large-response'), {
      keys: ['value'], bytes: 8 * MiB + 1, allA: true,
    });
  });

  it('accepts an entire 15 MiB response without truncating its screenshot-like value', () => {
    const overhead = Buffer.byteLength('{"value":""}');
    assert.deepEqual(run('whole-response-boundary'), {
      frameBytes: 15 * MiB,
      value: { keys: ['value'], bytes: 15 * MiB - overhead, allA: true },
    });
  });

  it('accepts a 15 MiB response string but rejects one byte more', () => {
    assert.deepEqual(run('response-string-boundary'), {
      accepted: { keys: ['value'], bytes: 15 * MiB, allA: true },
      oversizedRejected: true,
    });
  });

  it('rejects a valid JSON frame above 16 MiB even with the response string limit', () => {
    assert.deepEqual(run('oversized-frame'), {
      frameBytes: 16 * MiB + 1,
      fault: 'invalid_json',
    });
  });

  it('rejects duplicate keys, invalid UTF-8, malformed escapes, unpaired surrogates, and trailing JSON', () => {
    assert.deepEqual(run('malformed'), {
      duplicateNullKey: 'duplicate_json_key',
      duplicateEscapedKey: 'duplicate_json_key',
      invalidUTF8Rejected: true,
      invalidEscapeRejected: true,
      invalidHexEscapeRejected: true,
      truncatedEscapeRejected: true,
      unpairedHighSurrogateRejected: true,
      unpairedLowSurrogateRejected: true,
      mismatchedSurrogateRejected: true,
      trailingLiteralRejected: true,
      trailingObjectRejected: true,
    });
  });

  it('preserves Unicode, an escaped surrogate pair, JSON literals, arrays, and numbers', () => {
    assert.deepEqual(run('valid-values'), {
      '문구': '😀\nQA',
      plain: '한글 café 😀',
      escaped: '"\\/\b\f\n\r\t',
      literals: [true, false, null],
      numbers: [0, -125, 0.125, 2000],
      nested: { value: 'kept' },
    });
  });
});
