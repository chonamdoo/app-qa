import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTHORING_MAX_PAYLOAD, AUTHORING_MAX_REPLY, AUTHORING_MODEL,
  type AuthoringCapabilities, type ProductAuthoringAdapter } from '../core/product-authoring.ts';
import { writeJsonAtomic } from '../core/fsx.ts';
import { CLAUDE_SUBSCRIPTION_FLAGS, isClaudeSubscriptionLogin } from './claude-subscription.ts';

const requiredFlags = ['--restricted', '--safe-mode', '--tools', '--disallowedTools', '--strict-mcp-config', '--mcp-config', '--setting-sources',
  '--settings', '--no-chrome', '--disable-slash-commands', '--no-session-persistence'];
const safeFailure = 'Claude 구독 CLI 응답을 확정하지 못했습니다. 구독 로그인·지원 버전·제한 옵션을 로컬에서 확인하세요. API key·Console·다른 제공자로 전환하거나 원문을 자동 재전송하지 않습니다.';

export class ClaudeProductAuthoringAdapter implements ProductAuthoringAdapter {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(options: { executable?: string } = {}) {
    this.executable = options.executable ?? join(homedir(), '.local', 'bin', 'claude');
    this.environment = { HOME: homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  }
  private async run(args: string[], cwd: string, input: string, maximum: number, timeout: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error(safeFailure);
    const completion = Promise.withResolvers<string>();
    let output = '', length = 0, failed = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const child = spawn(this.executable, args, { cwd, env: this.environment, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => {
      failed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (bytes: Buffer) => {
      length += bytes.length;
      if (length > maximum) { stop(); return; }
      try { output += decoder.decode(bytes, { stream: true }); } catch { stop(); }
    });
    child.stderr.on('data', (bytes: Buffer) => { length += bytes.length; if (length > maximum) stop(); });
    child.stdin.on('error', () => { stop(); });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      try { output += decoder.decode(); } catch { failed = true; }
      if (failed || code !== 0 || signal?.aborted) completion.reject(new Error(safeFailure));
      else completion.resolve(output);
    });
    child.stdin.end(input);
    return completion.promise;
  }
  private async requireSubscription(cwd: string, signal?: AbortSignal): Promise<void> {
    const auth: unknown = JSON.parse(await this.run([...CLAUDE_SUBSCRIPTION_FLAGS, 'auth', 'status'], cwd, '', 64 * 1024, 10_000, signal));
    if (!isClaudeSubscriptionLogin(auth)) throw new Error(safeFailure);
  }
  private async probe(cwd: string, signal?: AbortSignal): Promise<AuthoringCapabilities> {
    const base: Pick<AuthoringCapabilities, 'provider' | 'model'> = { provider: 'claude-cli', model: AUTHORING_MODEL };
    try {
      const versionText = (await this.run(['--version'], cwd, '', 16 * 1024, 10_000, signal)).trim();
      const version = /^(2\.1\.316)(?:\s|$)/.exec(versionText)?.[1];
      if (!version) return { ...base, available: false, version: null, reason: '현재 검증 대상으로 고정한 Claude CLI 2.1.316이 필요합니다. 다른 버전으로 제한 옵션을 추정하지 않습니다.' };
      const help = await this.run(['--help'], cwd, '', 256 * 1024, 10_000, signal);
      if (requiredFlags.some(flag => !help.includes(flag))) return { ...base, available: false, version, reason: '필수 도구·MCP·hooks·설정 차단 옵션을 확인하지 못했습니다. 안전하지 않은 옵션으로 대체하지 않습니다.' };
      try {
        await this.requireSubscription(cwd, signal);
      } catch {
        return { ...base, available: false, version, reason: 'Claude 구독 로그인(claude.ai)을 확인하지 못했습니다. 로컬 Claude Code CLI에 구독 계정으로 로그인하세요. API key·Console·외부 제공자로 전환하거나 원문을 전송하지 않습니다. 수동 작성·발행·실행은 계속 사용할 수 있습니다.' };
      }
      return { ...base, available: true, version, reason: '제한 옵션과 Claude 구독 로그인을 확인했습니다. 실제 모델 사용 권한·잔여 사용량·backend revision은 확인하지 않았습니다. 수동 작성·발행·실행에는 AI 연결이 필요하지 않습니다.' };
    } catch { return { ...base, available: false, version: null, reason: 'Claude CLI를 찾거나 제한 옵션을 확인하지 못했습니다. 로컬 Claude 2.1.316과 기존 구독 로그인을 준비하세요.' }; }
  }
  async capabilities(): Promise<AuthoringCapabilities> {
    const cwd = await mkdtemp(join(tmpdir(), 'qautra-authoring-probe-'));
    try { return await this.probe(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
  }
  async interpret(payload: string, signal: AbortSignal, beforeSend?: () => Promise<void>): Promise<string> {
    if (Buffer.byteLength(payload) > AUTHORING_MAX_PAYLOAD || signal.aborted) throw new Error(safeFailure);
    const cwd = await mkdtemp(join(tmpdir(), 'qautra-authoring-'));
    try {
      const capabilities = await this.probe(cwd, signal);
      if (!capabilities.available || signal.aborted) throw new Error(safeFailure);
      const mcp = join(cwd, 'empty-mcp.json');
      writeJsonAtomic(mcp, { mcpServers: {} });
      if (beforeSend) await beforeSend();
      if (signal.aborted) throw new Error(safeFailure);
      const result = await this.run([...CLAUDE_SUBSCRIPTION_FLAGS, '-p', '--model', AUTHORING_MODEL, '--output-format', 'json',
        '--tools', '', '--disallowedTools', '*', '--strict-mcp-config', '--mcp-config', mcp,
        '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1'],
        cwd, payload, AUTHORING_MAX_REPLY + 64 * 1024, 120_000, signal);
      const envelope: unknown = JSON.parse(result);
      if (!envelope || typeof envelope !== 'object' || !('result' in envelope) || typeof envelope.result !== 'string'
          || !('is_error' in envelope) || envelope.is_error !== false || Buffer.byteLength(envelope.result) > AUTHORING_MAX_REPLY) throw new Error(safeFailure);
      return envelope.result;
    } catch { throw new Error(safeFailure); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  }
}
