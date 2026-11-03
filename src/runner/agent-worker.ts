import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import type { AgentReply, AgentRequestInput } from '../core/agent.ts';
import { createAgentClient, type AgentScriptClient } from '../core/agent-client.ts';

const MAX_FRAME = 1_048_576;
const input = createReadStream('', { fd: 4, autoClose: false });
const output = createWriteStream('', { fd: 3, autoClose: false });
const pending = new Map<string, { resolve(value: AgentReply): void; reject(error: Error): void }>();
const decoder = new StringDecoder('utf8');
let buffered = '';
let connected = true;

function send(value: unknown): void {
  if (!connected) throw new Error('Manager disconnected');
  const frame = JSON.stringify(value);
  if (Buffer.byteLength(frame) > MAX_FRAME || output.writableLength > MAX_FRAME * 2) throw new Error('Worker protocol output limit');
  output.write(`${frame}\n`);
}
function disconnected(error: Error): void {
  if (!connected) return;
  connected = false;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  process.exitCode = 1;
  input.destroy();
  output.destroy();
}
input.on('data', (chunk: Buffer) => {
  buffered += decoder.write(chunk);
  let end: number;
  while ((end = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    if (Buffer.byteLength(line) > MAX_FRAME) { disconnected(new Error('Manager frame limit')); return; }
    let message: { type?: unknown; id?: unknown; reply?: AgentReply };
    try { message = JSON.parse(line); } catch { disconnected(new Error('Invalid manager frame')); return; }
    if (message.type !== 'reply' || typeof message.id !== 'string' || !message.reply || typeof message.reply.ok !== 'boolean') { disconnected(new Error('Invalid manager response')); return; }
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); request.resolve(message.reply); }
  }
  if (Buffer.byteLength(buffered) > MAX_FRAME) disconnected(new Error('Manager frame limit'));
});
input.on('end', () => disconnected(new Error('Manager disconnected')));
input.on('error', (error) => disconnected(error));
output.on('error', (error) => disconnected(error));

async function transport(request: AgentRequestInput, signal?: AbortSignal): Promise<AgentReply> {
  if (signal?.aborted) throw new Error('Request cancelled');
  const id = randomUUID();
  const completion = Promise.withResolvers<AgentReply>();
  const onAbort = () => {
    pending.delete(id);
    completion.reject(new Error('Request cancelled'));
    try { send({ type: 'cancel', id }); } catch (error) { disconnected(error instanceof Error ? error : new Error(String(error))); }
  };
  pending.set(id, completion);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    send({ type: 'call', id, request });
    return await completion.promise;
  } finally {
    pending.delete(id);
    signal?.removeEventListener('abort', onAbort);
  }
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => stream.write('', (error) => error ? reject(error) : resolve()));
}

async function flushOutput(): Promise<void> {
  await flush(process.stdout);
  await flush(process.stderr);
}

try {
  const source = process.argv[2];
  const sessionIds: unknown = JSON.parse(process.argv[3] ?? 'null');
  if (!source || !Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === 'string')) throw new Error('Invalid worker startup');
  const api = Object.defineProperty(createAgentClient(transport), 'sessionIds', { value: Object.freeze(sessionIds), enumerable: true, writable: false }) as AgentScriptClient;
  // The manager stages each submitted JS/TS module at runtime; it cannot be a static dependency.
  const module = await import(pathToFileURL(source).href);
  if (typeof module.default !== 'function') throw new Error('Script must export default async function(qa)');
  const result: unknown = await module.default(api);
  await flushOutput();
  send({ type: 'done', result: result === undefined ? null : result });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await flushOutput();
  try { send({ type: 'failed', message }); } catch { process.exitCode = 1; }
}
