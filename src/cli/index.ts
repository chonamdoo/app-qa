// `qa` command dispatcher. Each command module is imported lazily (dynamic import on purpose): command slices are owned by
// different modules, a missing or broken one must not break the others, and startup stays fast.
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../core/config.ts';

interface CommandInfo {
  /** Module path relative to this file. */
  module: string;
  fn: string;
  summary: string;
  usage: string;
}

const COMMANDS: Record<string, CommandInfo> = {
  setup: { module: './commands/setup.ts', fn: 'cmdSetup', summary: '도구 설치 (Appium 드라이버, OCR 도우미)', usage: 'qa setup' },
  doctor: { module: './commands/doctor.ts', fn: 'cmdDoctor', summary: '환경 점검 (adb, Xcode, Appium, Jev 키)', usage: 'qa doctor' },
  devices: { module: './commands/devices.ts', fn: 'cmdDevices', summary: '디바이스·시뮬레이터 목록', usage: 'qa devices [--platform android|ios] [--all]' },
  apps: { module: './commands/apps.ts', fn: 'cmdApps', summary: '설치된 앱 목록·백업', usage: 'qa apps [--platform android|ios] [--device <id>] [--backup <appId>]' },
  calibrate: { module: './commands/calibrate.ts', fn: 'cmdCalibrate', summary: 'Jev 판단 임계값 보정', usage: 'qa calibrate [--mode live|record|replay] [--golden <dir>]' },
  plan: { module: './commands/plan.ts', fn: 'cmdPlan', summary: '문서 → 테스트 생성 (요구사항 추적)', usage: 'qa plan --app <id> [문서...] [--run]' },
  run: {
    module: './commands/run.ts',
    fn: 'cmdRun',
    summary: '테스트 실행 → 판정·리포트',
    usage: 'qa run [경로...] [--platform android|ios|all] [--device <id>] [--tag <t>] [--junit]',
  },
  smoke: { module: './commands/smoke.ts', fn: 'cmdSmoke', summary: '스모크 (실행·상태·빈 화면·스크린샷)', usage: 'qa smoke --app <id> --platform android|ios|all [--crawl tabs]' },
  inspect: { module: './commands/inspect.ts', fn: 'cmdInspect', summary: '현재 화면 후보 표 (가림·fast path·위험)', usage: 'qa inspect --app <id> --platform android|ios' },
  capture: { module: './commands/capture.ts', fn: 'cmdCapture', summary: '현재 화면을 fixture + 인벤토리로 저장', usage: 'qa capture --app <id> --platform android|ios --name <이름>' },
  report: { module: './commands/report.ts', fn: 'cmdReport', summary: '실행 리포트 다시 생성', usage: 'qa report <실행ID|latest>' },
  serve: { module: './commands/serve.ts', fn: 'cmdServe', summary: 'macOS 앱용 엔진 서버 (127.0.0.1)', usage: 'qa serve [--port <n>] [--exit-with-stdin]' },
};

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length)) + 2;
  return [
    'app-qa — 문서 → 테스트 → 실기기 실행 → 판정 → 추적 리포트',
    '',
    '사용법: qa <명령> [옵션]   (명령별 도움말: qa <명령> --help)',
    '',
    '명령:',
    ...Object.entries(COMMANDS).flatMap(([name, c]) => [`  ${name.padEnd(width)}${c.summary}`, `  ${' '.repeat(width)}${c.usage}`]),
    '',
    '종료 코드: 0 = 성공, 1 = 테스트 실패·판정 불가·오류, 2 = 사용법·환경 오류',
  ].join('\n');
}

/** Runs `argv` (without `node bin/qa.ts`) and returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(helpText());
    return 0;
  }
  const info = COMMANDS[name];
  if (!info) {
    console.error(`알 수 없는 명령: ${name}\n\n${helpText()}`);
    return 2;
  }
  const file = fileURLToPath(new URL(info.module, import.meta.url));
  const shown = relative(PATHS.root, file);
  if (!existsSync(file)) {
    console.error(`'qa ${name}' 명령을 사용할 수 없습니다: 모듈 ${shown}이(가) 아직 없습니다.`);
    return 2;
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(info.module)) as Record<string, unknown>;
  } catch (err) {
    console.error(`'qa ${name}' 명령 모듈(${shown})을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const fn = mod[info.fn];
  if (typeof fn !== 'function') {
    console.error(`'qa ${name}' 명령 모듈(${shown})에 ${info.fn} 함수가 없습니다.`);
    return 2;
  }
  return (fn as (args: string[]) => Promise<number>)([...rest]);
}
