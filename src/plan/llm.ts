// LLM adapters for document → test generation. Both shell out to a locally installed, logged-in CLI; neither gets
// tools or write access. The prompt goes in on stdin, the final message comes back as text for `extractJson`.
//   claude-cli: `claude -p --model <m> --output-format json --tools "" --no-session-persistence` → `.result`
//   codex-cli:  `codex exec -m <m> -s read-only --skip-git-repo-check --ephemeral --output-schema <file> -o <out> -`
//               (falls back to prompt-only when the API rejects the JSON Schema; zod validation runs either way)
// The child gets a scoped environment (system basics + the CLIs' own auth/config variables, never TYPESAFE_API_KEY or
// app secrets from .env) and its stdout/stderr are capped.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type LlmProvider = 'claude-cli' | 'codex-cli';

export const LLM_PROVIDERS: Record<string, LlmProvider> = { 'claude-cli': 'claude-cli', 'codex-cli': 'codex-cli' };

export const DEFAULT_LLM_MODELS: Record<LlmProvider, string> = { 'claude-cli': 'claude-opus-5-5', 'codex-cli': 'gpt-6-sol' };

/** Hard cap per LLM call. */
export const LLM_TIMEOUT_MS = 15 * 60_000;

/** Cap per output stream; a CLI that prints more is killed (a real reply is far below this). */
export const LLM_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Exact variable names passed to the CLI: process basics, locale, proxy/TLS settings the CLIs' HTTP clients read. */
const CLI_ENV_NAMES: Record<string, true> = Object.fromEntries(
  [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'TERM',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  ].map((name) => [name, true]),
);
/** Prefixes of the CLIs' own auth/config variables (claude: CLAUDE_*, ANTHROPIC_*; codex: CODEX_*, OPENAI_*). */
const CLI_ENV_PREFIXES = ['LC_', 'CLAUDE_', 'ANTHROPIC_', 'CODEX_', 'OPENAI_'];

/** The CLI's environment: allow-listed names only, so project secrets (TYPESAFE_API_KEY, app passwords) never leak. */
function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CLI_ENV_NAMES[name] === true || CLI_ENV_PREFIXES.some((p) => name.startsWith(p)) || /^QA_[A-Z]+_BIN$/.test(name)) out[name] = value;
  }
  return out;
}

export interface Llm {
  readonly provider: LlmProvider;
  readonly model: string;
  /** Returns the model's final message text. Throws on process failure, timeout or abort. */
  complete(prompt: string, opts: { schema: object; signal?: AbortSignal }): Promise<string>;
  /** Notes about adapter behavior worth surfacing (e.g. schema fallback). */
  readonly notes: string[];
}

export interface LlmOptions {
  provider: LlmProvider;
  model?: string;
  /** Reads QA_CLAUDE_BIN / QA_CODEX_BIN (binary overrides, e.g. a fake CLI in tests). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function createLlm(opts: LlmOptions): Llm {
  const env = opts.env ?? process.env;
  const model = opts.model ?? DEFAULT_LLM_MODELS[opts.provider];
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const notes: string[] = [];
  if (opts.provider === 'claude-cli') {
    const bin = env.QA_CLAUDE_BIN?.trim() || 'claude';
    return {
      provider: opts.provider,
      model,
      notes,
      async complete(prompt, { signal }) {
        const work = mkdtempSync(join(tmpdir(), 'qa-plan-'));
        try {
          const args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence'];
          const r = await runCli(bin, args, { stdin: prompt, cwd: work, env, signal, timeoutMs });
          if (r.code !== 0) throw new Error(`claude CLI 실패 (종료 코드 ${r.code}): ${tail(r.stderr || r.stdout)}`);
          let envelope: { is_error?: boolean; subtype?: string; result?: unknown };
          try {
            envelope = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '');
          } catch {
            throw new Error(`claude CLI 출력이 JSON이 아닙니다: ${tail(r.stdout)}`);
          }
          if (envelope.is_error || typeof envelope.result !== 'string') {
            throw new Error(`claude CLI 오류 (${envelope.subtype ?? 'unknown'}): ${tail(String(envelope.result ?? ''))}`);
          }
          return envelope.result;
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      },
    };
  }
  const bin = env.QA_CODEX_BIN?.trim() || 'codex';
  let schemaRejected = false;
  return {
    provider: opts.provider,
    model,
    notes,
    async complete(prompt, { schema, signal }) {
      const work = mkdtempSync(join(tmpdir(), 'qa-plan-'));
      try {
        const schemaFile = join(work, 'schema.json');
        const outFile = join(work, 'out.txt');
        writeFileSync(schemaFile, JSON.stringify(schema));
        const run = (withSchema: boolean) =>
          runCli(
            bin,
            ['exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', work, ...(withSchema ? ['--output-schema', schemaFile] : []), '-o', outFile, '-'],
            { stdin: prompt, cwd: work, env, signal, timeoutMs },
          );
        let r = await run(!schemaRejected);
        if (r.code !== 0 && !schemaRejected && /invalid_json_schema|invalid schema/i.test(`${r.stderr}\n${r.stdout}`)) {
          schemaRejected = true;
          notes.push('codex가 JSON Schema를 거부해 프롬프트 지시 + zod 검증으로 대체했습니다');
          r = await run(false);
        }
        if (r.code !== 0) throw new Error(`codex CLI 실패 (종료 코드 ${r.code}): ${tail(r.stderr || r.stdout)}`);
        let text: string;
        try {
          text = readFileSync(outFile, 'utf8');
        } catch {
          throw new Error('codex CLI가 마지막 메시지 파일(-o)을 쓰지 않았습니다');
        }
        return text;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** JSON object from a model reply: the whole text, a fenced block, or the outermost `{…}`. */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()];
  for (const m of text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```/g)) candidates.push(m[1]!.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next candidate
    }
  }
  throw new Error(`모델 출력에서 JSON 객체를 찾지 못했습니다: ${tail(text, 200)}`);
}

function tail(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(
  bin: string,
  args: string[],
  opts: { stdin: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal | undefined; timeoutMs: number },
): Promise<CliResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  if (signal.aborted) throw new Error('LLM 호출이 취소되었습니다');
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: cliEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
    let overflow: 'stdout' | 'stderr' | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[]) => (d: Buffer) => {
      if (overflow) return;
      bytes[stream] += d.length;
      if (bytes[stream] > LLM_MAX_OUTPUT_BYTES) {
        overflow = stream;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(d);
    };
    child.stdout.on('data', collect('stdout', out));
    child.stderr.on('data', collect('stderr', err));
    child.stdin.on('error', () => {
      // The CLI may exit before reading stdin; its exit code reports the failure.
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(e.code === 'ENOENT' ? `LLM CLI를 찾을 수 없습니다: ${bin}` : `LLM CLI 실행 실패: ${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      if (overflow) {
        reject(new Error(`LLM CLI ${overflow} 출력이 ${LLM_MAX_OUTPUT_BYTES / 1024 / 1024} MiB 제한을 넘어 중단했습니다: ${bin}`));
        return;
      }
      if (signal.aborted) {
        const limit = opts.timeoutMs >= 60_000 ? `${Math.round(opts.timeoutMs / 60_000)}분` : `${opts.timeoutMs / 1000}초`;
        reject(timeout.aborted ? new Error(`LLM 호출이 ${limit} 제한을 넘었습니다`) : new Error('LLM 호출이 취소되었습니다'));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(opts.stdin);
  });
}
