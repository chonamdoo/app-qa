// `--platform` / `--device` arguments shared by the commands. Every choice derives from `core/platform.ts`.
import { PLATFORMS } from '../core/platform.ts';
import type { Platform } from '../core/types.ts';

export type PlatformChoice = Platform | 'all';

/** Usage text for a single-platform option: `android|ios|desktop-chrome|desktop-safari`. */
export const PLATFORM_LIST = PLATFORMS.join('|');
/** Usage text for an option that also takes `all` (= every platform of the app profile). */
export const PLATFORM_CHOICE_LIST = `${PLATFORM_LIST}|all`;

/** Null prototype: user input such as `toString` or `__proto__` must not hit an inherited property. */
const CHOICES: Record<string, PlatformChoice | undefined> = Object.assign(
  Object.create(null) as Record<string, PlatformChoice>,
  Object.fromEntries([...PLATFORMS, 'all' as const].map((p) => [p, p] as const)),
);

/** A `--platform` value: a platform, `all` when `allowAll`, otherwise a Korean usage error. */
export function parsePlatform(value: string, allowAll: false): Platform | { error: string };
export function parsePlatform(value: string, allowAll: true): PlatformChoice | { error: string };
export function parsePlatform(value: string, allowAll: boolean): PlatformChoice | { error: string } {
  const choice = CHOICES[value];
  if (choice !== undefined && (allowAll || choice !== 'all')) return choice;
  return { error: `--platform은 ${allowAll ? PLATFORM_CHOICE_LIST : PLATFORM_LIST} 중 하나여야 합니다 (현재: ${value})` };
}

/**
 * `--device` values → per-platform ids, or a Korean usage error. `<platform>:<id>` names the platform (the id may
 * itself contain `:`, e.g. `android:192.168.0.2:5555`); a bare id belongs to the single `--platform`.
 */
export function parseDevices(values: readonly string[], platform: PlatformChoice): Partial<Record<Platform, string>> | { error: string } {
  const out: Partial<Record<Platform, string>> = {};
  for (const v of values) {
    const colon = v.indexOf(':');
    const named = colon > 0 ? CHOICES[v.slice(0, colon)] : undefined;
    if (named !== undefined && named !== 'all') {
      const id = v.slice(colon + 1);
      if (!id) return { error: `--device ${v}: 기기 ID가 비어 있습니다` };
      if (platform !== 'all' && named !== platform) return { error: `--device ${v}는 --platform ${platform}와 맞지 않습니다` };
      out[named] = id;
    } else if (platform === 'all') {
      return { error: `--platform all에서는 --device <플랫폼>:<id> 형식을 쓰세요 (플랫폼: ${PLATFORMS.join(', ')}): ${v}` };
    } else {
      out[platform] = v;
    }
  }
  return out;
}
