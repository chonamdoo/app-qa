import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { prepareKit } from '../../src/drivers/vm/backend-io.ts';
import type { GuestRuntimeFiles } from '../../src/drivers/vm/runtime.ts';

describe('cold owned guest kit replacement', () => {
  let scratch: string;
  let machine: string;
  let id: string;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'qa-guest-kit-')));
    machine = join(scratch, 'machine');
    mkdirSync(machine, { mode: 0o700 });
    id = randomUUID();
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  function runtime(version: string): GuestRuntimeFiles {
    const directory = join(scratch, 'runtime-' + version);
    const agent = join(directory, 'QAutraGuestAgent.app');
    mkdirSync(join(agent, 'Contents/MacOS'), { recursive: true, mode: 0o700 });
    writeFileSync(join(agent, 'Contents/MacOS/QAutraGuestAgent'), version, { mode: 0o700 });
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ sourceSha256: version.repeat(64) }), { mode: 0o600 });
    for (const file of ['setup-guest.sh', 'GuestSetup.txt']) writeFileSync(join(directory, file), version, { mode: 0o600 });
    return { directory, agent, helper: join(directory, 'QAutraGuestHost'), helperSha256: '0'.repeat(64) };
  }
  function initialKit(): { first: GuestRuntimeFiles; boot: string; inode: number } {
    const first = runtime('a');
    prepareKit(machine, id, first);
    const boot = JSON.stringify({ instanceId: id, epoch: 71, bootToken: 'old-private-boot' });
    writeFileSync(join(machine, 'kit/instance.json'), boot, { mode: 0o600 });
    return { first, boot, inode: lstatSync(join(machine, 'kit')).ino };
  }
  it('retires the previous boot identity without carrying it into a changed cold runtime', () => {
    const { boot } = initialKit();
    prepareKit(machine, id, runtime('b'));
    assert.deepEqual(JSON.parse(readFileSync(join(machine, 'kit/.qautra-kit.json'), 'utf8')), { version: 1, machineId: id, sourceSha256: 'b'.repeat(64) });
    assert.equal(existsSync(join(machine, 'kit/instance.json')), false);
    const retired = readdirSync(machine).find(name => name.startsWith('kit-retired-'));
    assert.ok(retired, 'the prior private boot identity must remain recoverable');
    assert.equal(readFileSync(join(machine, retired, 'instance.json'), 'utf8'), boot);
    assert.equal(readFileSync(join(machine, retired, 'QAutraGuestAgent.app/Contents/MacOS/QAutraGuestAgent'), 'utf8'), 'a');
  });
  it('keeps the same kit inode and boot identity when the runtime did not change', () => {
    const { first, boot, inode } = initialKit();
    prepareKit(machine, id, first);
    assert.equal(lstatSync(join(machine, 'kit')).ino, inode);
    assert.equal(readFileSync(join(machine, 'kit/instance.json'), 'utf8'), boot);
  });
  it('leaves the current boot identity intact when staging rejects an unsafe runtime entry', () => {
    const { boot, inode } = initialKit();
    const second = runtime('b');
    rmSync(join(second.directory, 'setup-guest.sh'));
    symlinkSync(join(second.directory, 'GuestSetup.txt'), join(second.directory, 'setup-guest.sh'));
    assert.throws(() => prepareKit(machine, id, second), { code: 'guest_kit_source_unsafe' });
    assert.equal(lstatSync(join(machine, 'kit')).ino, inode);
    assert.equal(readFileSync(join(machine, 'kit/instance.json'), 'utf8'), boot);
    assert.equal(JSON.parse(readFileSync(join(machine, 'kit/.qautra-kit.json'), 'utf8')).sourceSha256, 'a'.repeat(64));
  });
  it('never retires or adopts a kit whose machine UUID is different', () => {
    const { boot, inode } = initialKit();
    assert.throws(() => prepareKit(machine, randomUUID(), runtime('b')), { code: 'guest_kit_runtime_changed' });
    assert.equal(lstatSync(join(machine, 'kit')).ino, inode);
    assert.equal(readFileSync(join(machine, 'kit/instance.json'), 'utf8'), boot);
  });
});
