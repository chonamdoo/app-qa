# QAutra

QAutra는 Android/iOS 앱과 웹사이트(데스크톱 Chrome·Safari, Android Chrome, iOS Safari)를 같은 테스트 DSL로 자동 검증한다. 기획서·QA 문서에서 테스트를 만들고, 실기기·실브라우저에서 실행하고, 판정과 요구사항 추적 리포트를 남긴다. 판정은 결정적 검사나 보정된 Jev 게이트로만 PASS가 되고, 불확실하면 ERROR·INCONCLUSIVE로 남는다.

설계와 불변식: [`skills/architecture/SKILL.md`](skills/architecture/SKILL.md), [`skills/architecture/references/design.md`](skills/architecture/references/design.md).

다음 개발 에픽(계획): [기존 AI 기반 격리 웹·모바일 QA와 Mac 앱](docs/plans/2026-10-28-isolated-agent-qa-epic.md) · [GitHub #2](https://github.com/chonamdoo/app-qa/issues/2). 기존 Claude/Codex의 직접 제어, VM·다중 기기 프로필, replay와 판정 체계의 확장 계획이며 현재 구현 완료를 뜻하지 않는다.

에픽 구현·공개 전 기준: [B01 제품·권한·외부 재사용 계약](docs/plans/isolated-agent-qa-b01-contract.md). 현재 동작과 목표 기능, 고객 데이터 전송 조건, 권리 확인 전 배포 제한을 구분한다.

제품명은 **QAutra**, package명은 `qautra`로 확정했다. 저장소 주소와 이름 확정 전 에픽·B01 기록의 `app-qa` 표기는 유지한다. 이름 확정은 상표·도메인 확보나 배포 권리 확인을 뜻하지 않으며 `private: true`와 공개 전 권리 검토는 유지한다.

## 준비

Node 24가 필요하다. 모바일은 Xcode(iOS 시뮬레이터)·Android SDK(에뮬레이터), 데스크톱 guest는 Virtualization.framework를 지원하는 Apple Silicon Mac이 필요하다. 도구는 프로젝트 안(`.tools/`)에 설치한다.

```sh
npm ci
cp .env.example .env          # 필요한 모델·Android SDK 설정; 직접 SDK 실행에는 별도 모델 키 불필요
node bin/qa.ts setup          # 모바일 Appium 드라이버 고정 버전 + OCR 도우미
node bin/qa.ts setup --browsers   # 모바일 브라우저 준비 + 실제 guest 상태 조회; 호스트 Safari 설정 변경 없음
node bin/qa.ts doctor         # 준비 상태 조회; 모델·보정 상태는 직접 실행과 구분
```

### 실제 guest 브라우저

데스크톱 Chrome·Safari는 QAutra가 소유한 macOS guest 안에서만 실행한다. 호스트 브라우저나 WKWebView로 대체하지 않는다. 호스트 Safari의 원격 자동화·Accessibility·화면 녹화 권한을 요구하지 않는다.

1. `bash scripts/build-mac.sh`로 native helper와 guest agent를 포함한 앱을 빌드한다.
2. Mac 앱의 **환경 및 기기**에서 웹 프로필과 **인스턴스 생성**을 구분한다. 프로필 등록은 VM 생성이나 준비 완료가 아니다. Apple 복원 이미지는 별도로 내려받으며 라이선스가 적용된다.
3. **VM 시작** 후 **guest 설정 안내**를 읽는다. Apple 라이선스·계정 생성, Safari 원격 자동화와 agent 설치는 실제 guest 안에서 직접 완료한다. [guest 준비 안내](src/drivers/vm/guest/GuestSetup.txt)의 명령을 호스트 Terminal에서 실행하면 안 된다.
4. **준비 확인**은 실제 guest W3C 세션이 성공한 뒤에만 브라우저 버전을 확인한다. OS 설치·부팅·agent 연결만으로 준비 완료나 업무 PASS를 기록하지 않는다.

기본 VM 자원은 CPU 2개·메모리 4096 MiB·디스크 64 GiB다. Apple 복원 이미지의 최소 조건과 호스트 자원을 검사한다. 현재 물리 VM 상한은 2개다. Safari는 VM당 context 1개, Chrome은 같은 프로필의 호환 VM에서 독립 ChromeDriver·저장소를 가진 context를 최대 8개 사용한다. 같은 VM에서 준비·실행 중인 context는 승인된 localhost 포트 범위가 같아야 한다. 다른 범위는 별도 프로필·VM이 필요하다.

guest 창을 숨겨도 QA는 계속된다. QA 중 표시한 설정 창은 입력·활성화를 받지 않는다. 종료나 동작이 미확인이면 소유권을 격리하고 변경을 자동 재전송하지 않는다. 호스트의 남은 창을 닫거나 `setup --browsers`로 상태를 지우는 복구 경로는 없다.

비정상 종료 후 **결과 미확인 · 재사용 금지**라면 인스턴스의 **열기 → 기존 VM 복구**에서 중지 확인을 요청한다. 실행 중인 VM이 있다면 같은 VM의 모든 context를 강제 종료하므로 저장하지 않은 guest 작업을 잃을 수 있다. 실행기만 사라진 경우에는 소유권·디스크 잠금과 원래 파일의 identity를 확인하고 `stopped`를 저장해야 복구된다. 확인 실패 시 `unknown`을 유지하며, 기존 디스크를 삭제하거나 새 VM을 만들지 않는다. 복구 후 **VM 시작**과 guest 설정·브라우저 준비는 별도로 진행한다.

중지가 확인된 VM에서 runtime 버전이 달라졌다면 새 guest kit를 완성한 뒤 교체하고 이전 kit를 비공유 백업으로 보존한다. 원래 VM 디스크·하드웨어·계정은 유지하며, 변경 전의 불확실한 실행 기록을 성공으로 바꾸지 않는다.


## 대상 프로필 (`apps/<id>.yaml`)

앱과 웹사이트 중 하나만 적는다.

```yaml
# 앱
id: tteonam
name: 떠남
android: { package: kr.tteonam.app, activity: .MainActivity }
ios: { bundleId: kr.tteonam.app }
```

```yaml
# 웹사이트
id: web-demo
name: QA 데모 상점 (웹)
web:
  url: http://localhost:4173/
  origins: [http://localhost:4173]     # 생략하면 url의 origin
  viewport: { width: 1280, height: 800 }  # 데스크톱 브라우저만
  # platforms: [desktop-chrome, android]  # 생략하면 네 가지 전부
```

웹 프로필의 `android`는 에뮬레이터의 Chrome, `ios`는 시뮬레이터의 Safari다. localhost 주소는 Android에서 `adb reverse`로 자동 연결되고(이 도구가 만든 매핑만 지운다), iOS 시뮬레이터는 Mac의 localhost를 그대로 쓴다.

데스크톱 localhost는 신뢰된 앱 프로필에서 승인한 포트만 guest loopback으로 전달한다. 호스트 home·프로젝트 디렉터리를 guest에 공유하거나 개발 서버를 `0.0.0.0`으로 다시 띄우지 않는다.

## 테스트 작성 (`tests/**/*.e2e.yaml`)

```yaml
id: web-demo-search
name: 상품을 검색하면 일치하는 상품만 남는다
app: web-demo
steps:
  - see: 검색
  - type: 사과
    into: 상품 검색
  - hideKeyboard: true
  - tap: 검색
    expect:
      text: 상품 1개
  - assertNoText: 바나나
```

- 대상은 사람이 보는 문구로 적는다. 같은 문구가 여럿이면 `nth`·`near`·`within`·`state`로 좁힌다.
- 위험해 보이는 동작(삭제·결제·보내기…)과 Jev commit 확인이 "외부 변경"이라고 본 동작은 막힌다. 사람이 확인한 동작만 `allowRisky: true`로 연다.
- 비밀값은 `${NAME}`으로 적고 `.env`에 둔다. 입력한 값은 기록에 남지 않는다.

예제 사이트로 바로 해 볼 수 있다: `node scripts/serve-static.ts examples/web-demo 4173` 후 아래 실행.

## 문서 → 테스트

```sh
node bin/qa.ts plan --app tteonam docs/기획서.md QA체크리스트.xlsx
```

LLM(Claude/Codex CLI)이 문서의 요구사항마다 테스트 초안을 만들고, 스키마·위험 규칙·Jev 기준별 검토를 거쳐 `tests/generated/<app>/`에 draft로 저장한다. `plan.json`이 요구사항 ↔ 테스트 ↔ 결과를 잇는다.

Claude는 구독 계정으로 로그인한 로컬 Claude Code CLI만 사용한다. `claude auth login`에서 Claude 구독 계정을 선택한다. 앱의 해석 보조와 `qa plan --llm claude-cli`는 `loggedIn`만 믿지 않고 `authMethod: "claude.ai"`를 확인한다. API key·Console·외부 제공자·인증 불명은 원문 전송 전에 거부하며 `ANTHROPIC_*`와 provider 전환 환경변수를 전달하지 않는다. QAutra는 키나 OAuth token을 입력·복사·추출하지 않는다.

사용량 한도·인증 오류를 API 과금 경로로 자동 우회하지 않는다. 다만 Claude 계정에서 **Usage credits/추가 사용량**을 켜 놓았다면 구독 CLI에도 별도 비용이 발생할 수 있다. QAutra가 이 계정 설정을 끄거나 잔여 구독량을 보증하지는 않는다. [인증 우선순위](https://code.claude.com/docs/en/authentication#authentication-precedence), [구독 추가 사용량](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans).

## 실행과 결과

CLI의 `run`, `smoke`, `capture`, `inspect`, `plan --run`은 동일 프로젝트의 `qa serve`에 연결한다. 별도 Terminal에서 `node bin/qa.ts serve`를 실행하거나 Mac 앱이 시작한 엔진을 사용한다. CLI가 두 번째 guest 관리자·실행 소유자를 만들지 않는다. 제출 응답 유실·상태 조회 실패 시 작업을 재제출하지 않으며, 알고 있는 job ID와 엔진 작업 목록으로 확인한다. 취소 요청만으로 완료를 표시하지 않고 실제 종료 상태를 기다린다.


```sh
node bin/qa.ts run tests/web-demo --platform android --device android:emulator-5554
node bin/qa.ts run tests/generated/tteonam --platform android --device android:emulator-5554
node bin/qa.ts smoke --app tteonam --platform ios
node bin/qa.ts inspect --app web-demo --platform desktop-safari --device "guest:$QA_GUEST_CONTEXT_ID"
node bin/qa.ts report latest
```

`QA_GUEST_CONTEXT_ID`는 해당 작업이 생성·할당받은 `instance.create` 응답의 `id`다. 물리 VM의 `machineId`와 다르다. AI는 이미 받은 ID를 CLI/MCP/SDK에 전달하며 UI에서 다시 입력할 필요가 없다. 준비된 기기는 `node bin/qa.ts devices`로 조회한다. 독립 context를 명시한 작업은 동시에 실행할 수 있고, 같은 context나 기기가 미정인 작업은 충돌 범위를 직렬화한다. 이 큐 규칙만으로 계정·테스트 데이터·업무 선행 조건의 독립성을 보장하지 않는다.

`.qa/runs/<runId>/`에 `report.html`, `summary.json`, `junit.xml`, 스텝별 스크린샷·화면 원본(마스킹됨)이 남는다. 웹 대상이 있으면 `web-qa/{plan,result}.json`도 쓴다(web-qa-skill `check-run.mjs`로 검사 가능). 결과마다 원래 판정과 함께 `qaStatus`(PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED)를 적는다.

## Mac 앱

```sh
bash scripts/build-mac.sh
open .tools/mac-build/Build/Products/Debug/QAutra.app
```

앱이 `qa serve`를 시작하거나 기존 엔진에 연결한다. 계획·실행·기기 화면·실행 기록과 실제 guest 인스턴스 상태를 보여준다. 데스크톱 프레임은 승인된 QA 세션의 저장된 최근 관측이며 OS 라이브 스트리밍이 아니다. 최초 guest 설정은 제품 소유 VZ 설정 창에서 한다.

`QAutraGuestHost`는 Dock 아이콘과 별도 메뉴 막대가 없는 보조 앱으로 실행한다. 실제 guest 설정 창은 QAutra에서 요청할 때 열 수 있으며, 자동화 중에는 기존 입력 차단 규칙을 유지한다.

Mac 소스는 `mac/Sources/QAutra/`, Xcode project·target·앱 이름은 `QAutra`, bundle ID는 `dev.qautra.QAutra`다. 빌드 시 `QAUTRA_ROOT`가 `QAutraRoot`로 기록된다.

관리 화면은 제공 시안의 색상·글꼴·여백을 공통 `ProductDesign`으로 적용한다. 사이드바는 경계선을 포함해 228pt, 상단 바는 경계선을 포함해 56pt이며 본문 여백은 가로 40pt·세로 32pt다. 기본 버튼의 최소 높이는 37.5pt, 작은 상세 버튼은 28pt다. macOS의 실제 창 제어 버튼을 유지하며 시안의 장식용 신호등이나 샘플 실행 상태를 그려 넣지 않는다.

디자인 참조를 Ego Browser에서 확인한 결과와 실제 SwiftUI 앱의 렌더·입력 검증은 별도 증거다. 전체 화면의 픽셀 동일성, 실제 guest 브라우저 실행, 호스트 입력 비간섭은 서로 대체할 수 없는 검증 항목이다.

아이콘은 제공된 1024×1024 RGBA PNG를 [`icon_512x512@2x.png`](mac/Resources/Assets.xcassets/AppIcon.appiconset/icon_512x512@2x.png)에 바이트 그대로 보존한다. macOS AppIcon의 10개 1x/2x 자산은 이 원본에서 크기만 줄였다.

`qa` 명령, `.qa/` 실행 기록, 기존 `$schema` ID와 Android Chrome 탭 소유자 ID는 이름 변경으로 초기화하지 않는다. 이전 호스트 브라우저 실행 이력도 보존하지만, 그 PASS를 guest 격리 검증으로 취급하지 않는다.

## 알려진 한계

- 웹 뷰포트는 프로필당 하나다(여러 해상도 매트릭스 없음). 실기기 iPhone Safari, Internet Explorer는 지원하지 않는다.
- iOS Safari에서 `open`은 새 탭을 연다. 그 직후 `back`은 되돌아갈 기록이 없어 거부된다.
- Android Chrome에서 탭의 첫 페이지에서 `back`하면 Chrome을 벗어나 `app_not_foreground`가 된다.
- 웹 commit 게이트(0.20)는 `로그인`을 외부 변경으로 보는 오경보가 있다 — 필요한 탭은 `allowRisky`로 승인한다.
- 실제 guest Safari·Chrome 업무 흐름과 물리 호스트 타이핑 비간섭은 guest 초기 설정 후 별도로 실증해야 한다. 빌드·단위 테스트·VM 설치 성공은 이 검증을 대신하지 않는다.
