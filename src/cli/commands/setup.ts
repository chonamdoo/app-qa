// `qa setup` — installs project-local tools (pinned Appium drivers, OCR helper) and checks platform tools. Idempotent.
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { checkAdb, checkXcode, installDrivers, printChecks, type Check } from '../../appium/setup.ts';
import { PATHS } from '../../core/config.ts';
import { ensureDir } from '../../core/fsx.ts';
import { listDevices } from '../../drivers/devices.ts';
import { buildOcrHelper } from '../../ocr/ocr.ts';

const USAGE = `사용법: qa setup
  Appium 드라이버(uiautomator2@8.7.0, xcuitest@12.13.2)를 .tools/appium에 설치하고,
  OCR 도우미(.tools/bin/qa-ocr)를 빌드하고, adb·Xcode·시뮬레이터를 확인합니다. 여러 번 실행해도 안전합니다.
종료 코드: 0 = 준비 완료, 1 = 필수 항목 실패, 2 = 사용법 오류`;

export async function cmdSetup(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } }, strict: true }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
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
  try {
    const devices = await listDevices();
    const booted = devices.filter((d) => d.state === 'booted');
    const sims = devices.filter((d) => d.platform === 'ios');
    printChecks([
      { label: 'Android', ok: true, detail: `${booted.filter((d) => d.platform === 'android').map((d) => `${d.id} (${d.name}, Android ${d.osVersion})`).join(', ') || '부팅된 기기 없음'}` },
      { label: 'iOS 시뮬레이터', ok: true, detail: `${sims.length}개 사용 가능, 부팅됨: ${booted.filter((d) => d.platform === 'ios').map((d) => `${d.name} iOS ${d.osVersion}`).join(', ') || '없음'}` },
    ]);
  } catch (err) {
    printChecks([{ label: '디바이스 목록', ok: false, detail: (err as Error).message }]);
  }

  const ok = drivers.every((c) => c.ok) && ocr.ok && (adb.ok || xcode.ok);
  console.log(ok ? '\n준비 완료. `qa doctor`로 전체 상태를 확인할 수 있습니다.' : '\n필수 항목이 실패했습니다. 위 안내를 따라 수정한 뒤 다시 실행하세요.');
  return ok ? 0 : 1;
}
