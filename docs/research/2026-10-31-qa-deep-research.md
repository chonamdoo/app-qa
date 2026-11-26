# QAutra/app-qa: Ego 수준의 시나리오 실행과 크로스플랫폼 QA 제안

2026-10-31 조사·독립 적대적 리뷰 2건을 반영한 최종안. **기존 에픽의 방향을 유지한다. 새 planner·필수 모델·DSL·통합 자동화 제품을 추가할 근거는 없다.** 필요한 일은 진행 중 B02의 실행 경로를 완성하고, Ego 목표에 맞는 관찰 비용과 정확성 검증을 기존 B02/B06/B08/B09/B10에 구체화하는 것이다. 최종 결론은 [로컬 에픽](../plans/2026-10-28-isolated-agent-qa-epic.md)의 D02·Q02·재사용 판단·성능 비교에 반영했다. 제품 코드·에픽 완료 상태·GitHub 이슈 본문은 변경하지 않았다.

## 1. 읽은 범위와 기준

- [에픽 #2](https://github.com/chonamdoo/app-qa/issues/2), 로컬 `docs/plans/2026-10-28-isolated-agent-qa-epic.md`의 갱신 전 1–610행 전체를 조사했다: D01–D14, Q01–Q16, B01–B10, R01–R11. 이번 최종 반영에서도 해당 식별자·작업 단위·완료 체크 상태를 유지했다.
- leader 기준 `86d5685651ede2bec57000c9b36e32d4ac5ea217`과 별도로, 실제 개발 중 `feat/qautra-b02` worktree의 `src/core/agent.ts`, `agent-client.ts`, `src/runner/agent-sessions.ts`, `agent-scripts.ts`, `engine.ts`, `src/drivers/desktop.ts`, B01 계약을 읽었다. B02는 다른 작업에서 수정 중인 미고정 소스다. 아래 줄 번호는 조사 시점 기준이며 완료/merge 여부를 의미하지 않는다.
- [web-qa-skill](https://github.com/chonamdoo/web-qa-skill/tree/c00d98c96ef60f875ada046776d9d4ecbceb5c15): `c00d98c96ef60f875ada046776d9d4ecbceb5c15`.
- [tester-army/e2e](https://github.com/tester-army/e2e/tree/1840b074f185c4d9e3e0af0a7e51245ec911f473): `1840b074f185c4d9e3e0af0a7e51245ec911f473`, source package `e2e@0.22.0`. npm 배포물과 동일성은 확인 안 함.
- `/Users/namdoo/Downloads/moru-artemis-main.zip`: SHA256 `1e5084c82c18585536b1a33a8ee00dafc2570599b7c845f5134cbc5091caeaf6`. 원본 ZIP을 읽었고 실행/설치하지 않았다. 원격 main과 동일성은 확인 안 함. 이하 `Z/`는 ZIP의 `moru-artemis-main/`이다.
- [Ego 공개 SDK](https://github.com/citrolabs/ego-lite/tree/12407167f84a58af24044f072868051952131491): `12407167f84a58af24044f072868051952131491`. 설치된 런타임을 직접 실행했다. 공개 SDK SHA가 설치 바이너리의 정확한 소스라는 주장은 하지 않는다.
- Apple, Android, Appium, Playwright 공식 문서를 대조했다. 공식 문서의 가능성과 현재 app-qa 지원은 구분했다.

**검증 한계:** 실제 고객 앱, app-qa의 여섯 target, 실기기, 병렬 처리량, QA 결함 탐지율은 이번에 실행 검증하지 않았다. leader의 `node bin/qa.ts doctor`는 worktree 정책에 차단되어 실행되지 않았다. 별도 진행 중 구현을 재시작하거나 수정하지 않았다. 실제 실행 증거는 아래 Ego 합성 브라우저 실험이다. 정적 실패 경로는 실행 재현과 구분한다.

## 2. 사용자가 이해한 제품 흐름은 맞다

현재 Claude/Codex에 시나리오를 주면, 기존 스킬과 AI가 프로젝트를 읽어 JS/TS·앱 조작 코드를 작성하고, app-qa의 공통 실행 관리자가 대상 준비·관찰·입력·대기·assertion·증거·정리를 맡는 방향이다. 매 클릭마다 별도 모델을 호출하는 제품이 아니다.

웹과 native에 **같은 시나리오 ID·기대 결과·데이터**를 적용하되, 모든 플랫폼에 똑같은 locator와 입력 코드를 강제하지 않는다. `script completed`, 클릭 성공, 화면 변화, runner exit 0은 업무 PASS가 아니다. 업무 기대 결과와 필수 실행 범위, 정리 상태까지 대조해야 한다. 모두 기존 Q01/Q07/Q10/Q11이다.

### 진행 중 구현을 없는 것으로 판단하지 않기

B02에는 이미 공통 request schema, `session.open/observe/screenshot/act/wait/status/close`, JS/TS script worker, CLI/MCP/SDK 연결이 있다. `modelRequired:false`, 실행 상태 `completed/failed/cancelled/unknown`과 세션 revision도 있다. 따라서 “MCP를 새로 만들자”는 제안은 제외한다.

현재 직접 실행 권한은 **제품 소유 합성 fixture** 범위다. 고객 프로젝트의 일반 실행 권한이 완성됐다고 볼 수 없다. `webview:false`, `recording:false`, exclusive display/device capability도 명시돼 있다. native fixture나 한 target 성공을 여섯 target 전체 지원으로 확대하면 안 된다.

## 3. 업데이트된 Ego: 실제 확인과 목표의 의미

### 버전과 중요한 계약

`ego-browser --version` 결과: **ego-browser 0.6.2.5 / Chromium 156.0.8078.74 / Node v24.22.1**. `ego-browser skill`은 usage guide **v2.2.0**이다. 바이너리 버전·guide 버전·GitHub release/SDK package 버전은 다른 번호다.

[현재 SDK 계약](https://github.com/citrolabs/ego-lite/blob/12407167f84a58af24044f072868051952131491/package/ego-browser/README.md):

- TaskSpace/Page는 여러 CLI 호출 사이에 유지된다. 한 호출 안에서 여러 동작과 조건 대기를 묶는다.
- 의미 관찰은 snapshot, 시각 확인은 screenshot으로 나눈다. 매번 둘 다 수집하라는 API가 아니다.
- 기본 snapshot은 viewport다. full-page/subtree가 별도이며, 아래 접힌 내용을 “없음”으로 해석하면 안 된다.
- ref는 frame/document/backend node에 연결된다. 변경되지 않은 node의 ref는 다음 동작/라운드에도 유지할 수 있지만, 교체·navigation·해결 불가 ref는 stale 처리한다. 이름이 같은 다른 node로 몰래 복구하지 않는다.
- 입력 receipt는 dispatch 결과이지 업무 성공이 아니다. `fill`은 최종 문자열의 업무 의미까지 보증하지 않는다.
- native browser runtime이 snapshot/transport를 제공한다. 공개 MIT SDK를 복사하면 모든 성능을 복제할 수 있다는 근거는 없다.
- TaskSpace는 작업 탭 경계다. 설치 스킬의 `references/clearing-state.md`는 같은 profile의 cookie/cache를 사용자 탭·다른 TaskSpace와 공유한다고 명시한다. QAutra의 계정·저장소 격리 대체재가 아니다.

### 실제 smoke와 짧은 측정

Apple M5 Pro, RAM 48 GiB, darwin 25.6.0 arm64. 자체 생성 data URL 페이지: input 1개, 확인 버튼 1개, 추가 버튼 200개. viewport 1900×953 CSS px, devicePixelRatio 2. 외부 서비스·개인 탭·계정·쿠키를 사용하지 않았다.

한 Node 호출 내 warm 측정, 항목별 15회. 측정값은 helper 호출 시간이며 모델 사고·전체 도구 왕복·프로세스 cold start·세션 준비는 포함하지 않는다. 병렬 개발 작업이 있는 호스트에서 측정했으며 통제된 성능 시험이 아니다.

| 작업 | n | 최소 ms | 중앙값 ms | 최대 ms |
| --- | ---: | ---: | ---: | ---: |
| viewport snapshot | 15 | 5.05 | 6.20 | 8.64 |
| full-page snapshot | 15 | 5.04 | 6.19 | 6.84 |
| screenshot 생성 | 15 | 59.11 | 100.79 | 103.92 |
| fill → click → 결과 조건 wait → snapshot | 15 | 65.35 | 67.18 | 72.38 |

최종 snapshot 문자열은 viewport 3,266 bytes, full-page 9,154 bytes였다. 각 batch는 지정한 `결과: QA N`과 클릭 `isTrusted:true`를 확인했다. 한글 입력 결과 screenshot도 직접 읽었다. 이는 **한글 IME 조합 검증이 아니다**. `isTrusted`도 모든 입력·모바일 gesture의 동등성을 증명하지 않는다.

탐색 과정에는 두 오류가 있었다: `task.cdp('Browser.getVersion')`는 지원되지 않았고, 결과가 변경된 output의 이전 `@3` ref로 subtree를 읽으려 하자 `Stale ref`가 발생했다. 이를 숨기거나 전체 도구 호출 성공률 100%로 보고하지 않는다. 별도의 측정 반복 15회는 완료됐다. 마지막 결과를 확인하고 생성한 TaskSpace만 `finish({keep:[]})`로 닫았다.

**해석:** 이 fixture에서는 screenshot이 semantic snapshot보다 비쌌다. 앱 전체 성능이나 app-qa 대비 배수는 알 수 없다. 공개 Ego README의 vendor benchmark도 QAutra·모바일에 대한 독립 증거가 아니다. “전 플랫폼 100ms” 같은 근거 없는 합격선은 만들지 않는다.

## 4. 세 자료에서 취할 것과 버릴 것

| 자료 | 실제 가치 | 현재 채택 결론 | 이유/제약 |
| --- | --- | --- | --- |
| web-qa-skill | 요구사항·UI 조사, risk-based matrix, 사전 required, evidence/negative control, cleanup 대조 절차 | 현재 AI의 절차로 유지 | runner가 아니다. `check-run`은 제공 기록/해시의 구조를 검사하며 실행 사실·업무 oracle·cleanup을 대신 증명하지 않는다. 이미 에픽에 포함 |
| tester-army/e2e | deterministic locator/expect, fixture, 기존 테스트 실행·trace | **핵심 전체 도입 보류**. 실제 재사용할 기존 suite가 있을 때 공개 `run()` 또는 worker의 `openHost()` 평가 | B02가 이미 자체 경로를 구현 중이다. 새 owner/worker를 추가할 순편익은 아직 측정되지 않았다. MCP `run_code`는 제한 grammar parser이지 일반 JS 실행기가 아님 |
| Moru host adapter | screenshot 없는 요소 관찰, bounded wait/scroll, exact selector 중복 거부, 짧은 증거 구간 표시 | 구현 패턴만 참고. Python server/자율 multi-agent 도입 안 함 | Android 전용 17개 host-driven tools. iOS/actual Safari/desktop/mobile-web 공통 실행기가 아님. 세션 lease/영속 action journal도 없음 |
| Ego | 한 세션에서 코드 묶음, 작은 관찰, 정확한 refs, 조건 wait, 빠른 피드백 | UX/성능 비교 기준 | 실제 Safari·native driver·storage isolation·QA verdict를 제공하는 공통 기반으로 오해하지 않음 |

### e2e 채택 전에 반드시 알고 있어야 하는 사실

[고정 MCP 문서](https://github.com/tester-army/e2e/blob/1840b074f185c4d9e3e0af0a7e51245ec911f473/docs/reference/mcp.mdx), [hosted runner](https://github.com/tester-army/e2e/blob/1840b074f185c4d9e3e0af0a7e51245ec911f473/docs/reference/runner.mdx):

- deterministic fixture/expect와 no-model interactive 경로는 존재한다. built-in `agent` fixture는 별도 model preflight를 한다. 모든 SDK 호출이 모델 무호출인 것은 아니다.
- MCP 세션은 stdio 서버 수명에 종속된다. registry 기본 4/최대 16은 독립 기기·영속 복구·처리량 보증이 아니다. 공개 hosted attempt는 프로세스당 한 개이므로 병렬이면 worker 경계가 필요하다.
- `test_lines`는 성공한 일부 동작의 초안이다. 실패 action·point action 등은 완전하게 재현되지 않고 업무 assertion도 자동 완성되지 않는다.
- upstream은 retry attempt와 `flaky`를 보존한다. “원래 실패를 모두 삭제한다”는 비판은 틀리다. 다만 flaky가 exit 0일 수 있어 raw exit를 PASS로 매핑하면 안 된다.
- adaptive cache는 다른 경로로 agent가 이어갈 수 있다. strict cache만으로 무모델·경로 불변·무재시도가 보장되지 않는다.
- web launch는 Chromium/Firefox/WebKit이다. actual branded Chrome은 별도 채널/연결 확인이 필요하고, WebKit은 actual Safari가 아니다. mobile `app.url`은 거부된다: [engine.ts](https://github.com/tester-army/e2e/blob/1840b074f185c4d9e3e0af0a7e51245ec911f473/packages/mobile/src/engine.ts#L99-L126).
- mobile dispose의 session-close 오류를 삼키는 경로가 있다: [surface.ts](https://github.com/tester-army/e2e/blob/1840b074f185c4d9e3e0af0a7e51245ec911f473/packages/mobile/src/surface.ts#L737-L771). 종료 확인·기기 반환은 상위 관리자가 검증해야 한다. 실제 고아 session은 이번에 재현하지 않았다.

### Moru 원본에서 확인한 이식 금지 항목

정적 소스 경로이며 실제 기기에서 재현하지 않았다.

- 최초 관찰의 UIAutomator 연결이 Maestro 설치를 확인하고 제거할 수 있다. `Z/third_party/mobile_use/clients/ui_automator_client.py:195-305`. readOnlyHint는 부수효과를 막지 않는다. 자동 제거를 가져오지 않는다.
- malformed XML을 `[]`로 바꾸고 absent wait가 이를 참으로 받을 수 있다. 같은 파일 `102-108`, `Z/moru_elements.py:138-155`. 관찰 오류와 정상 부재를 합치지 않는다.
- 필터 결과는 64 nodes/4 KiB로 잘리지만 축약 metadata가 없다. `Z/moru_mcp.py:156-176,234-244`. 전체 inventory나 absence 증거로 사용하지 않는다.
- 입력은 Android clipboard paste → ADBKeyboard → native ADB input으로 전환할 수 있다. `Z/artemis/drivers/android/adb_driver.py:307-367`. 실제 IME 검사와 구별하며 clipboard·설정 변경을 숨기지 않는다.
- 좌표 입력에 app-qa 수준의 revision/identity/가림 재검증·lease가 없다. screenshot과 hierarchy도 원자적 같은 시점이 아니다.
- `record_frames`는 1–10초/1–4fps/최대16장이다. 합성 시각 라벨·샘플링·원본 삭제 특성 때문에 frame-perfect animation 검증이나 forensic replay 대체가 아니다.
- `gfxinfo`는 Android rendering 진단이다. Ego 도구 응답 성능이나 웹/iOS 공통 성능 지표가 아니다. 0 frames에서 jank 0%를 건강한 성능으로 해석하면 안 된다.
- 정적 pixel diff는 실제 구현돼 있다. MORU-MCP.md 말미의 “diff 없음” 문구보다 코드를 우선한다. diff는 명시 non-verdict이며 업무 assertion 대체가 아니다.

라이선스: e2e/Moru는 Apache-2.0 LICENSE·NOTICE·수정 표시와 실제 포함 의존성 검토가 필요하다. Ego 공개 SDK는 MIT이나 별도 native browser 전체가 MIT라는 의미가 아니다. web-qa-skill 고정 tree에는 permissive 허가를 확인하지 못했으므로 절차 참조와 복사·번들을 구분한다. B01에서 이미 다루는 채택 조건이며 새 라이선스 시스템을 제안하지 않는다.

## 5. 남길 개선안: 큰 기능 추가가 아니라 기존 작업의 구체화

### A. Ego 비교를 B02/B10의 동일 조건 측정으로 만든다 — 우선

**문제:** “Ego처럼 빠르다”는 목표만 있고 현재 동일 작업의 app-qa 수치가 없다. 이번 단일 fixture의 67.18ms를 서비스 SLA로 삼을 수 없다.

**최소 변경:** B02의 최소 사용자 흐름을 완성하면서, 기존 합성 fixture의 세션 준비·observe·입력·wait·assert·close 비용을 함께 측정한다. benchmark 전체 완성을 기능 개발의 선행 조건으로 두지 않는다. navigation·popup·frame·ref 교체·큰 페이지는 해당 경로를 검증할 때 비교 사례에 포함하며, 비교표를 채우기 위한 신규 지원을 만들지 않는다. actual Chrome과 Ego는 같은 업무·입력·필수 증거 조건 및 각각의 browser version을 기록해 비교하고, Safari/native는 각 플랫폼의 직접 driver 비용을 별도 기준선으로 둔다. 자동화 도구 시간과 native 앱 rendering frame time을 혼합하지 않는다.

**영향:** 기존 smoke/benchmark harness와 B10 완료 증거. runner 교체·추가 모델·고객 데이터 필요 없음.

**장점:** 구조 변경 전 병목과 투자 효과를 구분한다. **단점:** cold/warm·관찰 범위·trace/screenshot 정책이 다르면 수치가 무의미하다.

**수용 기준:** 같은 fixture/build/host/viewport/data와 안전·증거 조건, cold/warm 분리, raw samples 및 p50/p95·오류·false PASS·출력 크기 보존. 최종 사용자 시간에는 모델/transport/준비/복구/사람 개입도 포함한다. 속도를 위해 업무 oracle·freshness·필수 evidence를 줄이지 않는다. 비교 가능한 데이터가 나오기 전 동등 성능 완료 선언은 금지한다. 숫자 합격선은 근거 없이 제안하지 않는다.

Ego의 결과 조건 wait와 app-qa의 settle·health·증거 기록은 같은 완료 조건이 아니다. 현재 `engine.ts:108-110,1085-1147`에는 변경 확인 polling 150ms, 안정 확인 간격 250ms, 별도 부재 유지 간격 500ms가 있다. 모두 모든 동작에 무조건 더해지는 값은 아니며, 정적 설정이지 이번에 측정한 실제 실행시간도 아니다. 이 안전·안정화 계약을 제거해 67.18ms에 맞추는 것은 제안하지 않는다. 하부 driver/helper 비용과 동일 QA 보장을 제공하는 업무 완료시간을 별도 보고한다.

### B. 후보별 순차 identity RPC를 측정할 최적화 후보로 남긴다 — 구현 채택 보류

**소스 사실:** `src/runner/agent-sessions.ts:187-218`은 매 관찰마다 screenshot/PNG decode, 전체 candidate map과 UUID, source/elements 파일을 만든다. `199`행에서 조작 후보마다 `await driver.elementIdAt(...)`를 순차 호출한다. desktop 구현 `src/drivers/desktop.ts:568-573`은 호출당 WebDriver `executeScript`다. act/wait 뒤에도 `observe`가 다시 수행된다(`agent-sessions.ts:392,397`). native 모든 adapter가 같은 RPC 비용을 가진다는 뜻은 아니다.

**최소 변경:** A에서 후보별 identity 조회의 관찰 시간 및 전체 업무 완료시간 기여도를 측정한다. 동일 업무·안전·증거 조건에서 개선 필요성과 기대 순편익이 확인될 때만, desktop 관찰의 identity 수집을 같은 응답/하나의 bulk RPC로 묶는 방식을 검토한다. 유의한 개선 필요성이 없으면 현재 구현을 유지한다. dispatch 직전 해당 target의 identity·geometry·가림·활성 상태 검사는 유지한다. 병렬 N개 RPC 발사로 드라이버 부하만 옮기는 방식은 선택하지 않는다.

**영향:** `src/observe/web.ts`, `src/drivers/desktop.ts`, `src/runner/agent-sessions.ts`의 관찰/identity 경계와 관련 계약. API 전체나 모바일 driver를 무조건 바꾸지 않는다.

**장점:** 후보 수에 비례하는 transport 왕복을 줄인다. **단점/위험:** source 추출과 identity의 시점·frame·좌표 대응이 어긋나면 잘못된 입력이 생긴다. Chromium과 actual Safari에서 각각 검증해야 한다.

**수용 기준:** 호출 수 감소는 구조 지표이며 성능 개선 자체의 합격 기준이 아니다. 동일 조건의 변경 전후 관찰 시간·업무 완료시간·오류·안전 거부 결과와 구현/플랫폼 검증 부담을 함께 보고 채택한다. bulk 방식을 택한다면 identity transport 호출 수가 후보 수에 비례하지 않는지도 확인한다. 같은 이름의 node 교체·overlay·navigation·rotation·취소 후 mutation의 기존 거부와 업무 결과·필수 증거를 유지한다. 개선량은 아직 확인 안 함이며, 이 최적화를 하지 않았다는 이유만으로 B02 완료를 막지 않는다.

**지금 하지 않을 확장:** screenshot을 무조건 제거하거나 모든 ref를 영구 보관하지 않는다. 현재 B02 screenshot은 안전·증거 계약에도 연결되어 있다. Ego식 의미 관찰/시각 관찰 분리와 stable ref는 각각의 비용·필요성과 identity/invalidation 보존 가능성이 확인될 때 별도 검토한다. 단순히 시간이 지났다는 이유 또는 같은 label이라는 이유로 ref를 재사용하지 않는다.

### C. 관찰 범위를 명시하고 부분 관찰을 전체 부재로 해석하지 않는다 — 정확성 우선

**소스 사실:** B02 `AgentObservation`은 candidates/texts/화면/truncated/screenshot을 반환한다. desktop `WEB_EXTRACT_SCRIPT`는 viewport에 걸친 node만 추출하고 iframe/canvas 등을 leaf로 다룬다(`src/observe/web.ts:54-69,173-239`). open shadow root/slot 탐색은 이미 구현돼 있다(`75-94`); 이를 신규 기능으로 제안하지 않는다. `truncated:false`는 CAP에 안 걸렸다는 뜻이지 모든 frame·전체 페이지의 관찰 완료 증명이 아니다.

**이미 있는 보호:** `src/runner/engine.ts:194-199,1247-1249,1280-1282,1509-1512`는 `depthCapped` 관찰에서 부재를 PASS로 판정하지 않으며 `src/runner/prepare.ts:272-276`은 잘린 관찰의 대상 기반 mutation을 거부한다. B02는 이 경로를 재사용한다. CAP/depth 초과 차단은 신규 구현이 아니라 보존할 회귀 조건이다. Moru의 malformed XML→빈 배열 동작도 app-qa의 결함으로 옮겨 주장하지 않는다. 여기서 남는 쟁점은 truncation과 다른 viewport/frame/표면의 범위를 AI와 assertion 소비자에게 정확히 전달하는 것이다.

**최소 변경:** 기존 관찰 결과/스킬 계약에서 viewport 범위, 미관찰 frame/표면, 수집 실패/축약을 구별한다. 현재 관찰 영역에서 보이지 않는다는 결과와 전체 화면/페이지/업무 상태에서 존재하지 않는다는 주장을 구분한다. 필요한 frame이 지원되지 않으면 해당 assertion을 BLOCKED/판단 불가로 남긴다. 모든 iframe/canvas/WebView engine을 지금 구현하자는 뜻이 아니다.

**영향:** `src/core/agent.ts`, `src/observe/web.ts`, session 결과, skill의 해석, absence/coverage assertion과 report. 기존 Q02/Q07/Q10을 구체화한다.

**장점:** 작은 관찰을 유지하면서 거짓 coverage/absence를 막는다. **단점:** unsupported/unknown을 명시하면 표시 PASS 비율은 낮아질 수 있지만 정확성이 개선된다.

**수용 기준:** viewport에 한정한 assertion도 그 공간적 범위와 필요한 관찰 수단이 모두 충족될 때 판정한다. 관찰된 대상의 존재와 미검출 대상의 부재를 구분한다. iframe·canvas·닫힌 shadow·`aria-hidden`으로 제외된 내용은 화면 안에 있더라도 semantic 미검출만으로 시각적 부재를 입증하지 못한다. below-fold/미렌더링 virtualized 항목을 전체 페이지의 부재로 확대하지 않는다. screenshot 파일의 존재와 그 이미지로 기대 결과를 실제 검증했다는 사실도 다르다. 필수 표면·oracle을 확인할 수 없으면 해당 assertion만 BLOCKED/판단 불가로 남기고 무관한 assertion까지 차단하지 않는다. 기존 CAP/depth·잘못된 관찰 거부는 유지하며, 새 visual judge나 범용 iframe/canvas engine은 요구하지 않는다. 현재 app-qa의 false PASS를 실행 재현했다는 주장은 하지 않는다.

## 6. 여섯 대상별 검증 경계: 기존 B06/B08의 수용 사례

| 실제 target | 실행 경로 판단 | 반드시 구분할 것 |
| --- | --- | --- |
| Android native | 기존 Appium/UiAutomator2를 먼저 유지 평가 | 기기/앱 build·OS·IME·권한·회전·background/resume. emulator와 실기기는 별도 target |
| iOS native | 기존 Appium/XCUITest를 먼저 유지 평가 | Simulator와 실기기, WDA/서명, system permission/keyboard, 앱 복귀 |
| desktop Chrome | 실제 branded Chrome identity를 확인하는 adapter | Chromium 기본 launch와 구분. CDP 재사용은 소유권과 lifecycle이 맞을 때만 |
| desktop Safari | actual Safari + safaridriver | Playwright WebKit 대체 금지. [Apple 명세](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)의 macOS windowing 환경은 활성 Safari instance 하나와 WebDriver session 하나로 제한됨. 같은 환경의 인스턴스 증설로 병렬성을 가정하지 않음. glass pane를 깨서 세션을 중단하면 기존 연결이 영구 단절되며 복귀는 새 세션 경계를 따름 |
| Android Chrome | emulator/실기기의 실제 Chrome | viewport 에뮬레이션과 구분. browser toolbar·software keyboard·touch·뒤로가기·localhost 경로 확인 |
| iOS Safari | Simulator/실기기의 실제 Mobile Safari | desktop WebKit과 구분. 주소창/keyboard/viewport, OS permissions, 입력 방식과 inspector 전제 확인 |

WebView는 일곱 번째 브라우저 이름이 아니라 native↔web context 전환 요구다. accessibility-only 조작으로 입증 가능한 제한적 E2E는 유효할 수 있지만 DOM 전체 지원으로 표기하지 않는다. [Appium contexts](https://appium.io/docs/en/latest/guides/context/), [WKWebView inspectability](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)를 따른다.

**입력 방식 위험:** [XCUITest hybrid 12.22](https://appium.github.io/appium-xcuitest-driver/12.22/guides/hybrid/) 문서의 기본 web context는 Selenium atoms다. `nativeWebTap` 기본값은 false이고, Simulator용 WebKit Automation은 W3C Actions 불안정 경고가 있다. 이 최신 문서는 기술 경계 근거이며 현재 repo의 pinned XCUITest 12.13.2에 같은 새 기능이 있다는 뜻이 아니다. 새 driver 업그레이드를 이번에 제안하지 않는다.

### 적용 조건이 있을 때만 넣을 사례

- **한글 입력:** 최종 문자열 성공, software keyboard 가림, 실제 IME composition/수정/확정은 별도 assertion이다. [Playwright keyboard](https://playwright.dev/docs/api/class-keyboard#keyboard-type)는 비-US 문자에 input만 보낼 수 있다고 명시한다. paste/fill 성공으로 Q09 IME 검증 완료를 선언하지 않는다.
- **lifecycle/deep link:** 작성 중 상태 복원·로그인 복귀·딥링크가 제품 요구에 있으면 background/resume, OS process death, force-stop/quit, cold/warm link 진입을 구분한다. [Android state](https://developer.android.com/topic/libraries/architecture/saving-states), [Apple lifecycle](https://developer.apple.com/documentation/uikit/managing-your-app-s-life-cycle), [Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app). 앱 재실행 하나로 OS process death를 실증했다고 하지 않는다. 해당 기능 요구가 없으면 신규 필수 항목으로 추가하지 않는다.
- **permissions/offline/auth/upload/payment/WebView/animation:** 실제 해당 기능과 실패 위험이 있을 때 시나리오/expected result/대상만 추가한다. 모든 기기×모든 상태의 Cartesian 실행, 새 profiler·visual judge·디바이스 팜을 일괄 도입하지 않는다.

공통으로 실제 build/API/fixture identity, localhost/HMR stale 여부, 계정·기기 충돌, required 범위, cleanup을 확인한다. 모두 기존 Q05–Q16이므로 새로운 개선안 수로 세지 않는다.

## 7. 기존 에픽에 있으므로 새로 제안하지 않는 것

leader 소스에서는 별도 planner CLI, 사후 required 생성, config hash build ID, warning-only teardown, 과거 결과의 testId/platform 연결, 단일 display lock이 확인됐다. 이 차이는 에픽 Q01/Q06/Q08/Q10/Q11/Q14/Q15와 B02/B03/B07/B08/B09에 이미 적혀 있다. B02 진행 중 소스와 구분해 **기존 구현 과제**로만 남긴다.

특히 다음은 유지할 기존 완료 조건이다.

1. 사전에 고정한 필수 시나리오/target에 invalid·0개·skip·중단·누락이 있으면 분모에서 삭제하지 않는다.
2. 코드·실제 build·fixture·attempt identity가 다른 PASS를 현재 결과로 붙이지 않는다. 동일 조건이 아닌 결과를 FLAKY로 합치지 않는다.
3. 본문 제품 FAIL과 필수 cleanup 실패를 둘 다 보존한다. cleanup 실패를 제품 FAIL로 덮어쓰거나 선택적 진단 실패를 제품 결함으로 만들지 않는다.
4. 소유권·취소·결과 unknown 뒤에 자동 mutation 재전송하지 않는다. process 분리는 악성 코드 sandbox가 아니다.
5. 독립 업무 oracle과 정상 PASS → 결함 도달 → 해당 assertion FAIL → 복구 PASS의 negative control을 유지한다.
6. rerun/self-heal은 새 attempt다. assertion 약화·다른 경로로 성공한 결과로 원래 실패를 덮지 않는다.
7. source/screenshot/video/trace의 개인정보 승인·보존·전송 범위를 나눈다. 텍스트 redaction을 PNG 보호로 취급하지 않는다.

## 8. 적대적 리뷰와 최종 채택 상태

독립된 성능/구조 리뷰와 QA 정합성 리뷰를 완료했다. 두 리뷰 모두 **제안문 범위에서 Critical/High 문제와 확정 가능한 현재 app-qa false PASS는 없다고 판단**했다. 이는 제품 전체의 무결함·보안 인증이나 실행 검증 결과가 아니다. 아래 반박을 반영해 권고 범위를 줄였다.

| 적대적 반박 | 반영한 최종 결정 |
| --- | --- |
| N개 RPC가 있다는 사실만으로 지배적 병목·투자 효과를 입증할 수 없음 | B는 구현 확정에서 측정 후보로 낮춤. 업무 완료시간과 안전·증거 동등 조건의 순편익이 없으면 적용하지 않음 |
| benchmark를 먼저 완성하면 실제 사용자 흐름과 최초 증거 연결을 지연시킴 | A는 기존 B02/B08/B09 흐름과 병행. 측정표 완성을 기능 개발의 관문으로 두지 않음 |
| viewport 안에 있어도 semantic 관찰이 못 읽는 표면이 있음 | C에 공간 범위와 관찰 수단의 충분성을 분리. screenshot 존재만으로 검증 완료를 주장하지 않음 |
| CAP/depth 보호는 이미 존재하며 Moru 문제를 app-qa 결함으로 전이하면 안 됨 | 기존 보호의 회귀 조건으로만 유지. 현재 false PASS 확정 주장을 제거 |
| Safari 제한과 glass-pane 중단 조건이 축약돼 있음 | 활성 instance/session 단일성 및 실제 중단 시 영구 연결 단절로 정밀화 |

**최종 상태:** A는 기존 수용 흐름과 병행하는 측정으로 유지, B는 필요성 입증 전 구현 보류, C는 기존 관찰/판정 계약 명확화로 유지한다. e2e/Moru 핵심 도입·screenshot 제거·stable ref 재설계·새 대형 제품 기능 권고는 없다. lifecycle 등 조건부 사례도 실제 제품 요구가 없으면 추가하지 않는다.

## 9. 제안 적용 순서

1. **우선:** 진행 중 B02를 유지하며 B08/B09의 작은 흐름을 병행한다. 기존 AI·스킬의 합성 시나리오 → 웹/native 코드 작성 → 묶음 실행 → 명시적 업무 assertion → 실패 증거/읽기 전용 replay 열람 → 새 attempt 재검증 → 종료·필수 정리까지 연결한다. 새 planner·manager·replay 제품을 만들지 않는다.
2. 이 기존 흐름에서 정상 PASS → 승인된 업무 결함 도달 → 해당 assertion FAIL → 복구 PASS를 확인한다. 다른 개발자/기존 AI가 기록으로 실패 지점 또는 재현 불가 원인을 식별할 수 있어야 한다. 최초 mutation부터 증거를 남기며, 본문 FAIL과 필수 cleanup 실패를 각각 보존한다.
3. 같은 흐름에 단계별 비용 측정을 붙인다. Ego/직접 driver의 비용과 app-qa의 추가 안전·안정화·증거 비용을 분리하고, 실제 필요성과 순편익이 확인된 병목만 최적화한다. 후보별 desktop identity RPC는 그중 하나의 후보일 뿐이다.
4. B06/B08의 여섯 실제 target 수용 사례를 연결한다. IME/lifecycle/WebView 등은 실제 요구에 따라 범위를 선택한다. 관찰 범위와 수단이 충족하지 못한 assertion을 PASS로 확대하지 않는다.
5. B10에서는 이미 연결한 결과를 기반으로 누락·flaky·unknown·cleanup, 결함 탐지·잘못된 PASS·재현성·사람 총시간을 함께 평가한다. 실패·취소·결과 미확인 뒤 후속 mutation/묶음 재전송이 없음을 확인하고, 속도만으로 QA 대체 완료를 선언하지 않는다.

**현재 제외:** 새 AI planner, Moru 전체 서버, e2e 핵심 강제 도입, 추가 필수 모델, 새 DSL/CI, 전 플랫폼 동일 locator, WebKit→Safari 대체, 모든 실기기 조합, 범용 profiler, 자동 baseline 승인, 무조건 retry/self-heal. 사용자가 요청한 목표와 실제 근거에 비해 비용·위험이 크거나 기존 에픽과 중복이다.
