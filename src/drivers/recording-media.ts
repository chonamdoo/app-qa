import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnv } from '../appium/exec.ts';
import { AgentExecutionError } from '../core/agent.ts';
import { writeSecure } from '../core/fsx.ts';
import type { RecordingSegment } from '../core/recording.ts';

export interface MediaTool { readonly path: string; readonly version: string }
export interface MediaTools { readonly ffmpeg: MediaTool; readonly ffprobe: MediaTool }
export type DiagnosticSanitizer = (text: string) => string;

class RecordingToolError extends AgentExecutionError {
  readonly stderr: string;
  constructor(code: string, stderr: string) {
    super(code, '미디어 도구가 실패했습니다. 원본과 제한된 진단 출력을 확인하세요');
    this.stderr = stderr;
  }
}

interface ChildState { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>; ended: boolean; stderr: string }
export function childState(child: ChildProcess): ChildState {
  const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>();
  const state: ChildState = { child, done: completion.promise, ended: false, stderr: '' };
  let error: Error | null = null;
  child.stderr?.on('data', (chunk: Buffer) => { state.stderr = (state.stderr + chunk.toString('utf8')).slice(-16384); });
  child.once('error', value => { error = value; });
  child.once('close', (code, signal) => { state.ended = true; completion.resolve({ code, signal, error }); });
  return state;
}
export const timeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => Promise.race([promise, delay(ms, null, { ref: false })]);

export async function runRecordingCommand(binary: string, args: string[], options: { timeoutMs: number }): Promise<{ stdout: Buffer; stderr: string }> {
  const state = childState(spawn(binary, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  state.child.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 65536) chunks.push(chunk);
    else overflow = true;
  });
  const result = await timeout(state.done, options.timeoutMs);
  if (!result) { state.child.kill('SIGKILL'); await state.done; throw new RecordingToolError('video_tool_timeout', state.stderr); }
  if (result.error || result.code !== 0 || overflow) throw new RecordingToolError('video_unplayable', state.stderr);
  return { stdout: Buffer.concat(chunks), stderr: state.stderr };
}

// The Mac app launches the engine with only node's directory added to the Finder PATH, so the previously supported Homebrew prefixes stay as explicit fallbacks.
const MEDIA_TOOL_FALLBACK_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'];

function executableOnPath(name: 'ffmpeg' | 'ffprobe'): string | null {
  for (const directory of [...(childEnv().PATH ?? '').split(delimiter), ...MEDIA_TOOL_FALLBACK_DIRECTORIES]) {
    if (!isAbsolute(directory)) continue;
    try {
      const path = realpathSync(join(directory, name));
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch { continue; }
  }
  return null;
}

/** A recording tool that is missing or failed its version check; `path` is the executable found, if any. */
export class MediaToolUnavailableError extends AgentExecutionError {
  readonly tool: 'ffmpeg' | 'ffprobe';
  readonly path: string | null;
  constructor(tool: 'ffmpeg' | 'ffprobe', path: string | null, problem: string) {
    super('video_tool_unavailable', path ? `녹화에 필요한 ${tool}(${path})을 확인할 수 없습니다: ${problem}` : `녹화에 필요한 ${tool}을 찾지 못했습니다`);
    this.tool = tool;
    this.path = path;
  }
}

export async function resolveMediaTools(): Promise<MediaTools> {
  const tool = async (name: 'ffmpeg' | 'ffprobe'): Promise<MediaTool> => {
    const path = executableOnPath(name);
    if (!path) throw new MediaToolUnavailableError(name, null, 'not found');
    let version: string;
    try { version = (await runRecordingCommand(path, ['-version'], { timeoutMs: 5000 })).stdout.toString('utf8').split('\n', 1)[0]!.trim().slice(0, 256); }
    catch (error) { throw new MediaToolUnavailableError(name, path, `-version failed (${error instanceof AgentExecutionError ? error.code : 'spawn_failed'})`); }
    if (!version.startsWith(`${name} version `)) throw new MediaToolUnavailableError(name, path, '-version output is not recognized');
    return { path, version };
  };
  return { ffmpeg: await tool('ffmpeg'), ffprobe: await tool('ffprobe') };
}

export function diagnosticOutput(text: string, sanitize: DiagnosticSanitizer | undefined): { text: string | null; bytes: number } {
  return { text: sanitize && text ? sanitize(text) : null, bytes: Buffer.byteLength(text) };
}

export function writeDiagnostic(file: string, build: () => unknown): boolean {
  try {
    if (lstatSync(file, { throwIfNoEntry: false })) throw Object.assign(new Error('Diagnostic already exists'), { code: 'EEXIST' });
    writeSecure(file, JSON.stringify(build()));
    return true;
  } catch (error) {
    process.emitWarning(`녹화 진단 파일을 기록하지 못했습니다: ${file}`, { code: 'QAUTRA_DIAGNOSTIC_WRITE_FAILED', detail: error instanceof Error && 'code' in error ? String(error.code) : 'unknown' });
    return false;
  }
}

export async function validateRecordedVideo(file: string, tools: MediaTools, sanitize?: DiagnosticSanitizer): Promise<Omit<RecordingSegment, 'startedAt' | 'endedAt' | 'source'>> {
  const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new AgentExecutionError(missing ? 'video_missing' : 'video_file_unsafe', missing ? '녹화 원본이 없습니다' : '녹화 원본의 파일 경계를 안전하게 열 수 없습니다');
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size < 32) throw new AgentExecutionError('video_missing', '안전한 녹화 원본 파일이 없거나 비어 있습니다');
    await handle.chmod(0o600);
    await handle.sync();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new AgentExecutionError('video_changed', '녹화 파일이 hash 수집 중 변경되었습니다');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev || !named.isFile() || named.nlink !== 1 || named.ino !== after.ino || named.dev !== after.dev) throw new AgentExecutionError('video_changed', '녹화 파일 경계가 변경되었습니다');
    const digest = hash.digest('hex');
    const integrity = await open(`${file}.integrity.json`, 'wx', 0o600);
    try { await integrity.writeFile(JSON.stringify({ file, sha256: digest, bytes: offset, tools })); await integrity.sync(); } finally { await integrity.close(); }
    const result = await runRecordingCommand(tools.ffprobe.path, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,width,height,nb_read_frames:format=duration', '-of', 'json', file], { timeoutMs: 180_000 });
    const object = JSON.parse(result.stdout.toString('utf8')) as { streams?: { codec_type?: unknown; width?: unknown; height?: unknown; nb_read_frames?: unknown }[]; format?: { duration?: unknown } };
    const stream = object?.streams?.[0];
    const frames = Number(stream?.nb_read_frames), durationSeconds = Number(object?.format?.duration), width = Number(stream?.width), height = Number(stream?.height);
    if (result.stderr.trim() || stream?.codec_type !== 'video' || !Number.isSafeInteger(frames) || frames < 1 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) throw new RecordingToolError('video_unplayable', result.stderr);
    // Validation must preserve VFR timestamps: a guessed output time base can make valid source frames collide.
    const decoded = await runRecordingCommand(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-f', 'null', '-'], { timeoutMs: 180_000 });
    if (decoded.stderr.trim()) throw new RecordingToolError('video_unplayable', decoded.stderr);
    const final = await handle.stat();
    const finalName = await lstat(file);
    if (final.size !== before.size || final.mtimeMs !== before.mtimeMs || final.ino !== before.ino || final.dev !== before.dev || !finalName.isFile() || finalName.nlink !== 1 || finalName.ino !== final.ino || finalName.dev !== final.dev) throw new AgentExecutionError('video_changed', 'decode 중 원본 파일 경계가 변경되었습니다');
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return { file, sha256: digest, bytes: offset, frames, durationSeconds, width, height };
  } catch (error) {
    writeDiagnostic(`${file}.validation.json`, () => ({ code: error instanceof AgentExecutionError ? error.code : 'video_validation_failed', tools, stderr: error instanceof RecordingToolError ? diagnosticOutput(error.stderr, sanitize) : null }));
    throw error;
  } finally { await handle.close(); }
}
