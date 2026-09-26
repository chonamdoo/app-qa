import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, test } from 'node:test';
import { JevError, loadJevConfig } from '../../src/jev/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'jev-cfg-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const KEY = 'ts_live_abcdef0123456789';

function keyFile(mode: number): string {
  const file = join(dir, `key-${mode.toString(8)}`);
  writeFileSync(file, `${KEY}\n`);
  chmodSync(file, mode);
  return file;
}

const isConfigError = (e: unknown) => e instanceof JevError && e.kind === 'config';

test('a key file readable by group/others is refused; 0600 is accepted and trimmed', () => {
  assert.throws(() => loadJevConfig({ TYPESAFE_API_KEY_FILE: keyFile(0o644) }), isConfigError);
  assert.throws(() => loadJevConfig({ TYPESAFE_API_KEY_FILE: keyFile(0o640) }), isConfigError);
  assert.equal(loadJevConfig({ TYPESAFE_API_KEY_FILE: keyFile(0o600) }).apiKey, KEY);
});

test('the key never shows up when the config is serialized or inspected', () => {
  const config = loadJevConfig({ TYPESAFE_API_KEY: KEY });
  assert.equal(config.apiKey, KEY);
  assert.doesNotMatch(JSON.stringify(config), new RegExp(KEY));
  assert.doesNotMatch(inspect(config), new RegExp(KEY));
});

test('defaults pin jev-1.13.0 on the public endpoint; base URL override drops trailing slashes', () => {
  const c = loadJevConfig({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://127.0.0.1:9999/v1/' });
  assert.equal(c.model, 'jev-1.13.0');
  assert.equal(c.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(loadJevConfig({ TYPESAFE_API_KEY: KEY }).baseUrl, 'https://api.typesafe.ai/v1');
});

test('model aliases are refused (the response would never match the pinned id)', () => {
  assert.throws(() => loadJevConfig({ TYPESAFE_API_KEY: KEY, QA_JEV_MODEL: 'jev-latest' }), isConfigError);
});

test('live and record need a key; replay does not', () => {
  assert.throws(() => loadJevConfig({}), isConfigError);
  assert.throws(() => loadJevConfig({}, { mode: 'record' }), isConfigError);
  assert.equal(loadJevConfig({}, { mode: 'replay' }).apiKey, null);
  assert.throws(() => loadJevConfig({ QA_JEV_MODE: 'mock' }), isConfigError);
});

test('keys with whitespace or non-ASCII characters are refused', () => {
  assert.throws(() => loadJevConfig({ TYPESAFE_API_KEY: 'ts live key' }), isConfigError);
  assert.throws(() => loadJevConfig({ TYPESAFE_API_KEY: 'ts_키' }), isConfigError);
});
