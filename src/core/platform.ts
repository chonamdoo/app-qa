// Static facts per platform. Every platform list, label and host lookup derives from this table.
import type { Platform, Surface } from './types.ts';

export interface PlatformInfo {
  /** Machine that runs the target: a device (adb / simctl) or this Mac's desktop browser. */
  host: 'android' | 'ios' | 'desktop';
  label: string;
  /** Profile kinds this platform can run. */
  surfaces: readonly Surface[];
  /** Browser app that shows web profiles here. */
  browser: string;
  /** Label for web profiles (the browser that actually runs). */
  webLabel: string;
}

export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  android: { host: 'android', label: 'Android', surfaces: ['app', 'web'], browser: 'com.android.chrome', webLabel: 'Android Chrome' },
  ios: { host: 'ios', label: 'iOS', surfaces: ['app', 'web'], browser: 'com.apple.mobilesafari', webLabel: 'iOS Safari' },
  'desktop-chrome': { host: 'desktop', label: 'Chrome (macOS)', surfaces: ['web'], browser: 'chrome', webLabel: 'Chrome (macOS)' },
  'desktop-safari': { host: 'desktop', label: 'Safari (macOS)', surfaces: ['web'], browser: 'safari', webLabel: 'Safari (macOS)' },
};

/** Every platform, in display order. */
export const PLATFORMS = ['android', 'ios', 'desktop-chrome', 'desktop-safari'] as const satisfies readonly Platform[];

/** Platforms that can run a profile of this kind, in display order. */
export function platformsFor(surface: Surface): Platform[] {
  return PLATFORMS.filter((p) => PLATFORM_INFO[p].surfaces.includes(surface));
}
