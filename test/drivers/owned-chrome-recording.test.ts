import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { it } from 'node:test';
import { DesktopWebDriver } from '../../src/drivers/desktop.ts';
import { startOwnedChromeRecording } from '../../src/drivers/owned-chrome-recording.ts';
import { resolveMediaTools } from '../../src/drivers/recording-media.ts';

const mediaToolsMissing = (await resolveMediaTools().catch(() => null)) === null;

class OwnedPage extends DesktopWebDriver {
  constructor() { super('desktop-chrome', 'owned-context'); }
  override async ownedChromePage() { return 'ws://127.0.0.1:12345/devtools/page/owned'; }
}

for (const event of ['Page.windowOpen', 'Page.javascriptDialogOpening', 'Page.fileChooserOpened', 'invalid-frame']) {
  it(`does not claim page-only readiness after ${event}`, { skip: mediaToolsMissing }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qa-page-scope-'));
    const Original = globalThis.WebSocket;
    class ScriptedSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(data: string) {
        const request = JSON.parse(data) as { id: number; method: string };
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result: {} }) }));
          if (request.method === 'Page.startScreencast') {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { text: 'Recording started' } }) }));
            const message = event === 'invalid-frame'
              ? { method: 'Page.screencastFrame', params: { sessionId: 1, data: Buffer.from('not a valid JPEG frame').toString('base64'), metadata: { timestamp: Date.now() / 1000 } } }
              : { method: event, params: {} };
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
          }
        });
      }
      close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
    }
    globalThis.WebSocket = ScriptedSocket as unknown as typeof WebSocket;
    try {
      const driver = new OwnedPage();
      await assert.rejects(startOwnedChromeRecording(driver, { binding: { attemptId: 'attempt-page', runId: 'run-page', platform: driver.platform, deviceId: driver.deviceId, generation: null }, file: join(directory, 'capture.mp4'), signal: new AbortController().signal }), { code: event === 'invalid-frame' ? 'recorder_not_ready' : 'capture_scope_unsupported' });
      assert.equal(existsSync(join(directory, 'capture.mp4')), true);
    } finally { globalThis.WebSocket = Original; rmSync(directory, { recursive: true, force: true }); }
  });
}

it('starts and validates a Chrome recording with the one resolved ffmpeg/ffprobe, not a later PATH entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-chrome-tools-'));
  const log = join(directory, 'calls.log');
  const fake = (name: string, failing: boolean): string => {
    const bin = join(directory, name);
    mkdirSync(bin, { mode: 0o700 });
    const head = `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> ${JSON.stringify(log)}\n${failing ? 'exit 1\n' : ''}`;
    writeFileSync(join(bin, 'ffmpeg'), `${head}[ "$1" = "-version" ] && { echo "ffmpeg version fake-1"; exit 0; }\nfor last; do :; done\ncase "$last" in *.mp4) printf 'fake-video-bytes-fake-video-bytes-fake-video' > "$last";; esac\nexit 0\n`);
    writeFileSync(join(bin, 'ffprobe'), `${head}[ "$1" = "-version" ] && { echo "ffprobe version fake-1"; exit 0; }\necho '{"streams":[{"codec_type":"video","width":64,"height":64,"nb_read_frames":"2"}],"format":{"duration":"1000"}}'\n`);
    chmodSync(join(bin, 'ffmpeg'), 0o700); chmodSync(join(bin, 'ffprobe'), 0o700);
    return bin;
  };
  const original = process.env.PATH;
  const OriginalSocket = globalThis.WebSocket;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  class ScriptedSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data: string) {
      const request = JSON.parse(data) as { id: number; method: string };
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result: request.method === 'Page.captureScreenshot' ? { data: jpeg } : {} }) }));
        if (request.method === 'Page.startScreencast') this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.screencastFrame', params: { sessionId: 1, data: jpeg, metadata: { timestamp: Date.now() / 1000 } } }) }));
      });
    }
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  try {
    const resolved = fake('resolved', false);
    const shadow = fake('shadow', true);
    process.env.PATH = [resolved, original].join(delimiter);
    globalThis.WebSocket = ScriptedSocket as unknown as typeof WebSocket;
    const driver = new OwnedPage();
    const file = join(directory, 'capture.mp4');
    const recording = await startOwnedChromeRecording(driver, { binding: { attemptId: 'attempt-tools', runId: 'run-tools', platform: driver.platform, deviceId: driver.deviceId, generation: null }, file, signal: new AbortController().signal });
    process.env.PATH = [shadow, original].join(delimiter);
    await assert.rejects(recording.stop(), { code: 'video_frame_mismatch' });
    const ffmpeg = realpathSync(join(resolved, 'ffmpeg')), ffprobe = realpathSync(join(resolved, 'ffprobe'));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const binaries = new Set(calls.map(line => line.split(' ', 1)[0]));
    assert.deepEqual(binaries, new Set([ffmpeg, ffprobe]));
    assert.ok(calls.some(line => line.startsWith(`${ffmpeg} `) && line.includes('-frames:v 1')), 'start decoded the first frame with the resolved ffmpeg');
    assert.ok(calls.some(line => line.startsWith(`${ffmpeg} `) && line.includes('-f concat')), 'encoder used the resolved ffmpeg');
    assert.ok(calls.some(line => line.startsWith(`${ffmpeg} `) && line.includes('-fps_mode passthrough')), 'validation decoded with the resolved ffmpeg');
    assert.ok(calls.some(line => line.startsWith(`${ffprobe} `) && line.includes('-count_frames')), 'validation probed with the resolved ffprobe');
    const receipt = JSON.parse(readFileSync(`${file}.integrity.json`, 'utf8'));
    assert.equal(receipt.tools.ffmpeg.path, ffmpeg);
    assert.equal(receipt.tools.ffmpeg.version, 'ffmpeg version fake-1');
  } finally { process.env.PATH = original; globalThis.WebSocket = OriginalSocket; rmSync(directory, { recursive: true, force: true }); }
});
