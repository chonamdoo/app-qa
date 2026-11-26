import { z } from 'zod';
import { GuestRecoveryIdentitySchema, GuestRecoverySourceSchema, type GuestAttemptBinding, type GuestRecoverySource } from './guest-recovery.ts';

export const GUEST_BROWSER_EPHEMERAL_CAPABILITY_PATHS = [['goog:chromeOptions', 'debuggerAddress'], ['chrome', 'userDataDir'], ['goog:processID']] as const;
const Text = z.string().min(1).max(4096);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Binary = z.strictObject({ path: Text, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: Counter.positive().max(1024 * 1024 * 1024), coverage: z.literal('main-executable-only'), device: Text, inode: Text, modifiedAt: Text });
const Process = z.strictObject({ pid: z.number().int().positive().max(2147483647), executable: Binary });
export const GuestRuntimeRequestSchema = z.strictObject({ source: GuestRecoverySourceSchema, nativeGeneration: z.uuid(), identity: GuestRecoveryIdentitySchema });
export const GuestBrowserRuntimeSchema = z.strictObject({
  schema: z.literal('qautra/guest-browser-runtime/v1'), identity: GuestRecoveryIdentitySchema,
  sessionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), observedAt: z.iso.datetime(),
  platform: z.enum(['desktop-chrome', 'desktop-safari']), browserVersion: Text, browserBuild: Text, driverVersion: Text,
  browser: Process, driver: Process,
  association: z.enum(['owned-chrome-profile', 'exclusive-guest-safari-session']),
  os: z.strictObject({ platform: z.literal('darwin'), release: Text, version: Text, build: Text, arch: z.enum(['arm64', 'x86_64']), languages: z.array(Text).min(1).max(32), timezone: Text }),
  page: z.strictObject({ width: z.number().positive().max(32768), height: z.number().positive().max(32768), dpr: z.number().positive().max(16), language: Text, languages: z.array(Text).min(1).max(32), timezone: Text, userAgent: Text, cookieEnabled: z.boolean(), online: z.boolean() }),
  window: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().max(32768), height: z.number().positive().max(32768) }),
  capabilities: z.record(z.string().max(256), z.json()), requestedCapabilities: z.record(z.string().max(256), z.json()),
  settings: z.strictObject({ args: z.array(Text).max(256), preferenceSource: z.enum(['chrome-profile-file', 'safari-preference-overrides']), preferences: z.record(z.string().max(256), z.json()) }),
  ephemeral: z.strictObject({ sessionId: z.literal('session'), profilePath: Text.nullable(), browserPid: z.literal('process'), driverPid: z.literal('process') }),
});
export const GuestBrowserEvidenceSchema = z.strictObject({ source: GuestRecoverySourceSchema, nativeGeneration: z.uuid(), workerId: Text, runtime: GuestBrowserRuntimeSchema });
export type GuestBrowserEvidence = z.infer<typeof GuestBrowserEvidenceSchema>;
export type GuestBrowserRuntime = z.infer<typeof GuestBrowserRuntimeSchema>;

export function validateGuestBrowserEvidence(value: unknown, binding: GuestAttemptBinding, source: GuestRecoverySource): GuestBrowserEvidence {
  const evidence = GuestBrowserEvidenceSchema.parse(value);
  const actual = evidence.runtime.identity;
  const name = evidence.runtime.platform === 'desktop-safari' ? 'safari' : 'chrome';
  if (Object.entries(binding.identity).some(([key, expected]) => actual[key as keyof typeof actual] !== expected)
    || evidence.runtime.capabilities.browserName !== name || evidence.runtime.capabilities.browserVersion !== evidence.runtime.browserVersion
    || source.id !== binding.identity.recorderId || source.root !== binding.context.root
    || evidence.source.id !== source.id || evidence.source.root !== source.root || evidence.source.bindingSha256 !== source.bindingSha256
    || evidence.nativeGeneration !== binding.native.nativeGeneration || evidence.workerId !== binding.workerId
    || evidence.runtime.platform !== binding.context.target.platform
    || (evidence.runtime.platform === 'desktop-chrome' ? evidence.runtime.association !== 'owned-chrome-profile' || evidence.runtime.ephemeral.profilePath === null : evidence.runtime.association !== 'exclusive-guest-safari-session' || evidence.runtime.ephemeral.profilePath !== null)) {
    throw new Error('guest_runtime_original_attempt_mismatch');
  }
  return evidence;
}
