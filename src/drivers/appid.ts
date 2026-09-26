// Target validation for every driver entry: app ids reach device shells, simctl arguments and `.qa/apps/<appId>` paths;
// web URLs reach `am start -d` / `simctl openurl` and evidence.
import { PLATFORM_INFO } from '../core/platform.ts';
import type { AppTarget, Platform, WebTarget } from '../core/types.ts';
import { AndroidPackage, IosBundleId } from '../spec/schema.ts';

/** Installed-app id shape per platform; desktop hosts run browsers only and have no app ids. */
const APP_ID: Record<Platform, { schema: typeof AndroidPackage; label: string } | null> = {
  android: { schema: AndroidPackage, label: 'Android 패키지' },
  ios: { schema: IosBundleId, label: 'iOS 번들' },
  'desktop-chrome': null,
  'desktop-safari': null,
};

const quoted = (s: string) => JSON.stringify(s.slice(0, 120));

/** Korean reason why `appId` is not an installed-app id (Android package / iOS bundle id) on the platform, or null when it is one. */
export function appIdProblem(platform: Platform, appId: string): string | null {
  const rule = APP_ID[platform];
  if (!rule) return `${PLATFORM_INFO[platform].label}에는 설치 앱이 없어 앱 ID를 쓸 수 없습니다 (웹 대상만 실행): ${quoted(appId)}`;
  return rule.schema.safeParse(appId).success ? null : `${rule.label} ID가 올바르지 않습니다: ${quoted(appId)}`;
}

/**
 * Korean reason why `url` cannot be opened in a browser (absolute http(s) with a host, no `user:password@`), or null.
 * A URL with credentials is never echoed back.
 */
export function webUrlProblem(url: string): string | null {
  if (!URL.canParse(url)) return `웹 주소가 올바르지 않습니다: ${quoted(url)}`;
  const u = new URL(url);
  if (u.username !== '' || u.password !== '') return '웹 주소에 계정 정보(user:password@)를 넣을 수 없습니다';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `http(s) 주소만 열 수 있습니다: ${quoted(url)}`;
  return u.hostname ? null : `웹 주소에 호스트가 없습니다: ${quoted(url)}`;
}

/** Korean reason why a driver-initiated navigation to `url` is refused for the web target (bad URL, or its origin is not one of the declared origins — default: the start URL's), or null. */
export function navigationProblem(target: WebTarget, url: string): string | null {
  const bad = webUrlProblem(url);
  if (bad) return bad;
  const origin = new URL(url).origin;
  const allowed = target.origins.length > 0 ? target.origins : [new URL(target.url).origin];
  return allowed.includes(origin) ? null : `허용된 origin(${allowed.join(', ')}) 밖의 주소는 열지 않습니다: ${origin}`;
}

/**
 * Korean reason why a driver for `platform` must refuse `target`, or null. The target must be for this platform and of a
 * kind it runs (`PLATFORM_INFO.surfaces`); apps need a valid installed-app id; web targets run in the platform's own
 * browser (`PLATFORM_INFO.browser`) from an http(s) start URL inside exact `scheme://host[:port]` origins.
 */
export function targetProblem(platform: Platform, target: AppTarget): string | null {
  const info = PLATFORM_INFO[platform];
  if (target.platform !== platform) return `${info.label} 드라이버는 ${PLATFORM_INFO[target.platform]?.label ?? quoted(String(target.platform))} 대상을 실행할 수 없습니다`;
  if (!info.surfaces.includes(target.kind)) return `${info.label}에서는 ${target.kind === 'web' ? '웹' : '앱'} 대상을 실행할 수 없습니다`;
  switch (target.kind) {
    case 'app':
      return appIdProblem(platform, target.appId);
    case 'web': {
      if (target.appId !== info.browser) return `브라우저 ID가 올바르지 않습니다: ${quoted(target.appId)} (${info.webLabel}는 ${info.browser})`;
      for (const origin of target.origins) {
        if (webUrlProblem(origin) || new URL(origin).origin !== origin) return `허용 origin은 scheme://host[:port] 형식이어야 합니다: ${quoted(origin)}`;
      }
      return navigationProblem(target, target.url);
    }
  }
}
