// `qa apps` — user-installed apps per booted device; `--backup <appId>` copies the installed binary to .qa/apps.
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from '../../core/config.ts';
import { PLATFORM_INFO, platformsFor } from '../../core/platform.ts';
import type { Platform } from '../../core/types.ts';
import { backupApp, listApps, pickDevice } from '../../drivers/index.ts';
import { parsePlatform } from '../platforms.ts';

const APP_PLATFORMS = platformsFor('app');

const USAGE = `사용법: qa apps [--platform ${APP_PLATFORMS.join('|')}] [--device <id>] [--json] [--backup <appId>]
  --backup <appId>   설치된 앱 바이너리를 .qa/apps/<appId>/<sha256>.{apk|apks|app}로 복사 (앱은 건드리지 않음).
                     iOS clear 초기화와 reinstall 초기화에 필요합니다.
  데스크톱 브라우저에는 설치 앱이 없어 지원하지 않습니다.
종료 코드: 0 = 성공, 1 = 실패, 2 = 사용법 오류`;

export async function cmdApps(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        platform: { type: 'string' },
        device: { type: 'string' },
        json: { type: 'boolean' },
        backup: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const chosen = values.platform === undefined ? undefined : parsePlatform(values.platform, false);
  if (typeof chosen === 'object') {
    console.error(`${chosen.error}\n${USAGE}`);
    return 2;
  }
  if (chosen !== undefined && !APP_PLATFORMS.includes(chosen)) {
    console.error(`qa apps는 ${APP_PLATFORMS.join(', ')}만 지원합니다: ${PLATFORM_INFO[chosen].label}에는 설치 앱 목록이 없습니다.\n${USAGE}`);
    return 2;
  }
  if (values.device && !chosen) {
    console.error(`--device에는 --platform이 필요합니다.\n${USAGE}`);
    return 2;
  }
  const platforms: Platform[] = chosen ? [chosen] : APP_PLATFORMS;
  const explicit = chosen !== undefined;
  let failed = false;
  const results: { platform: Platform; deviceId: string; apps: unknown }[] = [];
  for (const platform of platforms) {
    let device;
    try {
      device = await pickDevice(platform, values.device);
    } catch (err) {
      // Without --platform, a platform with no booted device is simply skipped.
      if (explicit) {
        console.error((err as Error).message);
        failed = true;
      } else if (!values.json) console.log(`[${platform}] ${(err as Error).message}`);
      continue;
    }
    try {
      if (values.backup) {
        const b = await backupApp(platform, device.id, values.backup);
        results.push({ platform, deviceId: device.id, apps: b });
        if (!values.json) {
          console.log(`[${platform}] ${b.appId} 백업 ${b.reused ? '(동일 백업 존재)' : '완료'}: ${relative(PATHS.root, b.path)} — ${(b.bytes / 1024 / 1024).toFixed(1)} MB, 파일 ${b.files}개`);
        }
        continue;
      }
      const apps = await listApps(platform, device.id);
      results.push({ platform, deviceId: device.id, apps });
      if (!values.json) {
        console.log(`[${platform}] ${device.name} (${device.id})`);
        for (const a of apps) console.log(`  ${a.appId.padEnd(40)} ${a.label ?? '-'}${a.version ? `  v${a.version}` : ''}`);
        if (apps.length === 0) console.log('  (사용자 설치 앱 없음)');
      }
    } catch (err) {
      console.error(`[${platform}] ${(err as Error).message}`);
      failed = true;
    }
  }
  if (values.json) console.log(JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}
