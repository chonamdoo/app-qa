import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentExecutionError, type AgentObservation, type AgentReply, type AgentSessionView } from '../../src/core/agent.ts';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import type { InstanceProfile } from '../../src/core/instances.ts';
import { createAgentSessions } from '../../src/runner/agent-sessions.ts';
import { createAgentService } from '../../src/runner/index.ts';
import { FakeClock, FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { fakeDeps, tempRoot } from '../helpers/run.ts';

function success<T>(reply: AgentReply): T {
  if (!reply.ok) assert.fail(JSON.stringify(reply));
  return reply.result as T;
}

function failure(reply: AgentReply, code?: string, effect?: string): void {
  if (reply.ok) assert.fail(`Expected refusal, got ${JSON.stringify(reply)}`);
  if (code !== undefined) assert.equal(reply.error.code, code, reply.error.message);
  if (effect !== undefined) assert.equal(reply.error.effect, effect, reply.error.message);
}

describe('direct execution ownership regression boundaries', () => {
  for (const persistenceFails of [false, true]) {
    it(`keeps an uncertain lease fenced after confirmed browser closure${persistenceFails ? ' when ownership persistence fails' : ''}`, async (t) => {
      const clock = new FakeClock();
      const platform = 'desktop-chrome' as const;
      const deviceId = 'synthetic-ownership-device';
      const app = 'agent-ownership-fixture';
      const root = realpathSync(tempRoot({
        [`apps/${app}.yaml`]: JSON.stringify({
          id: app,
          name: 'Synthetic ownership fixture',
          web: { url: 'http://localhost:4173/', platforms: [platform] },
          agent: {
            data: 'synthetic-fixture', screenshots: true, deviceIds: [deviceId],
            mutations: ['tap'], coordinates: false,
          },
        }),
      }));
      const admission = createExecutionAdmission(join(root, '.qa', 'test-admission'));
      const driver = new FakeDriver(fixtureSnapshot(platform, 'web-demo', 'index'), clock, deviceId);
      driver.hittable = () => true;
      driver.elementIdAt = async (point) => `element:${point.x}:${point.y}`;
      let owner: { sessionId: string; unknown: boolean } | null = null;
      const persistenceError = new Error('synthetic-ownership-persistence-failed');
      const sessions = createAgentSessions({
        root,
        appsDir: join(root, 'apps'),
        runsDir: join(root, '.qa', 'runs'),
        clock,
        ocr: null,
        pickDevice: async () => ({
          platform, id: deviceId, name: 'Synthetic fixture', osVersion: '1',
          state: 'booted', kind: 'browser',
        }),
        createDriver: () => driver,
        acquireSession: (_platform, _deviceId, _runId, sessionId) => {
          const reservation = admission.acquire(`session:${sessionId}`, `device:${deviceId}`);
          if (owner) {
            reservation.ended();
            throw new AgentExecutionError('device_locked', 'The physical resource still has an owner.');
          }
          const lease = { sessionId, unknown: false };
          owner = lease;
          return {
            ended: () => {
              if (owner === lease && !lease.unknown) owner = null;
              reservation.ended();
            },
            unknown: () => {
              if (owner !== lease) return;
              reservation.unknown('synthetic-input-unconfirmed');
              lease.unknown = true;
              if (persistenceFails) throw persistenceError;
            },
          };
        },
        openFailureProvenRejected: () => false,
      });
      t.after(() => sessions.shutdown());
      const request = { method: 'session.open', app, platform, deviceId } as const;
      const view = success<AgentSessionView>(await sessions.call(request));
      const observation = success<AgentObservation>(await sessions.call({ method: 'session.observe', sessionId: view.sessionId }));
      const target = observation.candidates.find((candidate) => candidate.resourceId === 'help-open');
      assert.ok(target);
      driver.tapStatus = 'uncertain';
      failure(await sessions.call({
        method: 'session.act', sessionId: view.sessionId, revision: observation.revision,
        action: { kind: 'tap', ref: target.ref }, timeoutMs: 1000,
      }), undefined, 'unknown');
      const stopped = success<AgentSessionView>(await sessions.call({ method: 'session.status', sessionId: view.sessionId }));
      assert.equal(stopped.state, 'unknown');
      assert.equal(driver.called('tap').length, 1);
      if (persistenceFails) {
        assert.match(stopped.stopReason ?? '', /synthetic-ownership-persistence-failed/);
        const persisted = JSON.parse(readFileSync(join(root, '.qa', 'runs', view.runId, 'session.json'), 'utf8')) as AgentSessionView;
        assert.equal(persisted.state, 'unknown');
        assert.match(persisted.stopReason ?? '', /synthetic-ownership-persistence-failed/);
      }
      success(await sessions.call({ method: 'session.close', sessionId: view.sessionId }));
      assert.equal(driver.called('close').length, 1);
      failure(await sessions.call(request), 'execution_reconciliation_required', 'not_started');
      assert.equal(admission.status().state, 'unknown');
      assert.equal(driver.called('open').length, 1);
      assert.equal(driver.called('tap').length, 1);
    });
  }

  it('admits a second direct session only after the first session finalizes evidence and cleanup', async (t) => {
    const platform = 'android' as const;
    const app = 'sequential-agent-fixture';
    const deviceIds = ['synthetic-first', 'synthetic-second'];
    const root = tempRoot({
      [`apps/${app}.yaml`]: JSON.stringify({
        id: app, name: 'Sequential synthetic fixture',
        web: { url: 'http://localhost:4173/', platforms: [platform] },
        agent: { data: 'synthetic-fixture', screenshots: true, deviceIds, mutations: ['tap'] },
      }),
    });
    const admission = createExecutionAdmission(join(root, '.qa', 'test-admission'));
    const drivers = deviceIds.map(id => new FakeDriver(fixtureSnapshot(platform, 'web-demo', 'index'), new FakeClock(), id));
    let finalized = false;
    const service = createAgentService({
      ...fakeDeps(root, drivers[0]!),
      admission,
      pickDevice: async (_platform, id) => ({
        platform, id: id!, name: 'Synthetic fixture', osVersion: '1', state: 'booted', kind: 'emulator',
      }),
      createDriver: (_platform, id) => {
        const driver = drivers.find(item => item.deviceId === id);
        assert.ok(driver);
        return driver;
      },
    }, { emit: event => {
      if (event.type !== 'run.finished') return;
      assert.equal(admission.status().state, 'active');
      finalized = true;
    } });
    t.after(() => service.shutdown());
    const first = success<AgentSessionView>(await service.call({ method: 'session.open', app, platform, deviceId: deviceIds[0]! }));
    const next = { method: 'session.open', app, platform, deviceId: deviceIds[1]! } as const;
    failure(await service.call(next), 'execution_busy', 'not_started');
    assert.equal(drivers[1]!.called('open').length, 0);
    assert.equal(admission.status().state, 'active');
    success(await service.call({ method: 'session.close', sessionId: first.sessionId }));
    assert.equal(finalized, true);
    assert.equal(admission.status().state, 'idle');
    const second = success<AgentSessionView>(await service.call(next));
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(drivers[1]!.called('open').length, 1);
    success(await service.call({ method: 'session.close', sessionId: second.sessionId }));
    assert.equal(admission.status().state, 'idle');
  });

  it('refuses instance creation when shutdown completes during trusted profile lookup', async (t) => {
    const root = realpathSync(tempRoot());
    const profile: InstanceProfile = {
      id: randomUUID(), name: 'Trusted synthetic Chrome profile', platform: 'desktop-chrome',
    };
    const entered = Promise.withResolvers<void>();
    const profiles = Promise.withResolvers<readonly InstanceProfile[]>();
    const driver = new FakeDriver(fixtureSnapshot('desktop-chrome', 'web-demo', 'index'), new FakeClock(), 'synthetic-unused-device');
    const service = createAgentService({
      ...fakeDeps(root, driver),
      instanceProfiles: () => {
        entered.resolve();
        return profiles.promise;
      },
    });
    t.after(async () => {
      profiles.resolve([profile]);
      await service.shutdown();
    });
    const pending = service.call({ method: 'instance.create', requestId: randomUUID(), profileId: profile.id }, { operatorReview: { principalId: 'local-test-owner', channel: 'local-ui' } });
    await Promise.race([entered.promise, pending.then(reply => assert.fail(`Request ended before trusted profile lookup: ${JSON.stringify(reply)}`))]);
    try {
      await service.shutdown();
    } finally {
      profiles.resolve([profile]);
    }
    failure(await pending, 'engine_stopping', 'not_started');
  });
});
