import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { appendFileSync, chmodSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { appendJsonl, commitDirectory, ensureDir, readJsonl, readPrivateFile, writeAtomic, writeJsonAtomic, writeSecure } from '../../src/core/fsx.ts';

const supported = process.platform !== 'win32' && Boolean(constants.O_NOFOLLOW && constants.O_DIRECTORY);
const codeIs = (code: string) => (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === code;
const diskFull = (): Error => Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'qautra-fsx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
}

const operations = ['openSync', 'closeSync', 'writeSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'readFileSync', 'readSync', 'fstatSync', 'fchmodSync'] as const;
type Operation = typeof operations[number];
type Call = (...args: unknown[]) => unknown;

function intercept(around: (op: Operation, args: unknown[], call: () => unknown) => unknown, run: () => void): void {
  const patchable = fs as unknown as Record<Operation, Call>;
  const originals = operations.map(op => [op, patchable[op]] as const);
  let inside = false;
  for (const [op, original] of originals) {
    patchable[op] = (...args) => {
      if (inside) return original(...args);
      inside = true;
      try { return around(op, args, () => original(...args)); }
      finally { inside = false; }
    };
  }
  syncBuiltinESMExports();
  try { run(); }
  finally {
    for (const [op, original] of originals) patchable[op] = original;
    syncBuiltinESMExports();
  }
}

describe('private filesystem commits', { skip: !supported, concurrency: false }, () => {
  it('commits file bytes before rename and every directory entry before acknowledging', t => {
    const root = sandbox(t);
    const directory = join(root, 'accepted', 'requests');
    ensureDir(directory);
    const file = join(directory, 'request.json');
    const paths = new Map<number, string>();
    const events: { kind: string; path: string }[] = [];
    intercept((op, args, call) => {
      if (op === 'openSync') {
        const fd = call() as number;
        paths.set(fd, String(args[0]));
        return fd;
      }
      if (op === 'fsyncSync') events.push({ kind: 'sync', path: paths.get(args[0] as number)! });
      if (op === 'renameSync') events.push({ kind: 'rename', path: String(args[0]) });
      return call();
    }, () => {
      writeJsonAtomic(file, { requestId: 'one', state: 'accepted' });
      events.push({ kind: 'ack', path: file });
    });
    const rename = events.findIndex(event => event.kind === 'rename');
    const stage = events[rename]!.path;
    assert.equal(dirname(stage), directory);
    assert.ok(events.slice(0, rename).some(event => event.kind === 'sync' && event.path === stage));
    for (let dir = directory; ; dir = dirname(dir)) {
      assert.ok(events.slice(rename + 1, -1).some(event => event.kind === 'sync' && event.path === dir), dir);
      if (dirname(dir) === dir) break;
    }
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { requestId: 'one', state: 'accepted' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(directory)).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(directory), ['request.json']);
  });

  it('keeps the old value visible throughout short writes, including split UTF-8 bytes', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old', { mode: 0o600 });
    const expected = '새 ownership marker 🌐';
    let writes = 0;
    intercept((op, args, call) => {
      if (op !== 'writeSync') return call();
      writes++;
      assert.equal(readFileSync(file, 'utf8'), 'old');
      return writeSync(args[0] as number, args[1] as Uint8Array, args[2] as number, Math.min(2, args[3] as number));
    }, () => writeAtomic(file, expected));
    assert.ok(writes > 1);
    assert.equal(readFileSync(file, 'utf8'), expected);
    assert.deepEqual(readdirSync(root), ['state']);
  });

  it('writes the caller’s exact Uint8Array view without cloning the source', t => {
    const root = sandbox(t);
    const bytes = new Uint8Array([90, 1, 2, 3, 91]);
    const view = bytes.subarray(1, 4);
    intercept((op, args, call) => {
      if (op === 'writeSync') assert.equal(args[1], view);
      return call();
    }, () => writeAtomic(join(root, 'frame'), view));
    assert.deepEqual([...readFileSync(join(root, 'frame'))], [1, 2, 3]);
  });

  it('rejects a zero-progress write and preserves the old value without leaking its stage', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old');
    assert.throws(() => intercept((op, _args, call) => op === 'writeSync' ? 0 : call(), () => writeAtomic(file, 'new')), codeIs('EIO'));
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(readdirSync(root), ['state']);
  });

  it('cleans only its own stage after a partial write, leaving an earlier orphan untouched', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    const orphan = '.state.abandoned.tmp';
    writeFileSync(file, 'old');
    writeFileSync(join(root, orphan), 'earlier crash');
    let writes = 0;
    assert.throws(() => intercept((op, args, call) => {
      if (op !== 'writeSync') return call();
      if (++writes > 1) throw diskFull();
      return writeSync(args[0] as number, args[1] as Uint8Array, args[2] as number, 1);
    }, () => writeAtomic(file, 'new value')), codeIs('ENOSPC'));
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.equal(readFileSync(join(root, orphan), 'utf8'), 'earlier crash');
    assert.deepEqual(readdirSync(root).sort(), [orphan, 'state'].sort());
  });

  for (const failing of ['file sync', 'close', 'rename', 'mode'] as const) {
    it(`preserves old bytes and removes its stage on ${failing} failure`, t => {
      const root = sandbox(t);
      const file = join(root, 'state');
      writeFileSync(file, 'old');
      let injected = false;
      assert.throws(() => intercept((op, args, call) => {
        const regular = ['fsyncSync', 'closeSync', 'fchmodSync'].includes(op) && fstatSync(args[0] as number).isFile();
        if (!injected && (failing === 'file sync' && op === 'fsyncSync' && regular
            || failing === 'close' && op === 'closeSync' && regular
            || failing === 'rename' && op === 'renameSync'
            || failing === 'mode' && op === 'fchmodSync' && regular)) {
          injected = true;
          if (op === 'closeSync') call();
          throw diskFull();
        }
        return call();
      }, () => writeAtomic(file, 'new')), codeIs('ENOSPC'));
      assert.equal(injected, true);
      assert.equal(readFileSync(file, 'utf8'), 'old');
      assert.deepEqual(readdirSync(root), ['state']);
    });
  }

  it('reports unsupported directory fsync before replacing the old value', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old');
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'fsyncSync' && fstatSync(args[0] as number).isDirectory()) {
        throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' });
      }
      return call();
    }, () => writeAtomic(file, 'new')), codeIs('EINVAL'));
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(readdirSync(root), ['state']);
  });

  it('does not acknowledge or dispatch after a post-rename directory commit failure', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old');
    let renamed = false;
    let dispatches = 0;
    assert.throws(() => intercept((op, args, call) => {
      if (renamed && op === 'fsyncSync' && fstatSync(args[0] as number).isDirectory()) throw diskFull();
      const result = call();
      if (op === 'renameSync') renamed = true;
      return result;
    }, () => { writeAtomic(file, 'new'); dispatches++; }), codeIs('ENOSPC'));
    assert.equal(dispatches, 0);
    assert.equal(readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(readdirSync(root), ['state']);
  });

  it('never opens or cleans an O_EXCL staging collision', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old');
    let collision: string | null = null;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'openSync' && (Number(args[1]) & constants.O_EXCL) !== 0) {
        collision = String(args[0]);
        writeFileSync(collision, 'not our stage', { flag: 'wx', mode: 0o600 });
      }
      return call();
    }, () => writeAtomic(file, 'new')), codeIs('EEXIST'));
    assert.ok(collision);
    assert.equal(readFileSync(collision, 'utf8'), 'not our stage');
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.equal(readdirSync(root).length, 2);
  });

  it('does not remove or follow a staging path replaced by a symlink', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    const outside = join(root, 'external');
    writeFileSync(file, 'old');
    writeFileSync(outside, 'external value');
    let stage = '';
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'renameSync') {
        stage = String(args[0]);
        unlinkSync(stage);
        symlinkSync(outside, stage);
        throw diskFull();
      }
      return call();
    }, () => writeAtomic(file, 'new')), AggregateError);
    assert.equal(lstatSync(stage).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, 'utf8'), 'external value');
    assert.equal(readFileSync(file, 'utf8'), 'old');
  });

  it('refuses a changed target instead of overwriting another generation', t => {
    const root = sandbox(t);
    const file = join(root, 'state');
    writeFileSync(file, 'old');
    let replaced = false;
    assert.throws(() => intercept((op, args, call) => {
      if (!replaced && op === 'fsyncSync' && fstatSync(args[0] as number).isFile()) {
        const replacement = join(root, 'replacement');
        writeFileSync(replacement, 'other generation');
        renameSync(replacement, file);
        replaced = true;
      }
      return call();
    }, () => writeAtomic(file, 'new')), codeIs('ERR_FSX_FILE_CHANGED'));
    assert.equal(readFileSync(file, 'utf8'), 'other generation');
    assert.deepEqual(readdirSync(root), ['state']);
  });

  it('keeps evidence replacement private but makes no durable acknowledgement', t => {
    const root = sandbox(t);
    const file = join(root, 'preview');
    writeFileSync(file, 'old');
    chmodSync(file, 0o666);
    intercept((op, _args, call) => {
      if (op === 'fsyncSync') throw new Error('evidence must not request a durable commit');
      return call();
    }, () => writeSecure(file, 'new preview'));
    assert.equal(readFileSync(file, 'utf8'), 'new preview');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('rejects symlink, hardlink and directory leaves without modifying their contents or modes', t => {
    const root = sandbox(t);
    const outside = join(root, 'external');
    writeFileSync(outside, '{"external":true}\n');
    chmodSync(outside, 0o644);
    const symbolic = join(root, 'symbolic');
    const hard = join(root, 'hard');
    const directory = join(root, 'directory');
    symlinkSync(outside, symbolic);
    linkSync(outside, hard);
    mkdirSync(directory, { mode: 0o700 });
    for (const target of [symbolic, hard, directory]) {
      assert.throws(() => writeAtomic(target, 'new'));
      assert.throws(() => writeSecure(target, 'new'));
      assert.throws(() => appendJsonl(target, { phase: 'intent' }));
      assert.throws(() => readJsonl(target));
    }
    assert.equal(readFileSync(outside, 'utf8'), '{"external":true}\n');
    assert.equal(statSync(outside).mode & 0o777, 0o644);
    assert.equal(lstatSync(symbolic).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(directory), []);
  });

  it('rejects a foreign owner discovered on an opened regular file before append', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    writeFileSync(file, '{"old":true}\n', { mode: 0o600 });
    assert.throws(() => intercept((op, _args, call) => {
      const result = call();
      if (op === 'fstatSync' && (result as fs.Stats).isFile()) {
        return Object.assign(Object.create(result as object) as fs.Stats, { uid: process.geteuid!() + 1 });
      }
      return result;
    }, () => appendJsonl(file, { new: true })), codeIs('ERR_FSX_UNSAFE_FILE'));
    assert.equal(readFileSync(file, 'utf8'), '{"old":true}\n');
  });

  it('rejects another user’s writable directory before creating work files', t => {
    const root = sandbox(t);
    const directory = join(root, 'shared');
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o777);
    assert.throws(() => writeAtomic(join(directory, 'state'), 'new'), codeIs('ERR_FSX_UNSAFE_DIRECTORY'));
    assert.deepEqual(readdirSync(directory), []);
  });

  it('refuses user-controlled directory symlinks without creating external children', { skip: process.geteuid?.() === 0 }, t => {
    const root = sandbox(t);
    const external = join(root, 'external');
    mkdirSync(external, { mode: 0o700 });
    const alias = join(root, 'alias');
    symlinkSync(external, alias);
    assert.throws(() => writeAtomic(join(alias, 'child', 'state'), 'new'), codeIs('ERR_FSX_UNSAFE_DIRECTORY'));
    assert.deepEqual(readdirSync(external), []);
  });

  it('accepts the root-owned macOS /var alias without treating it as project authorization', { skip: process.platform !== 'darwin' }, t => {
    const root = mkdtempSync('/var/tmp/qautra-fsx-alias-');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeAtomic(join(root, 'state'), 'saved');
    assert.equal(readFileSync(join(realpathSync(root), 'state'), 'utf8'), 'saved');
  });

  it('commits owned directory entries created by a consumer’s hard-link installation', t => {
    const root = sandbox(t);
    const stage = join(root, 'stage');
    const installed = join(root, 'revision');
    writeAtomic(stage, 'immutable revision');
    linkSync(stage, installed);
    unlinkSync(stage);
    let synced = false;
    intercept((op, args, call) => {
      if (op === 'fsyncSync' && fstatSync(args[0] as number).isDirectory()) synced = true;
      return call();
    }, () => commitDirectory(root));
    assert.equal(synced, true);
    assert.equal(readFileSync(installed, 'utf8'), 'immutable revision');
  });

  it('accepts a full bounded private snapshot but refuses larger, empty or publicly readable evidence', t => {
    const root = sandbox(t), file = join(root, 'original-authority');
    const bytes = Buffer.from('exact-authority');
    writeFileSync(file, bytes, { mode: 0o600 });
    assert.deepEqual(readPrivateFile(file, bytes.length), bytes);
    assert.throws(() => readPrivateFile(file, bytes.length - 1), codeIs('ERR_FSX_PRIVATE_FILE'));
    writeFileSync(file, '');
    assert.throws(() => readPrivateFile(file, bytes.length), codeIs('ERR_FSX_PRIVATE_FILE'));
    writeFileSync(file, bytes); chmodSync(file, 0o644);
    assert.throws(() => readPrivateFile(file, bytes.length), codeIs('ERR_FSX_PRIVATE_FILE'));
  });

  it('never returns a private snapshot whose bytes grew or whose named inode was replaced during read', t => {
    for (const mutation of ['grow', 'replace'] as const) {
      const root = sandbox(t), file = join(root, 'original-authority');
      writeFileSync(file, 'original binding', { mode: 0o600 });
      let changed = false;
      assert.throws(() => intercept((op, _args, call) => {
        const result = call();
        if (op === 'readSync' && !changed) {
          changed = true;
          if (mutation === 'grow') appendFileSync(file, 'untrusted tail');
          else { renameSync(file, join(root, 'previous')); writeFileSync(file, 'another binding!', { mode: 0o600 }); }
        }
        return result;
      }, () => { readPrivateFile(file, 128); }), codeIs('ERR_FSX_FILE_CHANGED'));
    }
  });

  it('refuses linked original authority rather than reading through another pathname', t => {
    const root = sandbox(t), file = join(root, 'authority'), alias = join(root, 'alias');
    writeFileSync(file, 'original binding', { mode: 0o600 });
    linkSync(file, alias);
    assert.throws(() => readPrivateFile(file, 128), codeIs('ERR_FSX_UNSAFE_FILE'));
    unlinkSync(alias);
    symlinkSync(file, alias);
    assert.throws(() => readPrivateFile(alias, 128), codeIs('ELOOP'));
  });

  it('rejects a FIFO authority without waiting for a writer', t => {
    const root = sandbox(t), file = join(root, 'authority.pipe');
    execFileSync('mkfifo', [file]);
    const source = `import { readPrivateFile } from ${JSON.stringify(new URL('../../src/core/fsx.ts', import.meta.url).href)}; try { readPrivateFile(process.argv[1], 128); process.exit(2); } catch (error) { console.log(error.code); }`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source, file], { timeout: 2000, encoding: 'utf8' });
    assert.equal(result.trim(), 'ERR_FSX_UNSAFE_FILE');
  });
});

describe('durable JSONL framing', { skip: !supported, concurrency: false }, () => {
  it('finishes short appends and commits the file and parent before returning to dispatch', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    const events: string[] = [];
    intercept((op, args, call) => {
      if (op === 'writeSync') {
        events.push('write');
        return writeSync(args[0] as number, args[1] as Uint8Array, args[2] as number, Math.min(3, args[3] as number));
      }
      if (op === 'fsyncSync') events.push(fstatSync(args[0] as number).isFile() ? 'file sync' : 'directory sync');
      return call();
    }, () => { appendJsonl(file, { phase: 'intent', text: '한글\nvalue' }); events.push('dispatch'); });
    const fileSync = events.indexOf('file sync');
    assert.ok(fileSync > events.lastIndexOf('write'));
    assert.ok(events.lastIndexOf('directory sync') > fileSync);
    assert.equal(events.at(-1), 'dispatch');
    assert.deepEqual(readJsonl(file), [{ phase: 'intent', text: '한글\nvalue' }]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('preserves a failed partial append and blocks both reading it as complete and further append', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    appendJsonl(file, { phase: 'intent', id: 'first' });
    const prefix = readFileSync(file);
    let writes = 0;
    assert.throws(() => intercept((op, args, call) => {
      if (op !== 'writeSync') return call();
      if (++writes > 1) throw diskFull();
      return writeSync(args[0] as number, args[1] as Uint8Array, args[2] as number, 5);
    }, () => appendJsonl(file, { phase: 'intent', id: 'second' })), codeIs('ENOSPC'));
    const torn = readFileSync(file);
    assert.deepEqual(torn.subarray(0, prefix.length), prefix);
    assert.ok(torn.length > prefix.length);
    assert.notEqual(torn.at(-1), 10);
    assert.throws(() => readJsonl(file), codeIs('ERR_FSX_TORN_JSONL'));
    assert.throws(() => appendJsonl(file, { phase: 'outcome' }), codeIs('ERR_FSX_TORN_JSONL'));
    assert.deepEqual(readFileSync(file), torn);
  });

  it('does not acknowledge a fully written intent whose file fsync fails', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    let dispatches = 0;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'fsyncSync' && fstatSync(args[0] as number).isFile()) throw diskFull();
      return call();
    }, () => { appendJsonl(file, { phase: 'intent' }); dispatches++; }), codeIs('ENOSPC'));
    assert.equal(dispatches, 0);
    assert.deepEqual(readJsonl(file), [{ phase: 'intent' }]);
  });

  it('does not acknowledge a new journal whose directory commit fails after file fsync', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    let fileSynced = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'fsyncSync') {
        if (fstatSync(args[0] as number).isFile()) fileSynced = true;
        else if (fileSynced) throw diskFull();
      }
      return call();
    }, () => appendJsonl(file, { phase: 'intent' })), codeIs('ENOSPC'));
    assert.equal(readFileSync(file, 'utf8'), '{"phase":"intent"}\n');
  });

  it('tightens the mode on the same owned journal before appending', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    writeFileSync(file, '{"first":true}\n');
    chmodSync(file, 0o666);
    appendJsonl(file, { second: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readJsonl(file), [{ first: true }, { second: true }]);
  });

  it('rejects a valid JSON tail without its newline instead of joining another record', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    writeFileSync(file, '{"phase":"intent"}', { mode: 0o600 });
    assert.throws(() => readJsonl(file), codeIs('ERR_FSX_TORN_JSONL'));
    assert.throws(() => appendJsonl(file, { phase: 'outcome' }), codeIs('ERR_FSX_TORN_JSONL'));
    assert.equal(readFileSync(file, 'utf8'), '{"phase":"intent"}');
  });

  it('rejects invalid JSON, blank records and invalid UTF-8 without silently skipping records', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    for (const bytes of [Buffer.from('{broken}\n'), Buffer.from('{"ok":true}\n\n'), Buffer.from([34, 0xff, 34, 10])]) {
      writeFileSync(file, bytes, { mode: 0o600 });
      assert.throws(() => readJsonl(file), codeIs('ERR_FSX_INVALID_JSONL'));
      assert.deepEqual(readFileSync(file), bytes);
    }
    writeFileSync(file, '', { mode: 0o600 });
    assert.deepEqual(readJsonl(file), []);
  });

  it('refuses to report a journal snapshot that changed during its read', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    appendJsonl(file, { first: true });
    assert.throws(() => intercept((op, args, call) => {
      const result = call();
      if (op === 'readFileSync' && typeof args[0] === 'number') appendFileSync(file, '{"second":true}\n');
      return result;
    }, () => readJsonl(file)), codeIs('ERR_FSX_FILE_CHANGED'));
    assert.deepEqual(readJsonl(file), [{ first: true }, { second: true }]);
  });

  it('rejects a replaced journal generation even if its bytes match the opened snapshot', t => {
    const root = sandbox(t);
    const file = join(root, 'journal');
    appendJsonl(file, { first: true });
    assert.throws(() => intercept((op, args, call) => {
      const result = call();
      if (op === 'readFileSync' && typeof args[0] === 'number') {
        const replacement = join(root, 'replacement');
        writeFileSync(replacement, result as Buffer, { mode: 0o600 });
        renameSync(replacement, file);
      }
      return result;
    }, () => readJsonl(file)), codeIs('ERR_FSX_FILE_CHANGED'));
    assert.deepEqual(readJsonl(file), [{ first: true }]);
  });

  it('never creates storage during a read or for an unserializable record', t => {
    const root = sandbox(t);
    const directory = join(root, 'missing', 'nested');
    const file = join(directory, 'journal');
    assert.throws(() => readJsonl(file), codeIs('ENOENT'));
    assert.throws(() => appendJsonl(file, undefined), TypeError);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(() => appendJsonl(file, circular), TypeError);
    assert.equal(existsSync(join(root, 'missing')), false);
    assert.deepEqual(readdirSync(root), []);
  });
});

if (!supported) {
  it('reports unsupported private filesystem semantics instead of acknowledging a write', () => {
    assert.throws(() => writeAtomic(join(tmpdir(), 'qautra-fsx-unsupported'), 'state'), codeIs('ERR_FSX_UNSUPPORTED'));
  });
}
