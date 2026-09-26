# QA 문서·기획서 앞단 정규화 — Opus 5.5 · GPT-6 sol 적대적 리뷰 비교

기준 커밋: `2720011` (`feat/app-qa-platform`). 원문 리뷰: `/tmp/app-qa-review/intake-claude.md`(Opus 5.5), `/tmp/app-qa-review/intake-codex.md`(GPT-6 sol). 입력 사례는 QA 스프레드시트 스크린샷 2장, 토스플레이스 QA 아티클(https://toss.im/career/article/45927), 떠남 앱 기획 문서다.

## 결론

두 모델 모두 "원문 → LLM이 바로 DSL 생성"을 버리고, 그 사이에 **원본 좌표를 보존한 중간 표현(Case → 원자 Check)**을 두자고 했다. 차이는 순서다. GPT-6 sol은 원본 보존·IR·사람 게이트를 한꺼번에 P0로 두었고, Opus 5.5는 싼 정규화부터 하고 IR은 그 위에 올리자고 했다. 채택안은 Opus의 순서에 GPT-6 sol의 관찰 가능성 분류를 더한 3단계 계획이다(아래 "권장 순서").

## 실측으로 확인한 현재 약점

두 스크린샷 양식을 xlsx로 재현해 `ingestDocuments` → `segmentRequirements`에 넣었다(`/tmp/intake-probe/probe.ts`).

| # | 현상 | 결과 | 리뷰 주장과의 관계 |
|---|---|---|---|
| 1 | 병합 셀(대/중/소분류) | xlsx에서는 값이 채워짐. 다만 `section`에는 들어가지 않고 본문 텍스트에만 남음 | Opus "xlsx는 불확실" → 채워짐. GPT-6 sol "분류가 끊김" → 본문에는 남고 그룹 정보만 빠짐. CSV 내보내기는 fill-down이 없어 끊김(코드 근거, 미실행) |
| 2 | 파란 보조 설명 줄 | 색 정보가 사라지고 제목·본문에 한 줄로 섞임 | 둘 다 맞음 |
| 3 | `비고`("다음 실행 시점부터 적용") | 요구사항 본문에 들어감 | Opus 맞음 |
| 4 | `점검 결과: OK` | ignore되지 않고 본문에 들어감 → 결과를 적을 때마다 digest 변경 | 둘 다 맞음 |
| 5 | 빈 행(26번 두 번째 행) | 내용 없는 요구사항 `qa#26.2` 생성 | Opus 맞음 |
| 6 | 셀 안 번호 목록(회원가입 1~4) | 요구사항 1개 | 둘 다 맞음 |
| 7 | 두 번째 양식의 `항목`(회원가입) | `구분`이 area를 먼저 가져가 section이 `["회원","공통","1"]`이 됨 | 새로 발견 |
| 8 | 시트가 달라도 번호가 겹치면 | 두 번째 시트 1번이 `qa#1.2` | 둘 다 지적한 ID 불안정의 실례 |
| 9 | 스크린샷(png) 입력 | 지원 형식 오류(`src/plan/ingest.ts:135`) | GPT-6 sol 맞음 |
| 10 | Jev 검토 | 여러 `covers`를 이어 붙여 한 번에 채점(`src/plan/index.ts:242`) | Opus 맞음. 불변식 8(합산 점수 금지)의 취지와 어긋남 |
| 11 | 재계획 | 승인된 테스트를 경고만 남기고 교체(`src/plan/index.ts:163-164`) | Opus 맞음 |
| 12 | 문서 변경 감지 | 파일 전체 sha 비교(`src/report/trace.ts:37-43`) → 한 글자 수정에도 모든 요구사항이 `changed` | Opus 맞음 |

## 제안 비교

| 주제 | Opus 5.5 | GPT-6 sol | 영향 범위 | 장점 | 단점 | 판단 |
|---|---|---|---|---|---|---|
| 중간 표현 | `SourceAnchor`/`Case`/`Check` + `quote`가 원문의 부분 문자열인지 결정적으로 검사 | `SourceFragment` + `Check`(oracle, uid, revision) | 큼: `src/spec/schema.ts` PlanFile v2, `src/plan/*`, `src/report/trace.ts` | 부분 커버를 드러냄, 위험 부분만 분리 | 스키마 이관, LLM 호출 +1 | 채택. `quote` 검사(Opus)로 원문에 없는 검증점을 거부 |
| 양식 대응 | 헤더 지문별 매핑 프로필을 LLM이 제안 → 사람 1회 확인 → 결정적 적용 | 결정적 추출기가 병합·서식·이미지 위치 보존 | 중간: `ingest.ts`, `segment.ts`, `qa plan --mapping`, Mac 확인 화면 | 같은 양식은 다시 묻지 않음, 이력 열이 digest를 흔들지 않음 | 양식마다 첫 1회 확인 | 채택(Opus안). 지문이 다르면 자동 적용 안 함 |
| 실행 가능성 분류 | `{category, detail, owner}` enum, 키워드 사전 분류는 제안만 | 검증점×플랫폼별 `ready`/`web_only`/`needs_*`/`manual_only`, `ready`는 결정적 확인+관찰 근거 필요 | 중간: `schema.ts` untestable, `prompt.ts`, report, Mac 필터 | 사람이 할 일이 바로 보임 | 분류 체계 유지 비용 | 채택. 플랫폼별 판정과 `ready` 조건은 GPT-6 sol안 |
| 사람 확인 | IR 단계, 새로 생김·바뀜·저신뢰·ambiguous만(diff-only), `--auto`는 draft 유지 | 원본·정규화·근거를 한 카드에서 대조, 근거 없이는 승인 불가 | 큼: `src/server/*`, `mac/**`, 승인 기록 | 오해가 큰 곳에 집중 | 검토 대기열 | 채택(둘을 합침) |
| ID·재생성 | `caseKey`=정규화 경로+제목 해시, digest 같으면 테스트·승인 유지, lineage | `uid` 1회 부여 + `revision` | 중간: `segment.ts`, `index.ts` 병합, `trace.ts` | 승인이 헛수고가 안 됨, LLM 비용 감소 | 매칭 로직 | 채택. 문서 변경 감지도 요구사항 digest로 전환 |
| 커버 검증 | 검증 스텝에 `verifies: [checkId]`, Check별 Jev 검토 | `assertionMap` 요구, 자기 충족식 단언 거부 | 중간: Step 스키마, `validate.ts`, 러너 이벤트 | 실패 원인이 정확해짐 | 모든 소비자 수정 | 채택(`verifies`) |
| 코드베이스 대조 | 프레임워크별 추출기(RN strings/testID/routes, Flutter Semantics, 네이티브 리소스) → `provenance: code`는 가설, 인벤토리 확인 전 승인 불가 | 읽기 전용 어댑터 + 커밋·빌드 ID 연결, 충돌은 사람 결정 | 큼: 새 `src/plan/code/*`, 앱 프로필 `sourceRoot` | 기획서만 있어도 테스트 후보 | 스택별 유지 비용, 소스가 LLM으로 감 | 채택(P1). 코드 문구만으로 PASS 근거 금지 |
| 관찰 가능성 | 라벨 없는 요소 → 개발 요청 목록 | 화면별 buildId·capturedAt·관찰 경로 기록, 금액 같은 핵심 문구는 재현율 측정 | 중간: `src/runner/inventory.ts`, `context.ts` | 토스 사례(결제 금액이 Appium에 안 보임)에 직접 대응 | 빌드마다 재수집 | 채택(GPT-6 sol안) |
| 결과 역반영 | 사이드카 xlsx(원본 불변), "Grounded Pass" 표시 | Check→test→step→run 연결, 원본 P/F/B는 과거 이력으로 보관 | 중간~큼: `src/report/*`, CLI | QA 담당자가 보던 형식으로 결과를 받음 | 서식 보존 쓰기 | 채택(P1). 원본 셀 쓰기는 opt-in |
| 영향도 기반 선택 | `--changed <git diff>`로 영향 Check만 | route·컴포넌트·API 그래프 | 큼 | 회귀 비용 감소 | 정적 분석 누락 | P2 보류 |
| 스크린샷 입력 | 언급 없음 | OCR 좌표+확신도, 낮으면 사람 확인 전 생성 금지 | 작음~중간: `ingest.ts`(Apple Vision OCR 재사용) | 캡처만 받은 경우도 시작 가능 | 표 구조 복원 오류 | 채택(P1) |

## 서로의 반론

- 잘게 쪼개면 테스트가 폭증한다 → 둘 다 같은 답: Check는 커버리지 회계 단위, 테스트 생성은 지금처럼 화면 흐름 단위로 묶는다.
- LLM이 한 번 더 돌아 비용·환각이 는다 → Opus: 결정적 분할로 충분한 행은 LLM을 건너뛰고 `rawDigest`로 캐시, `quote` 검사로 환각 거부.
- 사람이 전부 승인만 누른다 → Opus: diff-only로 양을 줄인다. GPT-6 sol: 원본 근거와 미해결 사유를 보이지 않으면 승인 불가.
- 코드가 설치된 빌드와 다르다 → 둘 다: 코드 근거는 가설이고, 인벤토리나 빌드 연결로 확인되기 전에는 승인하지 않는다.

## 권장 순서

1. **1단계(바로 효과, S~M)**: 스프레드시트 정규화(대/중/소분류 경로, `확인사항`·`점검 결과`·`비고`·`시험 환경` 역할, 빈 행 제거, 셀 안 번호 목록 분리, rich-text 보조 줄 구분) + 헤더 지문 매핑 프로필, `untestable.reason`을 분류 enum으로, 요구사항 digest 기반 안정 키와 승인 유지.
2. **2단계(M~L)**: Case → Check IR, `quote` 검사, 검증 스텝 `verifies`, Check별 Jev 검토, IR 단계 사람 확인(diff-only).
3. **3단계(L)**: 스크린샷 OCR 입력, 코드베이스 추출기(가설 출처), 사이드카 결과 내보내기, 인벤토리 신선도·관찰 경로 기록. 영향도 기반 선택 실행은 그 뒤.

1단계는 기존 PlanFile v1과 호환되게 할 수 있다. 2단계부터 PlanFile v2 이관이 필요하다.
