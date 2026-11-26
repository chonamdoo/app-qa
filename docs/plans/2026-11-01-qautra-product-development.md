# QAutra 제품 전환 · 구현 계획

기준은 [최종 제품 설계](2026-11-01-qautra-product-design-brief.md)다. 이 문서는 별도 제품 방향·화면 시안이 아니라 구현 분해와 검증 책임을 기록한다.

## 작업 연결

- 사용자 선택: 기존 B02 기록·소스를 보존해 중단하고 새 설계 제품 개발로 전환.
- 이전 run `20261031-003608`: abort 출력에서 artifacts preserved 확인. 소스/증거 삭제·reset·stash·commit 없음.
- 현재 run은 `development/20261101-053524`다. `20261101-030504`와 `20261101-042222`는 사용자 승인 후 artifacts preserved 상태로 종료했다. 같은 bound checkout `feat-qautra-b02`와 수정 내용을 재사용하며 이전 승인은 승계하지 않는다. 완료 범위는 로컬 개발·독립 리뷰·검증이고 publication/merge/deployment는 제외한다.
- 최신 Open Design ZIP은 수신·전체 검수했다. `.qa/design-review/findings.json`과 `coverage.json`의 근거를 사용해 실제 데이터에 연결한다. 이전 `docs/design/qautra-redesign/` 참고 시안을 구현 대상으로 혼동하지 않는다. 다른 attempt의 관측값 혼입·읽기 실패 시 샘플 원문 대체·URL 저장 유실을 그대로 이식하지 않는다.
- 대상 범위를 임의로 Chrome 단독·합성 fixture 제품으로 축소하지 않는다. 실제 검증에는 고객 승인 없는 자료/계정/외부 효과를 사용하지 않고 소유한 합성 환경을 쓴다. 검증 불가한 실제 대상·권한·영상은 미지원/준비 필요를 표시하고 완료로 세지 않는다.

## 유지할 경계

1. 기존 `TestSession`의 observe/resolve/prepare/risk/freshness/journal/settle/health/판정·정제 경계를 재사용한다. planner/runner/승인 서버를 중복 생성하지 않는다.
2. contracts는 `src/core/*`와 `src/spec/*`, 드라이버는 `src/drivers/*`, 실행 상태와 orchestration은 `src/runner/*`, 조회/전송은 `src/server/*`의 주입 핸들러를 따른다.
3. UI/CLI/MCP/SDK는 동일 admission·request identity·권한·자원 소유권을 통과한다. direct script fan-out도 예외가 아니다.
4. 모델 답변은 초안/분석일 뿐 회귀 판정·병렬 배치·실행 정의 변경 권한이 없다. legacy Jev는 가짜 응답/전역 allowRisky로 제거하지 않는다.
5. mutable profile/test path를 발행 revision이나 대기 작업의 유일한 실행 입력으로 쓰지 않는다. 실제 실행 bundle과 필수 검증/대상을 내용으로 고정한다.
6. 관측 revision, catalog 저장 CAS, scenario revision, 실행 attempt를 다른 식별자로 유지한다.
7. desktop은 QAutra 소유 Chrome context/profile 또는 실제 Safari의 준비된 macOS worker를 사용한다. 모바일은 기기 내부 입력을 유지한다. 호스트 foreground/전역 포인터/키보드/클립보드 경로로 fallback하지 않는다.

## 구현 분해와 소유권

### P1 — 시나리오 해석·실행본 발행

- 기존 `src/plan/{ingest,segment,index}.ts`, `src/spec/{schema,load}.ts`, `src/server/product-store.ts`를 연결한다.
- 원본 구간·TC identity·전제·단계·각 기대값·근거·지원 불가를 보존한다. 특정 열 이름/Excel 구조를 입력 요건으로 만들지 않는다.
- 해석 검토/실행 정의 검증/발행/실행 이력을 구별한다. 코드·flow·profile·assertion 변경은 기존 발행 자격을 승계하지 않는다.
- 내부 executable은 기존 TestSpec/flow의 검증 가능한 부분을 재사용한다. 모델 의존 claim/which/grounding fallback, 불명확한 expectation, 빈/필수 누락 scope는 발행 전 거부한다. natural language를 단순 text 존재로 약화하지 않는다.
- 새 불변 revision 계약은 `src/core/`에, 내용 고정과 실제 로더 연결은 기존 runner 경계에 둔다. 과거 approved 표시를 새 발행 증거로 사용하지 않는다.

### P2 — 실행 요청·시도·내구성·순서

- `src/server/jobs.ts`의 in-memory 큐와 매 enqueue 새 UUID 계약을 durable request identity·fingerprint로 확장한다. 동일 identity/내용은 기존 결과를 조회하고 다른 내용 재사용은 conflict다.
- 기본 독립 흐름 동시 상한은 1. 내부 platform fan-out도 같은 정책을 따른다. 준비·진단 보존·정리·필수 증거 저장까지 점유한다.
- 원 TC row가 아닌 chain × 실제 target × attempt로 묶고 필수 시나리오/검증/대상을 시작 전에 고정한다. 후행만 선택하면 선행 범위를 사전 확인하고 몰래 추가하지 않는다.
- 기기/worker/desktop/host service와 계정/backend/tenant/fixture 영향 범위를 함께 예약한다. 공유 backend를 로컬 잠금만으로 전역 보호한다고 표현하지 않는다.
- 재시작은 조회/복구로 시작한다. pending/running/unknown을 자동 재전송·재실행하지 않는다. lease 만료·PID 종료만으로 오염 해소를 인정하지 않는다.

### P3 — 실제 입력·초기 상태·영상

- `src/runner/instances.ts`, guest backend/native/guest 코드와 `src/drivers/{android,ios,screen}.ts`의 실제 primitives를 재사용한다.
- 자동 실행 전 hostGlobalInput=false와 실제 target/OS/runtime/version, 초기 상태/fixture, 녹화 범위·readiness를 검증한다.
- Chrome/Safari의 OS·binary·session 제약, emulator/simulator/physical identity를 보존한다. 모바일 WebView context는 웹 저장 격리 context와 다르다.
- 녹화는 첫 필수 동작 전 유효 frame부터 attempt 수명주기에 연결한다. segment·capture/action 시간·gap·finalize·회수·재생 가능성을 관리한다.
- recorder 상실은 현재 흐름의 다음 변경 dispatch부터 차단한다. live preview 단절과 필수 recorder 장애를 구분한다.
- driver/session/cleanup 종료 미확인은 원 결과와 별도로 보존하고 자원을 quarantine한다. 늦은 backend 효과까지 해소/분리되기 전 재사용 금지.

### P4 — 권한·회귀 실행·판정

- 기존 준비 단계에 trusted frozen-execution authority를 연결한다. 입력 데이터/AI/worker 코드가 권한을 생성하지 못한다.
- 직접 B02 합성 grant, 발행 자격, 고객 프로젝트 권한을 섞지 않는다. target/environment/account/fixture/effect/sink/expiry/policy를 집행할 근거가 없으면 차단한다.
- 지원 assertion의 대상/범위/연산·기대값/최소 표본/시간창을 고정하고 엔진 receipt와 필수 목록을 대조한다. code completed/true 반환으로 PASS를 만들지 않는다.
- 업무/실행 효과/증거/정리/비교 상태를 분리한다. 원 FAIL/unknown은 새 attempt의 PASS로 덮지 않는다.
- static no-model qualification과 실제 런타임 모델 호출 부재를 함께 확인한다.

### P5 — 결과·기존 호출자·Open Design 연결

- `src/report/*`, runner store, server run APIs와 Swift API models/기존 흐름이 같은 versioned snapshot을 읽게 한다.
- 과거 plan.json으로 옛 리포트를 재해석하지 않는다. legacy artifact는 원본 그대로 읽기 가능하게 두며 빠진 metadata를 현재 값으로 채우지 않는다.
- run/attempt/증거/cleanup/조건 비교와 읽기 전용 Replay, 별도 새 실행 command를 제공한다.
- import/run/control/query/export는 같은 public service를 쓴다. 화면 버튼만 있는 기능을 backend 완료로 표시하지 않는다.
- raw/redacted/AI 전송/외부 공유·보존/삭제를 분리하고 현재 정책을 전송 시 재확인한다.
- Open Design 시안 수신·검수 조건은 충족됐다. 화면 적용은 확정 실행·저장·권한 계약에 연결하며, 시안의 샘플 상태를 실제 엔진 지원 증거로 쓰지 않는다.

## 아키텍처 변경 처리

사용자는 최종 설계로 규범 전환을 승인했다. 기존 run을 기록 보존 종료한 뒤 local architecture 요약의 입력 경계와 상세 §14를 갱신했다. 현재 run은 snapshot `124a97540b06d4e0b1a9210c042fa085e2cece72e05be3a617386ed36f95f5fc`를 새로 고정했다. B02 합성 전용 grant와 일반 프로젝트 grant를 분리하고 기존 위험·freshness·journal·unknown 보호를 유지한다. 활성 run의 pins나 drift baseline을 임의로 바꾸지 않는다. 추가 규범 변경은 runtime의 실제 확인 절차를 따르며 화면/문구만 바꿔 safety boundary를 제거하지 않는다.

## 검증 책임과 실행 계획

- 구현 작성 중 형식 검사/테스트를 여러 writer가 중복 실행하지 않는다. 통합 담당자가 작성 완료 후 한 번 실행한다.
- 기존 단위·계약 테스트에서 consumer-visible 발행/범위/중복/unknown/정리·증거 경계를 보강한다. wiring/source-text/단순 forwarding 테스트를 새로 만들지 않는다.
- 지원되는 실제 CLI/server 및 소유 fixture에서 입력→발행→실제 대상→결함 검출→영상→리포트→새 attempt/비교를 smoke한다. fake driver 성공은 실제 지원 증거가 아니다.
- 범위 누락/0개 assertion, 파일/helper drift, 중복 submit, 재시작/응답 유실, recorder 상실, partial cleanup, mixed build, 지연 commit, 타인 자원 간섭을 다룬다.
- 실제 host focus/포인터/키보드/클립보드는 준비·실행·종료·오류/OS dialog·IME에서 확인한다. 프로세스가 guest 안이라는 사실만으로 통과시키지 않는다.
- 집중 검사: `node --test --test-reporter=spec <변경 경로별 실제 test 파일>`; 통합 확인: `npx tsc --noEmit`, `npm test`; 아키텍처 확인: `agent-flow architecture-lint --profile typescript`. QA phase의 실제 명령과 exit는 `agent-flow run-command`로 기록한다.
- workflow review는 runner가 시작한 실제 독립 CLI reviewer 둘 이상으로 진행한다. in-session Task review를 공식 gate로 대체하지 않는다.

현재 이 계획 작성은 구현·플랫폼 지원·고객 QA 완료 증거가 아니다. 실제 구현 결과와 불가 항목은 해당 phase artifact에 기록한다.

## 2026-11-01 · 실제 실행 확인

### 반영한 동작

- 위험 동작 허용은 실제 action kind에 대응하는 서명된 프로젝트 범위와 결합한다. 업무상 삭제·테스트 Sink 전송의 승인과 호스트/시스템 권한 허용을 구별하고, 명시적 deny·unknown·호스트/시스템 위험은 승격하지 않는다. 같은 삭제 버튼도 read-only 범위에서는 입력 전에 차단한다.
- 발행 정의의 setup/main/teardown·중첩 flow·플랫폼 분기와 실제 startup을 따라 필수 operation을 산출한다. `type.submit`의 `press`, 실제 녹화 등 누락·중복 승인은 preflight와 submit에서 거부한다. 사전 확인은 fixture 준비나 테스트 입력을 수행하지 않는다.
- VFR 영상 전체 decode 검증이 추정 출력 time base로 정상 frame을 충돌시키던 오류를 수정했다. 원본 timestamp를 유지하는 `-fps_mode passthrough -enc_time_base demux`로 검증하며 `-xerror`·전체 decode·오류 거부는 유지한다. 기존 incomplete attempt는 정상으로 소급 변경하지 않는다.
- Native 실행 목록은 `finished`와 업무 `FAIL`을 별도로 표시한다. 실행 종료가 PASS로 보이지 않으며, 상세의 큰 실제 대상 receipt는 기본 접힌 읽기 전용 영역으로 제공한다. 일시·영상 구간은 년·월·일·시·분·초와 시간대/UTC offset을 표시한다.

### 관측한 결과

| 확인 | 실제 결과와 증거 |
| --- | --- |
| 통합 단위·계약 suite | 반복 분모·SDK·자원 정리 수정 후 `npm test`: 885개 중 881 PASS, 4 skip, 실패 0. native opt-in 4개는 별도 실행에서 통과했다. 아래 read-only 복구 추가 전의 전체 suite 결과이며, 이후 추가분은 집중 검사로 구분한다. |
| opt-in 실제 Chrome | `QA_OWNED_CHROME_FIXTURE=1 node --test --test-reporter=tap test/drivers/owned-chrome.test.ts`: 1 PASS. 입력·버튼 결과·1280×800 저장 영상·새 프로필의 localStorage 초기화를 확인했다. 검사 자체가 `open()`만 호출하고 페이지 진입을 생략하던 오류도 `launch()` 순서로 수정했다. |
| 집중 검사 | 위험/준비 26, 회귀 실행 44, 영상 4, admission 24 PASS. 정상 VFR의 failing-before/passing-after와 손상 영상 거부를 포함한다. |
| 타입·Native 빌드 | `npx tsc --noEmit` 및 `bash scripts/build-mac.sh` 성공. guest 영상 코드의 AVFoundation deprecated API 경고는 남아 있다. |
| 실제 보호된 로컬 fixture | `.qa/product-smoke/2026-11-01T16-10-35.234Z/`: 필수 검증 7/7의 새 attempt PASS 2회, 의도한 기대값 불일치 FAIL 1회, read-only 삭제 차단 1회. 네 attempt 모두 영상 ready·정리 confirmed·조건 verified. backend 삭제는 승인된 세 attempt에서만 총 3회 발생했다. |
| 중복·사전 차단 | 동일 request UUID는 동일 실행을 조회했다. `type` 승인을 제거한 preflight/submit은 차단됐고 fixture 준비 횟수는 4회로 유지됐다. |
| Native 실제 조회 | `.qa/native-smoke/live-result-video/`: 실제 debug app에서 실패 행→선택 attempt→저장 영상 조회, 리포트·증거 보관함 이동을 확인했다. AVPlayer/item `readyToPlay`, rate 1, 재생 위치 약 2.64초를 관측했다. 정상 종료했다. |

### 이 결과가 입증하지 않는 것

- 위 실행은 소유한 localhost fixture다. 실제 회사 backend·계정·기획 TC·배포 build의 검증이나 고객 프로젝트 권한 발급 완료가 아니다. fixture의 선언된 build material 비교를 회사의 실제 build attestation으로 표현하지 않는다.
- Native 확인은 자체 창 OCR·로컬 Cocoa 이벤트·공개 AVPlayer API를 사용했다. 재생 호출은 AVPlayer API로 수행했으며, 사용자 재생 컨트롤 클릭 검증은 아니다. 자체 창 bitmap에는 영상 layer가 검게 나와 실제 영상 표시 pixel은 확인하지 못했다. 영상 파일 자체는 별도로 전체 decode 검증했다.
- 최신 실제 smoke의 전후 host foreground·포인터·입력·clipboard revision은 달랐다. 사용 중인 호스트 활동과 자동화의 인과는 측정하지 못했으므로 비간섭 통과라고 하지 않는다. OS dialog·실제 IME 조합을 포함한 연속 비간섭 검증도 남아 있다.
- 준비된 실제 Safari guest/전용 Mac 및 모바일 프로젝트의 protected fixture bootstrap·enforcer는 확인하지 않았다. Native 입력 경로가 있다는 사실을 frozen 회귀 지원 완료로 승격하지 않는다.
- 원 전역 generation에 등록한 native binding·종료·영상 inventory·원 권한의 fresh backend proof를 production admission verifier에 연결했다. `execution.status`는 조회, local operator 권한이 필요한 `execution.reconcile`은 자원 대조다. 원 association이 없는 이전 기록은 PID·시간·체크박스로 복구하지 않는다.
- 실제 독립 Codex CLI reviewer 5개가 모두 `request-changes`를 반환했다. 이를 승인이나 workflow 완료로 표시하지 않는다. architecture 검사 `n/a`는 통과가 아니며 CI·병합·배포를 수행했다고 표시하지 않는다.

## 독립 CLI 리뷰 후 수정·재확인

- 시나리오·flow 입력은 `O_NONBLOCK`으로 연 뒤 정규 파일 여부를 확인한다. 실제 FIFO가 preview를 멈추던 두 경로를 failing-before/passing-after로 확인했다. FIFO를 정상 입력으로 승격하거나 자동 재시도하지 않는다.
- SDK는 공통 envelope와 `session.*`·`script.*`·`instance.*`의 메서드별 성공 결과를 공유 schema로 검사한다. session/script identity가 다른 결과도 거부한다. `request<T>`로 임의 타입을 보증하던 계약을 제거하고 메서드에서 반환 타입을 유도한다. 별도 typed facade가 없는 `scenario.*`·`regression.*`의 raw 결과는 `unknown`이며 호출자가 해당 계약으로 해석해야 한다.
- 잘못된 성공 응답은 `AgentClientError(code=invalid_response, effect=unknown)`으로 반환한다. revision을 갱신하거나 요청을 재전송하지 않는다. 실제 인증 HTTP smoke에서 null 관측 결과를 한 번 받은 뒤 이 오류와 `rememberedRevision=null`을 관측했다.
- ChromeDriver 준비의 fetch/JSON 실패에서도 실제 child의 exit를 확인한 다음 전용 프로필을 정리한다. 종료 확인 실패는 `uncertain`과 보존 경로로 남긴다. 정상 close도 프로필 삭제까지 완료한 뒤에만 확정하며, 삭제 실패 후 두 번째 close를 성공으로 바꾸지 않는다. native 종료 요청을 반복 전송하지 않는다.
- Chrome의 screencast timestamp는 paint 시각이므로 정적 화면의 새 관측 시각으로 사용하지 않는다. 실제 `Page.captureScreenshot`의 JPEG를 정적 구간과 마지막 frame에 저장하며, 전체 segment를 `encoder-observed`로 명시한다. source-clock 시작·종료 시각은 `null`이다. 오래된 frame의 timestamp를 늘리거나 가짜 frame으로 coverage를 채우지 않는다.
- 실제 SDK 검증에서 정상 action의 `step.code=null`을 공유 schema가 거부하던 불일치를 수정했다. producer 응답에 `satisfies AgentActionResult`를 적용했으며, SDK와 실제 scoped session/script·반복 assertion 집중 검사 59개가 통과했다. 정상 값을 가짜 성공 문자열로 바꾸지 않는다.
- 반복 분모 수정 당시 새 발행은 `scenario-definition/v3`·`scenario-revision/v3`였다. 고정 반복의 회차와 중첩 flow 경로를 occurrence identity에 포함하여 정적 필수 분모와 실제 결과를 맞췄다. 펼친 step·assertion은 각각 5,000개로 제한한다. 이후 아래의 명시 흐름 계약 v4로 전환했으며 이전 발행본을 현재 분모로 다시 해석하지 않는다.
- 필수 검증 중 확정 FAIL이 발생하면 미수행 나머지를 성공으로 채우지 않되, 독립 흐름은 계속할 수 있다. 효과 미확인·증거 미완료·정리 미확인·PASS 분모 누락은 계속 차단한다. 실제 Chrome에서 중첩 반복의 7개 검증을 두 번 모두 구분해 기록했고, 의도한 FAIL은 2/7에서 finished, 정책 차단은 1/7에서 blocked로 분리했다.

| 수정 후 확인 | 관측 결과 |
| --- | --- |
| SDK·MCP·인증 HTTP | 20 PASS. 취소·UTF-8 framing·잘못된 결과의 상태 오염 방지를 포함한다. |
| 실제 FIFO 입력 | 2 PASS. test와 flow의 blocking open 재현이 수정 후 거부로 바뀌었다. |
| 실제 ChromeDriver 수명주기 | fetch 실패·JSON 손상·프로필 삭제 실패 3 PASS. 준비 실패의 실제 exit와 프로필 제거를 확인했다. |
| 실제 Chrome 입력·영상·새 attempt | 수명주기 검사와 함께 4 PASS. 중간 실행에서 발견한 정적 최종 frame 실패는 위 관측 시각 기반 capture로 수정한 뒤 확인했다. |
| 장시간 정적 실제 페이지 | `.qa/static-recording/691c9c14-e58e-4829-b455-16daa68c647d/`: 실제 fixture 본문을 확인한 뒤 8.617초, 11 frame, 1280×800, 전체 decode valid. 업무 PASS나 호스트 비간섭 증거는 아니다. |

공식 재리뷰·최종 gate와 OS dialog·실제 IME 조합을 포함한 전 수명주기 비간섭 검증은 남아 있다. 앞의 독립 CLI 리뷰를 수정 후 승인으로 간주하지 않는다.

## 원 권한으로만 조회하는 fixture 복구

- 새 prepare·renew의 외부 효과 전, 정확한 binding·adapter·attempt·owner를 HMAC 서명한 원 권한 archive와 v2 요청 intent를 private storage에 기록하고 fsync한다. bearer·서명 key·bootstrap cookie 값은 기록하지 않는다. audit에는 원래의 `bootstrapSha256`를 보존하며, 임의로 `null`을 넣어 과거 서명을 재검증하지 않는다.
- `createProjectFixtureRecoveryObserver()`는 보호된 원 archive·서명·receipt chain·정확한 lease id/generation/fence·principal을 검증한 뒤 `observe`만 제공한다. 현재 정책이나 새 grant를 대신 채택하지 않으며, 과거 grant가 만료되어도 그 권한을 실행 권한으로 재발급하지 않는다. 원 credential이 없거나 회전했거나 원 이력이 변경되면 조회를 거부한다.
- 새 기록은 owner seed별 prefix로 제한하여 복구 이력을 찾는다. 읽기는 정규 파일·소유자·private 권한·symlink 거부·크기·개수 제한을 적용한다. 원 archive 없는 이전 기록을 추정으로 복원하지 않는다.
- fresh backend ledger가 fence revoked·지연 효과 drained·원 fixture restored를 증명하면 fixture 정리만 complete가 될 수 있다. 업무 effect는 계속 unknown, 반복 비교는 unobserved다. native 종료·영상 완료·전역 admission 해제를 이 증명 하나로 대신하지 않는다.

| 복구 확인 | 관측 결과 |
| --- | --- |
| 타입 검사 | `npm run typecheck` 성공. |
| 서명 backend 집중 검사 | 27 PASS. 만료된 원 권한·현 정책 삭제·prepare/cleanup ACK 유실·원 이력 변조·원 credential 누락/회전·다른 fence·지연 효과/복원 미완료를 포함한다. 이 검사 안의 만료 경계에는 제어된 Date clock을 사용했다. |
| 실제 별도 process smoke | `.qa/fixture-recovery-smoke/2026-11-01T17-05-27.902Z/summary.json`: prepare process 실제 종료 후 원 grant의 실제 만료를 기다리고 현 정책을 삭제했다. 새 observe process 두 개가 원 서명 이력만 읽어 fresh ledger를 조회했다. 요청 순서는 prepare→cleanup→observe→observe, 실제 fixture 변경 1회, mutating 재전송 0회였다. 정리는 complete였지만 effect=unknown·comparison=unobserved를 유지했다. |

마지막 smoke는 로컬 서명 backend fixture다. negative probe metadata는 선언값이며 회사 backend attestation이 아니다. 아래 production composition에서 이 backend 근거와 Chrome native 근거를 함께 대조한다.

## Controller 종료와 분리한 Chrome native owner

- Chrome main process와 ChromeDriver를 전용 background Node owner의 실제 `ChildProcess`로 소유한다. controller에서 사라지는 CDP 수집·encoder도 이 owner 안에서 실행한다. Terminal이나 호스트 브라우저 창을 띄우는 경로를 추가하지 않았다. 실제 Dock·host 입력 비간섭 검증을 대신하는 설명은 아니다.
- native 시작 전에 원 project·device·전역 owner/generation/resources·선택 instance 세대를 private seed에 저장한다. 동일 owner의 runtime claim은 재사용하지 않는다. PID나 일정 시간 경과를 native 종료 확인으로 쓰지 않는다.
- loopback 제어는 실행 token과 복구 token을 분리한다. 원 reply key로 요청 nonce·HTTP status·본문을 검증하며, 복구 token은 새 browser·capture·테스트 입력을 시작할 수 없다. 원 scope나 seed가 바뀌면 다른 프로세스를 채택하지 않는다.
- controller heartbeat 상실·시계 불확실성은 새 입력을 차단하고 기존 소유 자원 정리를 시작하는 조건일 뿐이다. 실제 browser/driver exit·profile 제거·capture/encoder/spool 정리·원 파일 inventory의 fsync/hash가 모이기 전에는 `closed`로 확정하지 않는다.
- capture는 원 grant와 evidence의 빠른 만료 시각을 전달한다. frame ingress·저장 queue·새 snapshot에서 wall/monotonic 만료와 철회를 확인한다. 시작 ACK 전 취소는 원 capture ID를 취소 처리하며 뒤늦은 동일 시작을 허용하지 않는다.
- `observeChromeOwner()`는 원 native 상태와 서명된 terminal inventory를 읽는다. 이 사실로 과거 업무 verdict·비교 조건을 성공으로 바꾸거나 fixture 복원을 추정하지 않는다.

| 실제 확인 | 관측 결과 |
| --- | --- |
| 새 owner 경로의 실제 입력·녹화·독립 프로필 | native opt-in 집중 실행 1 PASS. 실제 W3C 입력→버튼 결과→page 영상 전체 검증→새 프로필의 localStorage 초기화를 확인했다. |
| 실제 controller 강제 종료 | `.qa/native-owner-recovery/2026-11-01T19-10-12.171Z/summary.json`: fixture controller를 실제 `SIGKILL`로 종료한 뒤 새 process 두 개가 원 owner·전역 세대를 대조했다. main Chrome exit 0, ChromeDriver 실제 SIGTERM exit, profile removed, 원 녹화 finalized를 조회했다. |
| 보존 영상 | H.264, 5.702초, 19 frame, 1280×800, 67,031 bytes. SHA-256 `383f527893cc7593f9d44421aa6d37cabb26db493db702271fcc68a7849b44b9`. 전체 decode와 추출 frame의 실제 입력값·`effects: 1` 표시를 확인했다. |
| 재실행·해제 방지 | 실제 backend fixture 변경은 1회, page 진입도 종료 전후 각 1회였다. 전역 admission은 계속 unknown/orphan이며 다음 owner를 `execution_reconciliation_required`로 거부했다. native 증거만으로 backend 복원·전역 해제를 승격하지 않았다. |

이 확인은 로컬 deterministic web fixture다. 회사 backend, 실제 Safari/mobile, OS dialog·실제 IME 조합을 포함한 전 수명주기 host 비간섭, 수정 후 공식 독립 재리뷰·최종 gate는 별도 확인이 필요하다. `native owner` 자체가 예기치 않게 종료되어 원 native exit·증거 seal을 잃은 경우에도 PID 부재로 해제하지 않는다.

## Production 자원 복구 · 원 결과 보존

- 첫 native effect 전에 원 attempt/revision/test/target/grant/fixture seed를 native reply key로 서명하고, 원 admission generation에 binding SHA-256를 등록한다. 개별 resource가 끝나도 해당 epoch 전체가 끝나기 전에는 원 참조를 버리지 않는다.
- verifier는 원 native owner의 실제 Chrome·driver 종료와 profile 제거, 최종 inventory, 원 backend의 fence revoked·late effects drained·fixture restored를 모두 확인한다. 현재 grant·새 bootstrap·prepare·renew를 복구 권한으로 대신하지 않는다.
- 모든 근거가 맞으면 원 generation의 자원 복구 승인을 private storage에 먼저 durable commit하고 전역 점유를 해제한다. 그 사이 controller가 다시 죽어도 새 process가 동일 native/instance generation만 퇴역시킬 수 있다. 승인을 저장하지 못하면 점유를 유지한다.
- 과거 run/attempt의 unknown·FAIL·필수 검증 수·영상 incomplete는 고치지 않는다. 별도 복구 근거와 보존 segment를 표시한다. `execution.reconcile`은 테스트 실행이나 재전송이 아니며, 일반 MCP toolset·scoped script에는 이 권한을 노출하지 않는다.
- 원 unknown 이력이 있다는 이유만으로 이후 queue를 영구 정지하지 않는다. 단, idle 표시나 UI 체크가 아니라 원 attempt/run/revision/test/target/grant와 일치하는 서명 binding·durable 자원 복구 승인을 확인해야 한다. 승인 없는 이력은 preflight와 dispatch를 계속 막는다. 원 queue를 재전송하지 않으며 유효한 현재 권한으로 명시한 새 실행만 별도 수행한다.
- Native 환경 화면과 선택 attempt 화면은 실제 전역 점유와 마지막 원 자원 관측을 분리한다. binding·native 종료·증거·fixture·지연 효과 5축을 표시한다. 보존 영상은 실제 파일 크기·SHA-256·재생 가능 여부를 다시 확인하고 재생한다.
- 현재 grant 목록 조회 실패가 과거 실행·발행본 조회를 가리지 않도록 Native 조회를 분리했다. 실패한 권한 목록은 비우고 오류를 명시한다. 과거 기록의 열람이 새 실행 권한을 부여하지 않는다.
- attach-mode ChromeDriver가 `chrome.userDataDir`을 생략하는 경우에는 소유 endpoint의 실제 `Browser.getBrowserCommandLine` 응답으로 전용 profile·headless 실행을 확인한다. 제공된 capability가 다르거나 실제 인자를 확인하지 못하면 여전히 조건 미확인이다.

| 실제 확인 | 관측 결과 |
| --- | --- |
| 일반 발행 QA 재실행 | `.qa/product-smoke/2026-11-01T21-01-27.745Z/`: 필수 검증 7/7 PASS 2회, 의도한 FAIL 1회, read-only 정책 차단 1회. 네 attempt의 영상 ready·cleanup confirmed·conditions verified. 두 PASS는 same_conditions로 비교 가능하며 backend 변경은 승인된 세 attempt에서만 총 3회였다. |
| 강제 종료 후 원 권한 복구 | `/private/var/folders/81/308ppjhd4_175x6vnb5flwmr0000gn/T/qautra-live-fixture-jqaO1H/native-recovery-summary.json`: 실제 controller SIGKILL, backend 미복원 동안 차단, 실제 lease 만료와 별도 backend 복원 후 현 정책 삭제, 복구 승인 commit 직후 두 번째 SIGKILL, 새 process의 전역 idle·원 instance 예약 정리를 확인했다. 원 run은 unknown 그대로이고 테스트 재전송은 없었다. |
| 원 영상 보존 | 위 cold recovery의 H.264 8.959초·30 frame·1280×800·48,568 bytes, SHA-256 `8cc83e69e1bf22de0be1863d76a2c78a20f3ec4ab577ece0d8f1c6112b745701`. 실제 packet DTS 단조 증가와 decode를 확인했다. decoder 검사는 VFR time base를 유지한다. 임의 고정 fps의 null 출력에서 서로 다른 timestamp가 합쳐지는 경고를 원 MP4 손상으로 혼동하지 않는다. |
| 연속 host 관측 | `.qa/host-input-cold-recovery-summary.json`: 위 실제 준비·입력·controller 종료·복구 구간을 포함한 45초, 779 samples, 최대 간격 약 64ms. foreground·pointer·clipboard revision·한국어 입력 source가 유지됐고 combined/HID key·mouse·scroll counter 증가가 없었다. |
| Native 과거 기록·보존 영상 | `.qa/native-smoke/cold-recovery-final/`: 정책 삭제 상태에서도 실제 unknown run→선택 attempt→5축 복구 근거→원 segment 조회·재생→환경 화면을 확인했다. 실제 AVPlayer/item ready, rate 1, 재생 위치 약 3.73초. 자체 bitmap에는 영상 layer가 검게 나와 영상 표시 pixel은 여전히 확인 안 함이다. probe는 자기 UI process를 종료했으며 제품의 graceful 종료 검증은 아니다. |
| 복구 후 명시한 새 실행 | `/private/var/folders/81/308ppjhd4_175x6vnb5flwmr0000gn/T/qautra-live-fixture-xjUcBk/native-recovery-summary.json`: 원 controller와 복구 controller를 각각 SIGKILL한 뒤 새 process가 원 예약을 정리했다. 다른 backend fixture에 대해 현재 권한과 새 revision을 명시 발행·실행하여 필수 검증 2/2 PASS·영상 ready·cleanup confirmed를 확인했다. 원 unknown record·원 backend 변경 1회는 그대로이며 원 시나리오 재전송은 없었다. |

연속 관측은 해당 idle host 구간의 증거다. 64ms 미만의 foreground 전이를 배제하거나 실제 사용자 IME 조합·OS dialog·모든 오류/중지 경로의 비간섭을 인증하지 않는다. prepared Safari worker와 모바일 protected bootstrap/enforcer는 지원 완료가 아니다. 위 자료를 회사 backend·CI·배포·전체 제품 승인으로 표현하지 않는다.

## 2026-11-02 · 명시 흐름 발행과 원본 처리

- 현재 발행은 `scenario-definition/v4`·`scenario-revision/v4`다. `scenario.preview`의 `chains: [{ id, members }]`에 사람이 선택한 TC ID와 순서를 기록한다. TC 원본에 의존 관계를 중복 저장하거나 모델이 선행 TC를 추가하지 않는다. 이전 v1/v2/v3는 원 정의로 조회만 가능하며 현재 실행 자격을 승계하지 않는다.
- 같은 흐름은 동일 앱·고정 프로필·필수 플랫폼을 사용한다. 두 번째 TC부터 원 정의에 `start: attach`가 있어야 한다. 하나의 실제 browser/session·fixture 준비·recorder·cleanup 안에서 모든 TC의 필수 검증을 합산한다. 선행 업무 실패나 teardown 실패 뒤에는 후행 입력을 차단한다. 미수행 검증은 PASS로 채우지 않는다.
- 서로 다른 플랫폼을 요구하는 TC는 선언한 실제 target에만 배정한다. 선택한 TC가 사용하지 않는 target·권한, 누락한 필수 플랫폼·권한은 접수 전에 거부한다.
- Native의 묶음 검토 화면은 원문 선택→후보 미리보기→동일 세션 TC 선택·순서 변경→후보 재생성→각 필수 검증 검토→명시 발행으로 연결했다. 구성 변경은 후보와 검토 체크를 무효화한다. 시작 방식은 시나리오 편집에서 직접 선택하며 자동 수정하지 않는다. 실제 앱에서 두 TC 선택·명시 순서·필수 검증 검토·발행 응답과 저장된 원 revision을 확인했다.
- 실행에 필요한 원 발행본은 private revision storage에 그대로 보존한다. 공개 실행 파일의 `scenario-revision.json`은 `qautra/scenario-revision-evidence/v1`, `executable: false`인 별도 정제본이다. 원문·profile·flow의 모든 문자열과 key를 정제하며 정제 후 같은 key가 된 항목도 버리지 않는다. 개인정보 정제를 executable 자체에 적용하지 않는다. PNG·영상은 승인된 fixture의 raw pixel이며 개인정보 masking 완료를 뜻하지 않는다.
- direct script는 JS/TS 원본의 정확한 파일명·digest·파일 identity를 확인하고 실행 종료 전에 제거한다. 완료·실패·취소·시작 실패·복구 가능한 재시작에서 같은 경계를 사용한다. 보존 record에는 digest·정제 결과·삭제 확인 시각만 남긴다. 활성 mutex·원 소유 증명 부재·변조·symlink·모호한 legacy 파일은 추정 삭제하지 않고 새 코드 실행을 차단한다. source 삭제가 원 native 자원·업무 효과 복구를 대신하지 않는다.
- 실제 smoke에서 direct session이 `device:`로 전역 예약하고 native owner는 `target:`을 요구하여 시작이 거부되던 불일치를 확인했다. 새 direct session도 같은 `target:` 계약으로 연결했다. 기존 unknown 기록은 수정하거나 해제하지 않았다.
- 시나리오를 같은 ID로 수정해도 새 초안은 이전 해석 승인을 승계하지 않는다. 요구사항 추적은 현재 초안 파일 경로로 과거 발행본을 연결하지 않고, `revisionId`·원 TC ID로 `scenario.origin`을 조회한다. `sourceManifest`는 JSON 본문이 아닌 원 경로이며 실제 내용은 발행 시 고정한 content-addressed blob의 크기·SHA-256·manifest 검증 후 읽는다. 원 경로가 없어져도 현재 파일로 보충하지 않는다.
- `scenario.origin`은 별도 비실행 조회 projection이다. executable revision과 digest는 바꾸지 않는다. 로컬 QA review-token context가 필요하고 MCP tool 목록·호출에서는 제외한다. 로컬 원문 열람이 외부 AI 전송 허가를 뜻하지 않는다. 보관 원문이 없는 과거 기록은 `not-captured`, blob 변조는 오류다.
- 시스템 경로 별칭(`/var`→`/private/var` 등) 때문에 원문 ledger의 원 경로와 실제 캡처 경로가 달라도 같은 검증된 blob에 대응하도록 경로·해시를 함께 고정한다. 프로젝트 경계·원본 총량·경로 개수 제한은 유지하며 사용자 symlink를 storage root로 허용하지 않는다.

| 수정 후 실제 확인 | 관측 결과 |
| --- | --- |
| 실제 인증 HTTP·Chrome 동일 세션 | `.qa/product-smoke/2026-11-02T00-34-53.500Z/`: 두 TC의 상태 유지와 필수 검증 3/3 PASS, 실제 backend 변경 1회, 영상 ready·cleanup confirmed. 별도 선행 실패 실행은 후행 입력 차단, backend 변경 0회, 원 FAIL·미수행 분모 유지. 두 영상 전체 decode와 추출 frame을 확인했다. |
| 공개 정제본·직접 코드 | 같은 HTTP smoke에서 private 발행 원문 보존과 공개 snapshot의 입력값 제거·비실행 표시를 확인했다. 별도 synthetic direct script는 literal `${HOME}`를 확장하지 않고 실제 입력·assertion PASS, source module 제거·digest 보존·native session closed를 확인했다. 일반 프로젝트 권한 재사용 증거는 아니다. |
| 실제 direct scope 회귀 | `QA_OWNED_CHROME_FIXTURE=1`의 `native-direct-session.test.ts` 1 PASS. 다른 기기 scope 거부, 실제 owned Chrome 열기·SDK 실행·원본 삭제·업무 PASS·전역 idle을 확인했다. |
| 최신 원 권한 cold recovery | `native-recovery.test.ts` 1 PASS. 원 증거는 `/private/var/folders/81/308ppjhd4_175x6vnb5flwmr0000gn/T/qautra-live-fixture-vFPL2o/`다. 두 controller 종료와 원 backend proof 대조 후 새 process의 자원 해제를 확인했으며 원 실행은 unknown 그대로다. 보존 영상은 49,879 bytes·8.926초·30 frame·1280×800, SHA-256 `da342f9e535232d86bc399972aef7a31870f8f4290492ba5c969c862052f25ef`다. |
| 실제 Native 묶음 발행 | `.qa/native-smoke/suite-publication-reviewed/ui/`: 원문 두 건 선택·후보·명시 흐름 순서·필수 assertion 두 건 검토·명시 발행을 실제 화면에서 수행했다. 발행 revision `5bd924e539eb48adaba0923b9333040406e483cbc1ac80eb4a6eb9931ca9bbcc`, chain `native-first → native-next`가 보존됐다. 업무 테스트 실행·PASS 근거가 아닌 발행 UX 검증이다. |
| 수정 후 원문 HTTP·Native 추적 | `.qa/native-smoke/source-history/source-edit.json` 및 `ui-local-menu/`: 현재 `수정된 미검토 초안`과 다른 원 경로·제목 `먼저 입력하는 TC`를 같은 stable scenario ID로 대조했다. 원 artifact 해시·발행본 bytes 유지, blob 원 manifest 일치, 일반 agent 조회 거부, 로컬 reader 조회 성공, 실행 기록 0건을 확인했다. 실제 앱에서 원문 선택 후 수정한 초안과 과거 발행 당시 원문·대응·미실행 표시가 함께 보이는 화면을 확인했다. |
| 타입·Native 빌드·회귀 | `npx tsc --noEmit` 및 원문 조회 Native `xcodebuild` 성공. 관련 통합 회귀 143/143 통과. 원문 변경·현재 파일 삭제/변조 후에도 과거 snapshot 유지, 잘못된 TC·변조 blob·위조 review 필드·MCP 원문 조회 거부를 포함한다. 전체 suite 재검사는 아직 확인 안 함이다. |

Native 원문 이력 검증의 첫 자체 popup probe는 menu tracking을 마치지 못하고 종료돼 성공 증거에서 제외했다. global 입력 없이 자기 process의 mouse-up을 queue에 전달하도록 검증 probe를 수정한 뒤 실제 표시까지 확인했다. 최종 probe의 foreground PID는 시작 전·실행 후·종료 후 모두 668이었지만 endpoint 표본일 뿐 연속 비간섭 인증은 아니다. 두 probe 모두 제품의 graceful 종료 검증이 아니며 원 실행·grant를 만들지 않았다.

공식 재리뷰·전체 suite·Native 시안 수치 대응·완전한 host 입력 비간섭·Safari/mobile frozen 지원을 위 Chrome 확인으로 대신하지 않는다.

## 2026-11-02 · 중첩 JSON TC와 별도 실행 가이드

- JSON을 일반 텍스트 한 구간으로 취급하던 경로를 엄격한 JSON 문법 검사와 JSON Pointer 기반 구간 추출로 바꿨다. `src/core/source-json.ts`는 기존 `yaml`의 AST 위치만 사용하며 실제 key는 JSON으로, 값은 원 token으로 읽는다. 큰 정수·지수·Unicode·빈 문자열·빈 객체·`null`·알 수 없는 필드를 강제 변환하지 않는다. 원본 파일 bytes는 별도로 그대로 보존한다.
- 잘림·문법 오류·같은 객체의 중복 key는 `unparsed`와 명시적 문제로 남긴다. 정상처럼 보이는 앞부분만 가져오거나 누락 TC를 생성하지 않는다. 잘린 JSON·중복 key를 사람이 전체 전사했다고 확인해도 원 문제를 지우거나 실행 정의로 발행하지 못한다. 해당 우회는 회귀 검사에서 실패를 확인한 뒤 수정했다.
- 정상 JSON의 최상위 배열이 모두 객체일 때 `jsonRows`에 원본 UTF-8 byte 범위를 기록한다. `POST /api/product/document-rows`는 현재 catalog revision과 원 문서 ID를 받아 **모든** 객체행을 각각 별도 원문으로 보존한다. 필드명을 고정하거나 TC 의미를 승인하는 작업이 아니다. 혼합 배열·미확인 원문·변경된 bytes·등록 여유 부족은 일부 분리 없이 거부한다. 같은 원본의 중복 분리도 거부한다.
- 원 배열은 유지한다. 각 분리 원문은 고유 내부 ID와 `qautra/json-object-row/v1`의 원 문서 ID·경로·SHA-256·ledger digest·전체 객체행 수·정확한 byte 범위를 가진다. 원 TC ID가 같아도 행을 합치지 않는다. 다른 TC의 기대값을 참고로 버리거나 전체 배열을 하나의 상태 의존 흐름으로 강제하지 않는다.
- 분리 원문과 별도 가이드는 기존 원문 대응 검토에 함께 연결한다. `result: {}`·과거 `observed`·예상 FAIL·기획 충돌·mock 한계는 자료이며 새 판정이나 권한이 아니다. 전제·기대값·미지원 범위는 별도 검토하고, 같은 탭 의존은 사람이 명시한 chain으로만 확정한다. 가져오기만으로 시나리오·발행본·실행을 만들지 않는다.
- 발행 closure는 분리 원문과 원 배열 bytes를 함께 캡처한다. 원 배열은 여러 TC가 공유하고, 전체 부모 ledger를 각 TC manifest에 반복 복사하지 않는다. 실제 고정 bytes에서 부모 ledger·행 번호·전체 행 수·byte 범위·행 SHA를 다시 확인한다. 검증 한 번 안에서는 같은 원 배열 분석을 재사용한다. 원 파일이 나중에 사라져도 현재 파일로 보충하지 않는다.
- 기존 원문 snapshot은 재작성하지 않는다. 새 구조 추출을 사용하려면 다시 가져와 현재 대응을 검토한다. JSON 구조 분석 한도는 8,000,000 UTF-16 code units·100,000개 방문 구간·JSON Pointer ID 1,000자·구간 token 1,000,000자다. 객체행 후보는 최대 5,000개이고 전체 문서 등록 상한 5,000개와 남은 여유를 별도로 검사한다. 한도 초과는 원본 보존·미확인 상태이지 부분 성공이 아니다.
- Native 요구사항 추적에서 객체행 후보 수·명시 분리·원본/행 provenance·잘린 JSON 문제·별도 가이드를 표시한다. 원문 구간은 검색·50개 단위 페이지, 시나리오에 연결할 문서는 검색·40개 단위 페이지로 나눴다. 화면 페이지가 검토 범위나 실행 자격을 자동 축소하지 않는다.

| 실제 확인 | 관측 결과 |
| --- | --- |
| 회귀·타입·Native 빌드 | 관련 회귀 52/52, `npx tsc --noEmit`, Native `xcodebuild` 통과. Unicode byte 범위·중복 원 ID·복수 기대값·unknown/빈 값 보존, 변조 provenance·부모 파일 변경·전체 전사 우회 차단을 포함한다. 전체 suite는 이 변경 후 아직 확인 안 함이다. |
| 실제 HTTP·Native 입력 | `.qa/native-smoke/json-source/`: 앱에서 합성 객체행 415개를 한 번의 명시 요청으로 분리했다. 원 배열 SHA-256 `048a156728d3104f8b3241f38b5d3adb4e8955e0bd61779ddb6471e092dd6d66`과 각 415개 행의 실제 파일 bytes·원 범위 일치, 별도 가이드·잘린 원본 보존을 확인했다. |
| 실제 화면 | `ui/all-rows-preserved.png`, `derived-object-row.png`, `truncated-json-blocked.png`, `separate-guide.png`: 전체 분리 완료, 415번째 객체행의 부모 원본·byte 범위, `source_json_invalid`, 별도 가이드를 실제 앱에서 확인했다. |
| 실행과의 분리 | 같은 HTTP proof에서 시나리오 0·발행본 0·업무 실행 0. 자체 Native probe 종료 후 fixture service도 닫았고 unrelated handler 호출은 0이었다. 제품 graceful 종료·전체 host 입력 비간섭 검증은 아니다. |

415개는 **합성 smoke 데이터**다. 사용자가 첨부한 JSON은 FO-159 도중에 잘려 있으므로 원 415개 TC 수신·복원·QA 실행을 확인한 것으로 표시하지 않는다. 이 입력 보존 기능은 선택적 의미 해석 보조·미지원 assertion 구현·Safari/mobile 지원·제품 전체 완료를 대신하지 않는다.

## 2026-11-02 · 입력 경계 적대적 리뷰 보완

- JSON node·token·객체행 예산을 `JSON.parse`와 AST 생성 **전**에 검사한다. 잘림·중복 key뿐 아니라 분석 한도·UTF-8 decode 실패로 미확인인 JSON도 전체 전사 관계로 발행 자격을 얻지 못한다. 원 `.json` 자료의 parser 문제를 전사 확인으로 지우는 경로를 닫았다.
- 실제 800,003-byte 배열을 128 MiB worker에서 분석한 smoke는 수정 전 `ERR_WORKER_OUT_OF_MEMORY`, 수정 후 단일 `unparsed`·`source_json_limit`을 반환했다. 수정 후 관측 분석 시간은 약 5.23 ms다. 이 단일 예산 거부 측정은 일반 import 성능이나 hard RSS 격리 보장이 아니다.
- 파일 입력은 비차단·no-follow descriptor에서 일반 파일 여부와 읽기 전후 inode·device·size·mtime·ctime, 경로·부모 identity·경계를 대조한다. FIFO와 읽기 중 동일 길이 수정·파일 교체·부모/경계 교체를 거부하며 catalog lock을 반환한다. 실제 FIFO smoke는 수정 전 rescue writer까지 대기했고 수정 후 대기 없이 400으로 거부했다.
- 붙여넣기는 최종 ledger를 한 번 검증한 뒤 원본 artifact와 catalog를 기록한다. 100,001줄·200,002자의 허용 크기 입력이 수정 전 `ZodError`로 끝나던 사례는 수정 후 원본 전체와 `source_text_limit`·단일 `unparsed` 문서로 보존됐다. 앞부분만 정상 구간으로 저장하지 않는다.
- catalog는 UTF-8 직렬화 누적 16 MiB를 읽기 시 JSON parsing 전에, 쓰기 시 artifacts/catalog 교체 전에 집행한다. 문서·시나리오·원문 manifest·객체행 전체 분리 모두 같은 누적 예산을 적용한다. 한도 초과 기존 catalog를 초기화하거나 일부 행/고아 artifact를 남기지 않는다.
- XLSX는 ExcelJS 할당 전에 ZIP 선언·실제 확장과 XML 구조를 확인한다. entry 8 MiB·전체 확장 32 MiB·2,048 entries·XML 500,000 nodes·depth 128·100 sheets·cell/row storage 100,000·1,000 merges·merge area 100,000·참조 면적 누적 1,000,000을 제한한다. ZIP Unicode filename override와 parser의 suffix dispatch도 같은 검사 범위다. 이미지 drawing의 `col` 좌표와 worksheet의 `min`/`max` 열 범위를 구별해 기존 이미지·수식 원문 수집을 유지했다.
- Native 대응 key는 JSON Pointer를 Swift `String`의 Unicode 동등성만으로 합치지 않도록 byte identity를 사용한다. 부모 배열의 현재 구간에서 분리 행의 대응으로 이어지고, 당시 고정 manifest의 부모 hash·행 범위와 발행 이력을 별도로 표시한다. 원문 대응 편집은 10구간, 발행 원문 조회는 10개 단위이며 미조회 범위를 숨기지 않는다. Native 시각·동작 검증은 아래의 별도 성공 증거가 생기기 전까지 완료로 간주하지 않는다.
- 통합 회귀 **87/87**, `npx tsc --noEmit`, macOS arm64 Native `xcodebuild` 통과. 한 번 발견된 이미지 포함 XLSX 회귀를 수정한 뒤 관련 5개 파일의 87개 검사를 다시 통과했다. 전체 repository suite·CI·다른 OS/architecture는 이 보완 후 확인 안 함이다.
- `.qa/native-smoke/json-source/`의 `budget-before/after.json`, `fifo-before/after.json`, `paste-before/after.json`은 실제 실행한 경계 smoke다. `.qa/native-smoke/source-resolution-complete/`와 `source-resolution-final/`의 Native probe는 timeout으로 발행을 증명하지 못했다. 각각 catalog revision 3·미검토·발행 0·업무 실행 0을 대조했고 자체 app/fixture를 종료했다. 이 실패를 Native 발행 성공이나 제품 graceful 종료 증거로 사용하지 않는다.

## 2026-11-02 · 선택적 문서 해석과 증거 반출 경계

- 문서 해석 보조는 `ProductAuthoringService`의 선택 기능이다. 현재 원본 bytes·ledger·catalog revision을 포함한 정확한 전송 payload를 미리 보여 주고, 그 작업에만 유효한 사람의 동의를 요구한다. 결과는 미검토 초안이며 검토·발행·실행·의존 순서·권한·판정을 승인하지 않는다.
- Claude CLI adapter는 버전·지원 옵션·로그인 상태를 원문 전송 전에 확인한다. tools·MCP·hooks·외부 설정·Chrome 연결·세션 저장을 비활성화하고 private cwd와 최소 환경으로 실행한다. 동의 철회·원문 변경·catalog 변경·중복 request ID·재시작 후 실행 불명은 자동 재전송이나 부분 적용 사유가 아니다.
- 실제 설치된 Claude CLI `2.1.316`의 인증 조회는 `loggedIn: false`였다. 원문 전송과 모델 요청 없이 capability가 차단되는 것까지 확인했다. 실제 모델 제안 성공은 확인 안 함이다. 수동 원문 검토·발행은 이 선택 기능에 의존하지 않는다. 증거: `.qa/native-smoke/authoring-live/2026-11-02T11-25-27-486Z/proof.json`.
- 리포트·증거 보관함은 원 frozen attempt의 결과·조건·원 TC 대응·증거 manifest를 읽는다. 증상 묶음은 revision·실제 대상·필수 check·실행 조건·판정 축이 다른 결과를 합치지 않는다. 증거 finalizing·누락·영상 gap·소유권 불명·정리 불명을 성공처럼 표시하지 않는다.
- 내보내기·삭제는 캡처 grant와 별개인 local review 권한, 정확한 선택 범위, 현재 정책, 개인정보 경고 확인, 120초 유효한 일회 동의를 요구한다. 결과 JSON·조건·source capture·로그도 원시 자료다. 정제된 텍스트나 마스킹 자료로 간주하지 않는다. 기본 local 정책은 회사의 조직 정책·DLP 연동을 대신하지 않는다.
- export는 선택한 파일과 portable HTML·정확한 결과 JSON·manifest만 묶는다. 파일은 private mode로 저장하고 총 2 GiB, 보관 4개, 다운로드 자격 10분을 제한한다. 만료가 파일의 예약 삭제를 보장하는 것은 아니다. 외부 네트워크 전송·영상 마스킹은 수행하지 않는다.
- 실제 삭제는 최종 소유권·종료·정리·spool·진단 복사본 목록이 확인된 선택 범위만 처리한다. 원 FAIL·기대값·정의·receipt·journal은 보존한다. 삭제 권위는 프로젝트 backup 밖의 `~/Library/Application Support/QAutra/product-evidence`에 보관한다. 사용자가 내려받거나 외부에 복사한 파일은 원격 삭제할 수 없다.
- 삭제한 원시 bytes의 SHA-256은 다른 run·프로젝트·이후 capture에서도 조회·반출이 차단된다. 물리 삭제는 선택한 관리 파일만 대상으로 한다. 같은 내용의 재캡처도 차단될 수 있는 보수적인 개인정보 경계이며, Native 동의 경고에 이 영향을 표시한다. backup 복원이나 파일 이름 변경으로 차단을 해제하지 않는다.
- HTTP media·events·typed summary와 export는 권한 확인 때 연 바로 그 descriptor를 읽는다. symlink·FIFO·hard link·공개 mode·경로/부모 교체와 이미 열린 stream의 권위 변경도 거부한다. `events.jsonl`의 제한된 append만 최초 prefix 안에서 허용한다. 복원한 원시 bytes를 `summary.json` 등 불변 파일 이름으로 위장해도 content 철회가 우선한다.

| 실제 확인 | 관측 결과 |
| --- | --- |
| 실제 artifact HTTP smoke | 원 소유 Chrome 실패 실행의 별도 복사본에서 local review 없는 요청 403, 선택 export 생성·다운로드·동의 철회 후 410, 관리 파일 10개 삭제, 원 FAIL·기대값·불변 기록 유지, backup 복원·다른 run의 이름 변경 복사본 410을 확인했다. 원 프로젝트 영상은 변경하지 않았고 업무 handler 호출은 0이다. |
| 실제 실패 영상 | export한 원본 MP4의 SHA-256은 `b7f1bd2a5d60f7a4d7df23338681f6a16a9af6224b9604af6fe7bdb86a51525d`다. `ffprobe`는 1280×800, 10 frames, 5.749초를 보고했다. 후속 Ego 브라우저 검증에서 portable HTML 안의 기본 재생 버튼으로 같은 영상을 재생했다. Safari·mobile 녹화 검증은 아니다. |
| 정책·회귀 | `test/server/product-evidence.test.ts`, `server.test.ts`, `serve.test.ts`, `test/plan/product-authoring.test.ts`, `test/server/product-authoring.test.ts`의 71/71 통과. 결과 JSON만 선택하는 raw 정책 우회도 실패를 확인한 뒤 차단했다. 전체 suite·CI는 이 변경 후 확인 안 함이다. |
| Native | macOS arm64 Native 빌드와 아래 날짜 필터·증거 동의·삭제 UI smoke가 통과했다. 날짜 picker callback의 MainActor 경계를 명시한 뒤 해당 경고는 없어졌고, `GuestRecording.swift:333–336`의 기존 AVFoundation deprecated 경고는 남아 있다. Native 수치·시각 parity 전체, Safari/mobile 원 attempt 복구는 별도 확인이 필요하다. |

실제 HTTP proof와 원 export·영상·종료 기록은 `.qa/native-smoke/evidence-http/2026-11-02T12-25-19-344Z/`에 있다. 합성 Chrome 대상에서 얻은 증거이며 회사 실제 서비스 검증이나 OS 격리 승인으로 확대하지 않는다.

## 2026-11-02 · 실제 Native 검토·발행과 portable 리포트

- `.qa/native-smoke/source-review-owned-events-20261102-03/`에서 앱의 원문 대응 편집 → 검토 저장 → 후보 생성 → 서로 다른 두 필수 검증 확인 → 명시 발행 → 요구사항 추적을 수행했다. 원 배열 bytes·부모 hash·객체행 범위와 NFC/NFD가 다른 두 JSON Pointer를 보존했고, 각각 `steps[1]`·`steps[2]`로 고정됐다. 발행 revision은 `c91c3edb984eee99563e107b4d21db89d30768c484159365a73434df7de1a7eb`다.
- `.qa/native-smoke/source-resolution-owned-events-20261102-01/`에서는 구조 미확인 DOCX를 자동 성공 처리하지 않고, 원본·별도 전체 전사본·대조 범위를 앱에서 직접 연결한 뒤 검토·발행했다. 원본 bytes와 기존 구조 미확인 경고, 전사본 hash·ledger, 독립 기대값 두 개가 발행 manifest에 남았다. 발행 revision은 `03ff814cb2fe8079e20bee6e67263e195ea51e571fe0f9300689ecc2c4b107c5`다. 복잡한 PDF/DOCX의 표·이미지·레이아웃 자동 해석 성공을 뜻하지 않는다.
- 두 Native smoke는 자체 fixture·앱 process에서만 수행했고 업무 실행은 0이었다. foreground application PID는 시작·실행 후 모두 `668`이었으며 앱 자동 activation 없이 자체 window의 일반 입력·활성 접근성 동작을 사용했다. 자체 app과 fixture service를 종료했다. 이 제한된 관측은 모든 lifecycle·OS dialog·IME·장시간 host 입력 비간섭이나 제품 graceful 종료 전체의 증명이 아니다.
- 초기 Native smoke 실패는 미검토·발행 0으로 남겼다. 원문 checkbox의 OCR 구두점 차이와 선택 후 체크 표시가 붙은 같은 assertion을 두 번 누르던 probe를 수정했다. 비활성 발행 버튼을 강제 실행하거나 API로 검토·발행을 대신하지 않았다. 성공 판정은 화면 문구뿐 아니라 별도 실제 발행 기록·원본 hash 대조를 요구했다.
- portable HTML은 전체 JSON을 펼치는 대신 원 기대값·원 단계 관측·업무/실행/증거/정리 상태, 접을 수 있는 원 attempt·조건, 선택 영상의 기본 재생·저장 기능을 제공한다. 원 TC 매핑 없음·미포함 파일·영상 gap은 그대로 표시한다. `results.json`·`manifest.json`과 원 MP4는 별도로 유지하며 판정이나 source를 다시 계산하지 않는다.
- 날짜는 `년 월 일 시 분 초`와 offset·표시 시간대를 표시한다. 보고서의 `createdAt`은 실행 시작으로 바꾸어 부르지 않고 **요청 시각**으로 표시한다. Native 증거 검색은 ISO 문자열 입력 대신 초까지 있는 AppKit 날짜 picker와 선택적 시작·종료 조건을 사용한다. 종료 조건은 선택한 초 전체를 포함하고, 시작이 종료보다 늦으면 조회를 차단한다. 아래 Native smoke에서 조건별 활성·초 선택 요소·실제 필터 적용을 확인했다.

| 실제 브라우저 확인 | 관측 결과 |
| --- | --- |
| 같은 원 attempt 리포트 | Ego 1920×973 viewport에서 기본 문서 높이 37,225 px → 2,014 px. 원 필수 기대값 두 개와 FAIL은 유지했다. 일반 성능·전체 디자인 parity 측정은 아니다. |
| 표시·재생 | `2026년 11월 02일 09시 35분 04초 GMT+09:00 · Asia/Seoul`, 원 기대값 두 개, 업무 FAIL·실행 finished·증거 ready·정리 confirmed를 확인했다. HTML의 기본 재생 버튼으로 MP4가 paused=false·currentTime 증가·1280×800·5.749초·media error 없음으로 재생됐다. |
| 보안·범위 | 실제 export HTML에 page script 0개, 선택한 상대 파일과 CSP를 확인했다. 서버의 권한·철회·삭제 HTTP smoke도 새 renderer로 통과했다. 영상 마스킹·조직 DLP·외부 전송 허가를 얻었다는 뜻이 아니다. |

최종 portable HTTP·브라우저 증거는 `.qa/native-smoke/evidence-http/2026-11-02T13-16-22-486Z/`의 `proof.json`, `browser-proof.json`, `browser-report.png`, `browser-video.png`다. `npx tsc --noEmit`과 Native 빌드는 통과했다. 관련 71개 회귀는 renderer 변경 후 통과했고, 이후 표시 초의 0-padding 보완 후 타입 검사·실제 export·브라우저 표시를 확인했다. 전체 suite·CI·Safari/mobile은 이 보완 후 확인 안 함이다.

## 2026-11-02 · Native 날짜 필터·증거 동의 가독성과 삭제

- `.qa/native-smoke/evidence-native-owned-events-20261102-04/`에서 실제 앱의 날짜 조건 OFF → 시작만 ON → 양쪽 ON → 조건 적용 → 조건 해제, 관리 파일 선택 → 내보내기 범위 확인 → 취소 → 삭제 범위 확인 → 개인정보 위험 동의 → 명시 삭제를 수행했다. 초 선택 요소와 각 picker의 활성 상태를 검사했다. 초기 smoke에서 종료 조건 OFF인데 해당 picker가 활성인 것을 관측한 뒤, SwiftUI의 `.disabled`와 AppKit `context.environment.isEnabled`를 단일 기준으로 연결해 바로잡았다.
- 동의창이 시스템의 어두운 appearance를 받아 검은 배경에 검은 본문·digest·동의 라벨을 표시하던 문제를 실제 화면에서 발견했다. 증거 동의와 선택적 원문 해석 sheet에 제품 canvas와 명시적 light appearance를 적용했다. 수정 후 범위·정책 digest, 경고, 선택 파일 목록, 동의 라벨과 비활성 확인 버튼을 캡처해 가독성을 확인했다. Dark Mode 제품 지원을 추가했다는 뜻은 아니다.
- 별도 기록 대조에서 취소한 export는 동의·다운로드를 만들지 않았고, 삭제 동의 한 건만 소비됐다. 실제 실패 실행의 **별도 복사본**에서 관리 파일 10개가 삭제됐고, 원 프로젝트 영상 SHA-256·업무 FAIL·독립 기대값 두 개·불변 실행 기록은 그대로였다. 업무 handler 호출은 0이었다. Native의 최종 export 저장 패널은 아직 확인 안 함이며, 실제 export·재생은 앞의 HTTP·Ego 경로로 확인했다.
- 같은 Native smoke에서 선택적 원문 해석 화면을 열고 미연결 adapter 안내·AI의 미검토 초안 한계·수동 경로 독립성·원문 반출 경고를 확인했다. 이 fixture는 adapter 미연결 경로다. 원문 준비·전송·요청 JSON 생성은 0건이며, 실제 CLI 로그인 prerequisite 및 실제 공급자의 성공 응답을 검증한 것으로 확대하지 않는다.
- 자체 앱 PID `23061`은 자동 activation 없이 실행했고 foreground application PID는 시작·실행 후 모두 `668`이었다. 자체 앱과 fixture service를 종료했다. 이 관측은 그 구간의 비활성 실행 증거이며 장시간·모든 OS dialog·실제 Safari/mobile의 입력 비간섭 보장은 아니다.

증거: `proof.json`, `shutdown.json`, `ui/clock-disabled-controls.json`, `ui/clock-start-enabled-controls.json`, `ui/clock-both-enabled-controls.json`, `ui/delete-scope-before-consent.png`, `ui/authoring-prerequisite-only.png`. 이 변경 후 Native 빌드·실제 UI smoke가 통과했다. 전체 suite·CI는 아직 확인 안 함이다.

## 2026-11-02 · Guest 보존 영상의 부팅 검증 한도

- 실제 guest recorder는 공유 `status/recordings/`에 영상 하나를 최대 1 GiB까지 보존하지만, Native의 `verifyBootShares()`는 전체 `status/`를 16 MiB로 제한하고 있었다. 원 함수로 32 MiB·1 GiB의 private sparse 영상 fixture가 `unsafe_share`로 거부되는 것을 재현했다.
- Native 검증의 합계 한도를 영상 1 GiB + 기존 metadata 여유 16 MiB로 맞췄다. 128개 항목·소유 UID·private mode·regular file·단일 hard link 제약은 유지했다. 이 한도는 VM/recorder의 실제 소유권·영상 최종화·재생·정리 확인을 대신하지 않는다.

| 실제 Native 검증 함수 입력 | 수정 전 | 수정 후 |
| --- | --- | --- |
| private 32 MiB 보존 영상 | `unsafe_share` | 허용 |
| private 1 GiB 보존 영상 | `unsafe_share` | 허용 |
| 영상·metadata 합계 한도 + 1 byte | `unsafe_share` | `unsafe_share` |
| public mode·symlink·hard link·FIFO | `unsafe_share` | `unsafe_share` |

증거: `.qa/native-smoke/native-share-budget/before.json`, `after.json`. `NativeBootShareFixture.swift`로 실제 `NativeStore.verifyBootShares()`를 컴파일해 영구 회귀 검사를 추가했다. `native-boot-share.test.ts`, `guest-kit.test.ts`, `guest-recording.test.ts`는 16/16, Native 앱·guest runtime 빌드는 통과했다. 실제 VM 부팅·guest Safari 실행은 확인 안 함이다. AVFoundation의 기존 deprecated 경고는 남아 있다.

- Native 최종 저장 검증 `.qa/native-smoke/export-native-owned-events-20261102-01/`은 내보내기 동의 후 저장 modal의 자체 bitmap이 빈 화면으로 관측돼 완료하지 못했다. 자체 app·fixture는 종료했고 foreground PID는 `668`로 유지됐다. 정상 파일 저장 성공이나 제품 저장 실패로 판정하지 않는다.
- 독립 구현 worker 두 개는 활성 worktree의 host-session 쓰기 보호에서 거부돼 변경·검증이 없었다. 이 결과를 독립 코드 리뷰나 guest/mobile 구현 완료로 계산하지 않는다. Native 원 generation/정지·녹화 최종화 증거와 native client bootstrap은 여전히 별도 구현·실행 검증 대상이다.

## 2026-11-03 · Native 내보내기 사본의 실제 소유·정리

- Native 저장은 전체 TAR를 `Data`나 OS download 임시 파일로 먼저 받지 않는다. 보호된 서버가 원 export·동의 범위·정책·principal·만료·크기·SHA-256에 묶은 lease와 private `0600` 파일을 먼저 등록한다. 실제 `URLSessionDataDelegate`가 원 파일 descriptor로 쓰고, 파일 identity·정확한 byte 수·해시를 확인한다. Native 한도는 2 GiB다.
- 사용자가 선택한 목적지에는 별도 private staging의 identity를 기록한 뒤 128 KiB 단위로 복사·검증하고 원자적으로 승격한다. 재시작 정리는 원 payload의 실제 독점 잠금을 얻은 뒤에만 retire fence를 요청한다. 실제 파일 제거·descriptor 닫기·cleanup receipt·서버 인정은 별도 단계다. PID 소멸, 시간 경과, checkbox, API boolean만으로 정리 완료를 만들지 않는다.
- 미확인 Native 사본은 삭제 미리보기·동의·실행과 같은 내용의 다른 논리 run 삭제도 차단한다. 이미 정리된 경로에 파일이 재등장하면 다시 pending으로 취급한다. 사용자 목적지에 승격된 사본과 사용자가 별도로 만든 외부 사본은 앱의 관리 파일 삭제로 지웠다고 표시하지 않는다.
- 실제 실행 증거는 `.qa/native-smoke/native-export-core-20261103-02/`다. QAutra의 실제 Swift module을 그대로 컴파일하고 진입점만 CLI로 바꿔, 원 `APIClient.productEvidenceSave()`·`NativeExportCache`·정리 API를 실행했다. backend는 자체 실패 실행의 별도 복사본이며 업무 handler 호출은 0이었다.

| 실제 검증 경로 | 관측 결과 |
| --- | --- |
| 저장 | 관리 파일 10개, TAR 283,136 bytes, `0600`. 전체 TAR·내부 원 영상 해시와 원 FAIL·기대값 두 개·실행 이력 보존. payload 제거·승격 기록·정규화된 cleanup digest·서버 인정 확인. |
| 취소 | Native 요청 전에 취소하면 새 lease·사본을 만들지 않음. |
| 살아 있는 다른 writer | 별도 프로세스의 정리는 독점 잠금에서 거부됨. retire 기록 없음·원 partial bytes 유지·삭제 동의 HTTP 409. |
| producer 종료 | 자체 producer에만 `SIGKILL`을 보내 실제 종료를 확인. 새 프로세스가 원 lease를 정리하고 서버 인정까지 완료. replacement QA·브라우저·기기를 시작하지 않음. |
| 정리 뒤 파일 재등장 | 재등장한 파일은 삭제하지 않고 pending 유지. fixture가 자신이 만든 복원 파일만 제거한 뒤 원 receipt 재확인. 최종 pending 0건. |

- 저장 TAR SHA-256은 `5a1feca83e8777d87f34536eab7d4cbed0ac04505e408ddb1aa03d4a977c9234`다. 관측된 foreground application PID는 저장 전후 `42511`로 같았다. host-global 입력은 사용하지 않았다. 이는 해당 CLI 검증 구간의 관측이며 장시간·모든 OS dialog의 입력 비간섭 보장은 아니다.
- `NSSavePanel`의 사용자 저장 흐름은 **확인 안 함**이다. 별도 Native UI smoke 세 건은 백그라운드 시스템 패널에서 완료되지 않았고 자체 앱·fixture를 종료했다. 호스트 포커스·전역 키보드로 우회하지 않았다. 위 성공은 실제 저장 API·파일 소유·재시작 정리의 증거이며 저장 패널 UI 성공으로 확대하지 않는다.

## 2026-11-03 · 원 권한의 응답 유실·native claim·guest 경로 보완

- 서명된 관측 요청도 서버 receipt 체인을 전진시킨다. 응답 유실 시 체인 상태를 미확인으로 유지해 다음 mutation·bootstrap·witness 사용을 차단한다. 명시적인 새 read-only 관측으로 서명 체인을 다시 확인할 수 있지만, 원 mutation의 `unknown` 효과나 미관측 비교를 성공으로 바꾸지 않는다.
- native SDK가 request를 claimed 파일로 옮긴 뒤에도 같은 challenge를 다시 쓰거나 과거 응답을 재사용하지 못하게 했다. mailbox 실패는 원 Appium session의 종료 시도와 분리하며, 다른 session을 대신 닫지 않는다. 파일 발행 실패는 자신이 만든 pending inode만 제거하고, 기존 미확인 파일은 보존한다.
- `.qa/native-smoke/android-mailbox-20261103-01/proof.json`에서 실제 `AndroidDriver`의 shell 명령을 자체 소유 로컬 fixture로 실행했다. 중복 발행의 원 bytes 보존·자신의 pending 정리·실제 디렉터리 닫기·기존 미확인 pending 보존을 확인했다. **실제 Android 기기·SDK 앱 실행 검증은 아니다.**
- guest 복구가 `admission` 디렉터리의 이웃에서 instance 저장소를 찾던 오류를 별도 admission authority fixture에서 수정 전 재현했다. 기본 admission은 전역 저장소이므로 이 추측은 실제 조합에도 맞지 않았다. 최초 Native 등록의 `source.root`를 원 binding·recovery scope에 고정하고, 원 경로·digest·generation·실행 identity가 함께 맞을 때만 읽는다. 현재 프로젝트 설정이나 replacement owner로 대체하지 않는다. 경로 pin이 없는 과거 source에 현재 경로를 자동 보충하지 않는다.
- guest runtime 관측도 같은 원 root를 요구한다. 실제 guest OS·browser·driver executable·설정·원 session 관측을 host Chrome/Safari의 관측으로 대신하지 않는다. 실제 VZ 정지와 capture 종료·encoder·inventory·재생 가능한 영상은 계속 별개이며, partial 영상은 정리 후에도 incomplete다.

이 보완 후 관련 회귀 **195/195**, `npm run typecheck`, Native 앱·guest helper 빌드가 통과했다. 전체 suite·CI·실제 guest Safari·실제 모바일 frozen 실행은 확인 안 함이다. Swift의 기존 AVFoundation 경고와 신규 browser process path 변환의 deprecation 경고는 남아 있다. 독립 리뷰 하나는 응답 제한으로 실행되지 않았으므로 리뷰 완료나 workflow gate 통과로 계산하지 않는다.

## 2026-11-03 · Native 정리 완료 기록과 원 파일의 모순

- `cleanup.json` 또는 `closed.json`이 있으면서 동일한 원 payload inode도 남은 상태에서, 기존 reaper가 이를 새 정리로 덮어쓰고 bytes를 제거하는 문제를 자체 fixture에서 재현했다. 완료 기록은 실제 파일 부재를 대신하는 권한이 아니다.
- `NativeExportCache`는 원 pending 파일의 identity와 함께 완료 기록의 부재를 잠금 전·후 및 실제 unlink 전에 검사한다. 모순 상태에서는 retire·삭제·receipt 교체를 하지 않고 원 bytes·inode·metadata를 보존한다.
- 영구 회귀는 실제 shipping Swift cache를 컴파일한다. 모순 두 경우는 수정 전 실패했고, 정상 정리·재시작 후 registry 인정·모순 보존·receipt 없는 파일 부재를 포함한 네 경우는 수정 후 통과했다. 이 CLI fixture는 UI의 오류 전달 타입만 제공하며 실제 `NSSavePanel` 검증은 아니다.
- 실제 shipping Swift module의 `APIClient.productEvidenceSave()`·재시작 정리 API도 `.qa/native-smoke/native-export-core-20261103-04/`에서 다시 실행했다. 정상 저장·취소·다른 live writer·producer 종료·파일 재등장 경계에 더해, 같은 원 파일과 모순된 cleanup receipt를 넣었을 때 정리 요청이 거부되고 원 bytes·metadata·미-retire 상태가 유지됨을 확인했다. fixture가 자신이 주입한 receipt만 제거한 뒤 원 정리 경로가 완료됐고 최종 pending은 0건이었다.
- 이 실행의 TAR는 10개 파일·283,136 bytes, SHA-256 `a758ba383925d6ca199f6483f8b43351a93959d881de9996e601aad857409d51`이다. 원 FAIL·기대값 두 개·영상·이력을 보존했고 업무 handler 호출은 0회였다. foreground PID는 전후 `42511`이며 host-global 입력은 사용하지 않았다.

관련 회귀 **199/199**, `npm run typecheck`, Native 앱·guest helper 빌드가 통과했다. 전체 suite·CI·사용자 저장 패널·실제 guest Safari·모바일 frozen 실행의 성공을 뜻하지 않는다.

## 2026-11-03 · 별도 소유 iOS simulator의 부팅 lifetime 관측

- `.qa/native-smoke/simulator-boot-identity-20261103-01/`에서 새 임시 simulator 하나만 생성해 headless로 두 번 부팅·정지했다. 기존 사용자 simulator·QA 앱·업무 앱은 실행하거나 초기화하지 않았다. fixture 종료 시 자신이 만든 simulator만 삭제했다.
- iOS `26.5` / runtime build `23F77`에서 `simctl spawn <원 UDID> launchctl managerpid`가 원 `launchd_sim` 프로세스를 반환했다. 같은 UDID의 두 부팅에서 PID와 microsecond 단위 시작 시각이 달랐고, 정지 후 inventory는 `Shutdown`, 원 프로세스는 `unobserved`였다. 관측 실패를 `stopped`로 바꾸지 않는다.
- 이는 **simulator supervisor의 lifetime 관측**이다. 물리 iOS의 kernel boot identity, 원 XCTest/WDA session 종료, pending native 입력 소멸, backend late effect 정리, 영상 최종화를 입증하지 않는다. Native recovery의 해당 증거들을 대신하거나 소유권 미확인을 자동 해제하는 데 사용하지 않았다.
- 두 부팅 전후 foreground PID는 `42511`로 같았고 host-global 입력·업무 앱 실행은 0회였다. 모바일 소유·frozen 실행 초안은 아직 통합·실행 검증하지 않았다. 실행마다 별도 VM을 늘리는 정책으로 확정한 실험도 아니다.

## 2026-11-03 · Swift native client 재시작

- `QAutraFixtureClient.swift`가 기존 private mailbox에도 `createDirectory(..., withIntermediateDirectories: false)`를 호출해, 두 번째 프로세스의 초기화가 `NSCocoaErrorDomain 516`으로 실패함을 실제 shipping SDK를 컴파일한 consumer에서 재현했다.
- 기존 경로가 디렉터리면 원 mailbox를 사용하고, 없을 때만 새로 생성한다. 디렉터리가 아닌 파일은 거부한다. 기존 symlink 거부·private permission·DEBUG 제한·HTTPS endpoint·app credential 조건은 유지한다. 재시작을 이유로 ready identity나 claimed request를 재발행·덮어쓰지 않는다.
- `test/drivers/native-fixture-swift.test.ts`는 별도 app bundle·별도 프로세스·자체 temporary home에서 실제 SDK를 실행한다. 재시작 후 원 ready/claimed bytes·inode 보존과, 충돌 파일의 bytes·inode·permission 보존을 검증했다. 관련 native client·project fixture 검사는 **39/39** 통과했다.
- 이 검증은 **macOS Foundation의 DEBUG SDK 초기화·파일 동작**이다. iOS 기기의 SDK bootstrap·실제 Appium 입력·frozen 실행·backend principal witness 성공을 뜻하지 않는다. 실제 Claude 해석은 기존 로그인 미확인 상태로 검증하지 못했고, 다른 provider로 원문을 우회 전송하지 않았다.

## 2026-11-03 · Native client identity의 1회 결합

- `ProjectFixtureGuard.bindNativeClient`는 실제 세션을 연 뒤 측정한 app/build/device/session identity를 첫 backend dispatch 전에 한 번만 결합한다. identity가 없으면 `prepare`·`observe`를 거부하며, 잘못된 app/build/device, 재결합, 이미 효과가 불명확한 상태와 recovery guard의 재지정을 거부한다.
- 결합 뒤 호출자 객체를 바꿔도 원 identity는 바뀌지 않는다. 실제 인증 HTTP 교환과 서명된 별도 client witness로 원 identity 보존을 검증했다. native policy·project fixture·guest recovery **40/40**, `npm run typecheck`가 통과했다.
- 이 검증은 guard와 backend authority 경계다. Native driver·SDK cold bootstrap·영상·원 UI agent 종료까지 연결한 모바일 frozen 실행은 아직 검증하지 않았다. Appium의 HTTP 성공만으로 종료를 확정할 수 없는 근거는 [설치된 driver 종료 경로 조사](../research/2026-11-03-native-session-closure.md)에 별도로 기록했다.

## 2026-11-03 · Native SDK의 인증 전 업무 화면 차단

- Java·Swift SDK는 별도 principal을 필수로 받고, 신선한 challenge·실제 app/build/device/session·현재 scope·lease가 맞는 인증 응답을 받은 뒤에만 업무 화면을 허용한다. 응답은 app credential로 검증하는 HMAC envelope이며, 이전 bare claim HTTP 입력은 거부한다. 이미 소비한 요청을 재시작이나 응답 유실을 이유로 다시 전송하지 않는다.
- 실제 Android SDK로 컴파일·d8·정렬·서명한 DEBUG APK와 iOS simulator용 서명 앱을 빌드했다. Android SDK의 공개 API에 없는 `Os.unlink`·`O_DIRECTORY`는 쓰지 않고, `Os.remove` 및 열린 디렉터리의 `fstat` 검증 뒤 `fsync`를 사용한다.
- 별도 소유한 Android 34 ARM64 headless emulator와 실제 HTTPS backend에서 서명된 Java SDK의 인증 왕복을 확인했다. `native-sdk-android-20261103-06`은 현재 claim 2회, 원 claim 재전송 거부, backend fence 회수·초기 상태 복원을 기록한다. 미완성 JSON 요청은 정상 claim 처리 중에도 소비·변경하지 않았다. 기존 HTTP test fixture의 요청 수는 0이었다.
- 인증 전 접근성 트리에는 bootstrap 대기만 있고 업무 입력 위젯은 없었다. 인증 후 접근성 트리와 `after-authorization.png`에는 실제 입력창·확인 버튼이 표시됐다. 인증 전 PNG는 Android 시작 화면이어서 대기 문구의 픽셀 표시까지 입증하지 않는다. 업무 입력은 0회이며 모바일 frozen 실행·실기기·iOS 기기·원 UI agent 정리까지 검증한 결과가 아니다.
- 이 실측에서 Android 앱의 `Os.link`가 `EACCES(13)`로 거부되는 오류를 수정했다. Android private mailbox v2는 배타적으로 만든 데이터와 빈 `.committed` seal로 완성된 파일만 공개한다. 원 데이터·seal·소비된 claim을 덮어쓰거나 재전송하지 않고, bootstrap·소비 claim은 인증 요청 전에 동기화한다. 읽기·쓰기 fd는 공개 `Os` API로 닫는다. 기존 Android v1 marker를 자동 삭제·교체하거나 호환 경로로 받아들이지 않는다. Swift의 기존 private mailbox v1 경로는 그대로다.
- 수정 뒤 관련 회귀 **13/13**, `npx --no-install tsc --noEmit`, Android DEBUG APK 컴파일·d8·정렬·서명이 통과했다. localhost CA는 해당 DEBUG Android 앱의 localhost 연결과 smoke Node 프로세스의 `NODE_EXTRA_CA_CERTS`에만 지정했다. Mac 호스트 인증서 신뢰·Safari·전역 입력 설정은 바꾸지 않았다.

## 2026-11-03 · 원 프로세스와 원 listener의 구분

- `.qa/native-smoke/native-os-probe-20261103-01/proof.json`은 제안된 Objective-C observer를 실제로 컴파일·서명해 새로 소유한 TCP child에서 실행한 결과다. 같은 PID·시작 시각·실행 파일·포트인 상태에서도 listener를 닫고 다시 열면 kernel socket-generation hash가 달라졌다. 잘못된 시작 시각에는 exit `87`로 관측을 거부했다. 원 child는 종료·회수했다.
- 이 실험은 **OS 관측 API의 구분 능력**만 확인한다. WDA의 Mach task 제어, 실제 Android instrumentation 종료, 영상 최종화, backend 정리 또는 원 frozen attempt 복구를 입증하지 않는다. Native owner 초안은 아직 실행 경로에 연결하지 않았다.
- 초안 검토에서 cold SDK 시작과 인증의 순환 의존, Android recorder 종료의 PID 재사용 구간, 선택한 원 attempt와 recovery source의 대응을 추가 확인 대상으로 남겼다. 이 경계를 해결하기 전에 기존 `unknown` 상태를 해제하거나 모바일 frozen 실행을 허용하지 않는다.

## 2026-11-03 · Native 화면 대응의 확인 범위

- `native-main-geometry-20261103-05`는 실제 Native 앱의 7개 주 메뉴를 3개 창 크기에서 열어 **21개 화면**의 상단 메뉴명과 control 좌표를 검증했다. 원 FAIL·복수 기대값·영상·증거 목록은 보존됐고 fixture 업무 입력은 0회였다. 실행한 QAutra PID `64029`의 host activation 통지와 각 캡처의 foreground 진입은 관측되지 않았다. 다른 host 앱 전환까지 QAutra가 막는다는 뜻은 아니다.
- 실제 content 크기는 `1024×768`, `1440×900`, `1920×1050`이다. 마지막 크기는 OS가 요청 높이 `1080`을 제한한 결과이며 `1920×1080` 검증으로 표시하지 않는다. sidebar는 divider 포함 `196/228pt`, 상단 바는 divider 포함 `64pt`다. 작은 창의 초기 `70.5pt` 밀림은 root의 제안 크기를 고정해 수정했다. 낮은 높이의 scroll 대안은 sidebar 전체가 아니라 메뉴 영역에만 둔다.
- 원 PNG를 sRGB에서 측정한 sidebar `#F3F4F6`, canvas `#F8F9FB`, 로고 글자 `#20232C`가 선언 값과 맞았다. 기존 `.deviceRGB` 표본은 화면 profile을 변환한 값이어서 시안 비교에 쓰지 않는다. 제품 색상 값은 보정하지 않았다. 캡처는 원 display profile에서 sRGB로 변환하고 profile 이름을 함께 기록한다.
- 과거 `native-main-parity-05/06`과 `native-main-geometry-02`의 전체 sidebar scroll 실패는 채택하지 않았다. `geometry-03`의 외부 foreground 변화와 `04`의 JSON BOOL 표현 불일치도 원 실패로 남긴다. `05`는 canonical BOOL과 app activation 관측을 함께 검증한 새 실행이다. 모달·IME·전체 오류 상태·모바일 QA 실행까지 디자인이 일치한다는 증거는 아니다.
- `native-main-geometry-20261103-07`는 낮은 창 높이에서도 7개 메뉴와 일반·넓은 창을 포함한 21개 화면을 통과했다. 요청한 `1024×700`은 OS가 실제 `1024×732`로 제한했으므로 `700pt` 캡처로 표시하지 않는다. 마지막 메뉴는 QAutra 소유 sidebar viewport를 실제로 `47.5pt` 내려 접근했고, 본문·host 입력은 이 조작에 사용하지 않았다.
- `native-source-parent-layout-20261103-01`은 변경한 shell에서 원문 검토→복수 기대값 확인→발행을 Native UI로 실행했다. 서로 다른 Unicode 원문 ID 두 개와 별도 check 경로, 원 배열의 바이트·파생 근거를 보존한 발행본 1개를 확인했다. 합성 fixture의 UI 경로 검증이며 고객 TC 실행이나 모바일 frozen 완료가 아니다.
- `native-source-resolution-layout-20261103-01`은 동일한 shell에서 구조 미확인 원문의 수동 전사→명시 검토→발행을 실행했다. 원문 SHA·경고·원 배열 대응을 유지했고 `manual-full-transcript` 해소 근거와 발행본을 확인했다. 실행한 Native 앱은 종료됐고 host activation은 관측되지 않았다.
- `native-evidence-layout-20261103-01`은 실제 Native UI에서 내보내기 취소와 명시한 관리 사본 삭제를 실행했다. 취소한 내보내기는 동의·다운로드로 진행되지 않았고, 삭제한 관리 사본 10개와 별개로 원 영상·FAIL·기대값·불변 실행 기록을 보존했다. `NSOpenPanel`·`NSSavePanel`의 모든 성공 경로나 고객 QA 수행을 검증한 결과는 아니다.
- 디자인 시안과 Native의 같은 화면을 1440 폭에서 나란히 비교했다(시안 `S02-runs-1440`·`S03-scenarios-1440`, Native `parity-1440-0/1`). 색상·`12/8pt` 모서리·sidebar·`64pt` 상단 바·주 버튼 `40pt`는 이미 일치했다. 21개 Native 캡처에서 주 버튼 높이 `40pt`, 상단 바 세로 중앙 `32pt`를 픽셀로 측정했다.
- 고친 차이:
  - 상단 바: 시안에 없는 `+ 새 실행` 주 버튼이 있어 시나리오 화면에 파란 주 버튼이 두 개였다. 이 버튼을 제거하고 `프로젝트 / 화면` 경로와 아이콘만 있는 검색·알림으로 맞췄다. 새 실행은 실행 현황의 `+ 새 실행`으로 같은 대화상자를 연다.
  - 안내 박스: 16px에서 시안 `.qa-notice`의 13px, 줄 높이 약 1.85, 패딩 16, 간격 12로 바꿨다. 패널 부제도 16px에서 13px로 바꿨다.
  - 실행 현황 지표: 4개의 별도 카드를 한 패널 안의 구분선 4칸으로 바꿨다. 숫자는 시안의 `600 32px`에 맞춰 32pt semibold로 바꿨다.
  - 목록 검색: 실행·시나리오·리포트·요구사항의 검색을 공통 `ProductSearchField`로 바꿨다. 아이콘과 `40pt` 테두리 입력창이다.
- 확인: `native-design-alignment-20261103-02`에서 7개 메뉴 × 3개 폭, 21개 화면이 통과했다. 상단 바 control 2개가 `40pt` 높이로 중앙에 있고, 검색창 테두리 간격 `40pt`, 업무 dispatch 0회, backend 닫힘, 소유 앱 종료, foreground `56335` 유지를 확인했다. 직전 `-01`은 parity probe가 상단 바 문구의 완전 일치를 요구해 경로 표시에서 멈춘 실패로 보존한다. probe와 검증 스크립트는 메뉴명이 경로의 끝과 일치하는지로 바꿨다.
- 남은 구조 차이: 시안의 실행 목록 표(열 머리글), 상태 탭 필터, 시나리오 표는 Native에서 카드 목록과 Picker로 남아 있다. 정보 구조와 API 표시 범위를 바꾸는 별도 화면 작업이라 이번에는 바꾸지 않았다.

## 2026-11-03 · Android recorder의 원 child 종료 검증

- Android recorder 초안의 PID 확인 후 `kill`하는 구간은 아직 실행 경로에 적용하지 않았다. 별도 C supervisor는 자신이 `fork`한 원 child를 `waitid(WNOWAIT)`로 보유하고, 종료 신호 뒤 마지막 `waitpid`에서만 회수한다. 회수 전에는 PID가 다른 프로세스에 재사용되지 않는 경계를 쓴다.
- `native-recorder-supervisor-20261103-01`은 새로 소유한 emulator에서 명시 중지·잘못된 중지 token·stdin EOF의 3가지 경로를 실행했다. 원 child의 exit 0·회수와 host encoder의 exit 0, 최종 H.264 프레임을 확인했다. host foreground는 `42511`, 업무 입력은 0회다. 이 코드는 조사용이며 제품 Native owner에 연결하지 않았다.
- 별도 `native-recorder-child-20261103-01`의 첫 decoded frame 준비 검증은 실패 상태로 보존한다. 종료 후 파일에는 프레임 1개·길이 `0.04초`만 있어 연속 영상이나 변경 전 recorder readiness를 입증하지 않는다. supervisor 기록의 `firstDecodedFrameBeforeStop`은 종료 후 값을 샘플링한 진단 오류가 있어 준비 증거로 쓰지 않는다. 모바일 frozen 실행·실기기·UI agent 종료·원 attempt 복구도 이 실험의 검증 범위 밖이다.
- `native-recorder-raw-20261103-02`는 같은 3가지 중지 경로에서 **중지 요청 전 실제 decoded frame**을 확인했다. 별도 raw RGB 경로를 `720×1560` H.264로 인코딩했으며, 최종 파일에서 직접 꺼낸 PNG의 상태 바·본문·탐색 버튼 방향도 확인했다. `01`의 잘못된 `vflip` 결과는 별도 실패 평가로 보존한다. 현재 프레임은 인증 차단 화면이며 업무 입력·연속 장면·실패 구간 영상·행동과 영상의 시각 대응을 검증한 결과가 아니다.
- raw source는 Android 화면이 새로 그려질 때 프레임을 낸다. 정적인 화면의 무프레임 상태를 곧바로 녹화 고장으로 판정하거나, 수신 시각을 실제 화면 생성 시각으로 확정하지 않는다. 연속성·시간축·전송 단절 후 원 source 정리를 확인하기 전에는 제품의 실패 영상 경로로 채택하지 않는다.

## 2026-11-03 · Safari 원 guest 복구의 실행 전제

- `recovery.register`는 원 guest의 녹화·브라우저 요청 전, idle context와 원 VM generation에만 등록된다. 업무 실행의 `recovery.runtime`은 실제 `VZVirtualMachine`의 running 상태·원 lease·automation 상태와 등록된 attempt를 요청 전후에 확인한다.
- 복구는 원 native owner의 VZ 종료 callback이 기록한 서명된 stop·inventory만 사용한다. `recovery.observe`는 원 기록을 읽을 뿐 대체 owner를 시작하거나 종료 증거를 만들어내지 않는다. runner는 native 종료·증거·backend 정리·late effects가 모두 확인돼야 원 attempt 자원을 해제한다.
- 현재 기존 `QAutra B02 Safari Guest 003608`의 저장 메타데이터는 `stopped/idle`, `installed=true`다. 해당 guest의 `status` 디렉터리는 비어 있어 인증된 hello와 실제 Safari 준비 증거를 확인하지 못했다. 저장된 `stopped` 값 자체는 frozen attempt의 원 native 종료 증거가 아니다.
- 따라서 이 연결의 실제 Safari·VZ 종료·controller 재시작 검증은 준비된 원 guest가 필요한 상태로 남긴다. 기존 VM을 임의로 채택·재시작하거나 호스트 Safari·WebKit으로 대체하지 않았다.

## 2026-11-03 · 승인된 Native cold startup의 실제 순서

- `native-sdk-android-20261103-07`은 새로 소유한 emulator generation F의 실제 서명 DEBUG APK·UiAutomator2·HTTPS backend에서 실행했다. `fixture-prepared → bootstrap-authorized → sdk-start-dispatched → bootstrap-only-observed → bootstrap-published → client-authenticated` 순서를 host 시각과 단조 시각으로 기록했다.
- 실제 SDK 인증 전에는 bootstrap 대기 화면만, 인증 후에는 입력·확인 화면을 관측했다. 현재 조건의 인증 2회·이전 challenge 재사용 거부·미완성 요청 미소비·backend fence 회수와 baseline 복원을 확인했다. 업무 입력은 0회, host foreground는 전후 `56335`였고 host 인증서 신뢰와 전역 입력을 바꾸지 않았다.
- 이 실험은 cold SDK를 준비 승인 안에서 시작할 수 있음을 입증한다. 일반 `launch` 권한이나 모바일 frozen owner의 연결·녹화·복구 완료를 입증하지 않는다. 원 Appium·backend child는 종료됐고, 이후 generation F도 원 boot ID가 일치할 때만 power-off해 실제 supervisor exit 0을 확인했다.

## 2026-11-03 · Android UI agent의 원 kernel handle

- 별도 C probe는 `run-as io.appium.uiautomator2.server`의 UID에서 실제 UiAutomator2 agent에 `pidfd_open`을 호출한다. 열린 kernel handle과 원 PID·boot ID·시작 tick·UID·cmdline이 맞는지 확인한 뒤, 신호 전달과 종료 관측에는 그 handle만 사용한다. PID 재조회 후 번호로 `kill`하는 경로가 아니다.
- `native-agent-pidfd-20261103-02`는 새로 소유한 generation G에서 실제 agent 3개를 대상으로 명시 중지·잘못된 control token·stdin EOF를 실행했다. 각 원 process의 종료를 kernel handle에서 확인했고 escalation 없이 helper exit 0을 받았다. 잘못된 시작 tick은 모두 exit `87`로 거부됐으며 그 뒤 원 session의 관측은 계속 가능했다.
- helper·원 Appium child 종료와 업로드한 private binary 삭제를 확인했다. host foreground는 전후 `56335`, 업무 입력은 0회였다. `01`의 잘못된 `exec-out` duplex 제어 실패는 보존하고, `02`는 검증된 `adb shell -T` transport로 실행한 별도 결과다.
- 이는 실제 Android agent 종료의 component 증거다. 모바일 frozen owner에는 아직 연결하지 않았으며, ADB 단절 뒤의 durable 원 종료 증거·영상 연속성·backend recovery·실기기·iOS까지 완료한 것으로 표시하지 않는다. 이 결과로 기존 frozen 자원의 `unknown`을 해제하지 않았다.

## 2026-11-03 · 원 Android 종료 기록의 후속 검증

- `native-agent-disclosure-20261103-02`는 원 pidfd가 terminal이 된 뒤에만 private source에 종료 preimage·seal을 fsync하는 component를 실제로 실행했다. 명시 중지·잘못된 control token·stdin EOF·출력 정체·local ADB client 종료·기존 source 충돌의 6개 시나리오를 검증했다.
- 앞의 5개는 원 binding·source inode·commitment·local 인증 기록이 맞을 때만 원 종료를 확인했다. 충돌 시나리오는 process가 멈춰도 기존 source를 덮어쓰지 않고 `unknown`을 유지했다. 변조한 local 기록·잘못된 source inode·start tick·숫자 overflow도 거부했다.
- 원 Appium·helper의 local child 31개와 이번 성공 실행의 remote binary/source directory는 정리됐다. 앞선 `01`의 충돌 source·실패 판정은 보존했고, generation H 종료 뒤 wipe 없는 I·J·K에서도 해당 bytes·metadata가 그대로였다. 해당 generation은 각각 원 boot를 대조해 power-off하고 실제 supervisor exit 0을 확인했다.
- 이는 신뢰한 원 producer의 조건부 disclosure다. kernel 서명·native 완료 시각·ADB server 소실·기기 소실·helper OOM/SIGKILL·영상·backend 복구·모바일 frozen 자원 해제의 증거로 확장하지 않는다. 상세 계약과 iOS 후보 반증은 `docs/research/2026-11-03-native-session-closure.md`에 남겼다.

## 2026-11-03 · Native 내보내기 성공 UI의 미확인 경계

- `native-evidence-export-layout-20261103-01`·`02`의 긍정 `NSSavePanel` UI 실험은 모두 deadline으로 끝났다. 원 QAutra child는 종료됐으며 host foreground를 강제로 바꾸지 않았다. `02`에도 최종 저장·TAR 완성 증거는 없다.
- `01`에서는 remote service 시작 실패 alert stack을 관측했다. launcher의 불필요한 sample 실행과 상속 주입을 제거한 `02`에서는 그 stack을 수집하지 않았으므로 같은 원인이라고 확정하지 않는다. 관측한 것은 `NSSavePanel`·`NSRemoteView`와 저장 진행 정체다.
- 공개 panel validation을 우회하거나 host `Documents`에 강제 저장하지 않는다. 앞서 통과한 Native export cache 프로토콜과 취소 UI 결과는 긍정 저장 panel의 증거가 아니다.

## 2026-11-03 · 승인된 실제 Android 입력과 실패 영상 component

- `native-sdk-video-20261103-03`은 실제 signed DEBUG APK·UiAutomator2·Java SDK·HTTPS backend에서 한글 입력과 확인의 2개 업무 동작을 수행했다. 첫 decoded frame 준비 후에만 동작을 시작했고, `setValue` readback과 실제 결과 문구 `결과: QAutra 영상 20261103`를 확인했다. host clipboard 경로는 사용하지 않았다.
- SDK 인증은 7회였다. focus tap·입력 준비·setValue·확인에 해당하는 4개 driver action boundary마다 서로 다른 backend receipt를 한 번만 소비했다. 동일 action 내부의 facade/transport guard 재검사는 해당 call window의 조건·receipt·만료만 확인하며, 다른 action으로 권한을 넘기지 않는다. 제품의 single-use proof 검사를 완화하지 않았다.
- 의도적으로 다른 기대값을 준 합성 assertion은 `FAIL`로 남겼다. 보존한 실제 영상은 `720×1560`, `3초`, decoded frame `40개`, SHA-256 `c5010ad2c183b02f5106067c3c8e43f09c5b1bccf8e456cca696fa842e1ae4ca`다. 파일에서 꺼낸 첫/마지막 PNG로 입력 전 화면과 한글 결과 화면을 직접 확인했다. 고객 TC나 제품 frozen report의 결과가 아니다.
- 원 recorder child의 heartbeat·명시 중지·회수와 encoder exit 0을 확인했다. backend는 fence를 revoke하고 pending effect 0·baseline 복원을 응답했다. 원 Appium·backend child도 종료됐고 host foreground는 전후 `56335`, host 신뢰 설정·전역 입력은 바꾸지 않았다.
- `01`은 이미 소비한 조건 proof를 재검사한 harness 실패, `02`는 facade와 transport guard의 이중 호출에서 다시 소비한 harness 실패다. 원 실패와 원문을 바꾸지 않았다. 재실행은 앞선 VM의 실제 종료 뒤 새 boot에서 했고, 이전 실행이 만든 SDK provision의 정확한 bytes를 검증해 읽었을 뿐 덮어쓰지 않았다.
- **raw 녹화는 제품 채택 전이다.** 수신 raw frame `43개`와 encoded frame `40개`가 같지 않고, 시각은 `encoder-observed`이며 native 화면 생성 시각이 아니다. 앞선 정지 화면 실험에서는 원 helper control 구간이 `1.054초`였어도 MP4는 `1개/0.033333초`여서 정지 구간의 재생 길이를 보장하지 못했다. 스크린샷 반복이나 테스트 앱의 인위적 animation으로 이 한계를 숨기지 않는다.
- 모바일 frozen owner·원 UI agent와 영상의 통합 종료 authority·controller 재시작·실기기·iOS·제품 리포트 연결은 별도 미완료다. 이 component 결과로 기존 `unknown` 자원을 해제하지 않았다.

## 2026-11-03 · native 표시 시각을 보존한 Android 실패 영상

- raw 입력의 고정 frame rate 문제를 피하기 위해 별도 component에서 Android `MediaCodec.BufferInfo.presentationTimeUs`를 유지한 H.264 stream을 MP4로 remux했다. host 화면·스크린샷 반복·테스트 앱 animation·재인코딩은 사용하지 않았다. 이 시각은 **source presentation**이며 OS의 실제 화면 생성 시각을 증명하지 않는다.
- `native-source-video-20261103-01`은 사용자 입력 없는 4초 관찰 구간을 포함했다. 원 source frame `59개`와 decoded frame `59개`, native PTS 구간 `4.340155초`와 MP4 `4.340156초`를 확인했다. 각 frame 시각의 최대 차이는 `11µs`다. 첫/마지막 화면의 시스템 시계가 달라 완전한 무변화 화면 실험이라고 부르지 않는다.
- `native-sdk-source-video-20261103-01`은 동일한 원 boot에서 실제 SDK 인증·한글 입력·확인·의도한 합성 assertion `FAIL`을 실행했다. 첫 native frame의 실제 decode 이후 입력을 시작했고, 결과 관측 뒤 source presentation이 진행된 다음 녹화를 닫았다. 원 frame `45개`를 모두 보존한 `720×1560`, `2.479756초`, `274,778 bytes` 영상의 SHA-256은 `519689fcfb419e3bd57cd0ceff0a2d43777ff01b23a356dee7265e28c1325d75`다. frame별 최대 PTS 차이는 `11µs`이며 마지막 PNG에서 `결과: QAutra 영상 20261103`를 직접 확인했다.
- 입력·확인의 2개 업무 동작, SDK 인증 7회, 서로 다른 action receipt 4회의 single-use 경계는 유지했다. 원 producer의 fork child와 Unix socket peer PID가 같았고, `control=false`·`audio=false` 상태에서 native child가 signal 없이 exit 0, host remux도 exit 0이었다. backend는 revoke·pending effect 0·baseline 복원을 응답했으며 host foreground는 전후 `56335`였다.
- 사용한 것은 `scrcpy` desktop 앱이 아니라 Apache-2.0 server `4.0` JAR만이다. release commit `2322868e9e256eb5fce0b3d659ab2a409f29bae1`, JAR SHA-256 `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a`를 고정했다. 내부 protocol 4.0의 session/config/key flag를 엄격히 해석하고 중간 session 변경을 거부했다. native codec의 이전 frame 반복 설정은 사용했지만 host에서 frame을 합성하지 않았다.
- 기본 설치·제품 dependency·frozen recorder를 바꾼 결과는 아니다. durable producer 종료 기록·controller 재시작 복구·원 UI agent와의 통합·실기기·iOS·고객 TC report는 미완료다. 성공 component만으로 기존 unknown 자원을 해제하지 않았다.
- 독립 검토 후 native helper의 조기 exit를 STOP 성공으로 덮는 경계, exec 확인 대기, terminal 관측 출력 유실을 별도 소유한 native child로 재현했다. `.qa/native-smoke/native-source-lifecycle-before-20261103-01/`의 세 실패를 수정 뒤 `native-source-lifecycle-after-20261103-01/`에서 모두 보존·거부하는 동작으로 확인했다. 이는 실제 원 child 종료/오류 처리이며 유효한 영상·제품 frozen 종료 증명이 아니다.
- 보강 중인 component의 `.qa/native-smoke/native-source-video-20261103-02/`는 입력 없는 구간에서 **실패**했다. 고정 1.5초 frame-gap 판정이 정상 idle과 source 중단을 구별하지 못했다. 대기시간을 늘리거나 앱 animation으로 통과시키지 않았다. 원 source 디렉터리·실패 기록과 unknown을 보존하고 소유한 emulator 원 boot만 종료했다.
- 수정: frame 간격 대신 **원 encoder thread의 응답**을 판정한다. 같은 commit의 server source를 실험용으로 고친 `4.0-qautra-source-v3`는 video socket으로 받은 순번 challenge에 encoder loop가 직접 응답한다. 명시 STOP 뒤 MediaCodec EOS와 encoder 해제를 각각 보고한다. 중간 재시도·축소 재시작은 제거했다. 입력 제어·audio·추가 display는 거부한다. 이 JAR는 upstream 원본 release가 아니며 제품 dependency나 frozen recorder로 연결하지 않았다.
- host는 MPEG-TS를 private `0600` spool에 순서대로 기록·fsync한다. 원 EOS·해제·정상 종료가 확인될 때만 MP4로 한 번 remux한다. 마지막 frame은 EOS 시각까지 유지하며 frame을 합성하지 않는다. EOS가 없으면 완전한 녹화로 확정하지 않는다. 확인 가능한 앞부분만 `incomplete`로 남긴다.
- 실제 emulator 결과: `native-source-video-20261103-03`과 `-04`는 입력 없는 구간을 EOS까지 기록했다. encoded frame 간격이 최대 513ms·100ms였지만 encoder 응답으로 정상 idle을 확인했다. MP4 길이는 각각 4.536678초·4.705956초로, EOS 기준 길이와 3µs·8µs 차이였다. frame PTS 오차는 최대 11µs다.
- 실패 경로: `native-source-loss-20261103-01`은 수정 전 실패다. producer 강제 종료 뒤 EOS 없는 MP4가 먼저 만들어져 incomplete 표시가 누락됐다. 수정 뒤 `-02`는 소유한 encoder process만 SIGKILL했다. 조기 종료를 감지했고 완전 녹화 기록은 0개였다. 읽은 6 frame만 `incomplete`로 보존하고 원 remote source와 ownership `unconfirmed`를 유지했다.
- 관측 foreground PID는 전후 `56335`로 같았고 host-global 입력·업무 동작은 0회다. 소유한 emulator boot만 종료했다. OS 실제 화면 생성 시각, UI agent·backend 정리, controller 재시작 복구, 실기기·iOS·고객 TC report는 이 검증 범위가 아니다.

## 2026-11-03 · 모바일 고정 회귀 실행은 제출 단계에서 거부

- 사용자 결정: 모바일 고정 회귀 실행의 제품 연결은 **별도 에픽**으로 분리한다. 이번 범위에서는 android·ios 대상을 명시적으로 거부한다.
- 이전 동작: 제출은 대기열에 들어간 뒤 `executeFrozenAttempt`의 `beforeOpen`에서 `actual_target_mismatch`로 실패했다. 최종 코드는 `session_failed`로 남았을 것으로 추정하며, 실행해서 확인하지는 않았다. 사전 점검만 `fixture_native_bootstrap_unsupported`로 차단을 표시했다.
- 변경: `RegressionDependencies.supportsTarget`을 사전 점검과 제출이 함께 사용한다. 지원하지 않는 대상은 grant·정의 확인과 실행 기록 생성 전에 `frozen_target_unsupported`(`not_started`)로 거부한다. 현재 지원 대상은 엔진이 소유한 `chrome:`·`guest:` 데스크톱 대상뿐이다. 다른 기기로 대체하지 않는다.
- 확인: `test/runner/regression.test.ts` 51/51 통과, typecheck 통과. 일회성 실제 엔진 확인에서 android 제출이 `frozen_target_unsupported`로 거부됐고, 실행 기록 0건·실행 시작 0회였다.
- 별도 에픽에 남은 범위: 모바일 소유 프로세스와 device lease, 모바일 복구 schema·검증 분기, owner가 실행하는 녹화(위 v3 EOS 녹화기의 제품화), Android UI agent 종료 증명, 실험 의존성(수정한 scrcpy server·NDK helper)의 vendor·빌드·라이선스 고지. **iOS는 공식 경로로 UI agent 종료를 증명할 방법이 없어** 지원 경로가 정해지지 않았다.


## 2026-11-03 · Claude 구독 CLI 전용 전환

- Claude 직접 API client를 추가하지 않는다. 기존 `qa plan`의 `ANTHROPIC_*`·광범위한 `CLAUDE_*` 전달을 제거하고, Claude와 Codex의 환경을 분리했다. Claude API key·bearer token·Console profile·Bedrock/Vertex/Foundry 전환값은 Claude child에 전달하지 않는다. 사용자의 shell·계정·인증 저장소는 수정하지 않는다.
- 앱 해석 보조와 `qa plan --llm claude-cli`는 동일한 구독 인증 predicate를 쓴다. `loggedIn: true`만으로 전송하지 않고 `authMethod: "claude.ai"`를 요구하며, 보고된 `apiProvider`가 다르면 거부한다. API key/helper·외부 provider·환경 token·불명확한 상태와 깨진 JSON은 원문 전송 전에 차단한다.
- CLI의 제한 실행·빈 설정 원본·hooks 차단에 `forceLoginMethod: "claudeai"`를 함께 지정한다. 직접 API 호출이나 자격 증명 추출을 하지 않으며, 사용량·로그인 실패에서 API/다른 provider로 자동 전환하지 않는다. 사용자·회사 정책이 바뀌는 상황을 원자적인 과금 attestation으로 보증하지 않는다.
- Native 설정과 전송 동의에도 `Claude Code · 구독`을 명시했다. 기존 정확한 payload 동의·동의 철회·UNREVIEWED 결과·수동 검토/발행 계약은 유지한다. AI 연결은 확정 회귀 실행의 필수 조건이 아니다.
- 인증·계정 선택의 근거는 [공식 인증 문서](https://code.claude.com/docs/en/authentication)와 [CLI 명령](https://code.claude.com/docs/en/cli-reference)이다. 구독 계정의 [Usage credits/추가 사용량](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)은 별도 과금될 수 있으며 QAutra가 계정의 초과 사용량 설정을 끄거나 잔여량을 검증하지 않는다.
- 최종 관련 회귀 69/69, typecheck, Native 앱·guest helper 빌드가 통과했다. 별도 읽기 전용 적대적 검토에서 이 전환 범위의 확정 결함은 보고되지 않았다. 정식 workflow의 두 CLI 리뷰 게이트를 대신한 결과는 아니다.
- `.qa/native-smoke/claude-subscription-20261103-01/proof.json`은 **실제 설치 CLI**를 private HOME/config와 합성 무효 키로 실행한 결과다. raw CLI는 `loggedIn: true, authMethod: "api_key"`를 보고했으나, shipping adapter가 환경을 정제한 뒤에는 `loggedIn: false, authMethod: "none"`으로 원문 전송을 거부했다. 원 사용자의 로그인은 조회·변경하지 않았고 모델 프로세스 시작·모델 원문 전송은 0회다.
- `.qa/native-smoke/claude-subscription-settings-20261103-01/`은 재빌드한 실제 Native 앱의 7개 기본 화면×3개 폭, 총 21 capture다. 실제 설정 화면에서 구독 라벨과 API 미지원·요청별 동의 안내를 확인했다. 업무 dispatch 0회·backend 닫힘·소유 앱 종료를 확인했고 관측된 foreground PID는 전후 `56335`로 같았다. 모든 OS dialog/IME의 비간섭이나 실제 구독 모델 성공을 뜻하지 않는다.
- 실제 구독 모델 응답 성공은 **확인 안 함**이다. 앞서 확인한 실제 사용자 Claude CLI의 `loggedIn: false` 상태를 재조회해서 반복 확인하거나 다른 provider로 고객 원문을 전송하지 않았다. 수동 작성과 확정 회귀 실행은 이 연결에 의존하지 않는다.

## 2026-11-03 · 전체 suite 복구

- 수정 전 전체 `npm test`는 1202개 중 1047 통과·149 실패였다. 실패는 세 원인이었다.
  - **증거 읽기 경계**(약 147건): `openEvidenceFile`이 저장 위치 위쪽 경로까지 symlink를 거부했다. macOS `/var`가 `/private/var`의 symlink라 `$TMPDIR` 아래의 모든 실행 증거 읽기가 `evidence_boundary_unsafe`로 실패했다. 실제 프로젝트 경로에 OS 별칭이 있을 때도 같은 실패가 난다. 저장 위치 자체가 symlink이면 계속 거부하고, 위쪽 경로는 realpath로 정규화해 검사하도록 고쳤다. 별칭 위쪽 경로 허용·symlink 저장 위치 거부 회귀 검사를 추가했다.
  - **모듈 경계**(1건): `runner/recovery.ts`가 `drivers/vm/recording-protocol.ts`를, `server/product-evidence.ts`가 `report/html.ts`를 import했다. 녹화 프로토콜은 zod·core 타입만 쓰는 계약이라 `src/core/guest-recording-protocol.ts`로 옮기고 모든 import를 바꿨다. HTML 렌더러는 `PortableEvidenceRenderer`로 주입하며 `qa serve`가 연결한다. 주입이 없으면 export 파일을 만들기 전에 `evidence_renderer_unavailable`로 거부한다.
  - 나머지 1건(`retains an uncertain open lease…`)은 재실행에서 통과했다. 원인은 확인하지 못했고 간헐 실패 가능성으로 남긴다.
- 수정 후 전체 `npm test`: 1203개 중 1197 통과·0 실패·6 skip(선택 실행 fixture). typecheck 통과.
