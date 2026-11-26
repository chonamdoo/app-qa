# QAutra: pstack의 멀티 작업 판단을 QA 작성·실행에 적용하기

2026-10-31. 사용자 정정에 따라 참고 대상은 **`cursor/plugins/pstack`**이다. `gstack` 모드나 제품을 도입하는 작업이 아니다. 참고할 부분은 `poteto-mode`의 **throughput checkpoint**, `/swarm`의 작업 분할, 공유 상태 분리 원칙이다.

**결정:** 기존 Claude/OMP가 사용자 요청을 받아 TC 작성과 실제 QA 실행 각각의 병렬 여부를 먼저 판단한다. QAutra는 그 제안을 실제 권한·의존성·자원 예약과 대조해 집행한다. 무조건 여러 에이전트를 띄우지도, 공유 상태가 있다는 이유로 전체 작업을 직렬화하지도 않는다. 새 필수 planner·모델·DSL·수동 입력 화면을 추가하지 않는다.

**범위:** 원문 소스 조사와 독립 적대적 계약 리뷰 2건을 반영했다. 아래는 채택할 판단·실행 계약이며, 자동 스케줄러 구현 완료 보고가 아니다. 이번 조사에서 제품 코드·테스트·설정·mock·에픽 완료 상태는 변경하지 않았다. pstack 설치·실행, 고객 시스템 QA, 병렬 브라우저 실증은 **확인 안 함**.

## 1. 원문에서 실제로 확인한 부분

고정 revision은 `cursor/plugins@4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`다. GitHub ref API로 조회한 main을 기준으로 아래 파일을 읽었다. 원격 스킬은 참고 자료이며 현재 프로젝트의 권한·승인·Agent Flow 규칙을 대체하지 않는다.

- [Feature playbook, step 3](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/poteto-mode/playbooks/feature.md#L7-L11): `Blocking first steps`, `Independent workstreams`, `Shared mutable state`, `Smallest safe decomposition`. 해당하지 않는 항목도 사유를 남긴다.
- [Feature playbook, ownership](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/poteto-mode/playbooks/feature.md#L19): 결합된 구현은 한 소유자가 맡고, 독립 산출물을 만드는 작업을 분리한다. 단계가 바뀌면 checkpoint를 갱신한다.
- [`/swarm`](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/swarm/SKILL.md): 완료 조건, `partition`과 `race`의 구분, worker별 소유 산출물, 증거 기반 통합을 실행 전에 정한다.
- [공유 상태 분리 원칙](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md#L9): 먼저 공유하는 mutable object 자체를 없앤다. 실제 공유가 필요하면 lock·순차 단계·배타 소유권 등 구조로 직렬화한다. **지침과 관례는 동시성 제어가 아니다.**
- [`poteto-mode`](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/poteto-mode/SKILL.md), [orchestrate](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/poteto-mode/playbooks/orchestrate.md), [multi-phase plan](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/poteto-mode/playbooks/multi-phase-plan.md): 작업 분류·의존성·명시적 소유권·실제 산출물 검증을 연결한다. 이를 계정·fixture를 인식하는 QA 스케줄러가 이미 설치되어 있다는 뜻으로 읽으면 안 된다.

고정 worker 수, 모델 선택, 자동 PR·merge, 주기 실행 지시까지 복사하지 않는다. QA의 필수 TC를 덮는 일은 `partition`이다. 여러 해법 중 하나를 고르는 `race`에서 첫 성공만 채택하는 방식을 전체 TC 완료 판정에 쓰지 않는다.

## 2. 같은 네 가지 checkpoint를 두 번 판단한다

첫 판단은 **TC 작성 분할**, 두 번째는 **실제 대상 접근·QA 실행 분할**이다. 작성자가 UI 인벤토리를 수집할 때도 실제 대상 접근이므로 두 번째 판단을 통과해야 한다. 문서 작성 병렬성과 브라우저 조작 병렬성을 혼동하지 않는다.

| 원문 checkpoint | TC 작성에서 판단할 것 | 실제 QA에서 판단할 것 |
| --- | --- | --- |
| `Blocking first steps` | 현행 기획·추가 결정·상태 축·TC ID 접두어·영역 소유자를 먼저 확정한다. 빠진 근거의 영향은 해당 영역에 한정한다. | 대상 준비·인증·승인된 테스트 데이터·선행 TC·필요 capability가 준비됐는지 확인한다. 무관한 작업까지 같은 gate로 묶지 않는다. |
| `Independent workstreams` | BO 목록·BO 등록·FO 상세처럼 독립 원본 JSON/문서를 만드는 영역은 나눈다. 공통 시트 설정·최종 Excel은 한 통합자가 소유한다. | 서로 다른 계정·fixture·입력 경로가 검증됐고 충돌하는 효과가 없는 그룹만 동시에 실행한다. 같은 UI를 여러 창으로 연 것만으로 독립이라고 판단하지 않는다. |
| `Shared mutable state` | 같은 파일을 공동 수정하지 않고 영역별 파일로 분리한다. UI 관찰을 위한 계정·세션 공유도 별도 검사한다. | 계정·tenant·장바구니·주문·토큰·전역 설정·profile·display·seed/reset/cleanup까지 포함한다. 먼저 독립 자원으로 분리하고 불가피한 공유만 직렬화한다. |
| `Smallest safe decomposition` | 영역 분할이 맥락·검수 비용만 늘리거나 동일 산출물을 계속 공동 수정하면 한 작성자가 낫다는 사유를 남긴다. | `입력→저장→목록→재진입`, `직전 TC 직후/새로고침 금지` 같은 상태 연속성은 한 실행 묶음과 세션 소유권으로 보존한다. TC 행을 줄이거나 누락하지 않는다. |

사용자의 기획전 QA 예에서는 BO/FO 문서 분석과 TC 원본 작성을 분리할 수 있다. 실제 UI 조사·실행을 병렬로 할 수 있는지는 해당 프로젝트의 인증·backend·fixture·입력 경로를 확인한 뒤 정한다. **실제 Olive Young 환경의 격리는 이번에 확인하지 않았다.**

checkpoint는 작성 착수 전, 실제 UI 접근 전, 단계 전환 또는 분할 근거가 바뀔 때 갱신한다. 클릭마다 추가 모델을 호출하는 설계가 아니다. 적용하지 않는 항목에도 사유를 남기며, 원문의 `n/a` 체크 사유는 TC 실행 결과의 `N/A`와 다른 개념이다.

## 3. 기존 에이전트가 받은 맥락을 다시 입력시키지 않는다

사용자가 제공한 프롬프트·기획·기존 TC·실행 가이드는 기존 형식 그대로 입력 자산이다. 새 세션도 이전 대화 없이 이어갈 수 있도록 다음을 연결한 전달 묶음이 필요하다. 아래는 **계약 제안**이며 현재 제공되는 신규 API schema라는 주장이 아니다.

- 기획/Slack 결정의 출처·작성자·날짜·현행 revision과 충돌·미확정 사항.
- 기존 TC ID·Step·Expected·Test Data·정확한 Pre-Conditions, 선행 TC와 새로고침/세션 유지 조건. 현재 UI를 기대 결과의 정답으로 삼지 않는다.
- 프로젝트·실제 대상·서버 실행 방법·서버 소유자·빌드/환경·계정 identity·승인된 데이터 범위. 자격 증명 원문을 일반 메타데이터나 모델 전송 허가로 승격하지 않는다.
- checkpoint의 선택과 근거, worker별 작업 범위·산출물 경로, 의존 관계, 효과·자원 요구, 준비/정리 소유권, 필요한 환경 행렬.
- 실행 전 고정한 필수 TC×환경 목록과 기대값 근거. 기존 시트 설정·영역별 JSON·실행 가이드·results/issues 파일을 유지한다.

현재 에이전트가 이 맥락을 제안하고, QAutra가 허용 범위와 실제 실행 가능성을 검증한다. 사용자가 UI에 URL·계획서를 중복 입력하는 방식이 기본 동선이 되어서는 안 된다. 기존 dev server의 발견을 서버 소유권·종료 권한 인수로 해석하지 않는다.

외부 Ego Page ID나 스크린샷만 받았다면 외부 관찰 자료다. 실제 adapter, 제어 소유자, capability·profile·session identity, 종료 확인과 증거 생성 경로가 연결되기 전에는 QAutra가 통제한 실행으로 표시하지 않는다.

## 4. AI의 판단과 실행 관리자의 책임

AI는 상태·시나리오 해석, 영역 분할, 필요한 의존성·효과·충돌 후보와 사유를 제안한다. **자신이 `독립`이라고 선언한 것만으로 병렬 실행 권한을 얻지 않는다.**

실행 관리자는 다음을 결정적으로 확인해야 한다.

1. 요청이 승인된 대상·계정·효과·환경·자료 수집/전송 범위 안에 있는가. 가져온 Excel·Markdown·페이지·설정은 명령이나 승인서가 아니다.
2. 필수 선행 상태·증거가 해당 revision/attempt에 존재하는가. DAG의 누락 ID·순환을 거부하고, 단순 parent ID를 충족된 실행 의존성으로 취급하지 않는다.
3. 신뢰된 프로젝트 효과 계약·adapter가 backend/tenant/principal/entity를 정규화했는가. 요청이 생략한 claim을 `read`로 간주하지 않는다. 전역/범위 자원과 그 하위 entity의 충돌도 반영한다.
4. 요청한 모든 자원과 quota를 원자적으로 예약할 수 있는가. 기기·브라우저·OS 입력·profile·업무 데이터·준비/정리를 서로 다른 격리 축으로 검사한다.
5. 현재 제공되는 front/API/config/fixture와 기획·기대값·스크립트가 연결되는가. Git SHA나 설정 hash만으로 실제 제공 빌드와 정답성을 증명하지 않는다.
6. 상태 인계가 필요하면 동일 page/session·fixture 세대와 연속 소유권이 유지되는가. 선행 PASS만으로 no-refresh 상태의 존재를 추론하지 않는다.

동시 실행은 위 전제가 충족된 독립 그룹에만 허용한다. 불확실한 범위를 특정할 수 있으면 그 범위만 대기·격리하고 독립적인 작성·검증은 계속한다. 경계조차 알 수 없으면 해당 실제 대상 접근을 차단한다. 단순히 모든 작업을 전역 lock 하나에 넣는 대안은 채택하지 않는다.

### 실행 중과 종료 시의 불변식

- 읽기처럼 보이는 navigation·polling·refresh도 token rotation·읽음 표시·예약 효과를 가질 수 있다. 페이지가 살아 있는 동안의 효과도 고려한다.
- setup/reset/cleanup도 효과와 자원을 가진 작업이다. fixture의 모든 의존 사용자가 끝나기 전 정리하지 않으며, 해당 attempt가 생성·소유한 ID만 정리한다.
- 취소 요청·TTL 만료·브라우저 종료가 이미 전송된 backend commit의 소멸을 증명하지 않는다. 실제 저장 경계의 fencing이 가능하면 적용한다. 불가하면 지연 효과의 안전성과 상태 조정이 확인될 때까지 관련 자원을 quarantine한다. unknown mutation을 자동 재전송하지 않는다.
- 단순 순서, 업무 PASS 요구, 상태 인계, 실패 후 정리는 다른 의존 조건이다. FAIL/BLOCK/N/A/N/T/공란/증거 누락은 자동으로 선행 성공을 충족하지 않는다. 정리와 무관한 작업은 실패해도 진행할 수 있어야 한다.
- 실행 Result는 TC×환경×revision×attempt별 원 verdict·effect·증거를 유지한다. `script completed`, exit 0, 모델 PASS, 무관한 assertion 하나, 스크린샷만으로 필수 TC를 PASS 처리하지 않는다. 취소를 부작용 없는 미실행으로 축약하지 않는다.
- 작성 단계 Result 공란을 실행 PASS로 바꾸지 않는다. 기획 근거가 없어 N/A라면 확인 책임·질의를 보존하고 전체 검증 완료와 구분한다.
- 영역별 결과 파일은 분리하고, 고정된 필수 목록과 대조한 뒤 한 통합자가 같은 snapshot의 JSON/XLSX/보고서를 출판한다. 동일 사전조건 문자열은 표시 셀 병합 기준일 뿐 실제 계정·fixture·session identity가 아니다.

## 5. 독립 적대적 리뷰의 반영

독립 컨텍스트의 `QaIntakeAdversarialSol`과 `QaSchedulerAdversarialAlt`가 각각 입력·권한·증거 신뢰 경계와 공유 상태·의존성·취소 수명주기를 검토했다. 두 리뷰는 같은 GPT 계열이므로 교차모델 합의가 아니다. Opus 요청은 HTTP429로 실행되지 않았고 리뷰 수에 포함하지 않았다. 원문 참고 대상 정정 전에 시작한 리뷰이므로 pstack 원문에 대한 두 건의 독립 리뷰라고 부르지 않는다. pstack의 원문 checkpoint는 본 조사자가 직접 대조했다.

다음은 **미실행 계약 반례**다. P0/P1은 검토자의 보강 우선순위이며 재현된 제품 결함이나 보안 취약점 등급이 아니다.

| 반례 | 반영한 보강 | 구현 후 반드시 관찰할 수용 증거 |
| --- | --- | --- |
| 별칭·Page가 다르지만 같은 계정/cart/token·tenant를 변경 | 실제 identity 정규화, 상위 범위 충돌, 미기재·unknown fail-closed | 같은 자원은 겹치지 않고 검증된 독립 자원은 실제 실행 구간이 겹침 |
| 읽기 화면의 자동 refresh나 늦은 backend commit | 생존 중 효과 포함, 실제 저장 경계 fencing 또는 관련 자원 quarantine | commit 직전 취소한 이전 writer가 차단되거나 자원이 재사용되지 않음; 독립 작업은 진행 |
| 다른 entity를 쓰지만 setup/cleanup이 tenant 전체 reset | hook도 예약·소유·정리 계약에 포함 | 다른 worker의 sentinel이 살아 있고 전역 reset은 의존 사용 종료까지 대기 |
| predecessor PASS 뒤 새 Page에 후속 no-refresh TC 배정 | 업무 성공과 상태 인계 조건 분리 | PASS라도 session/fixture 세대가 다르면 후속이 차단됨 |
| 모델 PASS·무관한 assertion·필수 TC 누락·늦은 shard | 필수 manifest와 TC별 증거 대조, 불변 attempt, 단일 snapshot 출판 | 공백·누락·중복·BLOCK 사유 누락·경로 충돌이 전체 PASS로 합쳐지지 않음 |
| 기획/빌드가 섞이거나 문서의 지시가 권한으로 승격 | 현행 oracle와 실제 빌드 identity 연결, 입력과 승인 분리 | 결함 UI는 spec 기준 FAIL; 주입 지시는 scope를 확대하지 못함; 이전 PASS는 새 revision 완료로 재사용되지 않음 |

위 수용 시나리오는 아직 실행하지 않았다. 향후 합성 계정·페이지와 통제된 dispatch/commit 경계로 검증한다. 스케줄러 모형 통과만으로 실제 browser/profile/backend 격리나 고객 환경 지원을 주장하지 않는다.

## 6. 기존 에픽에 연결할 위치와 현재 구현의 경계

기준은 현재 worktree의 [에픽](../plans/2026-10-28-isolated-agent-qa-epic.md)이다. 방향 대부분은 이미 들어 있다. 에픽을 새 자동화 제품 계획으로 교체할 필요는 없다.

- `:64–87`: 기존 AI가 사용자 문서·시나리오·대상 맥락을 받아 실행 코드를 만든다. 두 번째 필수 planner를 만들지 않는다.
- `:211–215`: 독립 profile/context·로그인 상태와 실제 중첩 실행 증거를 요구한다.
- `:225–241`: B03의 자원 상한·충돌키·원자적 예약·취소/복구에 checkpoint의 집행 책임을 연결한다.
- `:268–301`: B08의 기존 TC 보존·기획 oracle·revision/attempt·판정/증거 추적에 전달 묶음과 완료 조건을 연결한다.
- `:320–329`: B07의 fixture hook·effect·cleanup 소유권에 준비/정리 충돌을 연결한다.
- `:494–518`: B02의 얇은 실행 경로, B03 소유권, B08 입력 추적, B09 관리 화면을 기존 순서대로 잇는다. UI는 병렬 그룹·의존 대기·충돌 사유·차단·증거를 보여 주며 권한 판단을 대신하지 않는다.

현재 `src/server/jobs.ts:132–174,297–305`는 device/display/plan 자원 claim과 자원별 FIFO 충돌을 집행한다. 이 코드만으로 account/tenant/entity 효과, TC DAG, 연속 상태 인계, 필수 TC 결과 통합이 완성되었다고 볼 수 없다. 같은 호스트의 실제 화면·포인터·키보드 lock을 모델 선언이나 별도 탭만으로 제거하지 않는다.

**다음 구현 연결점:** 기존 에이전트의 요청에 checkpoint 근거·분할 작업·의존 상태·자원 요구를 보존하고, 공통 실행 관리자가 승인/예약/상태 인계를 검사하도록 B02→B03/B08을 연결한다. 독립 병렬·공유 자원 직렬·no-refresh chain·취소 unknown·위조/누락 결과 거부를 실제 경로에서 입증한 뒤에만 자동 판정·실행 완료를 선언한다.
