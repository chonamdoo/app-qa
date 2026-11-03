# QAutra 화면 재설계 진행 기록

## 현재 범위

- 기준: `docs/plans/2026-11-01-qautra-product-design-brief.md`와 후속 대화의 자동 테스트 중 호스트 포인터·키보드·포커스 비간섭 요구.
- 사용자 최신 지시: 설계부터 진행. 제품 구현·실제 VM/기기 동작은 재개하지 않음.
- 모드: design. 웹 프로토타입의 화면과 인터랙션을 검토한다. 실제 Mac 앱 통합·엔진·녹화·비간섭 검증을 대신하지 않는다.
- 기존 Agent Flow `development/20261031-003608`은 B02 구현 범위로 implement 상태다. status만 조회했으며 continue·새 run·workflow 변경·구현 artifact 완료를 하지 않았다. 이번 디자인을 기존 구현 완료로 기록하지 않는다.

## 사전 확인

| 항목 | 확인 결과 |
|---|---|
| 제품/화면 | Mac QA 앱. 최종 문서 §12의 전체 정보 구조를 유지하며 입력/검토→실행/Space→결과/영상/비교의 중심 흐름부터 설계 |
| 참고 화면 | 사용자가 제공한 Ego Space 목록·Running 상태 캡처. `rival.md`에 관찰과 추론을 구분 |
| 입력 원본 | 최종 문서와 `qautra-design-package.zip` 실제 내용 확인. 아이콘·공통 원본·tokens 존재 |
| 고정 사항 | QAutra 이름/아이콘, 밝은 shell, 한국어, QA 중심 navigation, 실제 대상 구분, AI 실행 판단 없음 |
| 캡처 경로 | 설치된 `ego-browser skill` v2.2.0의 명령·Page screenshot/semantic 조작 지원 확인. 아직 브라우저를 열거나 화면을 렌더하지 않음 |
| 검수 크기 | 1024×768 / 1440×900 / 1920×1080 CSS px. 문서의 디자인 검수 조건 |
| 소스 breakpoint | 1400 / 1100 / 900 / 767 / 479px. CSS 원문 확인 |
| 검수 기준 | design-loop `floor.web.md`, `floor.native.md`, `teardown.md` 읽음. 웹 렌더 기준 적용, 실제 네이티브 동작은 blocked |
| 미확인 | Ego 실제 모션/내부 격리 방식, 실제 QAutra 네이티브 통합·호스트 입력 비간섭·Safari 실행·영상. 디자인 참고 캡처로 증명하지 않음 |

## 단계와 사용자 검토

1. **확인 완료:** 사용자 선택 `이 기준으로 진행`. 기존 밝은 QAutra 시각 기반에 Ego의 관측/전환 방식만 참고한다.
2. **확인 완료:** 사용자 선택 `이 기준으로 시안 만들기`. `tokens.md`의 공통 기준으로 구조 시안을 제작했다.
3. **현재:** 같은 정보·브랜드의 A/B/C 구조를 각각 1024×768 / 1440×900 / 1920×1080 CSS px에서 Ego로 렌더·캡처했다. `prototype/index.html`과 `renders/variant-*-*.png`에서 비교한다. 구조 선택 뒤 나머지 화면 설계를 진행한다.
4. 선택한 구조로 클릭 가능한 프로토타입과 화면별 command/오류 전이 구현. 샘플 데이터임을 지속 표시.
5. 격리된 독립 critic의 실제 렌더 검토와 공통 컴포넌트 일관성 검토. 아직 critic 실행/통과 없음.

## 검증 기록

자료/명령 가이드/정적 CSS와 토큰 조합 대비 계산을 완료했다. 보조 blue label 대비 4.33:1은 기존 dark blue로 바꿔 5.91:1을 제안하고, 입력 경계 1.23:1은 별도 ui-safe 경계 후보 3.72:1로 구분했다.

Ego TaskSpace 17의 `p1`에서 9개 구조/크기 조합을 실제 렌더했다. 관측한 각 조합은 h1 1개이고 document scrollWidth가 viewport 너비를 넘지 않았다. 세 시안의 1440px 이미지와 A 1024px/B 1920px 이미지를 직접 열람했다. 세로 스크롤은 존재하며 이미지가 전체 높이를 담는다. 실패/unknown 상태 전환, 증거/복구 안내 모달, ESC 닫힘과 호출 버튼 focus 복원을 실행했다. unknown을 최신 금액 관측처럼 보이게 하던 표시를 `최신 관측 미확인`으로 수정하고 reload 후 확인했다.

현재 시안은 실행 상세 **구조 선택용**이다. navigation은 위치 참고이며 전체 화면 이동 프로토타입/실패 동영상 플레이어가 완성됐다는 뜻이 아니다. 상태·목록 개수 stress, 200% zoom, 전 구간 keyboard/VoiceOver, 시각 독립 critic, 실제 네이티브·제품 실행·비간섭 측정은 아직 확인하지 않았다. TaskSpace 17은 구조 선택을 위해 사용자에게 handOff했다. 미리보기 서버는 `http://localhost:41841/`이며 외부 공개하지 않는다.

이 단계의 제품 코드 변경은 없다. 새 코드는 `docs/design/qautra-redesign/prototype/`의 브라우저 렌더용 산출물이다. 원본 디자인 source와 icon은 해당 폴더에 복사했고 새 화면은 등록 공통 컴포넌트로 조합한다. 실제 지원 기능의 증거로 취급하지 않는다.
