# app-qa

Android/iOS 앱과 웹사이트(데스크톱 Chrome·Safari, Android Chrome, iOS Safari)를 같은 테스트 DSL로 자동 검증한다. 기획서·QA 문서에서 테스트를 만들고, 실기기·실브라우저에서 실행하고, 판정과 요구사항 추적 리포트를 남긴다. 판정은 결정적 검사나 보정된 Jev 게이트로만 PASS가 되고, 불확실하면 ERROR·INCONCLUSIVE로 남는다.

설계와 불변식: [`skills/architecture/SKILL.md`](skills/architecture/SKILL.md), [`skills/architecture/references/design.md`](skills/architecture/references/design.md).

## 준비

Node 24, Xcode(iOS 시뮬레이터), Android SDK(에뮬레이터)가 필요하다. 도구는 모두 프로젝트 안(`.tools/`)에 설치된다.

```sh
npm ci
cp .env.example .env          # TYPESAFE_API_KEY, ANDROID_HOME, QA_LLM
node bin/qa.ts setup          # Appium 드라이버 고정 버전 + OCR 도우미
node bin/qa.ts setup --browsers   # 웹 테스트도 할 때: Android Chrome 준비, Safari/Chrome 점검
node bin/qa.ts doctor         # 전체 상태 점검 (기기 설정은 바꾸지 않음)
```

데스크톱 Safari는 macOS에서 한 번 "원격 자동화 허용"을 켜야 한다: `sudo safaridriver --enable` (또는 Safari 설정 › 고급 › 웹 개발자용 기능 보기 → 개발자 › 원격 자동화 허용).

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

## 실행과 결과

```sh
node bin/qa.ts run tests/web-demo --platform all        # android | ios | desktop-chrome | desktop-safari | all
node bin/qa.ts run tests/generated/tteonam --platform android --device android:emulator-5554
node bin/qa.ts smoke --app tteonam --platform ios
node bin/qa.ts inspect --app web-demo --platform desktop-chrome   # 현재 화면 후보 표
node bin/qa.ts report latest
```

`.qa/runs/<runId>/`에 `report.html`, `summary.json`, `junit.xml`, 스텝별 스크린샷·화면 원본(마스킹됨)이 남는다. 웹 대상이 있으면 `web-qa/{plan,result}.json`도 쓴다(web-qa-skill `check-run.mjs`로 검사 가능). 결과마다 원래 판정과 함께 `qaStatus`(PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED)를 적는다.

## Mac 앱

```sh
bash scripts/build-mac.sh
open .tools/mac-build/Build/Products/Debug/AppQA.app
```

앱이 `qa serve`를 띄우고 계획·실행·실시간 기기 화면·실행 기록을 보여준다. 데스크톱 브라우저는 실시간 화면 대신 마지막 스텝 스크린샷을 보여준다.

## 알려진 한계

- 웹 뷰포트는 프로필당 하나다(여러 해상도 매트릭스 없음). 실기기 iPhone Safari, Internet Explorer는 지원하지 않는다.
- iOS Safari에서 `open`은 새 탭을 연다. 그 직후 `back`은 되돌아갈 기록이 없어 거부된다.
- Android Chrome에서 탭의 첫 페이지에서 `back`하면 Chrome을 벗어나 `app_not_foreground`가 된다.
- 웹 commit 게이트(0.20)는 `로그인`을 외부 변경으로 보는 오경보가 있다 — 필요한 탭은 `allowRisky`로 승인한다.
- 데스크톱 Chrome·Safari는 화면·입력 포커스를 공유하므로 한 실행 안에서도, 작업 큐의 서로 다른 작업 사이에서도 차례로 실행된다.
