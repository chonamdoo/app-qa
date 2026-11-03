import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptTargetReceipt, createDispatchPreparation } from '../../src/runner/attempt.ts';

test('a target receipt never records the unmeasured host input boundary as verified', () => {
  for (const runtime of ['owned-chrome', 'macos-guest'] as const) {
    const owner = { runtime, instanceId: 'instance-1', machineId: runtime === 'macos-guest' ? 'machine-1' : null, workerId: 'worker-1', generation: 1 };
    const receipt = attemptTargetReceipt('attempt-1', { device: 'x' }, owner, { browser: null }, '2026-11-03T00:00:00.000Z');
    assert.equal(receipt.schema, 'qautra/attempt-target/v3');
    assert.deepEqual(receipt.hostInputBoundary, {
      transport: 'none', status: 'inferred-unmeasured', basis: runtime === 'owned-chrome' ? 'owned-chrome-runtime' : 'owned-macos-guest-runtime',
    });
    assert.equal(receipt.captureScope, runtime === 'owned-chrome' ? 'chrome-page' : 'macos-guest-display');
  }
});

function preparation(expiresAt = Date.now() + 60_000) {
  const log: string[] = [];
  let inFlight = false;
  const prepared = createDispatchPreparation({
    check: () => { log.push('check'); },
    inFlight: () => inFlight,
    open: async () => { log.push('open'); },
    close: () => { log.push('close'); },
    witness: async () => { log.push('witness'); return expiresAt; },
  });
  /** What the engine does around one dispatch: dispatching, then `finished` (which closes the recording boundary). */
  const dispatch = (): void => { inFlight = true; log.push('dispatch'); inFlight = false; prepared.consumed(); log.push('close'); };
  return { prepared, log, dispatch, setInFlight: (value: boolean) => { inFlight = value; } };
}

test('every dispatch runs on a witness fetched for it, including after an approval that never dispatched', async () => {
  const f = preparation();
  await f.prepared.prepare(); f.dispatch();
  assert.equal(f.prepared.held(), false);
  await f.prepared.prepare();
  f.prepared.release();
  assert.equal(f.prepared.held(), false, 'a refused approval drops its witness');
  await f.prepared.prepare(); f.dispatch();
  assert.deepEqual(f.log, ['check', 'open', 'witness', 'dispatch', 'close', 'check', 'open', 'witness', 'close', 'check', 'open', 'witness', 'dispatch', 'close']);
  assert.equal(f.log.filter(entry => entry === 'witness').length, 3);
  assert.equal(f.log.filter(entry => entry === 'open').length, f.log.filter(entry => entry === 'close').length, 'every recording boundary closes');
});

test('a new approval replaces a preparation an earlier approval left unused instead of reusing its proof', async () => {
  const f = preparation();
  await f.prepared.prepare();
  await f.prepared.prepare(); f.dispatch();
  assert.deepEqual(f.log, ['check', 'open', 'witness', 'close', 'check', 'open', 'witness', 'dispatch', 'close']);
});

test('a preparation in flight is never released, and a failed witness closes its boundary without holding a proof', async () => {
  const f = preparation();
  await f.prepared.prepare();
  f.setInFlight(true); f.prepared.release();
  assert.equal(f.prepared.held(), true);
  assert.equal(f.log.includes('close'), false);
  const failing = createDispatchPreparation({
    check() {}, inFlight: () => false, open: async () => { f.log.push('open-2'); }, close: () => { f.log.push('close-2'); },
    witness: async () => { throw new Error('witness refused'); },
  });
  await assert.rejects(failing.prepare(), /witness refused/);
  assert.equal(failing.held(), false);
  assert.deepEqual(f.log.slice(-2), ['open-2', 'close-2']);
});

test('a proof counts as expired at its expiry instant and when the expiry is unreadable', async () => {
  const now = Date.now();
  const f = preparation(now);
  assert.equal(f.prepared.expired(now), false, 'nothing held');
  await f.prepared.prepare();
  assert.equal(f.prepared.expired(now - 1), false);
  assert.equal(f.prepared.expired(now), true);
  const unreadable = preparation(Number.NaN);
  await unreadable.prepared.prepare();
  assert.equal(unreadable.prepared.expired(now), true);
});
