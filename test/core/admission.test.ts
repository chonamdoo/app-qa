import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs, { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import type { ExecutionRecoveryReceipt, ExecutionRecoveryScope } from '../../src/core/recovery.ts';
import { AgentExecutionError } from '../../src/core/agent.ts';

const admissionUrl = new URL('../../src/core/admission.ts', import.meta.url).href;
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hasCode = (code: string) => (cause: unknown): boolean => cause instanceof AgentExecutionError && cause.code === code;

function sandbox(t: TestContext): { root: string; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'qautra-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'execution') };
}

interface PeerMessage { event: string; ownerId?: string; code?: string }
interface Peer { child: ChildProcess; receive(event: string): Promise<PeerMessage>; send(command: object): void }
async function peer(t: TestContext, directory: string, cwd: string): Promise<Peer> {
  const script = `
    import { createExecutionAdmission } from ${JSON.stringify(admissionUrl)};
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const admission = createExecutionAdmission(process.argv[1], { pollIntervalMs: 2 });
    let reservation;
    let controller;
    process.on('message', async command => {
      try {
        if (command.kind === 'acquire') {
          reservation = admission.acquire(command.ownerId, 'browser');
          process.send({ event: 'acquired', ownerId: command.ownerId });
        } else if (command.kind === 'wait') {
          controller = new AbortController();
          const waiting = admission.wait(command.ownerId, 'browser', controller.signal);
          let failure;
          void waiting.catch(error => { failure = error; });
          const deadline = performance.now() + 5000;
          for (;;) {
            if (failure) throw failure;
            let queue;
            try { queue = JSON.parse(readFileSync(join(process.argv[1], 'pending.json'), 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (queue?.tickets.some(ticket => ticket.ownerId === command.ownerId && ticket.pid === process.pid)) break;
            if (performance.now() >= deadline) throw Object.assign(new Error('Durable queue registration was not observed'), { code: 'test_ticket_registration_missing' });
            await delay(2);
          }
          process.send({ event: 'queued' });
          reservation = await waiting;
          process.send({ event: 'acquired', ownerId: command.ownerId });
        } else if (command.kind === 'end') {
          reservation.ended();
          process.send({ event: 'ended' });
        } else if (command.kind === 'cancel') {
          controller.abort();
        }
      } catch (error) { process.send({ event: 'error', code: error.code }); }
    });
    process.send({ event: 'ready' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  const inbox: PeerMessage[] = [];
  const listeners = new Map<string, { resolve(message: PeerMessage): void; reject(cause: Error): void }[]>();
  child.on('message', value => {
    const message = value as PeerMessage;
    const waiting = listeners.get(message.event)?.shift();
    if (waiting) waiting.resolve(message); else inbox.push(message);
    if (message.event === 'error' && !waiting) {
      for (const pending of listeners.values()) for (const listener of pending) listener.reject(new Error(`admission peer failed: ${message.code}`));
      listeners.clear();
    }
  });
  child.on('exit', () => {
    for (const waiting of listeners.values()) for (const listener of waiting) listener.reject(new Error(`admission peer exited: ${stderr}`));
    listeners.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const result: Peer = {
    child,
    receive: event => {
      const index = inbox.findIndex(message => message.event === event);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]!);
      const failure = inbox.find(message => message.event === 'error');
      if (failure) return Promise.reject(new Error(`admission peer failed: ${failure.code}`));
      const { promise, resolve, reject } = Promise.withResolvers<PeerMessage>();
      const waiting = listeners.get(event) ?? [];
      waiting.push({ resolve, reject });
      listeners.set(event, waiting);
      return promise;
    },
    send: command => { child.send(command); },
  };
  await result.receive('ready');
  return result;
}

interface Workload { child: ChildProcess; root: string; resources: readonly string[] }
async function workload(t: TestContext, root: string, resources: readonly string[]): Promise<Workload> {
  const workRoot = join(root, 'owned-workload');
  mkdirSync(workRoot, { mode: 0o700 });
  const script = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.argv[1];
    writeFileSync(join(root, 'entity'), 'dirty fixture', { mode: 0o600 });
    writeFileSync(join(root, 'recording.part'), 'owned recording bytes', { mode: 0o600 });
    writeFileSync(join(root, 'effects'), 'initial effect\\n', { mode: 0o600 });
    process.on('message', () => appendFileSync(join(root, 'effects'), 'late effect\\n'));
    process.send({ event: 'ready' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, workRoot], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  await once(child, 'message');
  return { child, root: workRoot, resources };
}

async function verifyWorkload(owned: Workload, scope: ExecutionRecoveryScope): Promise<ExecutionRecoveryReceipt> {
  assert.deepEqual(scope.resources, [...owned.resources].sort());
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    const exited = once(owned.child, 'exit');
    owned.child.kill('SIGTERM');
    await exited;
  }
  assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
  const stop = Buffer.from(JSON.stringify({ pid: owned.child.pid, exitCode: owned.child.exitCode, signal: owned.child.signalCode }));
  writeFileSync(join(owned.root, 'native-stop'), stop, { mode: 0o600 });
  if (existsSync(join(owned.root, 'recording.part'))) renameSync(join(owned.root, 'recording.part'), join(owned.root, 'recording.final'));
  const fd = openSync(join(owned.root, 'recording.final'), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(join(owned.root, 'entity'))) unlinkSync(join(owned.root, 'entity'));
  assert.equal(existsSync(join(owned.root, 'entity')), false);
  const evidenceSha256 = digest(readFileSync(join(owned.root, 'recording.final')));
  const lateEffectsSha256 = digest(readFileSync(join(owned.root, 'effects')));
  return {
    schema: 'qautra/execution-recovery/v1', scope: { ...scope, resources: [...scope.resources] },
    resources: owned.resources.map(resourceId => ({ resourceId, nativeStop: 'confirmed', nativeStopSha256: digest(stop), evidence: 'finalized', evidenceSha256, fixture: 'restored', fixtureSha256: digest(`absent:${join(owned.root, 'entity')}`), lateEffects: 'resolved', lateEffectsSha256 })),
  };
}

describe('local-user execution admission', { timeout: 15_000 }, () => {
  it('shares one slot across objects while nested resource references finish independently', t => {
    const { directory } = sandbox(t);
    const first = createExecutionAdmission(directory);
    const second = createExecutionAdmission(directory);
    const run = first.acquire('run-a', 'run');
    const browser = second.acquire('run-a', 'browser');
    const recording = first.acquire('run-a', 'browser');
    assert.deepEqual(second.status().resources, ['browser', 'run']);
    assert.throws(() => second.acquire('run-b', 'browser'), hasCode('execution_busy'));
    run.ended();
    browser.ended();
    browser.ended();
    assert.deepEqual(first.status().resources, ['browser']);
    recording.ended();
    assert.equal(second.status().state, 'idle');
    const next = second.acquire('run-b', 'browser');
    run.ended();
    recording.unknown('late callback');
    assert.equal(first.status().ownerId, 'run-b');
    next.ended();
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  });

  it('preserves durable FIFO across different projects and processes', async t => {
    const { root, directory } = sandbox(t);
    const projectA = join(root, 'project-a');
    const projectB = join(root, 'project-b');
    mkdirSync(projectA); mkdirSync(projectB);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-current', 'preparation');
    const a = await peer(t, directory, projectA);
    const b = await peer(t, directory, projectB);
    a.send({ kind: 'wait', ownerId: 'run-a' });
    await a.receive('queued');
    b.send({ kind: 'wait', ownerId: 'run-b' });
    await b.receive('queued');
    assert.throws(() => admission.acquire('run-bypass', 'browser'), hasCode('execution_busy'));
    current.ended();
    assert.equal((await a.receive('acquired')).ownerId, 'run-a');
    assert.equal(admission.status().state, 'active');
    assert.equal(admission.status().ownership, 'live');
    assert.equal(admission.status().ownerId, 'run-a');
    a.send({ kind: 'end' });
    await a.receive('ended');
    assert.equal((await b.receive('acquired')).ownerId, 'run-b');
    b.send({ kind: 'end' });
    await b.receive('ended');
    assert.equal(admission.status().state, 'idle');
  });

  it('waits through a coordination gate disappearing during inspection without losing the live owner', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const current = admission.acquire('run-a', 'browser');
    const gate = join(realpathSync(directory), 'admission.lock');
    writeFileSync(gate, readFileSync(join(directory, 'owner.lock')), { mode: 0o600 });
    const original = fs.lstatSync;
    let removed = false;
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      if (!removed && String(args[0]) === gate) { removed = true; unlinkSync(gate); }
      return original(...args);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const controller = new AbortController();
    let waiting: Promise<unknown>;
    try { waiting = admission.wait('run-b', 'browser', controller.signal); }
    finally { fs.lstatSync = original; syncBuiltinESMExports(); }
    assert.ok(removed, 'The coordination-release interleaving was not exercised');
    const rejected = assert.rejects(waiting, hasCode('execution_cancelled'));
    controller.abort();
    await rejected;
    assert.equal(admission.status().ownerId, 'run-a');
    current.ended();
    assert.equal(admission.status().state, 'idle');
  });

  it('does not mistake a replaced coordination generation for unsafe live execution ownership', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const current = admission.acquire('run-a', 'browser');
    const gate = join(realpathSync(directory), 'admission.lock');
    const bytes = readFileSync(join(directory, 'owner.lock'));
    writeFileSync(gate, bytes, { mode: 0o600 });
    const original = { open: fs.openSync, stat: fs.fstatSync, named: fs.lstatSync };
    let tracked = -1, reads = 0, replaced = false, released = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = original.open(...args);
      if (!replaced && String(args[0]) === gate) tracked = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
      if (!replaced && args[0] === tracked && ++reads === 2) {
        unlinkSync(gate);
        writeFileSync(gate, bytes, { mode: 0o600 });
        replaced = true;
      }
      return original.stat(...args);
    }) as typeof fs.fstatSync;
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = original.named(...args);
      if (replaced && !released && String(args[0]) === gate) { unlinkSync(gate); released = true; }
      return stat;
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const controller = new AbortController();
    let waiting: Promise<unknown>;
    try { waiting = admission.wait('run-b', 'browser', controller.signal); }
    finally {
      fs.openSync = original.open; fs.fstatSync = original.stat; fs.lstatSync = original.named;
      syncBuiltinESMExports();
    }
    const rejected = assert.rejects(waiting, hasCode('execution_cancelled'));
    controller.abort();
    await rejected;
    assert.equal(admission.status().ownerId, 'run-a');
    current.ended();
    assert.equal(admission.status().state, 'idle');
  });

  it('does not grant a second process nested authority merely because its owner string matches', async t => {
    const { root, directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'run');
    const other = await peer(t, directory, root);
    other.send({ kind: 'acquire', ownerId: 'run-a' });
    assert.equal((await other.receive('error')).code, 'execution_busy');
    assert.equal(admission.status().ownerId, 'run-a');
    current.ended();
  });

  it('cancels only its own pending ticket and cannot release another owner', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const current = admission.acquire('run-a', 'browser');
    const controller = new AbortController();
    const cancelled = admission.wait('run-b', 'browser', controller.signal);
    const rejection = assert.rejects(cancelled, hasCode('execution_cancelled'));
    const next = admission.wait('run-c', 'browser');
    controller.abort();
    await rejection;
    assert.equal(admission.status().ownerId, 'run-a');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending.json'), 'utf8')).tickets.map((ticket: { ownerId: string }) => ticket.ownerId), ['run-c']);
    current.ended();
    const acquired = await next;
    assert.equal(admission.status().ownerId, 'run-c');
    acquired.ended();
  });

  it('removes a cancelled process ticket without changing the live owner generation', async t => {
    const { root, directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    const original = readFileSync(join(directory, 'owner.json'));
    const pending = await peer(t, directory, root);
    pending.send({ kind: 'wait', ownerId: 'run-b' });
    await pending.receive('queued');
    pending.send({ kind: 'cancel' });
    assert.equal((await pending.receive('error')).code, 'execution_cancelled');
    assert.deepEqual(readFileSync(join(directory, 'owner.json')), original);
    assert.equal(admission.status().ownerId, 'run-a');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending.json'), 'utf8')).tickets, []);
    current.ended();
  });

  it('does not dispatch a waiting request whose durable ticket disappeared', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const current = admission.acquire('run-a', 'browser');
    const pending = assert.rejects(admission.wait('run-b', 'browser'), hasCode('execution_ticket_lost'));
    const queuePath = join(directory, 'pending.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    queue.tickets = [];
    writeFileSync(queuePath, JSON.stringify(queue), { mode: 0o600 });
    current.ended();
    await pending;
    assert.equal(admission.status().state, 'idle');
  });

  it('treats an already-aborted wait as never started', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    await assert.rejects(admission.wait('run-a', 'browser', AbortSignal.abort()), hasCode('execution_cancelled'));
    assert.equal(admission.status().state, 'idle');
    assert.equal(existsSync(join(directory, 'owner.lock')), false);
    assert.equal(existsSync(join(directory, 'pending.json')), false);
  });

  it('drains active resources while closing and rejects pending/new work without releasing them', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const observer = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    const nested = admission.acquire('run-a', 'recording');
    const pending = assert.rejects(admission.wait('run-b', 'browser'), hasCode('execution_closing'));
    current.closing();
    assert.equal(observer.status().phase, 'closing');
    assert.throws(() => observer.acquire('run-a', 'extra'), hasCode('execution_closing'));
    admission.close();
    await pending;
    assert.throws(() => admission.acquire('run-c', 'browser'), hasCode('execution_closing'));
    current.ended();
    assert.equal(observer.status().state, 'active');
    nested.ended();
    const next = observer.acquire('run-b', 'browser');
    next.ended();
  });

  it('discards a dead process pending ticket but never dispatches its abandoned request', async t => {
    const { root, directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const current = admission.acquire('run-a', 'browser');
    const abandoned = await peer(t, directory, root);
    abandoned.send({ kind: 'wait', ownerId: 'abandoned' });
    await abandoned.receive('queued');
    const exited = once(abandoned.child, 'exit');
    abandoned.child.kill('SIGKILL');
    await exited;
    current.ended();
    const next = await admission.wait('run-b', 'browser');
    assert.equal(admission.status().ownerId, 'run-b');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending.json'), 'utf8')).tickets, []);
    next.ended();
  });

  it('reports another process as live while active and preserves orphan quarantine after it dies', async t => {
    const { root, directory } = sandbox(t);
    const admission = createExecutionAdmission(directory, { pollIntervalMs: 1 });
    const active = await peer(t, directory, root);
    active.send({ kind: 'acquire', ownerId: 'run-a' });
    await active.receive('acquired');
    assert.equal(admission.status().state, 'active');
    assert.equal(admission.status().ownership, 'live');
    const exited = once(active.child, 'exit');
    active.child.kill('SIGKILL');
    await exited;
    assert.equal(admission.status().state, 'unknown');
    assert.equal(admission.status().ownership, 'orphan');
    await assert.rejects(admission.wait('run-b', 'browser'), hasCode('execution_reconciliation_required'));
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
    assert.equal(existsSync(join(directory, 'owner.json')), true);
  });

  it('retains unknown scope and ignores late release after an unconfirmed stop', t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const browser = admission.acquire('run-a', 'browser');
    const recording = admission.acquire('run-a', 'recording');
    browser.unknown('backend response lost: secret must not be persisted');
    browser.ended(); recording.ended();
    assert.equal(admission.status().state, 'unknown');
    assert.deepEqual(admission.status().resources, ['browser', 'recording']);
    assert.equal(readFileSync(join(directory, 'owner.json'), 'utf8').includes('secret'), false);
    assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
  });

  it('retains a newly joined resource when marker persistence fails', t => {
    if (process.getuid?.() === 0) { t.skip('requires ordinary filesystem permission enforcement'); return; }
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const browser = admission.acquire('run-a', 'browser');
    const marker = join(directory, 'owner.json');
    chmodSync(marker, 0o000);
    assert.throws(() => admission.acquire('run-a', 'recording'), hasCode('execution_persistence_failed'));
    chmodSync(marker, 0o600);
    assert.deepEqual(admission.status().resources, ['browser', 'recording']);
    assert.equal(admission.status().state, 'unknown');
    browser.ended();
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
    browser.unknown('persist retained scope after storage is available');
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')).resources, ['browser', 'recording']);
  });

  it('does not lose a reference or release the slot when partial/final end persistence fails', t => {
    if (process.getuid?.() === 0) { t.skip('requires ordinary filesystem permission enforcement'); return; }
    for (const nested of [false, true]) {
      const { directory } = sandbox(t);
      const admission = createExecutionAdmission(directory);
      const browser = admission.acquire('run-a', 'browser');
      if (nested) admission.acquire('run-a', 'recording');
      const marker = join(directory, 'owner.json');
      chmodSync(marker, 0o000);
      assert.throws(() => browser.ended(), hasCode('execution_persistence_failed'));
      chmodSync(marker, 0o600);
      assert.equal(admission.status().state, 'unknown');
      assert.deepEqual(admission.status().resources, nested ? ['browser', 'recording'] : ['browser']);
      assert.equal(existsSync(join(directory, 'owner.lock')), true);
      assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
    }
  });

  it('keeps the lock when persisting unknown fails rather than interpreting ended as proof', t => {
    if (process.getuid?.() === 0) { t.skip('requires ordinary filesystem permission enforcement'); return; }
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    const marker = join(directory, 'owner.json');
    chmodSync(marker, 0o000);
    assert.throws(() => current.unknown('stop failed'), hasCode('execution_persistence_failed'));
    current.ended();
    chmodSync(marker, 0o600);
    assert.equal(admission.status().state, 'unknown');
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
  });

  it('does not clear corrupt or replaced markers through a late release', t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    const marker = join(directory, 'owner.json');
    writeFileSync(marker, '{corrupt', { mode: 0o600 });
    assert.equal(admission.status().reason, 'execution_record_invalid');
    assert.throws(() => current.ended(), hasCode('execution_persistence_failed'));
    assert.equal(readFileSync(marker, 'utf8'), '{corrupt');
    assert.equal(admission.status().state, 'unknown');
  });

  it('requires a trusted verifier instead of accepting owner/resource strings as cleanup proof', async t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    current.unknown('unconfirmed');
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_verifier_required'));
    assert.equal(admission.status().state, 'unknown');
  });

  it('does not stop an active flow or free one whose required evidence finalization fails', async t => {
    const { root, directory } = sandbox(t);
    const owned = await workload(t, root, ['browser']);
    const admission = createExecutionAdmission(directory, { verifyRecovery: scope => verifyWorkload(owned, scope) });
    const current = admission.acquire('run-a', 'browser');
    await assert.rejects(admission.reconcile(), hasCode('execution_active'));
    assert.equal(owned.child.signalCode, null);
    assert.equal(owned.child.exitCode, null);
    current.unknown('evidence finalization unconfirmed');
    unlinkSync(join(owned.root, 'recording.part'));
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_verification_failed'));
    assert.ok(owned.child.signalCode !== null || owned.child.exitCode !== null);
    assert.equal(admission.status().state, 'unknown');
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
  });

  it('keeps admission locked throughout real local stop, recording finalization and fixture/effect recovery', async t => {
    const { root, directory } = sandbox(t);
    const owned = await workload(t, root, ['browser']);
    const { promise: verifying, resolve: entered } = Promise.withResolvers<void>();
    const { promise: continueVerification, resolve: finish } = Promise.withResolvers<void>();
    const admission = createExecutionAdmission(directory, { verifyRecovery: async scope => { entered(); await continueVerification; return verifyWorkload(owned, scope); } });
    const observer = createExecutionAdmission(directory);
    const old = admission.acquire('run-a', 'browser');
    old.unknown('owned workload stop unconfirmed');
    const recovery = admission.reconcile();
    await verifying;
    assert.throws(() => observer.acquire('run-b', 'browser'), hasCode('execution_busy'));
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
    finish();
    const receipt = await recovery;
    assert.equal(receipt.resources[0]?.evidence, 'finalized');
    assert.equal(existsSync(join(owned.root, 'recording.final')), true);
    assert.equal(existsSync(join(owned.root, 'entity')), false);
    assert.equal(observer.status().state, 'idle');
    const next = observer.acquire('run-b', 'browser');
    old.ended(); old.unknown('late response');
    assert.equal(observer.status().ownerId, 'run-b');
    next.ended();
  });

  it('rejects partial proof and mismatched owner scope without clearing quarantine', async t => {
    const { root, directory } = sandbox(t);
    const owned = await workload(t, root, ['browser', 'recording']);
    let mode: 'partial' | 'mismatch' | 'complete' = 'partial';
    const admission = createExecutionAdmission(directory, { verifyRecovery: async scope => {
      const receipt = await verifyWorkload(owned, scope);
      if (mode === 'partial') receipt.resources.pop();
      if (mode === 'mismatch') receipt.scope.ownerId = 'different-owner';
      return receipt;
    } });
    const current = admission.acquire('run-a', 'browser');
    admission.acquire('run-a', 'recording');
    current.unknown('unconfirmed');
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_incomplete'));
    assert.equal(admission.status().state, 'unknown');
    mode = 'mismatch';
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_incomplete'));
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
    mode = 'complete';
    await admission.reconcile();
    assert.equal(admission.status().state, 'idle');
  });

  it('rejects marker replacement while the trusted verifier is running', async t => {
    const { root, directory } = sandbox(t);
    const owned = await workload(t, root, ['browser']);
    let replaced = false;
    const admission = createExecutionAdmission(directory, { verifyRecovery: async scope => {
      const receipt = await verifyWorkload(owned, scope);
      const marker = join(directory, 'owner.json');
      const replacement = join(directory, 'replacement');
      writeFileSync(replacement, readFileSync(marker), { mode: 0o600 });
      renameSync(replacement, marker);
      replaced = true;
      return receipt;
    } });
    const current = admission.acquire('run-a', 'browser');
    current.unknown('unconfirmed');
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_scope_mismatch'));
    assert.equal(replaced, true);
    assert.equal(admission.status().state, 'unknown');
    assert.equal(existsSync(join(directory, 'owner.lock')), true);
  });

  it('retains native recovery origins after one resource ends until the remaining evidence is verified', async t => {
    const { root, directory } = sandbox(t);
    const source = { kind: 'owned-chrome' as const, id: randomUUID(), bindingSha256: digest('original native binding') };
    const owned = await workload(t, root, ['recording']);
    const admission = createExecutionAdmission(directory, { verifyRecovery: scope => {
      assert.deepEqual(scope.recoverySources, [source]);
      return verifyWorkload(owned, scope);
    } });
    const browser = admission.acquire('run-a', 'browser');
    const recording = admission.acquire('run-a', 'recording');
    admission.registerRecoverySource(admission.ownerContext()!, source);
    browser.ended();
    recording.unknown('recording acknowledgement lost');
    assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
    await admission.reconcile();
    assert.equal(admission.status().state, 'idle');
    const next = admission.acquire('run-b', 'browser');
    next.ended();
  });

  for (const alteration of ['omit', 'substitute'] as const) it(`rejects recovery that would ${alteration} an original native binding`, async t => {
    const { root, directory } = sandbox(t);
    const source = { kind: 'owned-chrome' as const, id: randomUUID(), bindingSha256: digest('original native binding') };
    const owned = await workload(t, root, ['browser']);
    let alter = true;
    const admission = createExecutionAdmission(directory, { verifyRecovery: async scope => {
      const receipt = await verifyWorkload(owned, scope);
      return alter ? { ...receipt, scope: { ...receipt.scope, recoverySources: alteration === 'omit' ? [] : [{ ...source, bindingSha256: digest('another native binding') }] } } : receipt;
    } });
    const browser = admission.acquire('run-a', 'browser');
    admission.registerRecoverySource(admission.ownerContext()!, source);
    browser.unknown('native acknowledgement lost');
    await assert.rejects(admission.reconcile(), hasCode('reconciliation_incomplete'));
    assert.equal(admission.status().state, 'unknown');
    assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
    alter = false;
    await admission.reconcile();
    const next = admission.acquire('run-b', 'browser');
    next.ended();
  });

  it('never attaches an old generation or a replacement binding to a new native owner', t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const first = admission.acquire('run-a', 'browser');
    const previous = admission.ownerContext()!;
    first.ended();
    const next = admission.acquire('run-a', 'browser');
    const source = { kind: 'owned-chrome' as const, id: randomUUID(), bindingSha256: digest('original native binding') };
    assert.throws(() => admission.registerRecoverySource(previous, source), hasCode('execution_scope_changed'));
    assert.equal(admission.status().state, 'active');
    const current = admission.ownerContext()!;
    admission.registerRecoverySource(current, source);
    assert.throws(() => admission.registerRecoverySource(current, { ...source, bindingSha256: digest('replacement') }), hasCode('execution_scope_changed'));
    assert.equal(admission.status().state, 'unknown');
    next.ended();
    assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
  });

  it('retains the slot when positive recovery authority cannot be committed before release', async t => {
    const { root, directory } = sandbox(t);
    const owned = await workload(t, root, ['browser']);
    const admission = createExecutionAdmission(directory, { verifyRecovery: scope => verifyWorkload(owned, scope) });
    const current = admission.acquire('run-a', 'browser');
    const generation = admission.ownerContext()!.generation;
    current.unknown('original cleanup acknowledgement lost');
    const outside = join(root, 'unrelated-authority');
    mkdirSync(outside, { mode: 0o700 });
    const sentinel = join(outside, `${digest(generation)}.json`);
    writeFileSync(sentinel, 'unrelated authority', { mode: 0o600 });
    const journal = join(directory, 'recovery-authorizations');
    symlinkSync(outside, journal);
    await assert.rejects(admission.reconcile(), hasCode('execution_persistence_failed'));
    assert.equal(readFileSync(sentinel, 'utf8'), 'unrelated authority');
    assert.equal(admission.status().state, 'unknown');
    assert.throws(() => admission.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
    unlinkSync(journal);
    await admission.reconcile();
    const next = admission.acquire('run-b', 'browser');
    next.ended();
  });

  it('fails closed on unsafe roots, symlinks, hard links, oversized and insecure records', t => {
    const { root, directory } = sandbox(t);
    const outside = join(root, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, directory);
    assert.throws(() => createExecutionAdmission(directory), hasCode('execution_storage_unsafe'));
    unlinkSync(directory);
    const admission = createExecutionAdmission(directory);
    const target = join(outside, 'target');
    writeFileSync(target, 'untouched', { mode: 0o600 });
    const marker = join(directory, 'owner.json');
    symlinkSync(target, marker);
    assert.throws(() => admission.acquire('run-a', 'browser'), hasCode('execution_storage_unsafe'));
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    unlinkSync(marker);
    linkSync(target, marker);
    assert.throws(() => admission.acquire('run-a', 'browser'), hasCode('execution_storage_unsafe'));
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    unlinkSync(marker);
    writeFileSync(marker, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => admission.acquire('run-a', 'browser'), hasCode('execution_record_invalid'));
    writeFileSync(marker, '{}'); chmodSync(marker, 0o644);
    assert.throws(() => admission.acquire('run-a', 'browser'), hasCode('execution_storage_unsafe'));
    assert.equal(admission.status().state, 'unknown');
    chmodSync(directory, 0o777);
    assert.throws(() => createExecutionAdmission(directory), hasCode('execution_storage_unsafe'));
    chmodSync(directory, 0o700);
  });

  it('preserves lock-only and marker-only claims instead of reclaiming them from PID death', t => {
    const { directory } = sandbox(t);
    const admission = createExecutionAdmission(directory);
    const current = admission.acquire('run-a', 'browser');
    const marker = join(directory, 'owner.json');
    const markerBytes = readFileSync(marker);
    unlinkSync(marker);
    assert.equal(admission.status().state, 'unknown');
    assert.throws(() => createExecutionAdmission(directory).acquire('run-b', 'browser'), hasCode('execution_busy'));
    current.unknown('restore scoped quarantine');
    assert.equal(existsSync(marker), true);
    const otherDirectory = join(directory, 'orphan-marker');
    const other = createExecutionAdmission(otherDirectory);
    writeFileSync(join(otherDirectory, 'owner.json'), markerBytes, { mode: 0o600 });
    assert.equal(other.status().state, 'unknown');
    assert.throws(() => other.acquire('run-b', 'browser'), hasCode('execution_reconciliation_required'));
  });
});
