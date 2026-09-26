# app-qa 아키텍처 (v2, 웹 대상 포함)

어떤 모바일 앱이든(Android/iOS · 네이티브/RN/Expo/Flutter/Compose/WebView), 그리고 어떤 웹사이트든(데스크톱 Chrome·Safari, Android Chrome, iOS Safari) **문서(기획서·QA 문서·시나리오) → 테스트 → 실기기·실브라우저 실행 → 판정 → 추적 리포트**를 수행하는 대상 무관 QA 자동화 플랫폼. 앱과 웹은 한 파이프라인을 쓰고 드라이버·관찰 파서만 다르다(§12).

- 역할 분담 (PDF *How to use Jev with LLMs*): **코드** = 규칙·권한·실행, **Jev** = 좁은 typed 판단(대상 grounding, 화면 claim, 화면 분기, 생성물 검토), **LLM** = 문서 → 테스트 생성(열린 생성), **사람** = 위험 동작 승인·draft 검토.
- 원칙: fail-closed(불확실 ≠ PASS), 결과 불확실한 행동 재시도 금지, 모델 자기 판정 금지, 도구는 프로젝트 로컬.
- 근거: `docs/research/*` (43개 저장소 + artemis 코드 분석), `docs/reviews/*` (Codex GPT-6 sol · Claude Opus 5.5 교차 리뷰), 로컬 실측(아래 §9).

```
문서(md/txt/csv/xlsx/docx/pdf) ─► qa plan ─► tests/generated/<app>/**/*.e2e.yaml + plan.json (요구사항 추적)
                                     │  LLM 생성 → zod 검증 → 결정적 규칙 → Jev 검토(Noul) → draft/approved
사람 작성 *.e2e.yaml ────────────────┤
                                     ▼
qa run ─► runner ─► per step: observe → normalize(가림/중복/키보드/시스템UI 제거) → resolve(selector|fast path|Jev Choice+gate)
                  → policy(위험) → freshness(재관찰·재매칭·hit-test) → act(Appium W3C) → settle(변화→안정) → health → expect
                  → receipt(step-NN/…) ─► summary.json + junit.xml + report.html(요구사항↔테스트↔결과)
```

## 1. 모듈과 소유권

| 모듈 | 경로 | 공개 계약 |
|---|---|---|
| 공통(계약) | `src/core/*`, `src/spec/{schema,load}.ts` | 타입·플랫폼 표(`src/core/platform.ts`: `PLATFORM_INFO`, `PLATFORMS`, `platformsFor`)·경로·이벤트·DSL 스키마·`profilePlatforms`·스펙/프로필 로더·Jev 후보 행 형식(`src/core/candidate-row.ts`)·소유 잠금(`src/core/lock.ts`)·프로세스 식별(`src/core/process.ts`) (통합 담당만 수정) |
| 관찰 | `src/observe/*`, `src/ocr/*` | `parseAndroidSource`, `parseIosSource`, `parseWebSource`, `WEB_EXTRACT_SCRIPT`, `webSourceFromExtract`, `SOURCE_PARSERS`, `buildScreenModel`, `topmostAt`, `refind`, `renderCandidateTable`, `normLabel`, `runOcr`, `buildOcrHelper` |
| 위험 정책 | `src/policy/*` | `labelRisk`, `assessRisk`, `navigationProblem`, 키워드·대화상자 문맥 표 (결정적) |
| Jev | `src/jev/*` | `JevClient`, `loadJevConfig`, `groundChoice`, `judgeClaim`, `judgeWhich`, `judgeCommit`, `reviewGenerated`, `loadCalibration`, `usableGate` |
| 드라이버 | `src/appium/*`, `src/drivers/*` | `ensureAppium`, `createDriver`, `listDevices`, `pickDevice`, `listApps`, `backupApp`, `acquireDeviceLock`, `prepareAndroidChrome`, `androidChromeChecks`, `iosSafariChecks`, `desktopBrowserChecks` |
| 러너 | `src/runner/*`, `src/report/*` | `runTests`, `runSmoke`, `inspectScreen`, `captureScreen`, 리포트(`qaStatus`, web-qa 내보내기) |
| 문서→테스트 | `src/plan/*` | `generatePlan`, `ingestDocuments`, `segmentRequirements`, `generateTests` |
| 서버 | `src/server/*` | `qa serve` HTTP/SSE API; 러너·계획·드라이버는 주입된 핸들러로만 |
| CLI(컴포지션 루트) | `bin/qa.ts`, `src/cli/**` | 디스패처와 `cmd<Name>` 명령 전부(`cmdSetup/cmdDoctor/cmdDevices/cmdApps/cmdRun/cmdSmoke/cmdInspect/cmdCapture/cmdReport/cmdPlan/cmdCalibrate/cmdServe`) |

CLI 명령 모듈은 `src/cli/commands/<name>.ts`에서 `export async function cmd<Name>(argv: string[]): Promise<number>` (반환 = exit code) 형태로 내보내고, 인자 파싱은 `node:util` `parseArgs`. 디스패처(`src/cli/index.ts`)는 CLI 소유이며 명령 모듈을 지연 로딩한다.

## 2. 관찰·정규화 (src/observe, src/ocr)

- `parseAndroidSource(xml, screen): RawNode[]` — UiAutomator2 `/source`. 전역 z = 창 순서(문서 순서) → DFS, 형제는 `drawing-order` 오름차순 정렬. `window-id`, `displayed`, `password`, `heading`, `enabled` 등 속성 → `NodeFlags`.
- `parseIosSource(xml, screen): RawNode[]` — XCUITest `/source` (설정: `pageSourceExcludedAttributes=visible,accessible,index` → `visible` 없음, 가시성은 직접 계산). `XCUIElementType` 접두어 제거. z = 문서 순서 DFS.
- `buildScreenModel(snapshot, { volatile, ocr }) : ScreenModel`
  - 제거: 크기 0, 화면 밖(화면 rect와 교집합 없음; 교집합으로 클리핑), iOS `Keyboard` 서브트리와 `Key`, Android `com.android.systemui` 노드, 스크롤바 슬라이더("scroll bar").
  - **가림(occlusion)**: 점 p의 최상단 노드 = p를 포함하는 노드 중 z 최대, **단 가림 요소 후보는 터치 가능 노드(clickable|longClickable|focusable|scrollable)만**. 대상이 최상단(또는 최상단이 대상의 자손)인 영역만 "보임". `tapPoint` = 가려지지 않은 가장 큰 영역의 중심(격자 샘플링). 보이는 영역이 없으면 `occludedNodeIds`. 떠남 `fixtures/android/tteonam/my-flight-sheet` 정답: 보이는 clickable = `닫기`, `항공편 바꾸기`, `내 항공편 지우기` (나머지 13개 가림). 모든 노드를 가림 후보로 하면 0개가 되어 오답 — 금지.
  - 중복: 같은 정규화 라벨이면서 bounds IoU ≥ 0.9이고 조상-자손 관계일 때만 병합(액션 가능한 쪽 유지). **반복 행(리스트)은 병합 금지**.
  - 역할: Android class + flags (Compose/RN의 `View`/`ViewGroup`도 clickable이면 button), iOS type 매핑. `secure-input` 값은 `•`×길이.
  - 라벨: `desc`(content-desc/label) → `text` → `hint` → 자식 텍스트 합성(최대 80자). NFC. `normLabel` = NFC + 소문자 + 공백 정리 (**한글 보존**, ASCII 전용 정규식 금지).
  - 후보 키 e1..eN(읽는 순서: y, x). 254 초과 시 `overflow=true` (자르지 않음).
  - `texts` = 보이는·가려지지 않은 텍스트 줄 + OCR 줄.
  - `sparse` = (액션 가능 후보 < 3 && 텍스트 총 < 32자).
  - 지문: `identity` = 보이는 (role,name) 정렬 목록 해시, `layout` = 보이는 rect 목록(8px 격자) 해시. 둘 다 volatile 정규식(시계 `^\d{1,2}:\d{2}$`, 배터리/신호 문구, 앱 프로필 `volatile`) 제외.
- `topmostAt(nodes, p)`, `refind(prev: Candidate, model): Candidate | null` (role+name+value 일치, 이전 위치에 가장 가까운 것).
- OCR: `src/ocr/ocr.swift`(Apple Vision `VNRecognizeTextRequest`, `.accurate`, `ko-KR,en-US`) → `qa setup`이 `swiftc -O`로 `.tools/bin/qa-ocr` 빌드. `runOcr(png, screen): OcrLine[]` — 픽셀→탭 좌표 변환(iOS @3x). OCR은 `sparse`이거나 대상 not_found일 때만 실행. OCR 후보 `source:'ocr'`, role `text`.
- 접근성 트리도 OCR도 대상을 못 주는 화면(아이콘 전용·캔버스·게임) = **INCONCLUSIVE(`unsupported_surface`)**. 비전 LLM은 v1 제외(사용자 결정).

## 3. Jev (src/jev)

- 엔드포인트 `POST {TYPESAFE_BASE_URL|https://api.typesafe.ai/v1}/systemone`, 모델 **`jev-1.13.0` 고정**(응답 `model` 불일치 시 error). 키: `TYPESAFE_API_KEY` 또는 `TYPESAFE_API_KEY_FILE`(권한 0600 아니면 거부). 키·본문은 절대 로그 금지.
- 타임아웃 시도당 3s, 총 8s. 재시도: 408/429/5xx/529만(지수 백오프). 400/401/403/422 즉시 error. `x-typesafe-request-id` 기록.
- 응답 검증(하나라도 실패 → error, 무행동): `type` 일치, choice∈criteria, probabilities 키 = criteria 키, 값 유한·[0,1], 합 1±0.02, choice = argmax(±0.011 허용). Noul: `noul`∈[0,1].
- 질문 v1(`questionVersion: "q-v1"`, 문구 동결): state는 `{screen: {rows: ["e3 | button | 항공편 찾기 | disabled | bottom", …], texts: [...]}, intent}` — **좌표 금지**, 리댁션 적용 후 전송.
  - grounding: Choice(criteria = 후보 키 + `none`), 설명은 행 텍스트.
  - claim: Noul "Does the visible evidence on this current screen support this specific claim?" + `{claim}`.
  - which: Choice(옵션 s0..sN + `none`="still loading / none of these").
  - commit(거부 추가 전용): Noul "Would activating `target` commit an irreversible or external change (delete, pay, send, sign out…)?"
  - generated review(plan): Noul 3개 — addresses_requirement, unrelated_steps, needs_clarification.
- 게이트: `calibration/<model>/<questionVersion>.json`의 임계값만 사용. **레코드 없으면 Jev 결정 = error(`uncalibrated`)**. `qa calibrate`가 `calibration/golden/*.yaml`(fixture 기반 정답: grounding 정답/none/중복/가림, claim 참/거짓/부재)을 돌려 사전등록 기준(확신 오답 0, 수용률 ≥ 80%)으로 primitive별 임계값을 산출·기록. Noul과 Choice 임계값 공유 금지.
- commit 임계값은 표면별: 앱 = `commit.gate`(섹션 status), 웹 = `commit.surfaceGates.web` — 웹 골든 탐색 항목에서 찾은 임계값이 새 페이지·새 라벨의 홀드아웃(`holdout: true`)에서도 재조정 없이 기준(확신 오답 0, 오경보 ≤ 10%)을 만족할 때만 기록. 표면에 맞는 게이트가 없으면 그 표면의 commit 판정은 `uncalibrated`(러너는 `commit_check_unavailable`); 앱 게이트로 대신하지 않는다.
- 모드: `live` | `record`(응답 저장) | `replay`(요청 digest → 저장 응답; 없으면 error). 단위 테스트는 replay.

## 4. 드라이버 (src/appium, src/drivers)

- Appium 3.8.0은 npm 의존성, 드라이버는 `qa setup`이 `APPIUM_HOME=.tools/appium`에 고정 버전 설치: `uiautomator2@8.7.0`, `xcuitest@12.13.2`. 서버는 필요 시 기동/재사용(`ensureAppium`; 재사용은 이 프로젝트가 그 포트에 띄웠다는 `.qa/appium-<port>.json` 기록이 있을 때만, 시작은 포트별 single flight + `.qa/locks/appium-<port>.lock`), 로그는 `.qa/logs/appium.log`.
- Android caps: `noReset`, `autoLaunch:false`, 설정 `enableMultiWindows:false`, `waitForIdleTimeout:0`(RN 상시 리렌더에서 명령당 0.6–1.0s 대기 제거, typeText ≈3.2s → ≈0.6s 실측; 대기는 러너 settle이 소유). iOS caps: `noReset`, 설정 `waitForIdleTimeout:0`, `animationCoolOffTimeout:0`, `pageSourceExcludedAttributes:"visible,accessible,index"`, `snapshotMaxDepth:70` (실측 `/source` 0.25s → 0.03s).
- tap = W3C pointer(move → down → pause 60ms → up). swipe = 450ms 이동 + 350ms 정지(관성 방지). back: Android keycode 4, iOS 내비 back 버튼 → 없으면 엣지 스와이프.
- typeText: 탭으로 포커스 → 포커스 요소 찾기 → clear → setValue → 재확인. 값이 **전혀** 안 바뀐 경우에만 폴백(Android: 클립보드 base64 + KEYCODE_PASTE 279, iOS: `/wda/keys`). 일부만 바뀌면 폴백 금지 → `INPUT_UNVERIFIED`. iOS 클립보드 경로 금지(iOS 27 거부 + PasteboardAutomaticSync 덮어쓰기 실측).
- 전송 오류/타임아웃 → `ActionOutcome.status='uncertain'` (재시도 금지).
- reset: `relaunch`=terminate+launch, `clear`=Android `pm clear` / iOS 백업 .app로 uninstall+install, `reinstall`=백업 필요. **백업(`.qa/apps/<appId>/<sha256>.{apk|app}`) 없으면 clear(iOS)/reinstall 거부.** Android는 `pm path` → `adb pull`(split APK면 전부), iOS는 `simctl get_app_container` 복사.
- 로그: Android `logcat -v threadtime --pid <pid>` / iOS `simctl spawn <udid> log stream --style compact --predicate 'process == "<exec>"'`를 파일로; `logSlice(from,to)`.
- 디바이스 락 `.qa/locks/<deviceId>.lock` = {pid, 시작시각}; 죽은 소유자면 회수.
- `adb`는 `ANDROID_HOME/platform-tools/adb` 절대경로(PATH 불필요), 자식 프로세스에 `ANDROID_HOME` 주입.

## 5. 러너 (src/runner, src/spec/load.ts, src/report)

- 파일: `tests/**/*.e2e.yaml`, 앱 프로필 `apps/<id>.yaml`. 로딩 시 zod 검증, `type`의 `${ENV}`는 **실행 시** 치환.
- 스텝 대상 해석 순서: selector(정확 일치) → fast path(정규화 라벨 **유일** 일치; 유일성은 가림 필터 후·병합 전 기준) → Jev grounding. `within`(컨테이너 rect 안), `nth`(읽는 순서), `near`(거리). `decisionSource` 기록(가짜 Jev 응답 금지).
- 게이트 결과: pass → 진행 / not_found → 스텝 timeout 내 재관찰(트리 지문이 바뀔 때만 Jev 재질의) / ambiguous → 즉시 FAIL(문구 수정 필요) / error → ERROR.
- **위험 정책**(`src/policy/risk.ts`): 한·영 키워드(삭제, 지우기, 제거, 결제, 구매, 주문, 탈퇴, 로그아웃, 초기화, 송금, 이체, 전송, 보내기, 공유, 신고, 차단, 구독, 해지, 전화, 권한 허용 / delete, remove, erase, pay, purchase, buy, order, checkout, unsubscribe, sign out, log out, reset, send, transfer, share, report, block, call — 영어는 단어 경계) + 앱 프로필 deny/allow. 파괴적 확인 대화상자 문맥(삭제하시겠|정말|되돌릴 수 없|cannot be undone|are you sure …)에서는 확인/예/네/OK/Yes/계속도 위험. 라벨 없는 대상(`tapAt`, 이름 없는 아이콘) = 위험 미상. 정책은 **행동 직전 새 관찰의 최종 대상·화면**에 적용한다(freshness 이후 재평가). `press: enter`와 `type.submit`도 포커스된 필드와 화면 문맥으로 같은 정책을 거친다. Jev commit Noul(보정된 임계값 이상 → 위험)은 거부 추가 전용이며, `allowRisky` 없이 결정적으로 안전한 대상에 대한 모든 대상 기반 변경 행동(tap, longPress, type/clear, submit/enter)에 **필수**다: commit 판단이 오류이거나 commit 게이트가 `calibrated`가 아니면 스텝 ERROR `commit_check_unavailable`(행동 안 함). advisory 등급은 두지 않는다. 위험 + `allowRisky` 없음 → 스텝 ERROR `blocked_by_policy`(행동 안 함). 위험 요소는 Jev grounding 불가 — selector/fast path만.
- **증거 정제**: journal·events·SSE·`source.xml`·`elements.json`·로그로 가는 모든 기록은 한 정제 경계를 지난다 — 관찰된 `secure-input` 역할(DSL `secure` 플래그와 무관), `${ENV}`로 치환된 값, 앱 프로필 `redact` 일치, 민감한 URL 쿼리 값(파라미터 이름이 퍼센트 인코딩돼도)을 가린다. 테스트 세션 밖에서 쓰는 기록(스킵, 스모크 시작)도 같은 경계를 지난다. 스텝 라벨(계획 미리보기 포함)에는 입력 텍스트를 쓰지 않는다(길이·변수 여부만). Appium 서버는 요청 본문을 기록하지 않는 로그 수준으로 실행한다.
- **원자적 기록**: 보정 레코드, `plan.json`, 생성 테스트, `summary.json`, `.qa/server.json`은 임시 파일 → fsync → rename으로 쓴다. 계획 재생성은 새 세대를 완성한 뒤에만 이전 테스트를 정리한다.
- freshness: 행동 직전 재관찰 → `refind` → hit-test(Android 기하, iOS는 대상 상자의 WDA `hittable`, 데스크톱은 `elementFromPoint`) → 새 tapPoint. 실패 → 재해석 1회, 그래도 실패 → FAIL `stale_target`. commit 확인을 기다리는 동안 화면이 바뀔 수 있으므로 답을 받은 뒤 다시 관찰해 같은 노드·같은 상자·같은 상태인지(아니면 `stale_target`) 보고, 결정적 정책을 새 관찰에 다시 적용한다(그 사이 생긴 파괴적 대화상자 → 차단). 시계·실시간 수치처럼 대상과 무관한 변화는 승인을 무효로 하지 않는다. 입력·지우기 대상 해석은 같은 라벨 중 편집 가능한 후보로, 탭은 같은 라벨 중 유일한 행동 가능 후보로 좁힌다. 같은 노드 = 같은 트리 경로·resource id·상자·상태(데스크톱 웹은 같은 DOM 요소, 즉 같은 W3C 요소 참조). 잘린 관찰(`depthCapped`: iOS 깊이 상한, 웹 노드 상한)에서는 대상 기반 변경 행동을 승인하지 않는다(INCONCLUSIVE `observation_truncated`, 디스패치 없음).
- 행동 journal: 디스패치 **전** intent를 `journal.jsonl`에 fsync, 결과로 갱신. `uncertain` → 테스트 ERROR, 자동 재시도 없음.
- settle: 폴링 150ms. (1) 변화 감지: 행동 전 대비 identity 또는 layout 지문 변경(최대 = 스텝 timeout, 기본 5s) → (2) 안정: identity·layout 2회 연속 동일(간격 ≥ 250ms). 캔버스처럼 트리가 안 바뀌면 스크린샷 dHash 보조(같음 ≤4, 다름 ≥7). 기본 사후조건 = "변화 발생"(`expectNoChange:true`면 생략). commit 확인을 거친 행동은 확인 뒤 관찰 + 새 스크린샷을 기준으로 변화를 잰다(기다리는 동안의 변화는 행동의 효과가 아니다). 변화 없음 → INCONCLUSIVE `no_effect`. 안정 실패 → `settled:false` 기록(이후 freshness가 보호).
- health(매 settle 후): 포그라운드 앱 ≠ 대상 → FAIL `app_not_foreground`; Android 크래시/ANR 대화상자("계속 중지됨", "keeps stopping", "has stopped", "응답하지 않음", "isn't responding"); RN RedBox(`DISMISS (ESC)`/`RELOAD (R, R)`, "Unable to resolve module", 빨간 전체화면) → FAIL; RN LogBox 전체화면 에러("Render Error", "Uncaught Error", "Log N of M" + Dismiss/Minimize) → FAIL, 접힌 경고 토스트 → WARN; Flutter 에러("RenderFlex overflowed", "Another exception was thrown") → FAIL; 빈 화면(트리·OCR 비어 있고 스크린샷 ≥98% 단색) → FAIL `blank_screen`. FAIL 시 테스트 구간 로그 첨부.
- 스텝 종류 의미: `see` = grounding pass(strict: gap 구제 없음), `seeNot` = grounding이 not_found로 2회 연속 관찰(≥ holdMs 500) 시 pass, 애매하면 INCONCLUSIVE(없음 판정 — `seeNot`·`assertNoText`·`noText` — 은 잘린 관찰에서 INCONCLUSIVE `observation_truncated`); `assertText/assertNoText` = `texts` 결정적 검사(assertNoText는 settle 후 500ms 유지); `checkEach` = `texts` 각 줄에 정규식(named groups, 숫자 그룹은 number로 파싱) → JSONLogic 규칙 전부 true + 매치 수 ≥ min(모든 연산자는 피연산자 개수와 컬렉션 입력 타입을 검사, 규칙이 읽는 그룹이 매치되지 않은 줄은 평가하지 않음 → INCONCLUSIVE `check_unobserved`, 잘린 관찰에서는 관찰된 위반만 FAIL이고 나머지는 INCONCLUSIVE); `claim` = Jev Noul 게이트(pass/fail/inconclusive); `which` = Jev which; `scroll.until` = 대상/텍스트가 보일 때까지(max 회); `when` 인터럽트 = 각 스텝 전 `see` 판정(결정적 우선) 후 `do` 실행(max 회).
- 예산: 테스트별 steps/seconds/jevCalls, 초과 → INCONCLUSIVE `budget_exceeded`. 디바이스 락 획득 필수.
- 판정: 스텝 → 테스트 = 최악값(ERROR > FAIL > INCONCLUSIVE > PASS; optional 스텝 실패는 SKIPPED). 실행 = 테스트별 × 플랫폼별.
- 증거: `.qa/runs/<runId>/<testId>/<platform>/step-NN/{before.png, after.png, elements.json(후보; 값 마스킹), source.xml, jev.json(receipt), verdict.json}`, `journal.jsonl`, `summary.json`, `junit.xml`, `report.html`(단일 파일, 한국어, 스크린샷 썸네일, 요구사항↔테스트↔결과 매트릭스(plan.json이 있으면), draft 표시). 디렉터리 0700, 파일 0600.
- 명령: `qa run [paths] --platform android|ios|desktop-chrome|desktop-safari|all --device <플랫폼>:<id> --tag <t> --junit`, `qa smoke --app <id> [--crawl tabs]`(기본 = 실행·health·빈 화면·스크린샷만; `--crawl tabs` = 역할로 식별된 탭바 항목만 순회하며, 각 탭은 일반 탭과 같은 준비 단계(위험 정책 + 필수 commit 확인)를 거친다 — 보정된 commit 게이트가 없으면 첫 탭에서 ERROR `commit_check_unavailable`로 멈춘다), `qa inspect`(후보 테이블 + 가림/fast-path/위험 열), `qa capture --name`(fixture + `.qa/inventory/<app>/<platform>/<name>.json`), `qa report <runId>`.

## 6. 문서 → 테스트 (src/plan, `qa plan`)

- 입력: `.md .txt .csv .tsv .json .yaml .xlsx(exceljs) .docx(mammoth) .pdf(unpdf 텍스트 레이어)`; 경로/글롭 여러 개, 기본값 = 앱 프로필 `docs`.
- 분할(결정적): Markdown = 제목 경로 + 문단/목록/굵은 용어 정의 단위, 표 = 행 단위; 스프레드시트 = 행 = 테스트 케이스(열 이름 휴리스틱: ID/번호, 항목/기능/화면, 시나리오/제목, 사전조건, 절차/단계/Steps, 기대결과/Expected). `Requirement.id = <doc-slug>#<section-slug>[.<n>]`, `digest` = sha256(text).
- 앱 문맥: 앱 프로필 + 인벤토리(`.qa/inventory/<app>/**`, `qa capture`/`qa smoke --crawl tabs`가 기록한 화면별 후보 이름·텍스트) → LLM이 **실제 화면 문구**로 스텝을 쓰게 함.
- LLM 어댑터(`QA_LLM` 또는 `--llm`): `claude-cli`(`claude -p --model <m> --output-format json`, 결과 `result`에서 JSON 추출), `codex-cli`(`codex exec -m <m> --output-schema <file> -o <out> -s read-only`). 출력 JSON `{tests: TestSpec[], untestable: [{requirement, reason}]}`; 모든 test에 `covers`.
- 검증(결정적): zod, `covers` id 존재, 모든 요구사항 = 커버 또는 untestable(사유), 위험 단어 스텝은 `allowRisky` 금지(자동 생성은 위험 동작 불가) → 위험이 필요한 요구사항은 untestable(`needs_approval`), 스텝 종류 허용 목록. 오류는 **1회** 구조화된 피드백으로 재생성, 그래도 실패하면 그 테스트 폐기+사유 기록.
- Jev 검토(`reviewGenerated`): addresses_requirement ≥ 0.8 && unrelated_steps ≤ 0.2 && needs_clarification ≤ 0.3 → `approved` 후보, 아니면 `draft`(이슈 기록). 기본 저장 상태는 `draft`; `--approve` 플래그일 때만 통과분을 `approved`로.
- 출력: `tests/generated/<app>/<doc-slug>/<test-id>.e2e.yaml`(`source.plan`, `source.status`, `covers`) + `tests/generated/<app>/plan.json`(PlanFile). 문서 digest가 바뀐 요구사항의 테스트는 리포트에 `stale` 표시. `qa plan --run`이면 생성 직후 실행.

## 7. 앱 프로필 예 (`apps/tteonam.yaml`)

```yaml
id: tteonam
name: 떠남
build: dev
android: { package: kr.tteonam.app, activity: .MainActivity }
ios: { bundleId: kr.tteonam.app }
volatile: ['^\d{1,2}:\d{2} 기준$', '^마지막 확인 \d{1,2}:\d{2}$']
docs: ['~/.agent-flow/worktrees/IncheonAirport-2a25dd406249/feat-tteonam-app/CONTEXT.md']
```

## 8. 테스트(플랫폼 자체)

`node --test` + fixture(`fixtures/<platform>/<app>/<name>.{xml,png,meta.json}`) + Jev replay. 반드시 다룰 것: 가림 정답(my-flight-sheet), 반복 행 비병합(search-results), 키보드 제거(iOS search-results-keyboard), 희소 트리(ios/kroute, ios/granite), RedBox(android/ticketestimate), 로딩(android/easyway), Compose(android/example-tickets), 응답 검증 거부 사례, 게이트 경계, 위험 정책(떠남 `내 항공편 지우기`, example-tickets `Remove`), DSL 파싱 오류, 판정 합성.

## 9. 로컬 실측 근거 (2026-09-26)

Jev 0.69s/`jev-1.13.0`/한국어 OK · Choice 255개(none 포함) OK, 256개 → HTTP 400 · UIA2 `/source` 0.01–0.12s, `drawing-order`·`window-id` 제공 · iOS Appium `/source` 0.25s → 설정 후 0.03s · 한글 입력: Android setValue·iOS WDA 모두 떠남 RN 검색 결과까지 확인 · iOS pbcopy는 호스트 클립보드 동기화에 덮임 · AXe 기본 탭은 RN에서 무반응인데 "성공" 보고 → 사후 확인 필수 · Apple Vision OCR 0.3–0.5s 한국어 정확 · 떠남 iOS 간헐 LogBox `Render Error`(AppProviders.tsx:47) 관측 · 떠남은 Metro 의존 dev 빌드(`DEBUGGABLE`, 내장 번들 없음).

## 10. 이벤트·프로그래매틱 API·엔진 서버 (UI 공통 기반)

- 이벤트 계약: `src/core/events.ts` (`QaEventBody`, `EventBus`, `EventSink`). 러너와 플래너는 모든 단계에서 이벤트를 낸다. 러너는 `.qa/runs/<runId>/events.jsonl`에도 같은 이벤트를 기록(스크린샷 필드는 run 디렉터리 기준 상대경로).
- 프로그래매틱 API (CLI·서버·UI가 모두 이것만 호출):
  - 러너 `src/runner/index.ts`: `runTests(opts: { paths: string[]; platform: Platform | 'all'; deviceIds?: Partial<Record<Platform, string>>; tags?: string[]; junit?: boolean; events?: EventSink; signal?: AbortSignal }): Promise<RunResult>` / `runSmoke(opts: { app: string; platform; deviceId?; crawl?: 'tabs'; events?; signal? })` / `inspectScreen(opts)` / `captureScreen(opts)`. `RunResult = { runId, runDir, counts: Record<Verdict, number>, qaCounts: Record<QaStatus, number>, tests: TestResult[], reportPath, junitPath, webQa: string[] }`(`webQa` = 웹 결과가 있을 때 run 기준 `web-qa/plan.json`·`result.json`). `summary.json` = `app-qa/summary/v2`(v1은 읽을 때 `surface: 'app'`·`qaStatus`·`qaCounts`를 채워 변환).
  - 플래너 `src/plan/index.ts`: `generatePlan(opts: { app: string; docs: string[]; text?: string; llm?: 'claude-cli' | 'codex-cli'; model?: string; approve?: boolean; events?: EventSink; signal?: AbortSignal }): Promise<{ planPath: string; plan: PlanFile; testFiles: string[] }>` — `text`는 UI에 직접 입력한 시나리오(가상 문서 `inline.md`로 취급).
  - 드라이버 `src/drivers/screen.ts`: `grabScreen(platform, deviceId): Promise<Uint8Array>` — Appium 세션 없이 `adb exec-out screencap -p` / `xcrun simctl io <udid> screenshot -`(라이브 화면용, 2fps 목표), `startRecording/stopRecording(platform, deviceId, file)` — `adb shell screenrecord` / `simctl io recordVideo`. 데스크톱 플랫폼은 둘 다 거부(세션 밖 화면 수단이 없음).
- 엔진 서버 `qa serve` (`src/server/*`, UI 슬라이스 담당): 127.0.0.1 전용 HTTP. `GET /api/events`(SSE, 재접속 시 `Last-Event-ID`=seq 이후 재전송), `GET/POST /api/jobs`(run|smoke|plan|calibrate 큐; 디바이스별 직렬 실행), `POST /api/jobs/:id/cancel`, `GET /api/devices`, `GET /api/devices/:platform/:id/screen`(PNG), `GET /api/apps`, `GET /api/plans`, `GET /api/plans/:app`(plan.json + 테스트 상태), `GET /api/runs`, `GET /api/runs/:runId`(summary), `GET /api/runs/:runId/files/*`(증거 파일, run 디렉터리 밖 경로 거부), `POST /api/docs`(문서 업로드 → `.qa/uploads/`). 인증: 시작 시 생성한 토큰(`.qa/server.json`, 0600)을 `Authorization: Bearer`로 요구.
- UI 클라이언트: **SwiftUI 네이티브 macOS 앱**(`mac/`, xcodegen `project.yml` → `xcodebuild`, 사용자 결정). 앱이 엔진(`node bin/qa.ts serve`)을 자식 프로세스로 띄우고 `.qa/server.json`(port, token)으로 접속. 레이아웃은 artemis Workspace 참조 — 좌: 활동 스트림(스텝·판단 근거·확률 막대·행동 좌표·오류 카드), 중: 디바이스 라이브 화면(마지막 탭 지점 오버레이)·녹화, 우: 작업 큐 / 계획(요구사항→테스트→스텝 체크리스트, 실시간 체크), 하: 새 작업 입력(시나리오 텍스트·기획서 드래그 앤 드롭·계획 생성/실행/스모크), 상단 툴바: 앱·플랫폼·디바이스·LLM 선택, 녹화, 리포트 열기. 완료 알림, 과거 실행 재생(events.jsonl), 한국어 UI, 접근성 라벨 필수(이 앱 자체도 테스트 가능해야 함).

## 11. Maestro 코드 리뷰 반영 (`docs/research/Maestro.md` §6)

- **DSL 추가**(schema.ts): `open`(딥링크), `press`(enter/back/tab/escape/delete), `longPress`(+`holdMs`), `hideKeyboard`(보일 때만, 확인), `clear`, `type.append/submit`, 셀렉터 `{intent|text|desc|id(문자열=정확 일치, {regex})}` + `state{enabled,checked,selected,focused}`, `remember{name, from}` → 이후 모든 문자열에서 `${name}`, `use: *.flow.yaml`(+`with`), 테스트 `setup`/`teardown`(teardown은 항상 실행·판정 불변·경고로 보고), 스텝별 `platforms`, `repeat{times≤10 | while}`(예산 적용), `location{lat,lon}`, `launch{reset, permissions, arguments}`. 문자열의 `${ENV}`/`${remembered}`는 모든 스텝에서 실행 시 치환.
- **러너 규칙**: 대기 기한은 마지막 변경 행동 시각부터 계산(`timeout − (now − lastActionAt)`), 직전 스텝이 scroll/swipe/back이면 대상 rect가 연속 2회 관찰에서 같을 때까지(100ms 폴링, 최대 3s) 기다린 뒤 탭 — 3s 안에 안정되지 않으면 FAIL `stale_target`(탭 안 함), not_found 진단(`within` 컨테이너 일치 여부, 화면 다른 곳의 일치 수), 증거 `manifest.json`(버전·kind·상대경로·크기), 크래시 FAIL 시 `crashArtifacts` 첨부. 이벤트 `action.kind`는 DSL 행동을 그대로 표현한다(longPress, press, clear, hideKeyboard, open, location 포함; 다른 종류로 대체 금지).
- **드라이버**: iOS `snapshotMaxDepth: 70` + `depthCapped` 기록, iOS clear = 재설치 + `simctl keychain reset`, 권한은 명시적으로만(기본 부여 금지).
- **거부(버그 원인)**: 무변화 시 탭 재시도, 변경 스텝 재실행 `retry`, 빈 iOS back, 무조건 BACK인 hideKeyboard, 스크린샷 SHA 동일성 기반 settle, 정규식 전체 일치를 기본 문자열 매칭으로 쓰는 것, AI 판정을 기본 경고 처리, 기본 권한 전부 허용.

## 12. 웹 대상 (`docs/reviews/web-architecture-2026-09-26.md`)

- **결정**: 한 파이프라인(DSL·러너·정책·commit 확인·정제기·리포트·플래너), 나누는 곳은 드라이버와 관찰 파서. Opus 5.5·GPT-6 sol 적대적 리뷰(같은 잣대) 후 채택: 모바일 웹 = 기기 브라우저 앱을 네이티브 드라이버로(접근성 트리), 데스크톱 = Appium chromium 3.1.1 / safari 5.0.10 W3C, 플랫폼 = `android | ios | desktop-chrome | desktop-safari` + 프로필 `web`.
- **프로필**: `web: {url, origins?(기본 = url의 origin), viewport(기본 1280×800, 데스크톱만), platforms?}` — `android`/`ios`와 함께 쓸 수 없다. `profilePlatforms(profile)`가 `all`의 뜻을 정한다. 대상은 `WebTarget{appId = PLATFORM_INFO[p].browser, url, origins, viewport}`.
- **관찰**: 데스크톱은 `WEB_EXTRACT_SCRIPT`(읽기 전용; DOM 평탄화, 가시성, 접근 이름 근사, 비밀번호 값은 •로만, `elementFromPoint`로 덮는 층 = `occluder`) → `webSourceFromExtract`(zod 검증, UIA2 유사 XML, `password="true"`) → `parseWebSource`(occluder는 모든 비-occluder 위, clickable). 모바일 웹은 기존 Android/iOS 파서 + `surface: 'web'`: 브라우저 UI(Android `com.android.chrome:id/*`, iOS WebView 밖, iOS 상태 막대 띠)는 후보·텍스트에서 빼되 가림에는 참여(OCR 보완 결과에도 같은 제외). 데스크톱 추출은 `<body>` 바로 아래 텍스트와 방출되지 않는 래퍼 안 텍스트도 텍스트 노드로 낸다. `pageUrl` = 데스크톱 href / 모바일 주소창 텍스트.
- **드라이버**: 데스크톱 `DesktopWebDriver` — 마우스 포인터·키·휠 W3C 동작만, 값 확인은 페이지 스크립트로 읽기만, `back` = `history.length ≤ 1`이면 거부, `terminate`/`reset clear` = 세션 종료(다음 launch가 새 프로필), 권한·인자·위치 = 거부, Safari 콘솔 로그 미지원. 세션 종료·시작을 확인하지 못하면 `uncertain`이고 그 드라이버는 화면 상태를 모르는 채로 남아 새 세션을 열지 않는다 — 러너는 남은 데스크톱 작업(테스트·스모크·캡처)을 ERROR `display_unknown`(BLOCKED)으로 멈춘다. Safari는 앞에 있는 창만 입력을 받으므로(실측) 실제 입력 전에 `document.hasFocus()`를 보고 창을 올리며(W3C Switch To Window), 끝내 포커스가 없으면 보내지 않고 거부한다. Android Chrome — `qa setup --browsers`가 FRE 플래그(`set-debug-app` + command-line 파일)와 알림 권한을 준비, `open`은 확인만, localhost는 소유한 `adb reverse`만 만들고 지움, VIEW 인텐트는 같은 탭 재사용, `reset clear` = `pm clear` + 재준비, 웹 hideKeyboard = ESC 금지(검색창을 지움)·BACK 직전 재확인·주소 바뀌면 `uncertain`. iOS Safari — 시뮬레이터만, `simctl openurl`(새 탭), `back` = 활성 `BackButton`만, hideKeyboard = 입력 막대의 완료 버튼, `reset clear` = Safari 웹사이트 데이터 삭제(iOS 26.5 시뮬레이터에서 쿠키·localStorage 삭제 실측).
- **실측으로 고친 것**: 데스크톱 Chrome·Safari를 동시에 돌리면 앞에 있는 창만 입력을 받아 Safari 클릭이 무시됨 → 데스크톱 브라우저는 한 번에 하나: 한 실행 안에서는 한 줄(lane), 서버 큐에서는 `desktop:display` 점유, 프로세스 사이에서는 공통 디스플레이 잠금. Safari 26은 같은 wheel 입력원으로는 첫 스크롤만 반영 → 스크롤마다 새 입력원 id. Appium을 여러 슬롯이 동시에 띄우면 EADDRINUSE → 프로세스 안 single flight + 포트별 시작 잠금. iOS Safari에서 점 기준 `hittable`은 전체 화면 브라우저 컨테이너를 가리킴 → 대상 상자와 정확히 같은 요소의 `hittable`. Android Chrome은 `<label>`과 입력 필드의 연결을 트리에 남기지 않음 → 웹 화면에서 이름 없는 입력 필드는 바로 왼쪽(같은 줄)·바로 위의 유일한 라벨 문구를 이름으로 씀.
- **러너**: 웹 `launch`/`open` 뒤 내용이 보일 때까지 settle(끝내 비면 ERROR `page_not_ready`), health = `page_load_error`(Chrome `ERR_*`, Safari 오류 문구)·`origin_mismatch`, `open`은 origins 밖이면 `allowRisky`와 무관하게 차단. 입력/지우기 대상 해석은 같은 라벨 중 편집 가능한 후보로, 탭은 같은 라벨 중 유일한 행동 가능 후보로 좁힌다(없으면 그대로 두어 `not_editable` 등 진단 유지).
- **Jev**: commit 게이트는 표면별(앱 0.47, 웹 0.20). 웹 임계값은 탐색 81건에서 찾고 새 페이지·새 라벨 홀드아웃 57건(확신 오답 0, 오경보 2/39)으로 재조정 없이 확인한 뒤 기록. 알려진 웹 오경보: `로그인`(p≈0.27–0.31) — 테스트에서 사람이 `allowRisky`로 승인한다.
- **결과**: `Verdict` 유지 + 파생 `qaStatus`(PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED, INCONCLUSIVE 유지), 웹 대상이 있는 실행은 `<run>/web-qa/{plan,result}.json`(web-qa-skill check-run v1; INCONCLUSIVE → FAIL, ERROR → BLOCKED).
- **범위 밖**: 뷰포트 여러 개의 매트릭스(프로필당 하나), 실기기 iPhone Safari, Explorer, 웹뷰(context 전환) 관찰.
