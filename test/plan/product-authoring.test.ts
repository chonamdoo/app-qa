import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ClaudeProductAuthoringAdapter } from '../../src/plan/product-authoring.ts';

function fixture(t: TestContext, mode: 'success' | 'old-version' | 'missing-mcp' | 'logged-out' | 'hang' | 'secret-error' = 'success',
  authStatus: unknown = { loggedIn: mode !== 'logged-out', authMethod: 'claude.ai', apiProvider: 'firstParty' }) {
  const root = mkdtempSync(join(tmpdir(), 'qautra-claude-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-claude'); const trace = join(root, 'trace.json');
  const authPath = join(root, 'auth.json');
  writeFileSync(authPath, JSON.stringify(authStatus));
  const flags = ['--restricted', '--safe-mode', '--tools', '--disallowedTools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings', '--no-chrome', '--disable-slash-commands', '--no-session-persistence'];
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (args.includes('--version')) { console.log(mode === 'old-version' ? '2.1.315 (Claude Code)' : '2.1.316 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) { console.log(${JSON.stringify(flags)}.filter(value => mode !== 'missing-mcp' || value !== '--strict-mcp-config').join(' ')); process.exit(0); }
if (args.includes('auth') && args.includes('status')) { process.stdout.write(fs.readFileSync(${JSON.stringify(authPath)}, 'utf8')); process.exit(mode === 'logged-out' ? 1 : 0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const value = flag => args[args.indexOf(flag) + 1];
  const settings = JSON.parse(value('--settings'));
  const mcp = JSON.parse(fs.readFileSync(value('--mcp-config'), 'utf8'));
  if (!args.includes('--restricted') || !args.includes('--safe-mode') || value('--tools') !== '' || value('--disallowedTools') !== '*' || !args.includes('--strict-mcp-config') || Object.keys(mcp.mcpServers).length || value('--setting-sources') !== '' || settings.disableAllHooks !== true || settings.forceLoginMethod !== 'claudeai' || !args.includes('--no-chrome') || !args.includes('--disable-slash-commands') || !args.includes('--no-session-persistence') || args.includes('--bare')) process.exit(3);
  fs.writeFileSync(${JSON.stringify(trace + '.tmp')}, JSON.stringify({ input, args, cwd: process.cwd(), mode: fs.statSync(process.cwd()).mode & 511, env: process.env, pid: process.pid }));
  fs.renameSync(${JSON.stringify(trace + '.tmp')}, ${JSON.stringify(trace)});
  if (mode === 'hang') { fs.watch(process.cwd(), () => {}); return; }
  if (mode === 'secret-error') { process.stderr.write('PRIVATE_TOKEN_FROM_PROVIDER'); process.exit(1); }
  const result = JSON.stringify({ name: '독립 기대값', steps: [{ assertText: 'TC-007: 접수됨' }], expectations: [], issues: [] });
  const bytes = Buffer.from(JSON.stringify({ is_error: false, result }));
  const split = bytes.indexOf(Buffer.from('독립')) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setImmediate(() => process.stdout.end(bytes.subarray(split)));
});
`;
  writeFileSync(executable, script, { mode: 0o700 });
  return { root, trace, authPath, adapter: new ClaudeProductAuthoringAdapter({ executable }) };
}

test('restricted CLI adapter sends literal bounded stdin with empty MCP, disabled tools/hooks/settings, private cwd and minimal environment', async t => {
  const f = fixture(t);
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'never-forward-this';
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; });
  assert.equal((await f.adapter.capabilities()).available, true);
  const marker = join(f.root, 'source-must-not-execute');
  const payload = JSON.stringify({ untrusted: `$(touch "${marker}") 한글` });
  await f.adapter.interpret(payload, new AbortController().signal);
  assert.equal(existsSync(marker), false);
  const trace = JSON.parse(readFileSync(f.trace, 'utf8'));
  assert.equal(trace.mode, 0o700);
  assert.equal(trace.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(existsSync(trace.cwd), false);
});

for (const mode of ['old-version', 'missing-mcp', 'logged-out'] as const) {
  test(`unsupported prerequisite refuses transmission without unsafe fallback: ${mode}`, async t => {
    const f = fixture(t, mode);
    assert.equal((await f.adapter.capabilities()).available, false);
    await assert.rejects(f.adapter.interpret('private source', new AbortController().signal));
    assert.equal(existsSync(f.trace), false);
  });
}
for (const authStatus of [
  { loggedIn: true, authMethod: 'api_key' }, { loggedIn: true, authMethod: 'third_party' },
  { loggedIn: true }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
]) {
  test(`product authoring refuses non-subscription credentials before consent or source transmission: ${JSON.stringify(authStatus)}`, async t => {
    const f = fixture(t, 'success', authStatus);
    assert.equal((await f.adapter.capabilities()).available, false);
    let consentChecks = 0;
    await assert.rejects(f.adapter.interpret('private source', new AbortController().signal, async () => { consentChecks++; }));
    assert.equal(consentChecks, 0);
    assert.equal(existsSync(f.trace), false);
  });
}

test('a previously available subscription does not authorize a later Console credential', async t => {
  const f = fixture(t);
  assert.equal((await f.adapter.capabilities()).available, true);
  writeFileSync(f.authPath, JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  await assert.rejects(f.adapter.interpret('private source', new AbortController().signal));
  assert.equal(existsSync(f.trace), false);
});

test('malformed authentication status never receives source text', async t => {
  const f = fixture(t);
  writeFileSync(f.authPath, '{invalid PRIVATE_STATUS');
  const capability = await f.adapter.capabilities();
  assert.equal(capability.available, false);
  assert.ok(!capability.reason.includes('PRIVATE_STATUS'));
  await assert.rejects(f.adapter.interpret('private source', new AbortController().signal));
  assert.equal(existsSync(f.trace), false);
});

test('provider raw errors never escape and temporary files are removed', async t => {
  const f = fixture(t, 'secret-error');
  await assert.rejects(f.adapter.interpret('source', new AbortController().signal), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE_TOKEN_FROM_PROVIDER'));
  assert.equal(existsSync(JSON.parse(readFileSync(f.trace, 'utf8')).cwd), false);
});

test('cancellation terminates the owned process and removes its temporary cwd', async t => {
  const f = fixture(t, 'hang'); const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const watcher = watch(f.root, () => { if (existsSync(f.trace)) ready.resolve(); });
  t.after(() => { watcher.close(); controller.abort(); });
  const pending = f.adapter.interpret('source', controller.signal);
  const rejection = assert.rejects(pending);
  await Promise.race([ready.promise, pending.then(() => { throw new Error('provider exited before cancellation'); })]);
  watcher.close();
  const trace = JSON.parse(readFileSync(f.trace, 'utf8')); controller.abort(); await rejection;
  assert.equal(existsSync(trace.cwd), false);
  assert.throws(() => process.kill(trace.pid, 0));
});

test('final consent gate denial prevents stdin transmission after prerequisite probes', async t => {
  const f = fixture(t);
  let gates = 0;
  await assert.rejects(f.adapter.interpret('private source', new AbortController().signal, async () => {
    gates++; throw new Error('consent revoked');
  }));
  assert.equal(gates, 1);
  assert.equal(existsSync(f.trace), false);
});
