import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RefusedError, StepError } from './base.ts';
import type { ChromeNativeStatus, ChromeProcessFact } from '../core/chrome-owner.ts';
import { PATHS } from '../core/config.ts';

export interface OwnedChromeEndpoint {
  readonly url: string;
  readonly debuggerAddress: string;
  readonly profile: string;
  readonly binary: string;
  readonly args: readonly string[];
  assertHealthy(): void;
  nativeStatus(): ChromeNativeStatus;
  close(): Promise<void>;
}

export class OwnedChromeStartupError extends RefusedError {
  readonly profile: string;
  readonly nativeStatus: ChromeNativeStatus;
  constructor(cause: unknown, profile: string, nativeStatus: ChromeNativeStatus) {
    super('소유 Chrome 준비에 실패했으며 원 browser·driver의 native 종료와 프로필 정리를 확인했습니다.');
    this.cause = cause;
    this.profile = profile;
    this.nativeStatus = nativeStatus;
  }
}

function launchOwnedChild(executable: string, args: readonly string[], label: string, stdout: 'ignore' | 'pipe') {
  const child = spawn(executable, args, { stdio: ['ignore', stdout, 'ignore'] });
  let fact: ChromeProcessFact = { state: 'starting' };
  let failure: Error | null = null;
  let stopRequested = false;
  child.once('spawn', () => { fact = { state: 'running' }; });
  child.once('error', error => {
    failure = error;
    if (fact.state === 'starting') fact = { state: 'spawn-failed', code: (error as NodeJS.ErrnoException).code ?? error.name };
  });
  child.once('exit', (code, signal) => {
    fact = { state: 'stopped', exit: { code, signal, observedAt: new Date().toISOString() } };
    if (!stopRequested) failure = new Error(`Owned ${label} exited unexpectedly`);
  });
  const stopped = (): boolean => fact.state === 'stopped' || fact.state === 'spawn-failed';
  return {
    child,
    fact: () => structuredClone(fact),
    isStarting: () => fact.state === 'starting',
    assertHealthy() { if (failure || stopRequested || fact.state !== 'running') throw failure ?? new Error(`Owned ${label} is not running`); },
    async stop(): Promise<void> {
      if (stopped()) return;
      const completion = Promise.withResolvers<void>();
      const onExit = () => completion.resolve();
      const onError = (error: Error) => { if (stopped()) completion.resolve(); else completion.reject(error); };
      const timer = setTimeout(() => completion.reject(new Error(`Owned ${label} termination unconfirmed`)), 5000);
      child.once('exit', onExit);
      child.once('error', onError);
      try {
        if (!stopRequested) { stopRequested = true; child.kill('SIGTERM'); }
        await completion.promise;
      } finally { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); }
    },
  };
}

async function readDevToolsPort(profile: string): Promise<number | null> {
  let file;
  try { file = await open(join(profile, 'DevToolsActivePort'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || before.size > 4096) throw new Error('Owned Chrome DevTools port file is invalid');
    if (before.size === 0) return null;
    const bytes = Buffer.allocUnsafe(4097);
    const { bytesRead } = await file.read(bytes);
    const after = await file.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
    const match = /^([1-9]\d{0,4})\n\/devtools\/browser\/[A-Za-z0-9-]+\n?$/.exec(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!match) return null;
    if (Number(match[1]) > 65535) throw new Error('Owned Chrome DevTools port identity is invalid');
    return Number(match[1]);
  } finally { await file.close(); }
}

export async function startOwnedChromeEndpoint(): Promise<OwnedChromeEndpoint> {
  const startedAt = performance.now();
  const binary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executable = join(PATHS.tools, 'chromedriver', 'chromedriver-mac-arm64_v156.0.8078.80');
  try { await Promise.all([access(binary), access(executable)]); }
  catch { throw new RefusedError('소유 headless Chrome 실행에 필요한 실제 Chrome binary 또는 프로젝트 로컬 ChromeDriver가 없습니다.'); }
  const profile = await mkdtemp(join(tmpdir(), 'qautra-chrome-'));
  const args = ['--headless=new', '--enable-automation', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--disable-sync', '--password-store=basic', '--use-mock-keychain', '--lang=ko-KR', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  let browser: ReturnType<typeof launchOwnedChild> | null = null;
  let driver: ReturnType<typeof launchOwnedChild> | null = null;
  let removed = false, closed = false;
  let closing: Promise<void> | null = null;
  const nativeStatus = (): ChromeNativeStatus => ({
    schema: 'qautra/owned-chrome-native/v1', browser: browser?.fact() ?? { state: 'not-started' },
    driver: driver?.fact() ?? { state: 'not-started' }, profile: removed ? 'removed' : 'retained',
  });
  const closeNative = async (): Promise<void> => {
    const results = await Promise.allSettled([browser?.stop(), driver?.stop()]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned Chrome native termination unconfirmed');
    await rm(profile, { recursive: true, force: true });
    removed = true;
  };
  let url: string, debuggerAddress: string;
  try {
    await chmod(profile, 0o700);
    const directory = join(profile, 'Default');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false, password_manager_leak_detection: false }, translate: { enabled: false } }), { mode: 0o600, flag: 'wx' });
    browser = launchOwnedChild(binary, args, 'Chrome browser', 'ignore');
    let browserPort: number | null = null;
    const deadline = Date.now() + 15_000;
    while (browserPort === null && Date.now() < deadline) {
      if (!browser.isStarting()) browser.assertHealthy();
      browserPort = await readDevToolsPort(profile);
      if (browserPort === null) await delay(25);
    }
    if (browserPort === null) throw new Error('Owned Chrome browser readiness was not confirmed');
    browser.assertHealthy();
    debuggerAddress = `127.0.0.1:${browserPort}`;
    driver = launchOwnedChild(executable, ['--port=0', '--allowed-ips=127.0.0.1'], 'ChromeDriver', 'pipe');
    let port: number | null = null, output = '';
    driver.child.stdout?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192);
      const match = /ChromeDriver was started successfully on port (\d+)/.exec(output);
      if (match) port = Number(match[1]);
    });
    while (port === null && Date.now() < deadline) {
      browser.assertHealthy();
      if (!driver.isStarting()) driver.assertHealthy();
      await delay(25);
    }
    if (port === null) throw new Error('Owned ChromeDriver readiness was not confirmed');
    url = `http://127.0.0.1:${port}`;
    const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000) });
    const status: unknown = await response.json();
    if (!response.ok || typeof status !== 'object' || status === null || !('value' in status) || typeof status.value !== 'object' || status.value === null || !('ready' in status.value) || status.value.ready !== true) throw new Error('Owned ChromeDriver readiness response invalid');
    browser.assertHealthy(); driver.assertHealthy();
  } catch (error) {
    try { await closeNative(); }
    catch (cleanupError) {
      const uncertain = new StepError({ status: 'uncertain', ms: performance.now() - startedAt, error: `Owned Chrome startup cleanup unconfirmed; retained profile: ${profile}` });
      uncertain.cause = new AggregateError([error, cleanupError]);
      throw uncertain;
    }
    throw new OwnedChromeStartupError(error, profile, nativeStatus());
  }
  return {
    url, debuggerAddress, profile, binary, args, nativeStatus,
    assertHealthy() {
      if (closed || closing) throw new Error('Owned Chrome endpoint is closing or closed');
      browser!.assertHealthy(); driver!.assertHealthy();
    },
    async close() {
      if (closed) return;
      closing ??= closeNative().then(() => { closed = true; });
      const pending = closing;
      try { await pending; } finally { if (closing === pending) closing = null; }
    },
  };
}
