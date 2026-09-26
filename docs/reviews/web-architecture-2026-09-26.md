# 웹 테스트를 합칠까, 나눌까 — Opus 5.5 · GPT-6 sol 적대적 리뷰와 결정

원문: `/tmp/app-qa-review/web-arch-claude.md`(Opus 5.5), `/tmp/app-qa-review/web-arch-codex.md`(GPT-6 sol). 같은 프롬프트(`/tmp/app-qa-review/web-arch-prompt.md`), 같은 잣대(정확성, 안전성, 관찰 충실도, 유지보수, 변경 반경, 문서→테스트 재사용, 성능, 난이도)로 받았다. 참고한 스킬: https://github.com/chonamdoo/web-qa-skill (`af2ba57`).

## 결정

**하나의 파이프라인으로 합친다.** DSL·러너·위험 정책·commit 확인·증거 정제기·리포트·플래너는 앱과 웹이 같이 쓴다. 나누는 곳은 **드라이버와 관찰 파서**다. 다만 "드라이버만 바꾸면 된다"는 틀렸다. 두 리뷰가 공통으로 찾은 대로 아래 다섯 곳을 같이 바꾼다.

1. 대상 모델: `AppTarget`을 `app | web` 판별 유니온으로, 프로필은 앱 또는 웹 중 하나.
2. 관찰: 데스크톱 DOM 파서 추가, 모바일 웹에서는 브라우저 UI(주소창·스낵바·툴바)를 후보에서 제외하되 가림에는 참여.
3. 증거 정제: 데스크톱 원본도 `password="true"` 구조를 가진 정규 XML로 저장해 기존 구조 마스킹을 그대로 쓰고, URL 쿼리의 토큰류 값도 마스킹.
4. 건강 검사: 허용 origin 밖 이동(`origin_mismatch`)과 브라우저 오류 페이지(`page_load_error`) 추가, 웹 준비 대기.
5. Jev commit 보정: 웹 화면 골든 케이스로 다시 보정하기 전까지 웹 탭·입력은 `commit_check_unavailable`로 ERROR(fail-closed).

## 두 리뷰의 결론과 쟁점

| 쟁점 | Opus 5.5 | GPT-6 sol | 채택 | 이유 |
|---|---|---|---|---|
| 합칠지 | 합친다(러너 하나) | 하이브리드 C: 시나리오·결과 계약만 공유, 실행기는 분리 | **합친다** | 안전 불변식(기록 후 실행, `uncertain` 재시도 금지, commit 확인, 정제)을 실행기마다 다시 구현하면 어긋난다. GPT-6 sol의 공격 1·3·4·5는 "드라이버 외에도 바꿔야 한다"는 근거이지, 러너를 둘로 나눠야 한다는 근거는 아니다. 위 다섯 곳으로 흡수했다. |
| 모바일 웹 관찰 | A1: 브라우저 앱을 네이티브 드라이버로 조작, 접근성 트리 관찰 | A2+native: web context DOM + 네이티브 전체 화면 | **A1** (A2는 관찰 보조로 이후) | 실측: Android Chrome 웹 콘텐츠가 UiAutomator 트리에 `EditText`/`Button`/`View`로 나온다. 키보드·툴바·safe area를 같은 화면에서 보고 실제 탭을 쓰므로 web-qa 스킬의 "전체 기기 화면과 실제 탭 결과" 요구와 맞다. A2는 context 전환·좌표 보정·chromedriver 버전 관리가 추가된다. |
| 데스크톱 | A3: Appium chromium/safari 드라이버(W3C) | Chrome=Playwright, Safari=safaridriver | **A3** | 전송 계층·실패 분류(`completed/uncertain/rejected`)·서버 재사용 검사를 앱과 공유한다. Playwright의 자동 대기·재시도는 우리 settle·재시도 금지 규칙과 충돌하고, Safari는 어차피 WebDriver가 필요하다. |
| 플랫폼 모델 | D1: `Platform`에 `desktop-chrome`, `desktop-safari` 추가, 프로필 `web` | 프로필 `kind: web` + 타깃 튜플(os·browser·device·viewport) | **D1** + 프로필 `web.viewport` | 결과·증거·리포트·잠금 키가 이미 `platform` 문자열이라 반경이 가장 작다. "android가 앱인지 Chrome인지 모호하다"는 공격은 프로필이 앱/웹 중 하나만 갖게 해서 막는다. 뷰포트 매트릭스(여러 해상도)는 이번 범위에 넣지 않았다. |
| 결과 상태 | `Verdict` 유지 + 파생 `qaStatus` | 내부·대외 상태 둘 다 보존, 필수 조합 완전성 게이트 | **둘 다** | web-qa 스킬 형식(`PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED`)으로 파생 상태를 내고, 원래 `Verdict`와 이유 코드는 그대로 둔다. |
| 브라우저 준비 | `qa setup` 명시 단계, `driver.open`은 확인만 | 타깃별 readiness 단계, Safari 미설정은 BLOCKED | **같음** | FRE 우회·알림 권한은 `qa setup --browsers`에서만. Safari "Allow remote automation"은 사용자 sudo가 필요하므로 BLOCKED로 남긴다. |

## 실측 사실 (2026-09-26, 이 Mac)

- 데스크톱 Chrome 153.0.8010.53, Safari 26.6.2. safaridriver 세션은 "Allow remote automation" 미설정으로 실패.
- Android 에뮬레이터 Chrome 153.0.8010.37. `am set-debug-app --persistent com.android.chrome` + `/data/local/tmp/chrome-command-line`(`--disable-fre --no-first-run --no-default-browser-check`)로 FRE 우회, `pm grant … POST_NOTIFICATIONS`로 알림 안내 제거. 이후 웹 콘텐츠가 UiAutomator 트리에 노출(첫 dump는 비고 1~2회 뒤 채워짐). 주소창 `com.android.chrome:id/url_bar`, 스낵바도 같은 트리에 있음.
- appium-chromium-driver 3.1.1(`appium:executableDir`로 chromedriver 저장 위치 지정, autodownload 기본값 켜짐), appium-safari-driver 5.0.10 — 둘 다 Appium 3 호환.

## 하지 않는 것

- Playwright를 두 번째 러너로 들이기, Playwright WebKit을 Safari로 부르기.
- JS click·DOM 값 주입·강제 클릭으로 행동하기. 페이지 스크립트는 관찰(DOM 수집, 값 읽기, `elementFromPoint`)에만 쓴다.
- `driver.open`에서 기기 설정 변경이나 sudo 자동 실행.
