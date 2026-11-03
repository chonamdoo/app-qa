import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GuestInstanceView, InstanceExecutionError, OwnedChromeInstanceView, type GuestMachineBackend, type InstanceProfile, type InstanceRequest } from '../../src/core/instances.ts';
import { createDesktopInstances } from '../../src/runner/desktop-instances.ts';
import { createOwnedChromeInstances, type OwnedChromeInstances, type OwnedChromeResource } from '../../src/runner/owned-chrome-instances.ts';

const profile: InstanceProfile = { id: randomUUID(), name: 'Chrome environment', platform: 'desktop-chrome' };
const probe = () => ({ available: true, reason: null, workerId: 'fixture-owned-worker', osVersion: 'fixture-os' });
const code = (expected: string) => (error: unknown): boolean => error instanceof InstanceExecutionError && error.code === expected;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'qautra-instance-contract-'));
  const broker = createOwnedChromeInstances({ root, profiles: () => [profile], probe });
  t.after(async () => { await broker.shutdown().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  await broker.call({ method: 'instance.create', requestId: id, profileId: profile.id });
  return { root, broker, id, deviceId: `chrome:${id}` };
}
async function instance(broker: OwnedChromeInstances, request: InstanceRequest) {
  const result = await broker.call(request);
  assert.ok(!('instances' in result));
  return result;
}
function resource(broker: OwnedChromeInstances, deviceId: string, nativeProfile: string, stop: () => Promise<void> = async () => undefined): OwnedChromeResource {
  const execution = broker.execution(deviceId);
  assert.ok(execution);
  return { identity: { instanceId: execution.instanceId, generation: execution.generation, workerId: execution.workerId,
    browserSessionId: randomUUID(), profile: nativeProfile, browserVersion: 'fixture-browser', osVersion: 'fixture-os' }, assertHealthy() {}, stop };
}

function unsupportedGuest(calls: string[]): GuestMachineBackend {
  return {
    async probe() { calls.push('probe'); return { supported: false, reason: 'fixture guest unavailable', minimumCPUCount: 2, minimumMemoryMiB: 4096,
      physicalMemoryMiB: 32768, availableMemoryMiB: 16384, logicalCPUCount: 8, maximumMachines: 0 }; },
    async list() { calls.push('list'); return []; },
    async create() { calls.push('create'); throw new Error('Unexpected VM allocation'); },
    async start() { calls.push('start'); throw new Error('Unexpected VM start'); },
    async stop() { calls.push('stop'); throw new Error('Unexpected VM stop'); },
    async show() { calls.push('show'); throw new Error('Unexpected host/VM window'); },
    async hide() { calls.push('hide'); throw new Error('Unexpected host/VM window'); },
    async automation() { throw new Error('Unexpected guest setup'); },
    connection() { return null; },
    async bindBrowser() { throw new Error('Unexpected guest binding'); },
    async grantRoutes() { throw new Error('Unexpected guest route'); },
    async verifyBrowser() { throw new Error('Unexpected guest browser probe'); },
    async revokeBrowser() { throw new Error('Unexpected guest revocation'); },
    endpoint() { throw new Error('Unexpected guest endpoint'); },
    async request() { throw new Error('Unexpected guest command'); },
    async shutdown() { calls.push('shutdown'); },
  };
}

test('Chrome metadata creation, selection and show do not allocate or foreground a VM/browser', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qautra-desktop-facade-'));
  const calls: string[] = [];
  const facade = createDesktopInstances({ root, backend: unsupportedGuest(calls), profiles: () => [profile], chromeProbe: probe });
  t.after(async () => { await facade.shutdown(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  const created = await facade.call({ method: 'instance.create', requestId: id, profileId: profile.id });
  assert.ok(!('instances' in created));
  assert.equal(created.runtime, 'owned-chrome');
  assert.equal(created.machineId, null);
  assert.equal(created.cpuCount, null);
  assert.equal(created.isolation, 'owned-browser-context');
  assert.equal(created.frameAvailable, false);
  assert.equal(created.recordingReady, false);
  assert.ok(OwnedChromeInstanceView.safeParse(created).success);
  assert.ok(!GuestInstanceView.safeParse(created).success);
  await facade.call({ method: 'instance.start', instanceId: id });
  await facade.call({ method: 'instance.prepare', instanceId: id });
  await facade.call({ method: 'instance.show', instanceId: id });
  await facade.call({ method: 'instance.hide', instanceId: id });
  const picked = await facade.pick('desktop-chrome', `chrome:${id}`);
  assert.equal(picked.id, `chrome:${id}`);
  assert.deepEqual(calls, []);
  const listed = await facade.call({ method: 'instance.list' });
  assert.ok('instances' in listed);
  assert.equal(listed.instances.length, 1);
  assert.equal(listed.capabilities, null);
  assert.deepEqual(calls, []);
  assert.equal(listed.runtimes.find(runtime => runtime.runtime === 'owned-chrome')?.available, true);
  assert.equal(listed.runtimes.find(runtime => runtime.platform === 'desktop-safari')?.available, false);
  assert.equal(listed.runtimes.every(runtime => runtime.recordingReady === false), true);
  await assert.rejects(facade.pick('desktop-safari', picked.id), code('instance_platform_mismatch'));
  await assert.rejects(facade.pick('desktop-chrome', `guest:${id}`), code('instance_runtime_mismatch'));
});

test('real Safari and explicitly guest Chrome never fall back to owned host Chrome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qautra-guest-routing-'));
  const calls: string[] = [];
  const safari: InstanceProfile = { id: randomUUID(), name: 'Safari worker', platform: 'desktop-safari' };
  const guestChrome: InstanceProfile = { id: randomUUID(), name: 'Chrome guest', platform: 'desktop-chrome', runtime: 'macos-guest' };
  const facade = createDesktopInstances({ root, backend: unsupportedGuest(calls), profiles: () => [safari, guestChrome], chromeProbe: probe });
  t.after(async () => { await facade.shutdown(); await rm(root, { recursive: true, force: true }); });
  for (const target of [safari, guestChrome]) await assert.rejects(facade.call({ method: 'instance.create', requestId: randomUUID(), profileId: target.id }), code('guest_host_unsupported'));
  assert.ok(calls.includes('probe'));
  assert.ok(!calls.includes('create'));
  assert.equal((await facade.devices('desktop-chrome')).length, 0);
});

test('creation identity is durable and differing parameters cannot reuse the same request', async t => {
  const { broker, id } = await fixture(t);
  const initial = await instance(broker, { method: 'instance.status', instanceId: id });
  const repeated = await instance(broker, { method: 'instance.create', requestId: id, profileId: profile.id });
  assert.deepEqual(repeated, initial);
  await assert.rejects(broker.call({ method: 'instance.create', requestId: id, profileId: profile.id, name: 'Different' }), code('chrome_create_conflict'));
  await assert.rejects(broker.call({ method: 'instance.create', requestId: randomUUID(), profileId: profile.id, resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 64 } }), code('chrome_vm_resources_invalid'));
  await assert.rejects(broker.call({ method: 'instance.status', instanceId: randomUUID() }), code('chrome_instance_not_found'));
});

test('trusted macOS /var aliases preserve canonical durable Chrome creation identity', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp('/var/tmp/qautra-chrome-alias-');
  const canonicalRoot = await realpath(root);
  assert.notEqual(root, canonicalRoot);
  const broker = createOwnedChromeInstances({ root, profiles: () => [profile], probe });
  t.after(async () => { await broker.shutdown(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  const request = { method: 'instance.create', requestId: id, profileId: profile.id } as const;
  const initial = await instance(broker, request);
  const record = JSON.parse(await readFile(join(canonicalRoot, '.qa', 'instances', 'owned-chrome', `${id}.json`), 'utf8'));
  assert.equal(record.projectRoot, canonicalRoot);
  await broker.shutdown();
  for (const reopenedRoot of [canonicalRoot, root]) {
    const reopened = createOwnedChromeInstances({ root: reopenedRoot, profiles: () => [profile], probe });
    try {
      assert.deepEqual(await instance(reopened, request), initial);
      await assert.rejects(reopened.call({ ...request, name: 'Different' }), code('chrome_create_conflict'));
    } finally { await reopened.shutdown(); }
  }
});

test('user-controlled project root and ancestor symlinks remain refused', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'qautra-chrome-symlink-'));
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const root = join(parent, 'project');
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'nested'), { mode: 0o700 });
  const alias = join(parent, 'alias');
  await symlink(root, alias);
  for (const requestedRoot of [alias, join(alias, 'nested')]) {
    assert.throws(() => createOwnedChromeInstances({ root: requestedRoot, profiles: () => [profile], probe }), code('chrome_storage_unsafe'));
  }
  await assert.rejects(readFile(join(root, '.qa', 'instances', 'owned-chrome', 'manager.lock')), { code: 'ENOENT' });
});

test('other-user writable project roots and ancestors remain refused', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'qautra-chrome-unsafe-directory-'));
  t.after(async () => { await chmod(parent, 0o700); await rm(parent, { recursive: true, force: true }); });
  const root = join(parent, 'project');
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o722);
  assert.throws(() => createOwnedChromeInstances({ root, profiles: () => [profile], probe }), code('chrome_storage_unsafe'));
  await chmod(root, 0o700);
  await chmod(parent, 0o722);
  assert.throws(() => createOwnedChromeInstances({ root, profiles: () => [profile], probe }), code('chrome_storage_unsafe'));
});

test('a QA lease carries real worker and generation without inventing a VM UUID', async t => {
  const { broker, root, id, deviceId } = await fixture(t);
  await broker.call({ method: 'instance.prepare', instanceId: id });
  const first = broker.acquire(deviceId, 'run-a', randomUUID());
  const execution = broker.execution(deviceId);
  assert.ok(execution);
  assert.equal(execution.runtime, 'owned-chrome');
  assert.equal(execution.machineId, null);
  assert.equal(execution.workerId, probe().workerId);
  assert.equal((await instance(broker, { method: 'instance.status', instanceId: id })).state, 'preparing');
  assert.equal(await broker.prepare(deviceId, ['http://localhost:8080']), deviceId);
  broker.bind(deviceId, resource(broker, deviceId, join(root, 'native-profile-a')));
  const running = await instance(broker, { method: 'instance.status', instanceId: id });
  assert.equal(running.state, 'running');
  assert.equal(running.browserVersion, 'fixture-browser');
  assert.equal(running.recordingReady, false);
  first.ended();
  const second = broker.acquire(deviceId, 'run-b', randomUUID());
  assert.ok(broker.execution(deviceId)!.generation > execution.generation);
  await broker.prepare(deviceId, []);
  assert.throws(() => broker.bind(deviceId, resource(broker, deviceId, join(root, 'native-profile-a'))), code('chrome_storage_reused'));
  broker.bind(deviceId, resource(broker, deviceId, join(root, 'native-profile-b')));
  second.ended();
});

test('all earlier storage profiles stay fenced from reuse across later attempts', async t => {
  const { broker, root, id, deviceId } = await fixture(t);
  await broker.call({ method: 'instance.prepare', instanceId: id });
  for (const name of ['one', 'two']) {
    const lease = broker.acquire(deviceId, 'run', randomUUID());
    await broker.prepare(deviceId, []);
    broker.bind(deviceId, resource(broker, deviceId, join(root, name)));
    lease.ended();
  }
  const lease = broker.acquire(deviceId, 'run', randomUUID());
  await broker.prepare(deviceId, []);
  assert.throws(() => broker.bind(deviceId, resource(broker, deviceId, join(root, 'one'))), code('chrome_storage_reused'));
  lease.ended();
});

test('unknown ownership blocks dispatch and remains unknown after exact native stop', async t => {
  const { broker, root, id, deviceId } = await fixture(t);
  await broker.call({ method: 'instance.prepare', instanceId: id });
  const lease = broker.acquire(deviceId, 'run-unknown', randomUUID());
  await broker.prepare(deviceId, []);
  let nativeStops = 0;
  broker.bind(deviceId, resource(broker, deviceId, join(root, 'native-profile'), async () => { nativeStops++; }));
  lease.unknown('transport_lost');
  assert.equal(broker.execution(deviceId), null);
  assert.ok(broker.execution(deviceId, true));
  assert.throws(() => lease.ended(), code('chrome_lease_unknown'));
  await assert.rejects(broker.call({ method: 'instance.stop', instanceId: id, cancelActive: false, force: false }), code('chrome_instance_active'));
  const stopped = await instance(broker, { method: 'instance.stop', instanceId: id, cancelActive: true, force: true });
  assert.equal(nativeStops, 1);
  assert.equal(stopped.state, 'unknown');
  assert.equal(stopped.activeRunId, null);
  await broker.call({ method: 'instance.stop', instanceId: id, cancelActive: true, force: true });
  assert.equal(nativeStops, 1);
  await assert.rejects(broker.call({ method: 'instance.start', instanceId: id }), code('chrome_instance_unknown'));
  lease.ended();
});

test('native stop failure retains its exact resource and cannot release capacity', async t => {
  const { broker, root, id, deviceId } = await fixture(t);
  await broker.call({ method: 'instance.prepare', instanceId: id });
  broker.acquire(deviceId, 'run-a', randomUUID());
  await broker.prepare(deviceId, []);
  let rejectStop = true;
  broker.bind(deviceId, resource(broker, deviceId, join(root, 'native-profile'), async () => { if (rejectStop) throw new Error('unconfirmed native stop'); }));
  await assert.rejects(broker.call({ method: 'instance.stop', instanceId: id, cancelActive: true, force: false }), code('chrome_stop_unknown'));
  const otherId = randomUUID();
  await broker.call({ method: 'instance.create', requestId: otherId, profileId: profile.id });
  await broker.call({ method: 'instance.prepare', instanceId: otherId });
  assert.throws(() => broker.acquire(`chrome:${otherId}`, 'run-b', randomUUID()), code('chrome_capacity'));
  rejectStop = false;
  await broker.call({ method: 'instance.stop', instanceId: id, cancelActive: true, force: false });
});

test('restart preserves active ownership rather than adopting native resources or clearing by time', async t => {
  const { broker, root, id, deviceId } = await fixture(t);
  await broker.call({ method: 'instance.prepare', instanceId: id });
  broker.acquire(deviceId, 'run-restart', randomUUID());
  await assert.rejects(broker.shutdown());
  const recovered = createOwnedChromeInstances({ root, profiles: () => [profile], probe });
  t.after(async () => { await recovered.shutdown().catch(() => undefined); });
  const status = await instance(recovered, { method: 'instance.status', instanceId: id });
  assert.equal(status.state, 'unknown');
  assert.equal(status.activeRunId, 'run-restart');
  assert.equal(recovered.execution(deviceId), null);
  await assert.rejects(recovered.call({ method: 'instance.stop', instanceId: id, cancelActive: true, force: true }), code('chrome_stop_unknown'));
  assert.equal((await instance(recovered, { method: 'instance.status', instanceId: id })).state, 'unknown');
});

test('unavailable native Chrome preparation never reports browser or recording readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qautra-chrome-unavailable-'));
  const broker = createOwnedChromeInstances({ root, profiles: () => [profile], probe: () => ({ ...probe(), available: false, reason: 'actual binary missing' }) });
  t.after(async () => { await broker.shutdown(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  const created = await instance(broker, { method: 'instance.create', requestId: id, profileId: profile.id });
  assert.equal(created.state, 'setup-required');
  assert.equal(created.browserVersion, null);
  assert.equal(created.recordingReady, false);
  await assert.rejects(broker.call({ method: 'instance.prepare', instanceId: id }), code('chrome_setup_required'));
  assert.throws(() => broker.acquire(`chrome:${id}`, 'run', randomUUID()), code('chrome_setup_required'));
});
