import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { it } from 'node:test';
import { MediaToolUnavailableError, resolveMediaTools, runRecordingCommand, validateRecordedVideo, type MediaTools } from '../../src/drivers/recording-media.ts';

const toolsMissing = !existsSync('/opt/homebrew/bin/ffmpeg') || !existsSync('/opt/homebrew/bin/ffprobe');
const homebrewTools: MediaTools = { ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', version: 'ffmpeg version test' }, ffprobe: { path: '/opt/homebrew/bin/ffprobe', version: 'ffprobe version test' } };

function fakeTools(directory: string, name: string, log: string, failing: boolean): string {
  const bin = join(directory, name);
  mkdirSync(bin, { mode: 0o700 });
  const tool = (tool: 'ffmpeg' | 'ffprobe', body: string) => {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> ${JSON.stringify(log)}\n${failing ? 'exit 1\n' : ''}[ "$1" = "-version" ] && { echo "${tool} version fake-1"; exit 0; }\n${body}\n`);
    chmodSync(join(bin, tool), 0o700);
  };
  tool('ffmpeg', 'exit 0');
  tool('ffprobe', `case "$*" in *bad.mp4*) echo "decoder failed for secret-token" >&2; exit 1;; esac\necho '{"streams":[{"codec_type":"video","width":64,"height":64,"nb_read_frames":"3"}],"format":{"duration":"0.3"}}'`);
  return bin;
}

it('validates with the resolved absolute ffmpeg/ffprobe even if PATH changes, and records them in the receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-media-tools-'));
  const original = process.env.PATH;
  try {
    const log = join(directory, 'calls.log');
    const resolved = fakeTools(directory, 'resolved', log, false);
    const shadow = fakeTools(directory, 'shadow', log, true);
    process.env.PATH = [resolved, original].join(delimiter);
    const tools = await resolveMediaTools();
    assert.equal(tools.ffmpeg.path, realpathSync(join(resolved, 'ffmpeg')));
    assert.equal(tools.ffprobe.path, realpathSync(join(resolved, 'ffprobe')));
    assert.equal(tools.ffmpeg.version, 'ffmpeg version fake-1');
    process.env.PATH = [shadow, original].join(delimiter);
    const file = join(directory, 'video.mp4');
    writeFileSync(file, Buffer.alloc(64, 1), { mode: 0o600 });
    const video = await validateRecordedVideo(file, tools);
    assert.equal(video.frames, 3);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ', 1)[0]);
    assert.ok(calls.length >= 4);
    assert.deepEqual(new Set(calls), new Set([tools.ffmpeg.path, tools.ffprobe.path]));
    assert.deepEqual(JSON.parse(readFileSync(`${file}.integrity.json`, 'utf8')).tools, tools);
  } finally { process.env.PATH = original; rmSync(directory, { recursive: true, force: true }); }
});

it('fails closed without a usable ffmpeg/ffprobe on PATH and keeps the resolved path in the diagnostic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-media-tools-missing-'));
  const original = process.env.PATH;
  try {
    const broken = fakeTools(directory, 'broken', join(directory, 'calls.log'), true);
    process.env.PATH = [broken, '/nonexistent'].join(delimiter);
    const path = realpathSync(join(broken, 'ffmpeg'));
    await assert.rejects(resolveMediaTools(), (error: unknown) => error instanceof MediaToolUnavailableError
      && error.code === 'video_tool_unavailable' && error.tool === 'ffmpeg' && error.path === path && error.message.includes(path));
  } finally { process.env.PATH = original; rmSync(directory, { recursive: true, force: true }); }
});

it('persists tool stderr only through the supplied sanitizer and never raw', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-media-diagnostic-'));
  const original = process.env.PATH;
  try {
    process.env.PATH = [fakeTools(directory, 'bin', join(directory, 'calls.log'), false), original].join(delimiter);
    const tools = await resolveMediaTools();
    for (const sanitize of [undefined, (text: string) => text.replaceAll('secret-token', '[REDACTED]')]) {
      const file = join(directory, `${sanitize ? 'sanitized' : 'raw'}-bad.mp4`);
      writeFileSync(file, Buffer.alloc(64, 1), { mode: 0o600 });
      await assert.rejects(validateRecordedVideo(file, tools, sanitize), { code: 'video_unplayable' });
      const text = readFileSync(`${file}.validation.json`, 'utf8');
      assert.equal(text.includes('secret-token'), false);
      const diagnostic = JSON.parse(text);
      assert.ok(diagnostic.stderr.bytes > 0);
      assert.equal(diagnostic.stderr.text === null, sanitize === undefined);
      assert.deepEqual(diagnostic.tools, tools);
    }
  } finally { process.env.PATH = original; rmSync(directory, { recursive: true, force: true }); }
});

it('retains a corrupt original with its streaming checksum rather than inventing video metadata', { skip: toolsMissing }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-corrupt-media-'));
  try {
    const file = join(directory, 'corrupt.mp4');
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 0x62);
    writeFileSync(file, bytes, { mode: 0o600 });
    await assert.rejects(validateRecordedVideo(file, homebrewTools), { code: 'video_unplayable' });
    const integrity = JSON.parse(readFileSync(`${file}.integrity.json`, 'utf8'));
    assert.equal(integrity.bytes, bytes.length);
    assert.equal(integrity.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file).length, bytes.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('requires actual encoded frames and full decoding before accepting frame and duration metadata', { skip: toolsMissing }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-valid-media-'));
  try {
    const file = join(directory, 'encoded.mp4');
    await runRecordingCommand('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10', '-frames:v', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { timeoutMs: 10000 });
    const video = await validateRecordedVideo(file, homebrewTools);
    assert.equal(video.frames, 3);
    assert.equal(video.width, 64);
    assert.equal(video.height, 64);
    assert.ok(video.durationSeconds > 0);
    assert.equal(video.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('fully decodes variable-rate bursts without quantizing source timestamps to the nominal rate', { skip: toolsMissing }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-variable-media-'));
  try {
    const file = join(directory, 'variable.mp4');
    const timestamps = [0, 111, 592, 675, 792, 1075, 1159, 1225, 1275, 1292, 1342, 1392, 1675, 1742, 1809, 1892, 2392, 2892, 3392, 3892, 4392, 4892, 5392, 5892, 6392, 6892, 7392, 7892, 8392, 8892, 9392, 9891, 10375, 10408, 10458, 10508, 10525, 10575, 10591, 11058, 11141, 13025, 15025, 15758, 16125];
    writeFileSync(join(directory, 'frame.ppm'), Buffer.concat([Buffer.from('P6\n64 64\n255\n'), Buffer.alloc(64 * 64 * 3, 64)]));
    const manifest = join(directory, 'frames.ffconcat');
    writeFileSync(manifest, `ffconcat version 1.0\n${timestamps.map((timestamp, index) => `file 'frame.ppm'\noption framerate 1000\nduration ${((index + 1 < timestamps.length ? timestamps[index + 1]! - timestamp : 1) / 1000).toFixed(3)}`).join('\n')}\n`);
    await runRecordingCommand('/opt/homebrew/bin/ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', manifest, '-fps_mode', 'vfr', '-enc_time_base', '1:1000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file,
    ], { timeoutMs: 10000 });
    const video = await validateRecordedVideo(file, homebrewTools);
    assert.equal(video.frames, timestamps.length);
    assert.ok(Math.abs(video.durationSeconds - 16.126) < 0.002);
    assert.equal(video.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('reports a missing video without invoking a decoder or creating substitute evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-missing-media-'));
  try {
    const file = join(directory, 'missing.mp4');
    await assert.rejects(validateRecordedVideo(file, homebrewTools), { code: 'video_missing' });
    assert.equal(existsSync(file), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
