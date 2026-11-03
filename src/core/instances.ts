import { z } from 'zod';

export const GuestPlatform = z.enum(['desktop-chrome', 'desktop-safari']);
export type GuestPlatform = z.infer<typeof GuestPlatform>;
export const InstanceState = z.enum(['preparing', 'setup-required', 'ready', 'running', 'stopping', 'stopped', 'unknown', 'error']);
export type InstanceState = z.infer<typeof InstanceState>;
export const NativeMachineState = z.enum(['preparing', 'installing', 'installed', 'starting', 'running', 'stopping', 'stopped', 'unknown', 'error']);
export type NativeMachineState = z.infer<typeof NativeMachineState>;
const ID = z.uuid();
const Epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const InstanceResources = z.strictObject({
  cpuCount: z.number().int().min(2).max(32),
  memoryMiB: z.number().int().min(4096).max(65536),
  diskGiB: z.number().int().min(64).max(512),
});
export type InstanceResources = z.infer<typeof InstanceResources>;

export const InstanceRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('instance.list') }),
  z.strictObject({
    method: z.literal('instance.create'), requestId: ID, profileId: ID,
    name: z.string().trim().min(1).max(80).optional(),
    resources: InstanceResources.optional(),
  }),
  z.strictObject({ method: z.literal('instance.status'), instanceId: ID }),
  z.strictObject({ method: z.literal('instance.start'), instanceId: ID }),
  z.strictObject({ method: z.literal('instance.prepare'), instanceId: ID }),
  z.strictObject({ method: z.literal('instance.stop'), instanceId: ID, cancelActive: z.boolean().default(false), force: z.boolean().default(false) }),
  z.strictObject({ method: z.literal('instance.show'), instanceId: ID }),
  z.strictObject({ method: z.literal('instance.hide'), instanceId: ID }),
]);
export type InstanceRequest = z.infer<typeof InstanceRequestSchema>;
export type InstanceRequestInput = z.input<typeof InstanceRequestSchema>;

export const NativeMachineView = z.strictObject({
  id: ID, name: z.string(), platform: GuestPlatform, state: NativeMachineState,
  progress: z.number().min(0).max(1).nullable(), error: z.string().nullable(),
  cpuCount: z.number().int().positive(), memoryMiB: z.number().int().positive(), diskGiB: z.number().int().positive(),
  windowVisible: z.boolean(), automation: z.boolean(),
});
export type NativeMachineView = z.infer<typeof NativeMachineView>;

export const GuestInstanceView = z.strictObject({
  id: ID, profileId: ID, name: z.string(), platform: GuestPlatform, machineId: ID,
  runtime: z.literal('macos-guest'),
  generation: Epoch, state: InstanceState, nativeState: NativeMachineState,
  progress: z.number().min(0).max(1).nullable(),
  cpuCount: z.number().int().positive(), memoryMiB: z.number().int().positive(), diskGiB: z.number().int().positive(),
  requestedResources: InstanceResources.nullable(),
  osVersion: z.string().nullable(), browserVersion: z.string().nullable(),
  activeSessionId: ID.nullable(), activeRunId: z.string().nullable(), createdAt: z.iso.datetime(), reason: z.string().nullable(),
  hostGlobalInput: z.literal(false), isolation: z.enum(['guest-browser-session', 'guest-desktop']),
  frameAvailable: z.boolean(),
  recordingReady: z.literal(false),
});
export type GuestInstanceView = z.infer<typeof GuestInstanceView>;

export const OwnedChromeInstanceView = z.strictObject({
  id: ID, profileId: ID, name: z.string(), platform: z.literal('desktop-chrome'),
  runtime: z.literal('owned-chrome'), machineId: z.null(), nativeState: z.null(),
  generation: Epoch, state: InstanceState, progress: z.null(),
  cpuCount: z.null(), memoryMiB: z.null(), diskGiB: z.null(), requestedResources: z.null(),
  osVersion: z.string().nullable(), browserVersion: z.string().nullable(),
  activeSessionId: ID.nullable(), activeRunId: z.string().nullable(), createdAt: z.iso.datetime(), reason: z.string().nullable(),
  hostGlobalInput: z.literal(false), isolation: z.literal('owned-browser-context'),
  frameAvailable: z.literal(false), recordingReady: z.literal(false),
});
export type OwnedChromeInstanceView = z.infer<typeof OwnedChromeInstanceView>;
export const InstanceView = z.discriminatedUnion('runtime', [GuestInstanceView, OwnedChromeInstanceView]);
export type InstanceView = z.infer<typeof InstanceView>;

export interface InstanceRuntimeCapability {
  runtime: InstanceView['runtime'];
  platform: GuestPlatform;
  available: boolean;
  readiness: 'adapter-available' | 'prepared' | 'unavailable';
  reason: string | null;
  preparation: 'metadata-only' | 'prepared-worker-required';
  capture: 'page' | 'guest-desktop';
  recordingReady: false;
  hostGlobalInput: false;
}

export interface InstanceHostCapabilities {
  supported: boolean;
  reason: string | null;
  minimumCPUCount: number;
  minimumMemoryMiB: number;
  physicalMemoryMiB: number;
  availableMemoryMiB: number;
  logicalCPUCount: number;
  maximumMachines: number;
}
export interface GuestInstanceList {
  instances: GuestInstanceView[];
  profiles: readonly InstanceProfile[];
  capabilities: InstanceHostCapabilities;
}
export interface InstanceList {
  instances: InstanceView[];
  profiles: readonly InstanceProfile[];
  capabilities: InstanceHostCapabilities | null;
  runtimes: InstanceRuntimeCapability[];
}
export interface InstanceProfile {
  id: string;
  name: string;
  platform: GuestPlatform;
  runtime?: 'owned-chrome' | 'macos-guest';
}

const InstanceProfileSchema = z.strictObject({
  id: z.string().min(1), name: z.string(), platform: GuestPlatform, runtime: z.enum(['owned-chrome', 'macos-guest']).optional(),
}) satisfies z.ZodType<InstanceProfile>;
const InstanceHostCapabilitiesSchema = z.strictObject({
  supported: z.boolean(), reason: z.string().nullable(),
  minimumCPUCount: z.number().int().nonnegative(), minimumMemoryMiB: z.number().int().nonnegative(),
  physicalMemoryMiB: z.number().int().nonnegative(), availableMemoryMiB: z.number().int().nonnegative(),
  logicalCPUCount: z.number().int().nonnegative(), maximumMachines: z.number().int().nonnegative(),
}) satisfies z.ZodType<InstanceHostCapabilities>;
const InstanceRuntimeCapabilitySchema = z.strictObject({
  runtime: z.enum(['owned-chrome', 'macos-guest']), platform: GuestPlatform, available: z.boolean(),
  readiness: z.enum(['adapter-available', 'prepared', 'unavailable']), reason: z.string().nullable(),
  preparation: z.enum(['metadata-only', 'prepared-worker-required']), capture: z.enum(['page', 'guest-desktop']),
  recordingReady: z.literal(false), hostGlobalInput: z.literal(false),
}) satisfies z.ZodType<InstanceRuntimeCapability>;
export const InstanceListSchema = z.strictObject({
  instances: z.array(InstanceView), profiles: z.array(InstanceProfileSchema),
  capabilities: InstanceHostCapabilitiesSchema.nullable(), runtimes: z.array(InstanceRuntimeCapabilitySchema),
}) satisfies z.ZodType<InstanceList>;
export interface GuestControlRequest {
  version: 1;
  id: string;
  epoch: number;
  deadlineAt: number;
  operation: 'webdriver' | 'browser.evidence' | 'route.bind' | 'route.unbind' | 'status' | 'revoke' | 'recording';
  payload: Record<string, unknown>;
}
export type GuestControlReply = {
  version: 1; id: string; ok: true; effect: 'completed'; result: unknown;
} | {
  version: 1; id: string; ok: false; effect: 'not_started' | 'unknown'; error: { code: string; message: string };
};
export interface GuestMachineConnection {
  machineId: string;
  epoch: number;
  guestPid: number;
  osVersion: string;
  connected: boolean;
}
export interface GuestBrowserBinding {
  contextId: string;
  machineId: string;
  generation: number;
  platform: GuestPlatform;
}

export interface GuestMachineBackend {
  probe(): Promise<InstanceHostCapabilities>;
  list(): Promise<NativeMachineView[]>;
  create(id: string, name: string, platform: GuestPlatform, resources: InstanceResources): Promise<NativeMachineView>;
  start(id: string): Promise<NativeMachineView>;
  stop(id: string, force: boolean): Promise<NativeMachineView>;
  show(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  automation(id: string, enabled: boolean): Promise<void>;
  connection(id: string): GuestMachineConnection | null;
  bindBrowser(binding: GuestBrowserBinding): Promise<string>;
  grantRoutes(contextId: string, ports: readonly number[]): Promise<void>;
  verifyBrowser(contextId: string): Promise<{ browserVersion: string; osVersion: string }>;
  revokeBrowser(contextId: string): Promise<void>;
  endpoint(contextId: string, generation: number): string;
  request(machineId: string, request: GuestControlRequest): Promise<GuestControlReply>;
  shutdown(): Promise<void>;
}

export class InstanceExecutionError extends Error {
  readonly code: string;
  readonly effect: 'not_started' | 'unknown';

  constructor(code: string, message: string, effect: 'not_started' | 'unknown' = 'not_started') {
    super(message);
    this.name = 'InstanceExecutionError';
    this.code = code;
    this.effect = effect;
  }
}
