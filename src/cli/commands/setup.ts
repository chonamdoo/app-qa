// `qa setup` — installs project-local tools (pinned Appium drivers, OCR helper) and checks platform tools. Idempotent.
// `--browsers` also prepares web testing: desktop Chrome/Safari checks, Android Chrome prep, iOS Safari checks.
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { checkAdb, checkXcode, installDrivers, PINNED_DRIVERS, printChecks, type Check } from '../../appium/setup.ts';
import { PATHS } from '../../core/config.ts';
import { ensureDir } from '../../core/fsx.ts';
import type { DeviceInfo } from '../../core/types.ts';
import { desktopBrowserChecks, iosSafariChecks, listDevices, prepareAndroidChrome } from '../../drivers/index.ts';
import { buildOcrHelper } from '../../ocr/ocr.ts';
import { browserReadiness } from '../browsers.ts';

const USAGE = `사용법: qa setup [--browsers [--android <serial>] [--ios <udid>]]
  Appium 드라이버(${Object.entries(PINNED_DRIVERS)
    .map(([name, { version }]) => `${name}@${version}`)
    .join(', ')})를 .tools/appium에 설치하고,
  OCR 도우미(.tools/bin/qa-ocr)를 빌드하고, adb·Xcode·시뮬레이터를 확인합니다. 여러 번 실행해도 안전합니다.
  --browsers: 웹 테스트 준비도 합니다 — 데스크톱 Chrome/Safari 점검, Android Chrome 준비(첫 실행 화면 건너뛰기
              명령줄 플래그·알림 권한: 에뮬레이터 설정을 바꿉니다), iOS 시뮬레이터 Safari 확인.
              Safari(macOS)의 "원격 자동화 허용"은 sudo가 필요해 직접 켜야 합니다: sudo safaridriver --enable
  --android <serial>, --ios <udid>: 준비할 기기 (없으면 부팅된 기기 전부, 부팅된 기기가 없으면 건너뜀)
종료 코드: 0 = 준비 완료, 1 = 필수 항목 실패, 2 = 사용법 오류`;

export async function cmdSetup(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { browsers: { type: 'boolean', default: false }, android: { type: 'string' }, ios: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
  if (!values.browsers && (values.android !== undefined || values.ios !== undefined)) {
    console.error(`--android/--ios는 --browsers와 함께 씁니다.\n${USAGE}`);
    return 2;
  }
  for (const dir of [PATHS.tools, PATHS.appiumHome, PATHS.bin, PATHS.state, PATHS.logs, PATHS.locks, PATHS.appBackups]) ensureDir(dir);
  const log = (line: string) => console.log(`  … ${line}`);

  console.log('Appium 드라이버');
  const drivers = await installDrivers(log);
  printChecks(drivers);

  console.log('OCR 도우미');
  let ocr: Check;
  try {
    const bin = await buildOcrHelper();
    ocr = { label: 'qa-ocr', ok: true, detail: relative(PATHS.root, bin) };
  } catch (err) {
    ocr = { label: 'qa-ocr', ok: false, detail: (err as Error).message.slice(0, 300), hint: 'Xcode 명령줄 도구(swiftc) 설치 확인' };
  }
  printChecks([ocr]);

  console.log('플랫폼 도구');
  const [adb, xcode] = await Promise.all([checkAdb(), checkXcode()]);
  printChecks([adb, xcode]);

  console.log('디바이스');
  let devices: DeviceInfo[] | null = null;
  try {
    devices = await listDevices();
    const booted = devices.filter((d) => d.state === 'booted');
    const sims = devices.filter((d) => d.platform === 'ios');
    printChecks([
      { label: 'Android', ok: true, detail: `${booted.filter((d) => d.platform === 'android').map((d) => `${d.id} (${d.name}, Android ${d.osVersion})`).join(', ') || '부팅된 기기 없음'}` },
      { label: 'iOS 시뮬레이터', ok: true, detail: `${sims.length}개 사용 가능, 부팅됨: ${booted.filter((d) => d.platform === 'ios').map((d) => `${d.name} iOS ${d.osVersion}`).join(', ') || '없음'}` },
    ]);
  } catch (err) {
    printChecks([{ label: '디바이스 목록', ok: false, detail: (err as Error).message }]);
  }

  let browsersOk = true;
  if (values.browsers) {
    console.log('브라우저 (웹 테스트)');
    if (devices === null) {
      browsersOk = false;
      printChecks([{ label: '모바일 브라우저', ok: false, detail: '디바이스 목록을 가져오지 못해 Android Chrome·iOS Safari를 준비하지 못했습니다' }]);
    }
    const groups = await browserReadiness(
      devices ?? [],
      { android: values.android, ios: values.ios },
      { desktop: desktopBrowserChecks, mobile: { android: prepareAndroidChrome, ios: iosSafariChecks } },
    );
    for (const group of groups) {
      console.log(`  ${group.title}`);
      browsersOk = printChecks(group.checks, (line) => console.log(`  ${line}`)) && browsersOk;
    }
  }

  const ok = drivers.every((c) => c.ok) && ocr.ok && (adb.ok || xcode.ok) && browsersOk;
  console.log(ok ? '\n준비 완료. `qa doctor`로 전체 상태를 확인할 수 있습니다.' : '\n필수 항목이 실패했습니다. 위 안내를 따라 수정한 뒤 다시 실행하세요.');
  return ok ? 0 : 1;
}
