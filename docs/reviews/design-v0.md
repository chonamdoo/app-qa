# app-qa 설계 초안 v0 (리뷰용)

## 0. 목표와 제약
- **어떤 모바일 앱이든** (Android/iOS; 네이티브·React Native/Expo·Flutter·WebView·커스텀 드로잉) QA 자동화가 되는 **앱 무관(app-agnostic) 자체 플랫폼**.
- 판단 계층 = TypeSafe **Jev** (System One: text/JSON state + typed questions → Choice/Score/Noul 확률). 실행 권한은 결정적 코드가 가진다 (PDF "How to use Jev with LLMs" 원칙: code=규칙, Jev=좁은 판단, LLM=생성, 권한=정책).
- 도구 설치는 **프로젝트 로컬만** (전역 brew/pip 금지). 머신: macOS arm64, Node 24, uv, Java 17, Xcode 27, Android SDK(~/Library/Android/sdk, PATH 미등록).
- 1차 실검증 앱: **떠남** `kr.tteonam.app` (Expo/RN, 한국어 UI, Android emulator-5554 Android 17 + iPhone 17 Pro iOS 27 시뮬레이터에 설치됨). 소스 코드 없음 → 블랙박스.
- 조사 근거: `research/*.md` (보고서의 43개 저장소 + google/artemis 소스 분석, TypeSafe API 계약).

## 1. 로컬 실측 근거 (2026-09-26, 이 머신)
| 항목 | 결과 |
|---|---|
| Jev 실호출 | 0.69s, 응답 model `jev-1.13.0`, 한국어 라벨 Choice/Noul/Score 정상. 응답: `answers.<id>.{type, choice, confidence, probabilities}` / `{type:'noul', noul}` / `{type:'score', score, confidence, legend, probabilities}`, `usage.{input_tokens,output_tokens}` |
| Android `adb exec-out uiautomator dump` | 2.1s / 124 nodes |
| Android Appium UiAutomator2 `/source` | 0.01–0.12s (세션 생성 2.45s) |
| Android 한글 입력 | Appium element setValue로 `배터리` 입력 성공, IME 변경 없음 |
| Android 기존 u2 서버 | 에뮬레이터에 깔린 WeTest uia2 stub이 Android 17에서 `InputManager.getInstance` 없음으로 키 주입 실패 → openatx uiautomator2 경로 탈락 |
| **Android 가려진 노드** | 떠남에서 RN 바텀시트 4겹(설정→내 항공편→출국장 3→면세·식사)이 모두 덤프에 포함. 가려진 "항공편 바꾸기"를 탭하자 최상단 시트 영역이 눌림 → **occlusion 필터 필수** |
| iOS AXe 1.8.0 `describe-ui` | 2.1s. 기본 tap(simulator tapAt)은 RN Pressable에 무시됨, `--tap-style physical`만 동작. `axe type` US-ASCII만 |
| iOS `simctl pbcopy` | Simulator `PasteboardAutomaticSync=1` 때문에 즉시 호스트 클립보드로 덮임 (iOS 27은 pbcopy+Cmd+V 거부 보고도 있음) |
| iOS WDA (appium-webdriveragent 16.12.10) | Xcode 27에서 build-for-testing 12s. 직접 `/source` 0.3–0.5s. `/wda/keys`·element value로 **한글 입력 성공**, 떠남 검색창에 `대한항공` → 실제 검색 결과(KE1401 등) 표시 (RN onChange 발화 확인) |
| iOS Appium XCUITest 드라이버 경유 | `/source` 1.1s, screenshot 0.09s, window rect 402×874 pt |
| iOS 트리 노이즈 | 키보드 `Key` 노드, 중첩 중복 라벨(Heading 2회), 화면 밖 노드, 팝업 뒤 배경 요소("dismiss popup") 포함 |
| **떠남 iOS 실제 결함 후보** | "항공편 찾기" 첫 탭 시 RN LogBox `Render Error: undefined is not a function` (AppProviders.tsx:47 StatusBar, ThemeRoot useQuery). 재시도 시 재현 안 됨 → 간헐 크래시. **에러 오버레이 결정적 감지 필수** |
| 위험 동작 실존 | 떠남 Android "내 항공편 지우기" 버튼 → 파괴적 동작 차단 정책 필요 |

## 2. 조사 결론 (research/*.md 요약)
1. Jev는 **자율 다음-행동 선택엔 약하고**(jev-ios-bridge 사전등록 실험: top-1 17/20, 게이트 통과 10/20) **화면 assertion Noul엔 강함**(24개 화면 48 claim, 확신 오답 0). 부재/빈 상태 claim은 확률이 낮게 나옴(0.78–0.80).
2. Jev 응답은 행동 전 **엄격 검증**(type 일치, choice∈criteria, probabilities 키=criteria, 값∈[0,1], 합=1±0.02, choice=argmax) 실패 시 무행동.
3. 모든 Choice에 `none` 옵션. 모델에는 좌표를 주지 않고 코드가 id→bounds 매핑.
4. 정확 라벨 일치 시 Jev 생략(fast path). Convoy의 정규화는 ASCII 전용이라 한국어 라벨 fast path가 절대 안 탐 → Unicode NFC 필요.
5. 행동 직전 **freshness 재관찰**(대상 의미 비교, 좌표는 새 bounds 사용), 결과 불확실한 mutation은 재시도 금지.
6. settle은 고정 sleep이 아니라 fingerprint 안정 폴링(상태바 시계 등 제외).
7. 한글 입력: Accessibility set_text(Appium setValue) 1순위, clipboard+paste 2순위, `input text`/HID는 ASCII만.
8. PASS/FAIL은 코드가 결정(결정적 assertion + 밴드 게이트된 Noul). 모델의 DONE은 증거 아님.
9. 접근성 트리 없는 UI(게임/캔버스): OCR 텍스트화, grid tile + vision 설명 → Jev 선택, 앱 내부 브리지.
10. artemis: Android 전용, Jev 미사용(LangChain/Gemini). 가져올 것: 온디바이스 a11y helper(윈도우 레이어별 수집·가시 노드만·bounds 클리핑), precondition 점수 매칭, read-only device probes(dumpsys/settings/content query), SQLite 트레이스, 디바이스 락, keep-awake. 피할 것: fail-open 체크들, 모델 자기 판정 PASS, 고정 sleep.

## 3. 아키텍처 (제안)
```
spec(YAML) ──► runner ──► step executor ─────────────────────────────────────────────┐
                 │  observe(driver)  → raw tree + screenshot                          │
                 │  normalize        → 후보 e1..eN (NFC, 오프스크린/키보드/시스템UI/중복 제거, occlusion hit-test) │
                 │  resolve target   → exact fast path → Jev Choice(+none) → gate(pass/ambiguous/not_found) │
                 │  policy           → 위험 동작 deny (allowRisky 없으면 차단)                  │
                 │  freshness        → 재관찰, 대상 재매칭, 새 중심 좌표                         │
                 │  act (Appium W3C) → tap/type/swipe/back/launch/reset                    │
                 │  settle           → fingerprint 2회 연속 동일 (min 300ms, max 5s)          │
                 │  health watchdog  → 포그라운드 앱/크래시 다이얼로그/RN LogBox/ANR/로그          │
                 │  verify           → 결정적 expect + Jev Noul claim (≥0.9 pass, ≤0.1 fail, 사이=inconclusive) │
                 └─ receipt          → step-NN/{elements,jev-req,jev-res,verdict}.json + before/after.png │
report: summary.json + JUnit XML + 단일 HTML 리포트                                         ◄┘
```

## 4. 설계 결정 (리뷰 대상)
- **D1 런타임**: TypeScript / Node 24 (Appium과 단일 런타임). 대안: Python/uv (typesafe-sdk, artemis 패턴).
- **D2 실행 계층**: 프로젝트 로컬 Appium 서버(`APPIUM_HOME=.tools/appium`) + UiAutomator2(Android) + XCUITest(iOS) 드라이버, W3C 프로토콜 단일 클라이언트(얇은 fetch 클라이언트). 대안: (a) Appium 없이 UiAutomator2 server APK + WDA 직접 구동(더 빠름, 수명주기 직접 관리), (b) iOS 읽기는 idb axbridge(웜 33ms)/AXe, 입력은 WDA 하이브리드.
- **D3 판단 모델**: 작성된 스텝 실행. Jev는 (a) 대상 grounding Choice, (b) assertion Noul, (c) 화면 분기 `which` Choice에만 사용. 자율 탐색 에이전트는 v1 제외.
- **D4 정규화**: NFC+casefold, window rect 클리핑, 키보드/상태바 제거, 크기 0 제거, 동일 라벨·겹치는 bounds 중복 제거(액션 가능한 조상 유지), **문서순서 기반 hit-test로 가려진 요소 제거**, 역할은 class + clickable/checkable/editable/scrollable 속성. Jev에는 role/label/value(secure 마스킹)/state/대략 위치(top/middle/bottom)만, 좌표 없음. 후보 255 초과 시 거부(잘라내지 않음).
- **D5 게이트(초기값, 캘리브레이션 대상)**: target top≥0.75 & P(none)<0.10 & gap≥0.20 → pass; none≥0.10 → not_found(재시도 대상); 그 외 ambiguous(즉시 실패). assertion Noul ≥0.9 pass / ≤0.1 fail / 사이 inconclusive(CI에서는 실패 취급, 별도 상태). 응답 검증 실패·API 오류 → 전송 재시도 2회 후 error(절대 pass 아님). 모델 `jev-1.13.0` 고정.
- **D6 fast path**: 정규화 라벨 유일 일치 → Jev 생략. 명시 셀렉터(`id:`, `text:`, `desc:`)도 허용.
- **D7 행동**: tap=W3C pointer(down-pause 60ms-up) at fresh center; type=element setValue + read-back 검증, 실패 시 clipboard paste; scroll/swipe `until`; back(Android keyevent / iOS 내비 back 버튼→엣지 스와이프); launch/terminate/reset(relaunch|clear|reinstall).
- **D8 settle**: source fingerprint(시계·배터리 등 상태바 제외) 150ms 폴링, 2회 연속 동일, min 300ms, max 5s. Android `waitForIdleTimeout` 축소.
- **D9 health watchdog(매 스텝)**: 포그라운드 앱 확인, Android 크래시/ANR 다이얼로그, iOS 프로세스 소멸, RN LogBox/RedBox("Render Error", "Log 1 of"), Flutter 에러 위젯 텍스트 패턴 → 즉시 FAIL + 증거(logcat -b crash / iOS DiagnosticReports).
- **D10 위험 정책**: 한/영 파괴적 키워드(삭제, 지우기, 결제, 구매, 탈퇴, 로그아웃, 초기화, 송금, delete, pay, …) + 앱 프로필 확장. 해당 요소 대상 스텝은 `allowRisky: true` 필수, 그리고 위험 요소는 fast path 정확 일치만 허용(Jev grounding 불가).
- **D11 접근성 트리 없는 UI**: 라벨 후보가 희소(예: <3 액션 & <32자)하거나 not_found이면 스크린샷 OCR(Apple Vision, 로컬 Swift CLI, ko-KR/en-US) 결과를 `ocr-text` 후보로 추가 → Jev Choice. 아이콘 전용 UI는 v2(grid tile + vision LLM 설명). 탈출구: 정규화 좌표 `tapAt: {x:0.5, y:0.9}`.
- **D12 증거/receipt**: `.qa/runs/<ts>/<test>/<platform>/step-NN/…`, Jev receipt(model, 질문 버전, state digest, latency, usage/cost). 비밀값·secure 필드 값은 기록 안 함.
- **D13 스펙 포맷**: YAML 테스트 + 앱 프로필(`apps/<id>.yaml`: android.package/apk, ios.bundleId/app, 위험 키워드 확장). 스텝: launch, tap, type/into, see, see.not, expect(Noul claim), which, scroll, swipe, back, wait, tapAt, assertText(결정적), capture. `${ENV}` 치환, platforms/tags 필터.
- **D14 CLI**: `qa setup`(Appium+드라이버 로컬 설치·WDA 빌드 확인), `qa doctor`, `qa devices`, `qa apps`(설치 앱 목록), `qa inspect`(요소 테이블), `qa run`, `qa report`.
- **D15 설정/비밀**: `TYPESAFE_API_KEY` 또는 `TYPESAFE_API_KEY_FILE`, `.env` gitignore.
- **D16 플랫폼 자체 테스트**: 오늘 캡처한 떠남 Android/iOS 덤프를 fixture로 정규화·게이트·검증기 단위 테스트 + 떠남 실기 E2E.
- **D17 무작성 스모크(앱 무관)**: `qa smoke --app <id>` = 실행 → 크래시/에러/빈 화면 검사 → 안전한 요소(탭바·내비)만 제한 크롤(위험 키워드 제외, 스텝/시간 예산) → 각 화면 health + Jev Noul("에러/빈 화면인가"). 스펙 없이 어떤 앱이든 1차 QA.

## 5. v1 범위 밖 (명시)
자율 탐색 에이전트(artemis식), iOS 실기기 서명 자동화, 디바이스 팜/병렬 디바이스, 웹 대시보드, MCP 서버, vision LLM fallback.
