import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentClientError, connectAgentClient, type AgentClient } from '../../core/agent-client.ts';
import { AgentActionSchema, type AgentRequestInput } from '../../core/agent.ts';
import { PLATFORMS } from '../../core/platform.ts';

export interface AgentCommandIO {
  connect(options: { root?: string }): Promise<AgentClient>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function cmdAgent(argv: string[], io: AgentCommandIO = { connect: connectAgentClient, stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        root: { type: 'string' }, session: { type: 'string' }, app: { type: 'string' }, platform: { type: 'string' }, device: { type: 'string' },
        revision: { type: 'string' }, action: { type: 'string' }, text: { type: 'string' }, x: { type: 'string' }, y: { type: 'string' }, units: { type: 'string' },
        timeout: { type: 'string' }, 'expect-no-change': { type: 'boolean' }, absent: { type: 'boolean' }, append: { type: 'boolean' }, secure: { type: 'boolean' },
        sessionIds: { type: 'string', multiple: true }, 'script-id': { type: 'string' }, deadline: { type: 'string' }, 'max-output': { type: 'string' },
        request: { type: 'string' }, help: { type: 'boolean' },
      },
    });
    if (values.help || (!positionals.length && !values.request)) {
      io.stdout('qa agent <open|list|status|observe|screenshot|act|tap|type|clear|tap-at|wait|assert-text|close|run-script|script-status|script-cancel> [--root <project>]\nSession commands require --session <id>. act/ref/coordinate input requires --revision <n>. run-script <file.js|file.ts> requires --sessionIds <id> (repeatable).\n');
      return 0;
    }
    const client = await io.connect({ root: values.root });
    const command = positionals[0];
    let result: unknown;
    if (values.request) {
      result = await client.request(JSON.parse(values.request) as AgentRequestInput, controller.signal);
    } else if (command === 'open') {
      const platform = PLATFORMS.find((p) => p === values.platform);
      if (!values.app || !platform || !values.device) throw new Error('open requires --app, --platform and explicit --device');
      result = await client.request({ method: 'session.open', app: values.app, platform, deviceId: values.device }, controller.signal);
    } else if (command === 'list') {
      result = await client.request({ method: 'session.list' }, controller.signal);
    } else if (command === 'run-script') {
      const file = positionals[1];
      if (!file || !['.js', '.mjs', '.ts', '.mts'].includes(extname(file))) throw new Error('run-script requires a JavaScript or TypeScript file');
      const source = readScriptSource(file);
      result = await client.runScript({ source, sessionIds: values.sessionIds ?? [], language: ['.ts', '.mts'].includes(extname(file)) ? 'typescript' : 'javascript', scriptId: values['script-id'], deadlineMs: values.deadline ? Number(values.deadline) : undefined, maxOutputBytes: values['max-output'] ? Number(values['max-output']) : undefined }, controller.signal);
    } else if (command === 'script-status' || command === 'script-cancel') {
      const scriptId = values['script-id'] ?? positionals[1];
      if (!scriptId) throw new Error('Explicit script ID is required');
      result = command === 'script-status' ? await client.scriptStatus(scriptId, controller.signal) : await client.cancelScript(scriptId, controller.signal);
    } else {
      if (!values.session) throw new Error('An explicit --session is required');
      const session = client.session(values.session);
      const options = { timeoutMs: values.timeout ? Number(values.timeout) : undefined, expectNoChange: values['expect-no-change'] };
      const text = values.text ?? positionals[1];
      if (command === 'status') result = await session.status(controller.signal);
      else if (command === 'observe') result = await session.observe(controller.signal);
      else if (command === 'screenshot') result = await session.screenshot(controller.signal);
      else if (command === 'close') result = await session.close(controller.signal);
      else if (command === 'wait') {
        if (text === undefined) throw new Error('wait requires literal text');
        result = await session.wait(text, { timeoutMs: options.timeoutMs, absent: values.absent }, controller.signal);
      } else if (command === 'act' || command === 'tap-at' || ((command === 'tap' || command === 'type' || command === 'clear') && values.revision)) {
        let action: unknown;
        if (command === 'act') action = JSON.parse(values.action ?? 'null') as unknown;
        else if (command === 'tap-at') action = { kind: 'tapAt', x: Number(values.x), y: Number(values.y), units: values.units ?? 'screenshot-px' };
        else if (command === 'type') action = { kind: 'type', ref: positionals[1], text: values.text ?? positionals[2], append: values.append, secure: values.secure };
        else action = { kind: command, ref: positionals[1] };
        if (!values.revision) throw new Error('Explicit --revision is required; stale references are never refreshed');
        result = await client.request({ method: 'session.act', sessionId: values.session, revision: Number(values.revision), action: AgentActionSchema.parse(action), ...options }, controller.signal);
      } else if (command === 'tap' || command === 'type' || command === 'clear' || command === 'assert-text') {
        if (!positionals[1] && !(command === 'assert-text' && values.text)) throw new Error('An exact label or assertion text is required');
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(positionals[1] ?? '') && command !== 'assert-text') throw new Error('Reference input requires --revision; it will not be refreshed');
        if (command === 'type' && values.text === undefined && positionals[2] === undefined) throw new Error('type requires explicit literal text; use --text "" to type an empty string');
        await session.observe(controller.signal);
        if (command === 'tap') result = await session.tap(positionals[1]!, options, controller.signal);
        else if (command === 'type') result = await session.type(positionals[1]!, values.text ?? positionals[2] ?? '', { ...options, append: values.append, secure: values.secure }, controller.signal);
        else if (command === 'clear') result = await session.clear(positionals[1]!, options, controller.signal);
        else result = await session.assertText(values.text ?? positionals[1]!, controller.signal);
      } else throw new Error(`Unknown agent command: ${command}`);
    }
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AgentClientError) {
      io.stderr(`${JSON.stringify({ error: { code: error.code, message: error.message, effect: error.effect, fixtureEffect: error.fixtureEffect }, meta: error.meta })}\n`);
      return 1;
    }
    io.stderr(`qa agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

const MAX_SCRIPT_SOURCE = 262_144;

function readScriptSource(file: string): string {
  const fd = openSync(realpathSync(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SCRIPT_SOURCE)) throw new Error('Script source must be a regular file of at most 256 KiB');
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.byteLength) {
      const count = readSync(fd, bytes, size, bytes.byteLength - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (size !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Script source changed while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
