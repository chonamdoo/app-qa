// `qa doctor` — Korean readiness checklist. Never prints secrets.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { AppiumClient } from '../../appium/client.ts';
import { appiumPort } from '../../appium/server.ts';
import { checkAdb, checkXcode, installedDriverVersions, PINNED_DRIVERS, printChecks, type Check } from '../../appium/setup.ts';
import { loadEnv, PATHS } from '../../core/config.ts';
import { PLATFORM_INFO } from '../../core/platform.ts';
import type { DeviceInfo } from '../../core/types.ts';
import { androidChromeChecks, desktopBrowserChecks, iosSafariChecks, listDevices } from '../../drivers/index.ts';
import { JEV_MODEL, loadCalibration, loadJevConfig, QUESTION_VERSION } from '../../jev/index.ts';
import { listAppProfiles } from '../../server/store.ts';
import { browserReadiness } from '../browsers.ts';

const USAGE = `사용법: qa doctor
  Node·의존성·Appium 드라이버·OCR 도우미·adb·Xcode·디바이스·Jev 키·보정 기록과 웹 브라우저(데스크톱 Chrome/Safari,
  Android Chrome, iOS Safari) 준비 상태를 점검합니다. 읽기만 하며 기기 설정은 바꾸지 않습니다 (준비: qa setup --browsers).
  웹 항목은 apps/에 웹 프로필이 있을 때만 종료 코드에 반영됩니다.
종료 코드: 0 = 모두 정상, 1 = 하나 이상 실패, 2 = 사용법 오류`;

function nodeCheck(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return { label: 'Node.js', ok: major >= 24, detail: process.versions.node, hint: 'Node 24 이상을 설치하세요' };
}

function depsCheck(): Check {
  const pkg = JSON.parse(readFileSync(join(PATHS.root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const wanted = { ...pkg.dependencies, ...pkg.devDependencies };
  const bad: string[] = [];
  for (const [name, version] of Object.entries(wanted)) {
    try {
      const got = (JSON.parse(readFileSync(join(PATHS.root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
      if (got !== version) bad.push(`${name} ${got}≠${version}`);
    } catch {
      bad.push(`${name} 없음`);
    }
  }
  return { label: 'npm 의존성', ok: bad.length === 0, detail: bad.length ? bad.join(', ') : `${Object.keys(wanted).length}개 고정 버전 일치`, hint: '`npm ci` 실행' };
}

function driversCheck(): Check {
  const installed = installedDriverVersions();
  const parts = Object.entries(PINNED_DRIVERS).map(([name, { version }]) => ({ name, version, got: installed[name] ?? null }));
  const ok = parts.every((p) => p.got === p.version);
  return {
    label: 'Appium 드라이버',
    ok,
    detail: parts.map((p) => `${p.name} ${p.got ?? '없음'}${p.got === p.version ? '' : ` (필요: ${p.version})`}`).join(', '),
    hint: '`qa setup` 실행',
  };
}

function ocrCheck(): Check {
  const bin = join(PATHS.bin, 'qa-ocr');
  try {
    accessSync(bin, constants.X_OK);
    return { label: 'OCR 도우미', ok: true, detail: relative(PATHS.root, bin) };
  } catch {
    return { label: 'OCR 도우미', ok: false, detail: existsSync(bin) ? '실행 권한 없음' : '없음', hint: '`qa setup` 실행' };
  }
}

function devicesCheck(devices: DeviceInfo[] | Error): Check {
  if (devices instanceof Error) return { label: '디바이스', ok: false, detail: devices.message };
  const booted = devices.filter((d) => d.state === 'booted');
  const mobile = booted.filter((d) => PLATFORM_INFO[d.platform].host !== 'desktop');
  return {
    label: '디바이스',
    ok: booted.length > 0,
    detail: mobile.length
      ? mobile.map((d) => `${d.platform} ${d.name} (${d.id})`).join(', ')
      : `부팅된 에뮬레이터/시뮬레이터 없음${booted.length ? ' (데스크톱 브라우저만 사용 가능)' : ''}`,
    hint: 'Android 에뮬레이터 또는 iOS 시뮬레이터를 부팅하세요',
  };
}

function jevChecks(): Check[] {
  let model = JEV_MODEL;
  let key: Check;
  try {
    const config = loadJevConfig(process.env, { mode: 'live' });
    model = config.model;
    key = { label: 'Jev API 키', ok: config.apiKey !== null, detail: `설정됨 (값은 표시하지 않음), 모델 ${config.model}` };
  } catch (err) {
    key = { label: 'Jev API 키', ok: false, detail: (err as Error).message, hint: '.env에 TYPESAFE_API_KEY 또는 TYPESAFE_API_KEY_FILE(권한 0600) 설정' };
  }
  let calib: Check;
  try {
    const record = loadCalibration(model, QUESTION_VERSION);
    calib = !record
      ? { label: '보정 기록', ok: false, detail: `calibration/${model}/${QUESTION_VERSION}.json 없음 — Jev 판단은 uncalibrated 오류가 됩니다`, hint: '`qa calibrate` 실행' }
      : { label: '보정 기록', ok: record.status === 'calibrated', detail: `${model}/${QUESTION_VERSION} 상태: ${record.status}`, hint: '골든셋 확인 후 `qa calibrate` 재실행' };
  } catch (err) {
    calib = { label: '보정 기록', ok: false, detail: (err as Error).message, hint: '`qa calibrate` 재실행' };
  }
  return [key, calib];
}

async function appiumServerCheck(): Promise<Check> {
  const port = appiumPort();
  try {
    const s = await new AppiumClient(`http://127.0.0.1:${port}`).status(1500);
    return { label: 'Appium 서버', ok: true, detail: `포트 ${port} 실행 중 (${s.build?.version ?? '버전 미상'})` };
  } catch {
    return { label: 'Appium 서버', ok: true, detail: `포트 ${port} 꺼져 있음 (실행 시 자동 시작)` };
  }
}

export async function cmdDoctor(argv: string[]): Promise<number> {
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
  loadEnv();
  const [adb, xcode, devices, server, profiles] = await Promise.all([
    checkAdb(),
    checkXcode(),
    listDevices().catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
    appiumServerCheck(),
    listAppProfiles(PATHS.apps),
  ]);
  const checks = [nodeCheck(), depsCheck(), driversCheck(), ocrCheck(), adb, xcode, devicesCheck(devices), ...jevChecks(), server];
  console.log('qa doctor');
  const coreOk = printChecks(checks);

  const webRequired = profiles.profiles.some((p) => p.web !== undefined);
  console.log(`\n웹 (브라우저)${webRequired ? '' : ' — apps/에 웹 프로필이 없어 참고용'}`);
  const groups = await browserReadiness(devices instanceof Error ? [] : devices, {}, {
    desktop: desktopBrowserChecks,
    mobile: { android: androidChromeChecks, ios: iosSafariChecks },
  });
  let webOk = true;
  for (const group of groups) {
    console.log(`  ${group.title}`);
    webOk = printChecks(group.checks, (line) => console.log(`  ${line}`)) && webOk;
  }

  const ok = coreOk && (webOk || !webRequired);
  console.log(ok ? (webOk ? '\n모든 항목 정상.' : '\n필수 항목 정상 (웹 항목은 웹 테스트 전에 `qa setup --browsers`로 준비하세요).') : '\n실패한 항목을 위 안내에 따라 수정하세요.');
  return ok ? 0 : 1;
}
