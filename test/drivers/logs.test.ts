// Device logs reach .qa/logs only through the runner's sanitizer: whole lines across chunk and UTF-8 boundaries,
// a trailing line without a newline sanitized when the stream ends, a failing sanitizer never passes raw text on,
// multi-line secrets masked in every part, and a re-armed capture keeps every earlier sanitizer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { LogCapture, sanitizeLines } from '../../src/drivers/logs.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';
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

  it('a multi-line secret never reaches the log in either part, even split across chunks mid-secret', async () => {
    const clean = new EvidenceSanitizer([]);
    clean.addSecret('alpha-secret\nbeta-secret');
    const bytes = Buffer.from('I ReactNativeJS: token alpha-secret\nI ReactNativeJS: beta-secret end\n');
    const cut = bytes.indexOf('alpha-') + 'alpha-'.length;
    const out = await text(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]).pipe(sanitizeLines(clean.text)));
    assert.ok(!out.includes('alpha') && !out.includes('beta'), out);
    assert.equal(out, `I ReactNativeJS: token ${'•'.repeat(12)}\nI ReactNativeJS: ${'•'.repeat(11)} end\n`);
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

  it('re-arming for a later test keeps every earlier sanitizer, on the live stream and after a restart', async () => {
    const [s1, s2] = ['first-test-token', 'second-test-token'];
    const test1 = (line: string) => line.replaceAll(s1, '[S1]');
    const test2 = (line: string) => line.replaceAll(s2, '[S2]');
    const fifo = join(fake.root, 'logcat.fifo');
    writeFileSync(join(fake.root, 'logcat.txt'), `early ${s1}\n`);
    execFileSync('mkfifo', [fifo]); // the first logcat stays open until the test writes the late line
    const logs = new LogCapture('android', `emulator-rearm-${process.pid}`);
    const until = async (marker: string) => {
      for (let i = 0; i < 100; i++) {
        try {
          if (readFileSync(logs.file, 'utf8').includes(marker)) return;
        } catch {
          // not created yet
        }
        await delay(50);
      }
      assert.fail(`log never got "${marker}"`);
    };
    try {
      await logs.arm('pid:1', 'adb', ['logcat'], test1);
      await until('early');
      await logs.arm('pid:1', 'adb', ['logcat'], test2); // the next test, same live app process
      await writeFile(fifo, `late ${s1} ${s2}\n`);
      await until('late');
      rmSync(fifo);
      writeFileSync(join(fake.root, 'logcat.txt'), `restart ${s1} ${s2}\n`);
      await logs.arm('pid:2', 'adb', ['logcat'], test2); // relaunch: a new stream into the same file
      await until('restart');
      await logs.stop();
      assert.equal(readFileSync(logs.file, 'utf8'), 'early [S1]\nlate [S1] [S2]\nrestart [S1] [S2]\n');
    } finally {
      await logs.stop();
      rmSync(logs.file, { force: true });
    }
  });
});
