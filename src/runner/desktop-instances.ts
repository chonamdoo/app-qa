import { realpathSync } from 'node:fs';
import { GuestPlatform, InstanceExecutionError, InstanceRequestSchema, type GuestInstanceView, type GuestMachineBackend, type InstanceHostCapabilities, type InstanceList, type InstanceProfile, type InstanceRequest, type InstanceView } from '../core/instances.ts';
import type { DeviceInfo } from '../core/types.ts';
import { createGuestInstances, type GuestExecution, type GuestInstances, type InstanceLease } from './instances.ts';
import { createOwnedChromeInstances, type OwnedChromeExecution, type OwnedChromeInstances, type OwnedChromeProbe, type OwnedChromeResource } from './owned-chrome-instances.ts';
import type { ChromeOwnerLocator } from '../core/chrome-owner.ts';
import type { ChromeAttemptRecovery, InstanceRecoverySummary } from '../core/recovery.ts';

export interface DesktopInstances {
  call(request: InstanceRequest): Promise<InstanceList | InstanceView>;
  devices(platform?: GuestPlatform): Promise<DeviceInfo[]>;
  pick(platform: GuestPlatform, deviceId?: string): Promise<DeviceInfo>;
  acquire(deviceId: string, runId: string | null, sessionId: string, owner?: 'direct' | 'run' | 'screen'): InstanceLease;
  prepare(deviceId: string, origins: readonly string[]): Promise<string>;
  execution(deviceId: string, cleanup?: boolean): GuestExecution | OwnedChromeExecution | null;
  bindOwnedChrome(deviceId: string, resource: OwnedChromeResource): void;
  bindNativeOwner(deviceId: string, locator: ChromeOwnerLocator): void;
  reconcileOwnedChrome(): Promise<InstanceRecoverySummary>;
  shutdown(): Promise<void>;
}

export function createDesktopInstances(options: {
  root: string;
  backend: GuestMachineBackend;
  profiles: () => readonly InstanceProfile[];
  cancelExecution?: (executionId: string) => Promise<void>;
  chromeProbe?: () => OwnedChromeProbe;
  maximumActiveChromeContexts?: number;
  admissionDirectory?: string;
  nativeRecovery?: ChromeAttemptRecovery;
}): DesktopInstances {
  const chrome = createOwnedChromeInstances({ root: options.root, profiles: options.profiles, probe: options.chromeProbe,
    cancelExecution: options.cancelExecution, maximumActiveContexts: options.maximumActiveChromeContexts, admissionDirectory: options.admissionDirectory, nativeRecovery: options.nativeRecovery });
  let guest: GuestInstances;
  try { guest = createGuestInstances({ ...options, root: realpathSync(options.root) }); }
  catch (error) { void chrome.shutdown().catch(() => undefined); throw error; }
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;

  function assertOpen(): void {
    if (closing) throw new InstanceExecutionError('instance_engine_stopping', 'The desktop instance manager is shutting down.');
  }
  function owner(id: string): GuestInstances | OwnedChromeInstances {
    const ownedChrome = chrome.owns(id);
    const ownedGuest = guest.owns(id);
    if (ownedChrome && ownedGuest) throw new InstanceExecutionError('instance_identity_conflict', 'The same instance UUID has conflicting native ownership records.', 'unknown');
    if (ownedChrome) return chrome;
    if (ownedGuest) return guest;
    throw new InstanceExecutionError('instance_not_found', 'The instance UUID is not owned by this project.');
  }
  function deviceOwner(deviceId: string): GuestInstances | OwnedChromeInstances {
    if (deviceId.startsWith('chrome:')) {
      if (owner(deviceId.slice(7)) !== chrome) throw new InstanceExecutionError('instance_runtime_mismatch', 'The device prefix does not match its actual owned runtime.');
      return chrome;
    }
    if (deviceId.startsWith('guest:')) {
      if (owner(deviceId.slice(6)) !== guest) throw new InstanceExecutionError('instance_runtime_mismatch', 'The device prefix does not match its actual owned runtime.');
      return guest;
    }
    throw new InstanceExecutionError('instance_device_required', 'Select an owned chrome:<UUID> or guest:<UUID>; personal host browsers are not adopted.');
  }
  async function guestList(): Promise<{ instances: GuestInstanceView[]; profiles: readonly InstanceProfile[]; capabilities: InstanceHostCapabilities | null }> {
    if (!guest.hasInstances()) return { instances: [], profiles: options.profiles(), capabilities: null };
    const result = await guest.call({ method: 'instance.list' });
    if (!('instances' in result)) throw new InstanceExecutionError('instance_list_invalid', 'The guest manager returned an invalid inventory.', 'unknown');
    return result;
  }
  async function devices(platform?: GuestPlatform): Promise<DeviceInfo[]> {
    assertOpen();
    if (platform !== undefined) GuestPlatform.parse(platform);
    const guests = guest.hasInstances() ? await guest.devices(platform) : [];
    return platform === 'desktop-safari' ? guests : [...await chrome.devices(), ...guests];
  }

  return {
    bindNativeOwner(deviceId, locator) { assertOpen(); if (deviceOwner(deviceId) !== chrome) throw new InstanceExecutionError('instance_runtime_mismatch', 'Only an owned Chrome instance can bind this native owner.'); chrome.bindNativeOwner(deviceId, locator); },
    reconcileOwnedChrome: () => { assertOpen(); return chrome.reconcile(); },
    async call(input) {
      assertOpen();
      const request = InstanceRequestSchema.parse(input);
      if (request.method === 'instance.list') {
        const guests = await guestList();
        const owned = await chrome.call(request);
        if (!('instances' in owned)) throw new InstanceExecutionError('instance_list_invalid', 'The Chrome manager returned an invalid inventory.', 'unknown');
        for (const instance of owned.instances) if (guest.owns(instance.id)) throw new InstanceExecutionError('instance_identity_conflict', 'Duplicate instance ownership requires reconciliation.', 'unknown');
        return {
          instances: [...owned.instances, ...guests.instances], profiles: options.profiles(), capabilities: guests.capabilities,
          runtimes: [owned.capability, ...(['desktop-chrome', 'desktop-safari'] as const).map(platform => {
            const prepared = guests.instances.some(instance => instance.platform === platform && (instance.state === 'ready' || instance.state === 'running'));
            return {
              runtime: 'macos-guest' as const, platform, available: prepared, readiness: prepared ? 'prepared' as const : 'unavailable' as const,
              reason: prepared ? null : guests.capabilities?.reason ?? 'No actual prepared macOS guest browser is available; native VM capabilities have not been probed when no guest is owned.',
              preparation: 'prepared-worker-required' as const, capture: 'guest-desktop' as const, recordingReady: false as const, hostGlobalInput: false as const,
            };
          })],
        };
      }
      if (request.method === 'instance.create') {
        let selected: GuestInstances | OwnedChromeInstances;
        if (chrome.owns(request.requestId) || guest.owns(request.requestId)) selected = owner(request.requestId);
        else {
          const profiles = options.profiles().filter(profile => profile.id.toLowerCase() === request.profileId.toLowerCase());
          const profile = profiles[0];
          if (profiles.length !== 1 || !profile) throw new InstanceExecutionError('instance_profile_not_found', 'Select one trusted desktop environment profile.');
          if (profile.platform === 'desktop-safari' && profile.runtime === 'owned-chrome') throw new InstanceExecutionError('instance_runtime_unsupported', 'Real Safari requires an actual prepared macOS guest; Chrome is not a substitute.');
          selected = profile.platform === 'desktop-chrome' && profile.runtime !== 'macos-guest' ? chrome : guest;
        }
        const result = await selected.call(request);
        if ('instances' in result) throw new InstanceExecutionError('instance_create_invalid', 'Instance creation did not return an owned instance.', 'unknown');
        return result;
      }
      const result = await owner(request.instanceId).call(request);
      if ('instances' in result) throw new InstanceExecutionError('instance_status_invalid', 'Instance operation did not return an owned instance.', 'unknown');
      return result;
    },
    devices,
    async pick(platform, deviceId) {
      assertOpen(); GuestPlatform.parse(platform);
      if (deviceId) {
        const selected = deviceOwner(deviceId);
        if (selected === chrome) {
          if (platform !== 'desktop-chrome') throw new InstanceExecutionError('instance_platform_mismatch', 'An owned Chrome device cannot execute Safari.');
          return await chrome.pick(deviceId);
        }
        return await guest.pick(platform, deviceId);
      }
      const candidates = (await devices(platform)).filter(device => device.state === 'booted');
      const idle: DeviceInfo[] = [];
      for (const candidate of candidates) {
        try {
          const selected = deviceOwner(candidate.id);
          idle.push(selected === chrome ? await chrome.pick(candidate.id) : await guest.pick(platform, candidate.id));
        } catch (error) {
          if (!(error instanceof InstanceExecutionError) || !['chrome_device_unavailable', 'guest_device_unavailable'].includes(error.code)) throw error;
        }
      }
      if (idle.length !== 1) throw new InstanceExecutionError('instance_device_unavailable', 'Select one explicit prepared idle desktop instance.');
      return idle[0]!;
    },
    acquire(deviceId, runId, sessionId, leaseOwner) {
      assertOpen(); return deviceOwner(deviceId).acquire(deviceId, runId, sessionId, leaseOwner);
    },
    async prepare(deviceId, origins) {
      assertOpen(); return await deviceOwner(deviceId).prepare(deviceId, origins);
    },
    execution(deviceId, cleanup) {
      assertOpen(); return deviceOwner(deviceId).execution(deviceId, cleanup);
    },
    bindOwnedChrome(deviceId, resource) {
      assertOpen();
      if (deviceOwner(deviceId) !== chrome) throw new InstanceExecutionError('instance_runtime_mismatch', 'Only an owned Chrome lease can bind its actual native browser.');
      chrome.bind(deviceId, resource);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = (async () => {
        const results = await Promise.allSettled([chrome.shutdown(), guest.shutdown()]);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Desktop instance shutdown retains unconfirmed resources.');
      })();
      return shutdownPromise;
    },
  };
}
