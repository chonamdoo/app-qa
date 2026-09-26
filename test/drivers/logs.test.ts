// Device logs reach .qa/logs only through the runner's sanitizer: whole lines across chunk and UTF-8 boundaries,
// a trailing line without a newline sanitized when the stream ends, and a failing sanitizer never passes raw text on.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { sanitizeLines } from '../../src/drivers/logs.ts';
import { installFakeAdb, type FakeAdb } from './stubs.ts';

const SECRET = 'hunter2비밀';
const mask = (line: string) => line.replaceAll(SECRET, '[MASKED]');

describe('device log line sanitizing', () => {
  it('sanitizes whole lines even when a secret and a UTF-8 character are split across chunks', async () => {
    const bytes = Buffer.from(`a ${SECRET} b\nplain\ntail ${SECRET}`);
    const inChar = bytes.indexOf(Buffer.from('비')) + 1;
    const seen: string[] = [];
    const out = await text(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4, inChar), bytes.subarray(inChar)]).pipe(
        sanitizeLines((line) => {
          seen.push(line);
          return mask(line);
        }),
      ),
    );
    assert.deepEqual(seen, [`a ${SECRET} b`, 'plain', `tail ${SECRET}`]);
    assert.equal(out, 'a [MASKED] b\nplain\ntail [MASKED]\n');
  });

  it('a failing sanitizer fails the stream instead of passing the line on', async () => {
    const passed: string[] = [];
    const lines = sanitizeLines((line) => {
      if (line.includes(SECRET)) throw new Error('sanitizer down');
      return line;
    });
    lines.on('data', (d: Buffer) => passed.push(d.toString('utf8')));
    await assert.rejects(text(Readable.from([Buffer.from(`ok\n${SECRET}\n`)]).pipe(lines)), /sanitizer down/);
    assert.ok(!passed.join('').includes(SECRET));
  });
});

describe('android device log capture', () => {
  let fake: FakeAdb;
  beforeEach(() => {
    fake = installFakeAdb();
  });
  afterEach(() => fake.restore());

  it('writes the logcat stream to .qa/logs only through the sanitizer, trailing partial line included', async () => {
    const lines = [
      `2026-09-26 01:00:00.000 +0000  4242  4242 I ReactNativeJS: login pw=${SECRET}`,
      '2026-09-26 01:00:00.001 +0000  4242  4242 I ReactNativeJS: 화면 전환',
      `2026-09-26 01:00:00.002 +0000  4242  4242 E ReactNativeJS: token ${SECRET}`,
    ];
    writeFileSync(join(fake.root, 'logcat.txt'), lines.join('\n')); // no newline after the last line
    const serial = `emulator-logtest-${process.pid}`;
    const files = () =>
      readdirSync(PATHS.logs)
        .filter((f) => f.startsWith(`android-${serial}-`))
        .map((f) => join(PATHS.logs, f));
    const driver = new AndroidDriver(serial);
    try {
      await driver.startLogs({ platform: 'android', appId: 'kr.tteonam.app' }, mask);
      // The fake logcat exits after printing; the last line is written once the stream ends.
      for (let i = 0; i < 100 && (await driver.logSlice('2026-09-26T00:59:00Z', '2026-09-26T01:01:00Z')).split('\n').length < 3; i++) await delay(50);
      await driver.close();
      const [file] = files();
      const written = readFileSync(file!, 'utf8');
      assert.equal(written, `${lines.map(mask).join('\n')}\n`);
      assert.ok(!written.includes(SECRET));
      assert.equal(statSync(file!).mode & 0o777, 0o600);
      assert.ok(fake.hostCalls().some((c) => c.includes('logcat') && c.includes('--pid=4242')));
    } finally {
      await driver.close();
      for (const f of files()) rmSync(f, { force: true });
    }
  });
});
