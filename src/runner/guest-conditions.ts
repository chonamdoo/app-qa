import { z } from 'zod';
import type { AttemptBrowserEvidence, AttemptConditionsReceipt, AttemptMaterialConditions } from '../core/regression.ts';
import { projectFixtureCanonical } from '../core/project-fixture.ts';
import { regressionGrantSubjectSha256 } from '../policy/regression-grant.ts';
import { GuestAttemptBindingSchema } from '../core/guest-recovery.ts';
import {
  GUEST_BROWSER_EPHEMERAL_CAPABILITY_PATHS,
  validateGuestBrowserEvidence,
} from '../core/guest-runtime.ts';

export type OriginalConditions = Pick<AttemptConditionsReceipt,
  'attemptId' | 'revisionId' | 'testId' | 'target' | 'runId'
  | 'initial' | 'final' | 'browser' | 'worker' | 'runtime' | 'subject' | 'guest'>;

type Json = z.infer<ReturnType<typeof z.json>>;
type JsonObject = Record<string, Json>;

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGuestArguments(value: Json, profile: string | null): string[] | null {
  if (!Array.isArray(value) || value.some(argument => typeof argument !== 'string')) return null;
  const args = value as string[];
  const owned = args.filter(argument => argument.startsWith('--user-data-dir='));
  if (owned.length > 1 || owned.some(argument => profile === null || argument !== `--user-data-dir=${profile}`)) return null;
  return args.map(argument => profile !== null && argument === `--user-data-dir=${profile}`
    ? '--user-data-dir=<owned-profile>'
    : argument);
}

function normalizeGuestCapabilities(
  capabilities: JsonObject,
  profile: string | null,
  processId: number,
): JsonObject | null {
  const material = structuredClone(capabilities);
  for (const path of GUEST_BROWSER_EPHEMERAL_CAPABILITY_PATHS) {
    let container = material;
    if (path.length === 2) {
      const parent = container[path[0]];
      if (parent === undefined) continue;
      if (!jsonObject(parent)) return null;
      container = parent;
    }
    const key = path[path.length - 1]!;
    const value = container[key];
    if (value === undefined) continue;
    if (key === 'debuggerAddress') {
      if (profile === null || typeof value !== 'string') return null;
      const address = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/.exec(value);
      if (!address || Number(address[2]) > 65535) return null;
      container[key] = `${address[1]}:<owned-port>`;
    } else if (key === 'userDataDir') {
      if (profile === null || value !== profile) return null;
      container[key] = '<owned-profile>';
    } else {
      if (value !== processId) return null;
      container[key] = '<owned-process>';
    }
  }
  const options = material['goog:chromeOptions'];
  if (options !== undefined) {
    if (!jsonObject(options)) return null;
    if (options.args !== undefined) {
      const args = normalizeGuestArguments(options.args, profile);
      if (!args) return null;
      options.args = args;
    }
  }
  return material;
}

function normalizeGuestRequestedCapabilities(
  requested: JsonObject,
  profile: string | null,
  processId: number,
): JsonObject | null {
  const material = normalizeGuestCapabilities(requested, profile, processId);
  if (!material) return null;
  if (material.capabilities !== undefined) {
    if (!jsonObject(material.capabilities)) return null;
    const nested = normalizeGuestRequestedCapabilities(material.capabilities, profile, processId);
    if (!nested) return null;
    material.capabilities = nested;
  }
  if (material.alwaysMatch !== undefined) {
    if (!jsonObject(material.alwaysMatch)) return null;
    const normalized = normalizeGuestCapabilities(material.alwaysMatch, profile, processId);
    if (!normalized) return null;
    material.alwaysMatch = normalized;
  }
  if (material.firstMatch !== undefined) {
    if (!Array.isArray(material.firstMatch) || material.firstMatch.length === 0) return null;
    const alternatives: JsonObject[] = [];
    for (const candidate of material.firstMatch) {
      if (!jsonObject(candidate)) return null;
      const normalized = normalizeGuestCapabilities(candidate, profile, processId);
      if (!normalized) return null;
      alternatives.push(normalized);
    }
    material.firstMatch = alternatives;
  }
  return material;
}

export function guestBrowserMaterial(original: OriginalConditions): {
  browser: AttemptMaterialConditions['browser'];
  browserBinary: AttemptBrowserEvidence['browserBinary'];
  driverBinary: AttemptBrowserEvidence['driverBinary'];
  capturedAt: string;
  workerId: string;
} | null {
  const { guest, worker, initial } = original;
  if (!guest?.browser || !worker || !initial || original.browser !== null) return null;
  try {
    const binding = GuestAttemptBindingSchema.parse(guest.binding);
    const evidence = validateGuestBrowserEvidence(guest.browser, binding, guest.source);
    const { identity, context, native, execution } = binding;
    if (
      worker.runtime !== 'macos-guest'
      || original.target.deviceId !== `guest:${identity.contextId}`
      || worker.instanceId !== identity.contextId
      || worker.machineId !== identity.machineId
      || worker.generation !== identity.generation
      || worker.workerId !== binding.workerId
      || binding.workerId !== `guest:${identity.machineId}:${identity.guestPid}:${identity.epoch}`
      || native.machineId !== identity.machineId
      || native.recorderId !== identity.recorderId
      || guest.source.id !== identity.recorderId
      || context.attemptId !== original.attemptId
      || identity.attemptId !== original.attemptId
      || context.runId !== original.runId
      || identity.runId !== original.runId
      || context.revisionId !== original.revisionId
      || context.testId !== original.testId
      || context.ownerId !== `attempt:${original.attemptId}`
      || execution.ownerId !== context.ownerId
      || !execution.resources.includes(`target:${original.target.deviceId}`)
      || new Set(execution.resources).size !== execution.resources.length
      || context.subjectSha256 !== regressionGrantSubjectSha256(original.subject)
      || context.subjectSha256 !== initial.subjectSha256
      || projectFixtureCanonical(context.target) !== projectFixtureCanonical(original.target)
      || projectFixtureCanonical(original.subject.target) !== projectFixtureCanonical(original.target)
    ) return null;

    const runtime = evidence.runtime;
    const profile = runtime.ephemeral.profilePath;
    const chrome = runtime.platform === 'desktop-chrome';
    if (
      runtime.settings.preferenceSource !== (chrome ? 'chrome-profile-file' : 'safari-preference-overrides')
      || (chrome && (profile === null || !profile.startsWith('/')))
    ) return null;
    const args = normalizeGuestArguments(runtime.settings.args, profile);
    if (!args || (chrome && runtime.settings.args.filter(argument => argument.startsWith('--user-data-dir=')).length !== 1)) return null;
    const capabilities = normalizeGuestCapabilities(runtime.capabilities, profile, runtime.browser.pid);
    const requestedCapabilities = normalizeGuestRequestedCapabilities(runtime.requestedCapabilities, profile, runtime.browser.pid);
    if (!capabilities || !requestedCapabilities) return null;

    const binaryMaterial = (binary: typeof runtime.browser.executable) => {
      const { device: _device, inode: _inode, modifiedAt: _modifiedAt, ...material } = binary;
      return material;
    };
    const binaryEvidence = (binary: typeof runtime.browser.executable): AttemptBrowserEvidence['browserBinary'] => ({
      path: binary.path, bytes: binary.bytes, sha256: binary.sha256, coverage: binary.coverage,
    });
    const {
      identity: _identity,
      observedAt: _observedAt,
      sessionId: _sessionId,
      browser: _browser,
      driver: _driver,
      ...observed
    } = runtime;
    return {
      browser: {
        ...observed,
        identity: { machineId: identity.machineId },
        browser: { executable: binaryMaterial(runtime.browser.executable) },
        driver: { executable: binaryMaterial(runtime.driver.executable) },
        capabilities,
        requestedCapabilities,
        settings: { ...runtime.settings, args },
        ephemeral: { ...runtime.ephemeral, profilePath: profile === null ? null : '<owned-profile>' },
        machine: {
          machineId: identity.machineId,
          hardwareHash: binding.artifacts.hardwareHash,
          machineHash: binding.artifacts.machineHash,
        },
      },
      browserBinary: binaryEvidence(runtime.browser.executable),
      driverBinary: binaryEvidence(runtime.driver.executable),
      capturedAt: runtime.observedAt,
      workerId: `guest:${identity.machineId}`,
    };
  } catch {
    return null;
  }
}
