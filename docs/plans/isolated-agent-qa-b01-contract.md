# B01: 제품·권한·공개 단위와 외부 재사용 계약

app-qa의 후속 구현과 공개 여부를 결정할 기준이다. [에픽 #2](https://github.com/chonamdoo/app-qa/issues/2)의 [D01–D14, Q12–Q13/Q16, B01](2026-10-28-isolated-agent-qa-epic.md)을 구체화한다. **이 문서는 새 기능·보안 통제·라이선스 부여·고객 데이터 사용 허가를 구현하거나 증명하지 않는다.** 권리와 고객 승인 근거가 없는 공개·전송은 해당 근거를 확보하기 전 진행하지 않는다.

현재 구현 근거는 소스 기준 [`86d5685651ede2bec57000c9b36e32d4ac5ea217`](https://github.com/chonamdoo/app-qa/tree/86d5685651ede2bec57000c9b36e32d4ac5ea217)와 아래 파일이다. 외부 소스의 고정 revision은 조사 기준이지 채택 버전이 아니다. 이 작업은 문서 변경이며 플랫폼 실행·배포·QA 대체 효과를 검증하지 않았다.

## 1. 제품과 실행 책임

제품과 작업 저장소는 app-qa로 유지한다. 기존 TypeScript 엔진·CLI·SwiftUI Mac 앱을 확장하며 E2EVM으로 제품을 이전하지 않는다. 현재 Claude/Codex와 QA 스킬이 요구사항 조사·시나리오·실행 코드 작성·실패 분석을 담당하고, 제품 실행 핵심은 대상 준비·권한·자원·관찰·입력·증거를 담당하는 것이 목표다.

| 경계 | 현재 소스에서 확인한 사실 | 후속 구현의 결정과 제한 |
| --- | --- | --- |
| 실행 관리자 | CLI는 runner를 직접 호출할 수 있다. 서버 큐는 프로세스 메모리에 있으며 Mac 앱은 엔진에 연결하거나 자식 엔진을 시작한다. | GUI/CLI/MCP가 같은 소유권과 판정 계약을 사용하게 전환한다. 현재 이미 호스트 단위 단일 영속 관리자가 있다고 표현하지 않는다. |
| AI와 모델 | 현행 `qa plan`은 Claude/Codex CLI로 테스트를 생성하고 Jev는 실행·생성물의 좁은 판단에 사용된다. | 새 기본 직접 조작 경로에는 별도 필수 모델 키·새 수동 DSL·매 입력마다 모델 호출을 넣지 않는다. B02에서 실행 권한과 판정 근거를 함께 검증하기 전 Jev만 끄거나 전역 `allowRisky`로 우회하지 않는다. |
| 대상과 병렬성 | 데스크톱 Chrome/Safari는 공유 display를 잠근다. 모바일 기기 잠금과 일부 서비스는 checkout·호스트 자원을 사용한다. | VM·독립 브라우저·서로 다른 기기 프로필의 실제 격리/동시 구간을 B03–B06에서 검증한다. 기존 display 잠금부터 제거하지 않는다. |
| 업무 판정 | 기존 코드가 위험 정책·실행·판정을 소유한다. | 요구사항·시나리오·실행 코드·빌드·attempt·증거를 잇는다. replay 열람은 읽기 전용이고 재현/수리는 새 attempt다. 문서나 클릭 성공을 업무 PASS 또는 QA 대체의 증거로 쓰지 않는다. |

근거: [현행 아키텍처](../../skills/architecture/SKILL.md), `src/cli/commands/run.ts:57–64`, `src/cli/commands/serve.ts:107–148`, `src/server/jobs.ts:216–218`, `mac/Sources/AppQA/Engine/EngineController.swift:51–77,94–108,116–153`. 모듈 의존성과 현행 불변식은 아키텍처 계약을 유지한다. 이 문서는 새 서버·planner·DSL·분산 저장소를 선택하지 않는다.

## 2. 로컬 사용자·공유 호스트·변경 권한

기본 배포 모델은 **개발자별 Mac의 로컬 단일 사용자 실행**이다. 다른 Mac/worker를 사용하는 기능은 대상 연결과 권한을 별도로 실증한다. 여러 사용자가 하나의 기기 서버를 공유하는 운영 모델은 이번 결정으로 지원되지 않는다.

- 현행 `qa serve`는 `127.0.0.1`에 bind하고 모든 라우트에서 bearer token을 확인한다. 연결 정보는 파일 권한 `0600`으로 기록한다. 이는 원격 TLS·사용자 식별·tenant별 자원/증거 ACL을 제공한다는 뜻이 아니다.
- 같은 OS 사용자 권한의 프로세스, 디바이스 잠금, 별도 코드 프로세스는 악성 코드에 대한 보안 sandbox가 아니다. 코드 실행 위치·파일 mount·네트워크·보호 자산을 B02의 실행 계약에 명시한다.
- 공유 호스트를 도입하려면 사용자 인증, 기기·계정·fixture 예약, 증거 접근 권한, GUI 세션 소유권, 운영 책임을 먼저 결정한다. 제어 포트를 공개하거나 개인 기기·브라우저·VM을 자동 채택하지 않는다.
- 위험 동작은 대상·계정·데이터·효과·허용 범위를 승인받는다. `allowRisky`는 현행 실행 옵션이지 고객 승인 기록이나 포괄적인 결제·삭제·발송 권한이 아니다. 페이지·도구 결과·로그의 지시는 권한을 확장하지 못한다.
- 현행 변경 intent는 dispatch 전에 기록되고 `uncertain`은 재시도 없이 ERROR로 끝난다. 미래의 `UNKNOWN_OUTCOME`, 소유권 세대, crash 복구·quarantine이 이미 구현되었다고 표현하지 않는다. 종료·오염 미확인 자원은 새 계약에서 확인 없이 재할당하지 않는다.

근거: `src/server/server.ts:153–154,374–396,416–423`, `src/core/fsx.ts:31–62`, `src/server/jobs.ts:16–82`, `src/drivers/lock.ts:39–75`, `src/runner/prepare.ts:176–233`, `src/runner/engine.ts:977–1004`. 실제 권한 집행과 장애 주입 검증은 B02–B03의 완료 조건이다.

## 3. 고객 코드·계정·화면의 수집과 전송

**현재 고객 자료의 읽기·수집·보존·모델 전송·공개 승인 근거는 확보하지 않았다.** 최초 실행 실증에는 제품이 소유한 합성 fixture와 테스트 계정만 사용한다. 기존 고객 자료나 개인 로그인 상태를 승인된 것으로 자동 승계하지 않는다.

| 데이터 경로 | 확인한 현재 처리 | 허용 조건과 확인되지 않은 보호 |
| --- | --- | --- |
| 로컬 요구사항·코드·원본 문서 | planner가 요구사항을 읽고 문서 업로드는 원본 바이트를 저장한다. | 로컬 읽기 허가, 저장 위치·접근자·보존 기간·삭제 방법을 프로젝트별로 기록한다. 공개 저장소에 있다는 이유로 고객 자료 재배포나 외부 전송을 허용하지 않는다. |
| Jev 전송 | 후보 라벨/값·화면 텍스트·intent/claim/target, 생성물 검토의 요구사항과 테스트가 HTTPS API로 전송될 수 있다. 기본은 live 모드다. | 승인된 endpoint/제공자와 전송 항목을 확인한다. 이 경로에서 PNG 전체나 저장소 전체를 자동 업로드한다고 단정하지 않으며, 텍스트의 업무 정보·식별자도 승인 범위에 포함한다. |
| Claude/Codex planner | 요구사항·문서 식별자·프로필 URL/앱 식별자·화면 문구 등이 CLI prompt로 전달된다. | 검사한 prompt→CLI 경로에 planner 전체를 보호하는 redaction 호출은 없다. read-only 실행 옵션은 무전송·무보존 보장이 아니다. 외부 CLI 제공자의 실제 전송·보존·지역 정책과 고객 승인을 별도로 확인한다. |
| 화면·영상·로그·trace/HAR | 세션 텍스트/XML에는 sanitizer가 있지만 PNG는 원시 픽셀로 저장/응답하고 녹화도 별도 경로다. Mac 엔진 출력 로그도 별도다. | 텍스트 마스킹을 이미지·영상·원본 업로드 보호로 확대하지 않는다. 각 증거 종류의 수집/마스킹/전송 가능 여부·필수성·보존 기간·용량·삭제 정책을 정한다. trace/HAR는 목표 수집 항목이지 현재 지원 선언이 아니다. |
| 보고서·공유·공개 artifact | 로컬 보고서·파일 API와 형식 내보내기가 있다. | 계정 토큰·쿠키·개인정보·고객 코드/화면을 공개하지 않는다. 필요한 증거를 안전하게 제공할 수 없으면 공백과 BLOCKED/판단 불가를 남기며 수집을 강행하거나 PASS로 숨기지 않는다. |

고객 자료를 사용할 프로젝트 기록에는 실행 대상/계정/fixture, 금지·허용 효과, 로컬 읽기·원본 보존·모델 전송·팀 공유별 승인 범위와 근거, endpoint/제공자, 증거 종류별 처리·보존·삭제 책임을 연결한다. 비밀값 자체는 문서·명령 인자·승인 기록에 넣지 않는다. 제공자 정책이나 고객 동의가 미정이면 해당 전송/수집만 금지하고 독립적인 합성 검증을 계속한다. 이는 요구 정책이며 현행 런타임에 자동 집행 장치가 추가된 것은 아니다.

근거: `src/jev/config.ts:53–72`, `src/jev/client.ts:155–179`, `src/jev/decide.ts:51–74,205–214`, `src/jev/redact.ts:9–33,67–94`, `src/plan/prompt.ts:69–106`, `src/plan/generate.ts:69–77`, `src/plan/llm.ts:74–130`, `src/runner/sanitize.ts:100–190`, `src/server/server.ts:213–220,307–325`, `src/drivers/screen.ts:18–33,60–72`.

## 4. Apache-2.0 목표와 공개 단위

Apache-2.0은 사용자가 밝힌 **권리가 확인된 새 구현의 배포 목표**다. 현재 `app-qa@0.1.0`은 [`package.json`](../../package.json)에 `private: true`이고 `license` 필드가 없다. [검토한 고정 tree](https://api.github.com/repos/chonamdoo/app-qa/git/trees/86d5685651ede2bec57000c9b36e32d4ac5ea217?recursive=1)에는 LICENSE/NOTICE/제3자 고지 목록이 없다. `private`는 [npm 공개를 막는 설정](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#private)이지 저장소 비공개·소유권·라이선스 허가의 증거가 아니다.

| 공개 단위 | 이 작업의 결정 | 공개 전 필요한 증거 |
| --- | --- | --- |
| 권리가 확인된 신규 소스·문서 | app-qa에서 개발한다. 지금은 일괄 LICENSE나 package license를 추가하지 않는다. | 공개할 파일 범위, 작성자·기여자·고용/고객 계약의 배포 권한, 적용할 Apache LICENSE와 일치하는 메타데이터. 기존 코드/문서 전체의 권리를 Git 작성자나 계정명으로 추정하지 않는다. |
| 기존 코드·아이콘·UI fixture·외부 인용 | 기존 파일을 독립 작성물로 일괄 분류하거나 재라이선스하지 않는다. | 각 출처와 재배포 권한. `mac/Resources` 아이콘, 타 앱 PNG/XML, 외부 문서에서 복사한 예시는 별도 확인하며 고객 자산·자격 증명·Apple OS 이미지는 공개물에서 제외한다. |
| npm 패키지 | `private: true`를 유지한다. | 공개 단위·포함 파일·권리·dependency 고지를 확정한 별도 공개 변경. 이 작업은 npm publish를 허가하지 않는다. |
| 설치형 Mac 앱·worker·VM 구성 | 현재 로컬 Debug 빌드와 타 Mac에 배포할 제품을 구분한다. | 실제 포함 파일·바이너리·라이선스/고지·설치 전제·서명/배포 방식. 브라우저·드라이버·OS 이미지를 사용할 수 있는 것과 번들 배포 권리를 구분한다. |

권리·재사용 검토가 끝난 소스 범위와 실제 출하 목록을 정한 뒤 LICENSE/metadata/고지 내용을 맞춘다. 저장소 제어권, `NSHumanReadableCopyright`, 공개 접근, 출처 링크만으로 권리가 확보되지는 않는다. 이 문서는 법률 의견이나 저장소 전체 재라이선스가 아니다.

## 5. 현재 의존성과 외부 재사용 명세

### 현재 npm 구성

아래는 [`package.json`](../../package.json)과 [`package-lock.json`](../../package-lock.json)의 **직접 의존성과 lockfile 선언**이다. 실제 배포 패키지 내부의 라이선스/고지를 모두 확인했다는 뜻이 아니다.

| 구분 | 패키지 | 고정 버전 | lockfile license |
| --- | --- | --- | --- |
| runtime | appium | 3.8.0 | Apache-2.0 |
| runtime | exceljs | 4.4.0 | MIT |
| runtime | json-logic-js | 2.0.5 | MIT |
| runtime | mammoth | 1.12.3 | BSD-2-Clause |
| runtime | unpdf | 1.8.1 | MIT |
| runtime | yaml | 2.9.1 | ISC |
| runtime | zod | 4.6.5 | MIT |
| dev | @types/node | 26.6.3 | MIT |
| dev | typescript | 7.0.2 | Apache-2.0 |

기존 설정이 별도로 설치하는 Appium 드라이버는 UIAutomator2 `8.7.0`, XCUITest `12.13.2`, Chromium `3.1.1`, Safari `5.0.10`이다(`src/appium/setup.ts:10–27`). 이 표만으로 해당 도구·Chromedriver·브라우저·OS의 번들 배포를 승인하지 않는다.

전이 의존성도 일괄 MIT/Apache로 표기하지 않는다. lockfile의 optional `@img/sharp-libvips-darwin-arm64@1.3.3`은 `LGPL-3.0-or-later`를 선언한다. 설치/출하 여부는 별도 확인해야 하며 이것만으로 app-qa 자체가 LGPL이라고 결론내리지 않는다. `buffers@0.1.1`, `ftp-response-parser@1.0.1`, `parse-listing@1.1.3`에는 lockfile license가 없고, `spdx-exceptions@2.5.0`은 `CC-BY-3.0`, 일부 항목은 `BSD`, `MIT/X11`, `MIT or GPL-2.0` 같은 선언을 사용한다. 누락 메타데이터는 upstream 허가가 없다는 증거도 아니다. 실제 포함 항목의 원문·선택 조건·의무를 공개 전에 확인한다.

### 핵심 통합 후보: 미채택

아래 세 항목은 현재 npm 의존성이나 이 작업에서 복사한 코드가 아니다. 기존 보고서의 `check-run v1` 호환 출력은 별도 스킬의 코드·배포 권리를 도입한 증거가 아니다(`src/report/webqa.ts:1–37,60–85`).

| 후보와 조사 revision | 원문에서 확인한 라이선스·고지 | 현재 선택·복사 범위·고지 경로 |
| --- | --- | --- |
| E2EVM `e6a3df5ced1eae451c4a37bae394801843bda1f9` | [MIT LICENSE](https://github.com/taejs/e2evm/blob/e6a3df5ced1eae451c4a37bae394801843bda1f9/LICENSE), Copyright (c) 2026 E2EVM contributors. [별도 의존성/라이선스](https://github.com/taejs/e2evm/blob/e6a3df5ced1eae451c4a37bae394801843bda1f9/docs/dependencies.md)도 존재한다. | VM 수명주기 참고 후보. 신규 복사·변경·번들 없음, 채택/설치 안 함, 출하 고지 경로 미적용. 채택 시 원본 MIT 고지를 보존하며 guest OS·브라우저·Apple 구성까지 MIT로 취급하지 않는다. |
| tester-army/e2e `cad17c3200ceb5439a261f9c24e6e7ebbf85ddff` | [Apache LICENSE](https://github.com/tester-army/e2e/blob/cad17c3200ceb5439a261f9c24e6e7ebbf85ddff/LICENSE)와 [NOTICE](https://github.com/tester-army/e2e/blob/cad17c3200ceb5439a261f9c24e6e7ebbf85ddff/NOTICE): Copyright 2026 TesterArmy, Inc. 조사 패키지는 `e2e@0.22.0`, `@e2e-dev/web@0.15.4`, `@e2e-dev/mobile@0.12.5`. | 실행·테스트 코드화 연결 후보. 신규 복사·변경·번들 없음, 채택/설치 안 함, 출하 고지 경로 미적용. 패키지별 NOTICE와 의존성은 실제 채택 범위에 맞춰 보존한다. |
| web-qa-skill `c00d98c96ef60f875ada046776d9d4ecbceb5c15` | [고정 tree](https://api.github.com/repos/chonamdoo/web-qa-skill/git/trees/c00d98c96ef60f875ada046776d9d4ecbceb5c15?recursive=1)와 [package.json](https://github.com/chonamdoo/web-qa-skill/blob/c00d98c96ef60f875ada046776d9d4ecbceb5c15/package.json)에서 permissive LICENSE/NOTICE/메타데이터 허가를 확인하지 못했다. | 사용자가 별도로 제공한 스킬과 절차/출력 연계를 검토한다. 신규 복사·번역·번들 없음, 출하 고지 경로 미적용. 파일 포함/재라이선스는 해당 범위의 명시적 권한 확보 전 금지한다. 동일 계정명은 허가가 아니다. |

Ego의 별도 브라우저/native bindings, FSL 구성, AGPL 엔진, 사용자 제공 ZIP 등 나머지 참고물은 이번 채택 범위 밖이다. 에픽의 조사표는 채택 허가나 해당 저장소 전체 라이선스 보증이 아니다.

재사용을 선택할 변경에는 출처 URL·고정 revision/version·정확한 파일/범위·수정 내용·연결/복사/번들 방식·전이 구성·배포물·고지 위치를 기록하고 실제 원문을 보관한다. MIT는 저작권/허가/면책 고지를, Apache는 LICENSE·수정 표시·해당 고지/NOTICE를 보존한다([실제 Apache §4](https://github.com/tester-army/e2e/blob/cad17c3200ceb5439a261f9c24e6e7ebbf85ddff/LICENSE#L89-L128)). BSD/ISC 등 다른 조건도 각각 지킨다. 출처 링크나 번역·포팅·재작성만으로 원문 고지 의무가 사라지지 않는다.

## 6. 남은 확인과 후속 실행 조건

| 미확인 항목 | 막는 작업 | 충족할 증거 |
| --- | --- | --- |
| app-qa 코드·문서·기여분의 배포 권리 | 저장소 전체 Apache 선언, LICENSE/메타데이터 변경, 미확인 범위 공개 | 공개 파일 목록과 작성자/기여자·고용/고객 계약상 권한 근거. 확인되지 않은 범위는 제외한다. |
| 아이콘·타 앱 fixture·외부 인용·고객 자산 | 해당 자산의 공개·모델 전송·번들 | 출처와 수집/재배포/전송 허가 또는 허용 자산으로의 교체/배포 제외. |
| 실제 출하 의존성과 원문 고지 | npm/Mac/worker/VM 배포의 라이선스 적합성 주장 | 포함 파일 목록과 LICENSE/NOTICE, 누락/구형 표현·CC-BY·포함되는 LGPL 구성의 적용 의무 확인. |
| web-qa-skill 및 후보의 실제 재사용 범위 | 해당 파일 복사·번들·재라이선스 | 권한·채택 버전·복사 범위·변경·연결 방식·출하 고지. 단순 참조와 파일 포함을 구분한다. |
| 고객 데이터·위험 동작·제공자 정책 | 미승인 고객 대상 실행/수집/외부 전송 | 3절의 프로젝트별 승인·endpoint·증거 처리·보존/삭제 근거. |
| 원격/공유 호스트와 새 실행 통제 | 다중 사용자 보안·격리·플랫폼 지원 선언 | B02–B06의 실제 사용자 경로·권한·복구·격리와 해당 배포 모델의 검증 결과. |

B01의 결과는 위 제품/권한/공개 경계와 출처 명세다. **권리 확인·재사용 채택·고객 승인 자체는 아직 완료가 아니며 에픽의 완료 체크를 바꾸지 않는다.** B02는 고객 자료나 미허가 후보 코드를 복사하지 않는 합성 fixture의 최소 실행 경로부터 진행할 수 있다. 원래 Q01–Q16/B01–B10과 17개 DoD는 그대로 유지하며, 개별 로컬 검증 성공을 전체 지원·공개 준비·QA 대체 완료로 확대하지 않는다.
