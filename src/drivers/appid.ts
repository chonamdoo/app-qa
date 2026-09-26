// App id validation for every driver entry: ids reach device shells, simctl arguments and `.qa/apps/<appId>` paths.
import type { Platform } from '../core/types.ts';
import { AndroidPackage, IosBundleId } from '../spec/schema.ts';

const APP_ID: Record<Platform, typeof AndroidPackage> = { android: AndroidPackage, ios: IosBundleId };

/** Korean reason why `appId` is not a package (Android) / bundle id (iOS), or null when it is one. */
export function appIdProblem(platform: Platform, appId: string): string | null {
  if (APP_ID[platform].safeParse(appId).success) return null;
  return `${platform === 'android' ? 'Android 패키지' : 'iOS 번들'} ID가 올바르지 않습니다: ${JSON.stringify(appId.slice(0, 120))}`;
}
