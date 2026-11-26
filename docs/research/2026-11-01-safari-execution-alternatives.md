# QAutra의 실제 Safari 실행·격리 대안 조사

조사일: 2026-11-01. 상태: 공식 자료 조사와 독립 적대적 검토 2건 반영 완료. 제품 구현·실행기 전환 승인이 아니다. 기존 B02 run/워크트리·VM·권한·브라우저 설정을 변경하지 않는다.

## 결론

현재처럼 사용자의 Mac에 새 macOS VM을 설치하고 Setup Assistant를 직접 보여주는 방법만 가능한 것은 아니다. **실제 desktop Safari에 필요한 것은 지원되는 macOS 실행 환경이지, 테스트할 때마다 사용자 컴퓨터에 새 OS를 설치하는 과정이 아니다.** 로컬 macOS VM, 사내 전용 원격 Mac, 실제 Safari를 제공하는 관리형 서비스가 서로 다른 후보가 된다.[S3][S4][S9]

반대로 Ego 같은 인스턴스/Spaces 화면은 macOS VM의 증거가 아니다. Ego Space 소개는 같은 Chromium 프로세스 안의 BrowserContext라고 설명하지만, 공개 SDK의 저장 상태 문서는 같은 profile의 Space가 cookies/cache를 공유한다고 설명한다.[S1][S2][S37] 작업 공간·입력 소유권과 독립 로그인/저장 상태를 같은 보장으로 취급하지 않는다. 이 UX와 실제 Safari 지원도 하나의 구현 방식으로 묶지 않는다.

이 보고서의 공식 문서 확인은 QAutra에서 해당 대안을 실제 실행했다는 증거가 아니다. 가격·최대 처리량·실시간 화면 성능·호스트 입력 비간섭·기업 SSO는 별도 실증 전까지 미검증이다.

## 1. 유지할 요구와 아직 선택할 수 있는 수단

유지할 요구:

- 기존 Claude/Codex/OMP가 기획·TC·가이드를 받아 QAutra CLI/MCP/SDK를 호출한다. 이미 아는 URL·프로젝트·세션을 사용자가 반복 입력하지 않는다.
- 실제로 관측한 화면과 승인된 대상에만 입력한다. 업무 assertion과 증거가 있어야 PASS다.
- 개인 브라우저 데이터와 사용자의 마우스·키보드를 다른 QA 작업이 침범하지 않는다.
- 실행 중인 인스턴스를 QAutra 안에서 구분·관찰하고 작업 중지/인계를 할 수 있어야 한다.
- `Safari`라는 결과에는 실제 desktop Safari와 OS/browser 버전이 필요하다. WebKit이나 모바일 viewport를 조용히 대신 쓰지 않는다.
- localhost·사내망·로그인 환경을 다룬다. 독립 작업은 병렬, 선후행·공유 데이터 작업은 순차 또는 격리한다.
- 이전 사용자 지시로 거부된 호스트 Safari 자동화/호스트 권한 변경을 다시 기본값으로 삼지 않는다.

아직 선택할 수 있는 수단:

- 인스턴스의 경계가 browser context인지, process인지, container인지, OS/VM인지.
- 실행 위치가 로컬인지, 사내 별도 장비인지, 외부 클라우드인지.
- 웹 화면이 native embedded surface인지, 페이지 screenshot feed인지, 별도 desktop stream인지.
- OS 초기 준비를 사용자·관리자·서비스 공급자 중 누가 담당하는지.

**서로 다른 요구를 혼동하지 않는다.** `호스트 입력 비간섭`은 자동으로 `모든 브라우저마다 macOS VM`을 뜻하지 않는다. 그러나 별도 OS 격리까지 약속했다면 BrowserContext만으로 낮추는 것도 요구 축소다. 이번 조사는 그 변경을 승인하지 않는다.

### 조사 중 확정된 사용자 의도와 현재 코드의 차이

사용자는 Chrome·Safari 모두 Ego 같은 QAutra 내부 Space에서 보이고 에이전트가 별도로 조작하는 경험을 원한다고 명시했다. Space가 10개를 넘을 수 있으므로 `Space 하나마다 OS VM 하나`인 확장 방식은 원하지 않는다. E2EVM은 비교 대상이지 그 VM 단위를 작업 공간으로 그대로 채택하라는 요청이 아니다.

제품의 기본 단위는 **Space(작업·세션·증거·제어권)**이고, 실행 자원인 **Worker(브라우저 프로세스/container/OS/장비)**와 분리한다. 공통 Space UI를 제공하는 것과 Chrome/Safari의 내부 구현·병렬 능력이 같다는 것은 다르다.

현재 Chrome 코드에도 준비된 동일 프로필 VM을 재사용하는 분기가 있다(`src/runner/instances.ts:389-393`). Guest backend는 한 machine에 Chrome context 8개, Safari context 1개를 허용한다(`src/drivers/vm/backend.ts:674-695`). **현재 Chrome 코드가 무조건 Space당 VM 하나라는 설명도 부정확하다.** 다만 macOS guest 준비에 의존하고, 원한 가벼운 UX·10개 이상 실제 동시 처리·Safari 준비 완료는 입증되지 않았다. 구현 상수는 실측 용량이 아니다.

## 2. 중요한 공식 근거

### Ego가 실제로 설명하는 구조

Ego Space 문서: “Both sides share one ego(lite) browser process, but neither interrupts the other.” 이어서 “One isolated BrowserContext per task, with its own cookies and storage.”라고 한다. 새 Chrome profile, headless/offscreen, cloud session이 아니라고 구별한다.[S1]

**에픽 재대조에서 발견한 공식 문서 충돌:** 공개 SDK/Skill의 `clearing-state.md`는 “a task space picks a browser profile”이며 그 profile의 cookie jar/HTTP cache를 사용자 탭 및 같은 profile의 다른 Space와 공유한다고 명시한다.[S37] 에픽 3절도 이미 이 제약을 기록하고 있었다.[S38] Space 소개의 독립 cookies/storage 문구만 인용한 앞선 채팅 설명은 충분한 근거가 아니었다. 공급자 문서 간 차이의 원인·적용 버전은 확인하지 못했으므로 어느 한쪽을 전체 설치 앱의 보장으로 단정하지 않는다. QAutra의 독립 계정/저장 상태는 별도 수용 실험으로 검증해야 한다.

제품 소개는 “a Chromium browser for macOS” 및 수정된 Chromium 엔진의 snapshot 구현을 설명한다.[S2] 따라서 Ego의 Spaces를 참고해 QAutra의 UI/인계/배치 호출을 설계할 수 있지만, 이를 실제 Safari나 VM 격리의 증거로 쓰면 안 된다. 문서상 비간섭 주장은 공급자 설명이며 이번 조사에서 독립 실험한 것은 아니다. 광고 benchmark 수치는 이 보고서의 성능 비교에 사용하지 않았다.

### Safari에도 자체 데이터 격리는 있다

Apple은 WebDriver automation window가 일반 창, 설정·preferences와 분리되고 history/AutoFill에 접근하지 못한다고 설명한다. 따라서 “호스트 Safari는 개인 데이터 격리가 전혀 없다”는 주장도 틀리다.[S3]

하지만 이 데이터 격리는 별도 OS/desktop 경계나 사용자 foreground 비간섭 증명이 아니다. Apple은 동시에 Safari 인스턴스/연결 session을 하나로 제한하고 window·keyboard focus 경쟁을 이유로 든다.[S3] QAutra에서 호스트 Safari를 직접 제어한 과거 결과는 guest 격리 검증이 아니며 기존 사용자 거부도 유지한다.

Apple의 다른 문서는 Safari와 Safari Technology Preview가 각각 연관된 safaridriver를 갖고 동시에 실행할 수 있다고 한다.[S4] 이는 동일 Safari 여러 개의 독립 병렬 처리나 한 GUI에서 focus 경쟁이 사라진다는 보장이 아니다. build/driver별 예외는 실제 버전과 입력 충돌 실험 없이 병렬 capacity로 계산하지 않는다.

### WebKit은 실제 Safari 대체가 아니다

Playwright는 자사의 WebKit이 upstream main에서 파생한 패치 빌드이고 branded Safari에는 직접 동작하지 않는다고 명시한다.[S5] `Desktop Safari`, `Mobile Safari`라는 project/device 이름만 보고 실제 Safari·실제 iPhone 검증이라고 표시하지 않는다. WebKit은 별도의 호환성 사전 검사로 유용할 수 있지만 최종 Safari TC를 대체하지 않는다.

### Chrome은 Safari와 다른 경량 경로가 있다

Chrome unified headless는 headful과 browser code를 공유하며 visible UI 없이 실행한다.[S7] BrowserContext는 쿠키·local/session storage를 테스트별로 분리한다.[S6] 이 조합은 OS 설치 없이 논리적 web workspace를 만드는 후보지만, QAutra의 입력·frame·보안·pixel parity가 완성됐다는 뜻은 아니다.

개인 host와 다른 커널에 브라우저 작업을 두어야 한다면 Linux VM 안에 여러 Chrome context/container를 배치할 수 있다. 이 경우 **host↔worker VM 경계**는 있지만 **형제 Space 사이의 독립 OS 경계**는 없다. Container끼리는 커널을 공유한다.[S25] Mac의 Docker Desktop 자체도 Linux VM을 사용한다.[S12] “Docker이므로 VM/설치/호스트 권한이 전혀 없다”는 표현은 틀리다. Linux Chrome의 폰트·코덱·GPU·OS 차이는 macOS Chrome과 구분해서 결과에 남겨야 한다.

### 최신 공식 Safari MCP

Apple은 Safari 27 이상에서 공식 MCP server와 Claude Code/Codex 연결, agent 전용 새 창, DOM·네트워크·PNG screenshot·입력을 문서화한다.[S17][S18] Safari 27은 macOS 27뿐 아니라 macOS 26/Sequoia에도 제공된다. **MCP 때문에 host OS 전체를 반드시 27로 올려야 한다는 주장도 틀리다.**[S19]

이는 OS 격리·호스트 비간섭·독립 Safari session 10개·연속 영상의 증거는 아니다. `page_interactions`는 문서상 DOM interactions이므로 기존 실제 입력·freshness·risk·journal 계약과 같은 의미인지 확인해야 한다. 호스트 Safari 설정 변경이 요구되므로 이전에 거부된 host 경로를 MCP라는 이름으로 다시 승인된 것으로 취급하지 않는다. 소유 guest/전용 worker 안에서의 활용과 구분한다.

WebDriver의 single-session 제한을 MCP 등 모든 인터페이스의 미래 기능에 대한 불가능 증명으로 확대하지 않는다. 현재 읽은 MCP 문서는 10개 독립 context와 foreground 비간섭을 보장하지 않는다. 가능하다고도, 영원히 불가능하다고도 판정하지 않는다.

### VM도 항상 수동 설정만 가능한 것은 아니다

Apple의 `VZMacGuestProvisioningOptions`/`setGuestProvisioning(_:)`는 **host macOS 27+·guest macOS 27+·restore 뒤 첫 boot**에서 계정 설정·자동 로그인·SSH를 지원한다. 이전 guest는 옵션을 무시하며, provision된 OS를 이 API로 재설정할 수 없다.[S14][S15] Safari 권한과 QAutra agent 설치를 모두 해결하는 API는 아니다.

이번 조사에서 read-only `sw_vers -productVersion`은 **현재 host 26.6.2**를 반환했다. 현재 VM을 이 API로 즉시 해결한다고 제안하지 않는다. OS upgrade·새 VM·재설치는 실행/승인하지 않았다. “직접 초기 설정이 모든 버전에서 반드시 필요하다”는 이전 안내는 범위가 너무 넓었다.

이전 OS에서도 준비된 소유 VM 재사용이나 manager의 template/clone을 검토할 수 있다. Tart는 준비된 이미지/clone을 제공하지만 예제의 공용 `admin/admin`·passwordless sudo·넓은 공유 폴더를 제품에 그대로 가져오지 않는다.[S20] UTM은 GUI/clone과 버전별 provision/snapshot을, Anka는 자동 생성/template을 문서화한다.[S21][S22] 이들도 macOS·라이선스·guest 자원·QAutra 통합 비용을 없애지는 않는다. Anka의 SIP-off 기본값, Tart의 현행 FSL 라이선스는 별도 도입 검토 사유다.[S22][S23]

동시 clone에는 실제 고유 VZ machine identifier와 일관된 disk/auxiliary state가 필요하다. Apple은 동일 identifier VM의 동시 실행을 undefined behavior라고 명시한다.[S16] 파일 복사·화면 이름 변경만으로 독립 인스턴스라고 처리하지 않는다.

## 3. 대안 비교

아래의 `가능`은 공식 실행 모델이 있는 후보라는 뜻이다. QAutra 통합·정책·비간섭 PASS를 뜻하지 않는다.

| 방식 | 실제 desktop Safari | 호스트와의 경계 | 초기 준비와 반복 테스트 | QAutra 내부 관측/병렬의 조건 |
|---|---|---|---|---|
| 로컬 호스트 Safari + safaridriver | 예 | automation window의 데이터 격리, 같은 host GUI | 기존 macOS/Safari 사용, driver 권한 준비 | screenshot은 가능하나 foreground·입력 비간섭 미보장. 사용자 거부된 기본 경로라 채택하지 않음 |
| Chromium workspace/context | 아니요 | cookies/storage 경계. process/OS 경계는 별도 | 별도 macOS 설치 불필요, context 생성/폐기로 상태 분리 | Ego 같은 UX 후보. 실제 Chrome 표기는 실행 binary 확인 필요. 실제 Safari TC는 불가 |
| Playwright WebKit | 아니요 | 선택한 worker의 경계에 따름 | WebKit binary 설치 | WebKit 사전검사용. 실제 Safari·device PASS 불가 |
| 준비된 로컬 macOS VM + Safari | 예 | 별도 guest OS/desktop. host resource/network 정책은 여전히 필요 | 최초 준비/권한 설정, 이후 소유 VM 재사용 또는 적법한 template 전략 | 현재 방향의 개선안. Safari worker별 직렬, 추가 worker는 라이선스·기술·자원 제한 확인. 페이지 feed와 전체 desktop stream 별도 |
| 사내 전용 원격 Mac + Safari/Grid | 예 | 개발자 host와 물리/OS 실행 위치 분리 | 팀/관리자가 Mac 환경 준비. tester마다 OS 설치 불필요 | remote WebDriver로 실행 가능[S9]. 사내망 경로·인증·screenshot/stream·node당 concurrency는 별도 구축 |
| 관리형 실제 macOS Safari 서비스 | 공급자/browser capability 검증 필요 | 원격 서비스 경계, 공급자의 데이터 관리·tenant 정책 적용 | 공급자가 OS/browser 준비. 사용자 OS Setup Assistant 불필요 | localhost tunnel·허용 browser/OS·계약 concurrency·녹화/실시간 화면 API·외부 반출 정책 검증 필요 |

원격 Mac은 반드시 외부 인터넷 서비스일 필요가 없다. 사내 LAN의 소유 장비도 가능하다.[설계 추론] 다만 remote 접속 자체는 네트워크에 의존한다. 원격 WebDriver를 인터넷에 무인증으로 노출하는 설계는 제안하지 않는다.

### 공급자별 UI 통합의 차이

**TestingBot는 실제 Safari/native safaridriver와 실행 중 live view의 iframe embed·mouse/keyboard takeover를 명시적으로 문서화한다.**[S26][S27] 따라서 “클라우드 Safari는 공급자 dashboard로만 볼 수 있다”는 일반화는 틀리다. 구체적인 QAutra 통합 후보지만 해당 Safari의 takeover/재개, Mac 앱 embed, read-only/control 구분, share token 만료·회수, OEM 권리·비용은 미검증이다.

iframe이 직접 입력을 받으면 QAutra 승인·journal 경계를 우회할 수 있다.[설계 위험] 화면을 embed하는 것만으로 scoped 입력 계약을 충족했다고 판정하지 않는다. credential/share URL을 모델·로그에 노출하거나 예제의 clipboard 권한을 그대로 허용하지 않는다. provider iframe과 raw frame/evidence API도 다르다.

BrowserStack Automate Selenium은 실제 Safari/macOS·원격 제어·Local tunnel·interactive debugging을 문서화한다.[S29][S30] interactive debugging은 `video=true`도 요구하므로 녹화 금지 정책과 충돌할 수 있다. Sauce Labs도 Apple Silicon Safari를 제공한다.[S31] 이들의 dashboard interaction·결과/video embed를 QAutra live interactive API로 확대하지 않는다. 공개 문서에서 확인하지 못한 기능을 “절대 지원 안 함”이라고도 단정하지 않는다.

TestingBot tunnel 문서는 localhost alias/port 조건, 기본 SSL interception, WebSocket/SSE의 `--nobump --nocache` 전제를 명시한다.[S28] 별도 host명은 원래 origin과 같지 않다. 정확한 localhost·회사 인증·보안 검증 TC가 있으면 실지원 확인이 선결 조건이다.

공급자에 대한 보안·지역·보관·접근 통제는 문서/계약의 주장이고 이번에 감사하지 않았다. 브라우저가 cloud에 있는 한 회사 화면은 원격 처리된다. 암호화 tunnel이 “회사 밖으로 데이터가 안 나감”을 뜻하지 않는다.

## 4. “앱 안에서 보인다”의 네 가지 서로 다른 의미

1. **Embedded Chromium surface:** 실제 렌더 surface를 앱이 소유한다. Ego의 수정 Chromium과 같은 방향이지만 브라우저 배포·보안 업데이트·엔진 유지보수 범위가 커진다. 이것을 Safari로 부를 수 없다.
2. **페이지 screenshot/feed:** 실제 worker의 페이지 이미지를 QAutra가 받아 표시한다. WebDriver screenshot은 top-level browsing context의 visual viewport다.[S10] Safari 주소창·OS 설정·로그인 desktop 전체를 보여주는 기능은 아니다.
3. **전체 guest/remote desktop stream:** desktop·native prompt까지 보는 별도 capture/input/인증/인계 경로가 필요하다. local VZ view와 HTTP page PNG는 동일 기능이 아니다.
4. **공급자 Live dashboard:** 서비스 화면에서 볼 수 있다는 것과 QAutra가 합법적으로 embed/제어할 public SDK가 있다는 것은 다르다. 원격 browser endpoint만으로 dashboard iframe·remote takeover가 자동 제공되지 않는다.

Chrome protocol에는 page screenshot, screencast와 page 대상 key/mouse dispatch가 있다. `Page.startScreencast`/ack는 조사한 프로토콜에서 experimental이다.[S8] 이 API의 존재는 구현 부품의 근거이지 안정적인 FPS·지연·정확한 좌표 변환·메모리 상한의 실증이 아니다. 입력은 기존 scope/revision/freshness/risk/receipt 경계를 거쳐야 하며 DOM click/value 주입으로 우회하지 않는다.

Safari의 glass pane을 사용자가 직접 깨면 WebDriver 연결이 영구 단절된다고 Apple은 설명한다.[S3] 따라서 Ego처럼 `Take over → Return to agent`를 모든 Safari 네이티브 화면에서 같은 session으로 무조건 제공한다고 약속할 수 없다. QAutra가 human 입력을 같은 scoped WebDriver로 중계하는 경우와 OS prompt 때문에 native desktop 제어로 넘어가는 경우를 구분해야 한다.[설계 추론]

## 5. localhost·로그인·기업 QA에서 놓치면 안 되는 것

원격 browser의 `localhost`는 개발자의 Mac이 아니다. tunnel/port forwarding 또는 동일 network node가 필요하다. 원래 origin, subdomain, HTTPS/certificate, Secure/SameSite cookies, redirect, WebSocket/HMR를 개별 확인한다. 개발 서버를 무작정 `0.0.0.0`으로 노출하는 것은 대안이 아니다.

사내 VPN·device posture·SSO·client certificate·passkey/MFA는 URL 전달만으로 옮겨지지 않는다. 로그인 상태/cookie를 공급자에 업로드할 권한도 자동으로 생기지 않는다. Playwright 역시 저장된 인증 state에 계정 사칭에 쓰일 cookies/headers가 있을 수 있다고 경고한다.[S11] 테스트 전용 계정·최소 origin·보관/삭제 정책과 사람의 인증 단계가 필요하다.

macOS 초기 약관·계정·권한을 아무 승인 없이 우회하거나, 사용자의 개인 browser profile/VM을 복사해 준비 완료로 삼는 전략은 제안하지 않는다. prepared image는 소유·버전·provenance·라이선스·고유 identity·secret 제거·초기 검증이 있는 배포/관리 전략이어야 한다. 실제 guest initial setup 한 번과 매 테스트 clean browser state는 다른 작업이다.

## 6. 병렬 판단은 browser 수가 아니라 충돌 자원 기준

pstack의 실제 이름은 `poteto-mode`다. throughput checkpoint는 다음 네 축이다.[S13]

- Blocking first steps: OS/browser/driver·인증·test data·origin route·준비 확인부터 통과한다.
- Independent workstreams: 다른 context뿐 아니라 다른 계정/데이터/파일/기기 소유권인지 확인한다.
- Shared mutable state: 먼저 분리한다. 같은 장바구니·주문·설정·업로드 대상이면 분리 전에는 병렬 실행하지 않는다.
- Smallest safe decomposition: 한 worker로 충분하면 분할하지 않는다. 에이전트 수 자체가 처리량은 아니다.

Playwright도 서버 상태를 수정하는 병렬 테스트에 worker별 다른 계정을 권장한다.[S11] BrowserContext를 여러 개 만들어 같은 로그인·장바구니를 복제한다고 backend 데이터까지 분리되지는 않는다.

QA 적용:

- 문서/TC 작성은 공통 기획 기준을 먼저 확정한 뒤 화면 영역별 작성·검수로 분리할 수 있다. 최종 TC ID/coverage 병합은 단일 owner가 한다.
- 읽기만 하는 독립 TC라도 공유 browser navigation·session·계정 logout이 있으면 동일 worker 내 직렬이다.
- 저장 → 목록 반영 → 재진입, 앞 TC 직후/새로고침 금지 같은 TC는 같은 상태 lane을 유지한다.
- 실제 Safari worker는 해당 Safari/desktop session 제한을 가진다. 계정의 parallel quota나 Grid `max-sessions` 설정으로 Apple 제한을 없애지 않는다.
- 전체 capacity는 worker 준비 상태·기기/OS/browser 제한·RAM/CPU·공급자 quota·데이터 잠금·계약을 함께 만족해야 한다.
- unknown mutation은 재전송하지 않는다. control/lease 상실 후 late reply나 재시작을 성공으로 재분류하지 않는다.

### 10개 이상 Space와 실제 동시 실행 수를 분리한다

- Space는 작업 문맥, Worker는 실행 자원, Scheduler는 준비된 자원의 lease를 배정한다. UI card 수가 즉시 실행할 OS 수가 되지 않는다.
- Chrome context 여러 개를 소수 worker에 둘 수 있지만, 한 browser process의 장애/메모리 압박은 형제 작업에 영향을 줄 수 있다. process/container/VM 수는 요구 경계와 실측으로 결정한다.
- Docker는 Chrome 계열 실행/자원 관리 후보다. Linux container에 실제 macOS Safari가 생기지는 않으며 Playwright WebKit을 넣어 Safari라고 부르지 않는다.[S5][S25]
- Docker에는 기본 자원 상한이 없다.[S33] Playwright 공식 image의 root 실행은 Chromium sandbox를 비활성화하며 신뢰하지 않는 사이트용으로 권장하지 않는다.[S34] privileged/host IPC 예제를 그대로 안전한 제품 sandbox로 채택하지 않는다.
- **실제 Safari W3C 경로는 같은 release/GUI의 session 제한을 전제로 예약한다.** 같은 session의 tab 10개를 Space 10개로 바꿔 부르는 것은 독립 cookies·병렬 test session이 아니다. STP는 다른 channel이며 release Safari 슬롯 증설로 세지 않는다.[S3][S4][S32]
- 소수 Safari worker를 queue로 공유하면 **10개 작업을 등록·보관**할 수 있지만 **실제 Safari QA 10개를 동시에 실행하는 요구는 충족하지 못한다.** 사용자가 동시 실행을 요구하면 queue를 조용히 대체 해법으로 삼지 않는다. 추가 macOS 슬롯·라이선스·자원·네트워크·공급자 quota가 필요하다.
- 대기 Space의 마지막 frame에는 시각/대기를 표시한다. live/running 배지를 붙이지 않는다. worker 이동 시 cookies만 복사하면 DOM·IndexedDB·service worker·진행 중 transaction까지 복원된다고 약속하지 않는다.
- 같은 session을 유지해야 하는 의존 TC chain은 종료까지 lease를 유지한다. queue를 비우려고 session을 닫고 투명 복원되는 것처럼 처리하지 않는다.

**Space 수와 Worker/VM 수는 분리하되 실제 동시 실행 수를 허위로 늘리지 않는 것**이 핵심이다. 10개 이상의 실제 작업 부하·메모리·frame 성능은 이번에 측정하지 않았다.

## 7. 권장 방향 — 아직 구현 결정은 아님

### 로컬/사내 데이터 우선

기존 Safari guest 실증을 유일한 기본 실행 방식으로 확정하지 않는다. 사용자 요청에 따라 구현을 홀딩하고, 에픽의 전용 Mac/macOS VM 선택 경계와 최신 공식 MCP 후보를 먼저 대조한다.[S38] 준비된 소유 Safari worker를 선택할 경우 최초 환경 준비와 실제 test run을 분리하며, 매 TC마다 OS를 재설치하지 않는다. 브라우저 state 초기화·업무 데이터 초기화·OS 초기화는 서로 다른 동작이다.

일반 web workspaces는 엔진·필요한 격리 수준에 맞춰 경량화할 수 있다. 그러나 host context/process 경로는 별도 OS 격리와 같은 것으로 표시하지 않고, 기존 요구를 낮추는 cutover는 사용자 승인 없이 하지 않는다. 현재 macOS VM에 모든 브라우저를 일괄 몰아넣는 것도 유일한 설계는 아니다.

### OS 운영을 사용자에게 맡기지 않는 방식

사내 전용 Mac pool 또는 관리형 실제 Safari provider로 동일한 worker 계약을 구현한다. 테스트 담당자는 실행 가능한 환경을 선택하고 OS 준비는 관리자/공급자가 담당한다. 대신 네트워크·SSO·비용·데이터 반출·live view 통합이 새로운 수용 기준이다. 외부 서비스 사용은 명시적 승인이 필요하다.

둘 중 무엇이 더 빠르거나 싸다는 실측 결론은 없다. 기존 사내 장비/정책, 장기 병렬 수요, 최초 준비 부담과 유지보수 비용을 모른 채 서비스 비용이나 RAM 이득을 숫자로 만들어내지 않는다.

### E2EVM과 달리 가져갈 점

E2EVM 공식 architecture는 guest computer·VM framebuffer·명령 통로가 중심이다. Browser smoke는 기존 Chrome의 `browser.contexts[0].new_page()`를 사용한다.[S35][S36] 그 새 page는 새 독립 cookie context와 다르며 E2EVM 자체가 10개 Space의 격리·병렬 scheduling을 제공한다는 증거가 아니다. 첨부된 CLI/worker 실행 결과는 사용자가 제공한 참고 조사이며 이번 조사에서 재실행하지 않았다.

QAutra는 **Space UX·브라우저별 adapter·실제 capacity·업무 검증**이 중심이어야 한다. OS Setup Assistant는 일반 작업 실행 화면과 분리한다. VM manager 선택은 내부 worker 구현이지 매번 사용자가 OS를 다룰 이유가 아니다.

기본 추천은 **공통 Space UI + 실제 browser identity를 유지하는 서로 다른 실행 adapter**다. Chrome 계열은 승인된 context/process/container 경계에서 병렬화하고, 실제 Safari는 준비된 macOS worker 또는 승인된 원격 provider에 연결한다. 화면/작업 계약은 통일하되 같은 경량 내부 구현·동시 capacity를 약속하지 않는다. 실제 Safari 동시 10개가 필수라면 추가 비용/장비 요구를 드러내고 결정 전에 구현하지 않는다.

## 8. 구현 전에 통과할 검증

이번 조사는 아래 실험을 실행하지 않았다. 향후 승인된 합성 fixture에서만 수행한다.

- 실제 browser/OS/version·실행 위치·격리 수준을 식별하고 iframe/WebKit/host fallback이 아님을 확인.
- 호스트에서 다른 작업·물리적 typing을 계속하는 동안 worker 입력/화면/포인터/foreground가 간섭하지 않는지 확인. API 호출 성공만으로 대신하지 않음.
- localhost의 로그인·정적 asset·API·redirect·WebSocket/HMR·HTTPS/cert 경로와 종료 후 port/route 회수 확인.
- 독립 계정/데이터의 동시 실행과 공유 상태 lane의 순차 실행을 각각 확인.
- 실제 frame identity·시각·viewport·DPR·scroll·좌표·stale ref 거부와 영상 지연/자원 비용 확인.
- 사람 인계·MFA·OS prompt에서 통제권/권한 회수와 재개 가능 여부를 browser별 확인.
- crash·engine restart·disconnect·timeout·cancel 후 기존 작업을 자동 채택/재전송하지 않고, 확정 종료 전 소유권을 넘기지 않는지 확인.
- 최초 준비 뒤 재사용·browser update·epoch/lease 갱신·인증 만료를 확인. 설정 완료를 영구 readiness로 간주하지 않음.

현 상태: macOS VM의 첫 Setup Assistant 화면까지만 실제 확인됐고 Safari guest agent/실제 Safari QA는 미실행이다. UI/helper 빌드·테스트 통과를 Safari 격리 수용으로 확대하지 않는다. 이 연구의 독립 검토는 agent-flow의 정식 두 CLI code-review gate를 대체하지 않는다.

## 9. 적대적 검토와 조사 한계

외부 근거 조사 2건(local/self-hosted, remote/provider), 독립 적대적 검토 2건(필요성/라이선스, 제품 통합)을 반영했다. Opus 요청은 provider 429로 시작하지 못했고 독립 검토로 대체했다. 완료된 두 검토는 동일 GPT 계열이므로 **교차 모델 합의라고 주장하지 않는다.** child worktree 쓰기 제한은 우회하지 않았고 전달된 문서를 부모가 통합했다.

중요한 교정:

1. VM의 보편적 필요성 제거. 전용 physical Mac, 관리형 Safari, 준비된 guest·자동 first boot·공식 MCP를 별도 후보로 포함.
2. BrowserContext·container·별도 guest OS·실행 위치 분리. 같은 Linux VM의 container들을 여러 독립 OS로 설명하지 않음.
3. Glass pane은 human→test 보호이지 test→host 비간섭 보장이 아님. 반대로 generic WebDriver focus 계약을 무시하고 모든 Safari 명령이 항상 전경을 요구한다고도 단정하지 않음.
4. Safari/WebKit/STP, Chrome/Chromium/headless shell, W3C/MCP/CDP를 구분. 실제 binary·channel·OS·입력 충실도·다중 session은 검증 대상.
5. Provider dashboard·영상·embed·직접 takeover 구분. TestingBot의 구체적 embed는 확인했으나 token·입력 정책·Safari continuity 적합성은 미실증.
6. 라이선스의 일반 “2개 추가 copy/instance” 허용은 모든 host의 기술적 실행 한도 실측이 아님. Tahoe §2B(iii)는 취득 경로·Apple 하드웨어·용도를 조건으로 하며 volume/별도 계약, remote desktop/서비스 조건은 다르다.[S24] §3의 개발 서비스 임대에는 24시간 최소·전용 통제 등의 조건이 있다. 무제한 비활성 clone 보관·제품 이미지 재배포·공급자 계약 적법성을 승인하지 않는다. 실제 취득 계약과 관할을 확인해야 하며 법률 자문이 아니다.
7. VM/remote worker도 회사 device-bound SSO를 자동 상속하지 않음. cookie/keychain 복사나 SSL 무시를 범용 해법으로 삼지 않음.
8. Chrome/Safari 공통 Space UX·10개 이상 작업 반영. Chrome 현재 코드의 VM 재사용도 확인했고, 실제 Safari 10개 동시 실행을 queue로 충족시켰다고 설명하지 않음.

조사에서는 공식 문서/API/source를 읽고 CDP screenshot/screencast/input 및 W3C screenshot 정의를 추출했으며 host OS version만 read-only 확인했다. browser/VM 실행·Docker 설치·공급자 session/tunnel·host Safari MCP/권한 변경·벤치마크·새 코드/테스트 실행은 하지 않았다. 기존 VM과 제품 code, workflow 완료 상태를 변경하지 않았다.

구현 전에는 Space UX prototype, Chrome 복수 context 격리/비간섭, 실제 Safari adapter의 frame/input·인증·capacity를 **승인된 합성 fixture에서** 검증해야 한다. 이 보고서는 구현 완료나 요구 축소 승인이 아니다.

## 10. 에픽·기존 자동화 조사 재확인

사용자의 추가 질문에 따라 GitHub Epic #2 본문 610행 전체, 댓글 API, 로컬 에픽의 후속 조사·재사용 판단, 기존 심층 조사와 pstack 보고서를 다시 대조했다. 원격 댓글은 조회 시 0개였다. 로컬 에픽에는 `2026-10-31 후속 조사와 최종 반영`이 추가돼 있으며 해당 절은 GitHub 본문 갱신을 의미하지 않는다고 명시한다. 따라서 로컬 연구 반영과 원격 게시 완료를 혼동하지 않는다.[S38]

### 에픽에 이미 있던 계약

- D03/Q03: 여러 독립 브라우저 세션을 병렬 조작하되 탭·페이지마다 VM 하나를 강제하지 않는다.
- D06/Q05: 등록 프로필, 부팅 인스턴스, 실행 세션, AI 판단 작업 수를 구분한다. 플랫폼 한도와 충돌 자원에 따라 배정·대기한다.
- Q01 및 사용 흐름: 기존 AI가 전달받은 기획·TC·URL을 조사하고 제어 코드를 작성한다. QAutra는 같은 실행 관리자를 통해 코드 묶음 실행·권한·증거를 제공한다. 새 필수 planner/모델/DSL을 추가하지 않는다.
- Q03/B04: VM 안의 다중 브라우저 경로도 제품 범위에 포함한다. VM을 전부 제거하는 것으로 요구를 바꾸는 것도 이번 조사에서 승인되지 않았다.
- 실제 Safari 경로: macOS Safari와 검증된 WebDriver, 전용 Mac 또는 macOS VM의 배치·포커스 제약을 실증한다. 에픽은 Safari를 로컬 VM 한 방식으로 확정하지 않았다.

### 참고 대상은 같은 역할의 경쟁 제품이 아니다

| 참고 대상 | 기존 기록에서의 역할 | 채택·검증 경계 |
|---|---|---|
| `web-qa-skill` | 실제 UI 조사, 기획 근거, TC·기대 결과·증거·누락 대조 | 현재 AI의 절차. browser/VM 실행기를 설치하는 제품이 아님 |
| Ego SDK/Skill | 지속 TaskSpace/Page, 한 호출의 여러 조작, snapshot/ref·화면·좌표 입력 | UX·도구 성능 참고. actual Safari/native 또는 저장 상태 격리 보장이 아님 |
| `tester-army/e2e` | locator/assertion, deterministic fixture, 기존 suite·회귀 실행 연결 후보 | 기존 심층 조사에서 핵심 전체 도입 보류. 실제 재사용 이득이 있을 때 `run()`/`openHost()` 평가 |
| Playwright/CDP·기존 app-qa driver | 실제 브라우저 관찰·입력·assertion 실행 | WebKit과 actual Safari를 분리. 기존 B02의 실행 핵심을 무근거로 교체하지 않음 |
| agent-device·mobile-mcp·Moru | 모바일 관찰·입력·대기·기기 어댑터 후보/패턴 | 같은 지원 범위가 아님. Moru는 Android 참고이며 전체 서버 도입 결정이 아님 |
| E2EVM·Cua/Lume·Tart·UTM | 실행 장소인 VM의 준비·소유권·수명주기·표시 참고 | QA 시나리오/병렬 판단 엔진으로 취급하지 않음. 개별 라이선스 확인 필요 |
| pstack `poteto-mode` | 선행 조건·독립 작업·공유 변경 상태·최소 안전 분할을 판단하는 지침 | 후속 로컬 조사에 기록. QA 계정/기기/fixture를 예약하는 실행 스케줄러가 이미 설치됐다는 뜻이 아님 |

근거: [로컬 에픽](../plans/2026-10-28-isolated-agent-qa-epic.md)의 1·3·5절, [기존 심층 조사](2026-10-31-qa-deep-research.md)의 2·4절, [pstack 조사](2026-10-31-pstack-qa-parallelism.md)의 1–4·6절. 이 재확인은 기존 채택 보류를 채택으로 바꾸지 않는다.

### 현재 E2EVM 링크의 의미

현재 README는 스스로 “local VM workspace”라고 명시한다. `Virtualization.framework`가 Linux/macOS guest를 실행하고, native 앱은 guest 화면을 표시한다. 기존 host AI가 CLI를 호출하면 guest worker가 VM 안에서 프로그램을 실행하며, 기본 Chrome smoke는 guest Playwright→CDP→기존 Chrome context의 새 page 경로다.[S35][S36][S39] 별도 OS를 띄운다는 사용자의 해석이 맞다. 단, **별도 VM을 사용한다는 사실과 테스트 탭마다 VM 하나라는 주장은 다르다.**

공식 smoke에는 guest 안에서 fresh headless Chrome/context를 실행하는 대안도 있다.[S36] 따라서 E2EVM을 쓰면 반드시 모든 테스트가 같은 cookie context여야 하는 것은 아니다. 반대로 기본 예제의 `browser.contexts[0].new_page()`만으로 독립 로그인 상태·동시 실행 스케줄러가 제공되는 것도 아니다. 이번 재확인은 소스·문서 조사이며 새로운 VM/브라우저 실행, 설치, 제품 빌드·테스트는 하지 않았다.

재조회한 E2EVM main은 `5bc0f1a39ee63c55472a9c3d6fd8ea1b4f299700`이며, 에픽의 `e6a3df5ced1eae451c4a37bae394801843bda1f9`과 Git tree가 같다. GitHub compare는 merge commit 1개와 `files: []`를 반환했다.[S42] 새 Safari 자동화 기능을 놓쳤다는 근거는 없다.

**macOS 부팅 지원과 Safari 자동화 지원은 다르다.** upstream macOS 안내는 즉시 사용할 수 있도록 준비하는 자동화 경로가 Chrome+Playwright라고 명시한다.[S40] 공개 검증 기록도 macOS는 Setup Assistant 표시까지이며 새 guest 계정·Python/Homebrew bootstrap은 완료하지 않았다고 밝힌다.[S41] 따라서 E2EVM의 Linux Chrome 성공을 실제 Safari QA 완료·Safari 다중 병렬의 증거로 옮겨 쓰지 않는다. 이 기록은 upstream 보고이며 이번 직접 실행 결과가 아니다.

E2EVM 고정 소스의 `guest/worker.py:110–139`는 요청마다 `execute(request)`의 반환을 기다린 뒤 다음 요청을 처리한다. 여러 host `exec` 호출만으로 같은 worker의 일반 명령이 병렬화되지는 않는다.[S43] guest 안에서 별도 job을 실행할 수 있다는 것과 독립 QA 작업의 데이터·브라우저·취소를 예약하는 scheduler가 있다는 것은 별개다.

독립 소스 대조 2건을 이번 재확인에 사용했다(E2EVM 구조, 에픽·자동화 도구 역할). 새 적대적 리뷰·런타임 검증으로 세지 않는다. 기존 e2e 연구의 세션 상한과 hosted attempt 제한, pstack의 네 checkpoint도 재확인됐지만 후보 전체 채택이나 최신 upstream 전체 변경 감사로 확대하지 않는다.

## 출처

- [S1] Ego, Space: https://lite.ego.app/document/en/docs/space
- [S2] Ego, Product introduction: https://lite.ego.app/document/en/docs/product-introduce
- [S3] Apple, About WebDriver for Safari: https://developer.apple.com/documentation/webkit/about-webdriver-for-safari.md
- [S4] Apple, Testing with WebDriver in Safari: https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari.md
- [S5] Playwright, Browsers / WebKit: https://playwright.dev/docs/browsers#webkit
- [S6] Playwright, Isolation: https://playwright.dev/docs/browser-contexts
- [S7] Chrome, Headless mode: https://developer.chrome.com/docs/automation-and-testing/headless
- [S8] Chrome DevTools Protocol source: https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json
- [S9] Selenium Grid: https://www.selenium.dev/documentation/grid/
- [S10] W3C WebDriver, Screen capture: https://w3c.github.io/webdriver/#screen-capture (원문 HTML을 읽어 viewport/PNG 정의 확인. Working Draft이므로 browser 구현 지원과 구분.)
- [S11] Playwright, Authentication: https://playwright.dev/docs/auth
- [S12] Docker, Mac permission requirements / Linux VM boundary: https://docs.docker.com/desktop/setup/install/mac-permission-requirements/
- [S13] pstack, feature throughput checkpoint: https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/feature.md
- [S14] Apple, guest provisioning / macOS 27 host+guest: https://developer.apple.com/documentation/virtualization/vzmacguestprovisioningoptions.md
- [S15] Apple, setGuestProvisioning: https://developer.apple.com/documentation/virtualization/vzmacosvirtualmachinestartoptions/setguestprovisioning(_:).md
- [S16] Apple, machineIdentifier: https://developer.apple.com/documentation/virtualization/vzmacplatformconfiguration/machineidentifier.md
- [S17] Apple, Connecting an AI agent to Safari: https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari.md
- [S18] WebKit, Safari MCP: https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/
- [S19] Apple, Safari 27 supported OS: https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes.md
- [S20] Tart, prepared VM and scratch setup: https://tart.run/quick-start/
- [S21] UTM, macOS and scripting: https://docs.getutm.app/guest-support/macos/ ; https://docs.getutm.app/scripting/scripting/
- [S22] Anka, creation: https://docs.veertu.com/anka/anka-virtualization-cli/getting-started/creating-vms/index.html
- [S23] Tart source license: https://raw.githubusercontent.com/cirruslabs/tart/main/LICENSE
- [S24] Apple Tahoe 26 SLA: https://www.apple.com/legal/sla/docs/macOSTahoe.pdf . macOS 27 is separately listed: https://www.apple.com/legal/sla/docs/macOS27.pdf . Actual acquisition agreement/jurisdiction must be checked.
- [S25] Docker, shared kernel: https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/
- [S26] TestingBot, Selenium live view/iframe/takeover: https://testingbot.com/support/web-automate/selenium/live-view.md
- [S27] TestingBot, real Safari/native driver: https://testingbot.com/test-on-safari . Marketing version lists/generic Playwright language are not runtime fidelity proof.
- [S28] TestingBot, tunnel constraints: https://testingbot.com/support/tunnel/faq.md
- [S29] BrowserStack, Safari/macOS: https://www.browserstack.com/docs/automate/selenium/select-browsers-and-devices
- [S30] BrowserStack, interactive session/video: https://www.browserstack.com/docs/automate/selenium/interactive-session
- [S31] Sauce Labs, Apple Silicon Safari: https://docs.saucelabs.com/web-apps/macos-apple-silicon/
- [S32] Selenium Grid capacity: https://www.selenium.dev/documentation/grid/getting_started/
- [S33] Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/
- [S34] Playwright Docker security/network: https://playwright.dev/docs/docker
- [S35] E2EVM architecture: https://github.com/taejs/e2evm/blob/main/docs/architecture.md
- [S36] E2EVM browser smoke: https://github.com/taejs/e2evm/blob/main/skills/guest-e2e/references/browser-smoke.md
- [S37] Ego SDK/Skill, shared profile cookies/cache: https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/clearing-state.md . [S1]과 저장 상태 설명이 충돌하므로 실제 버전 검증 없이 보장을 합치지 않는다.
- [S38] QAutra Epic #2, D03/D06, 3절, Q01/Q03/Q05/Q14, 5절: https://github.com/chonamdoo/app-qa/issues/2 . 원격 본문과 후속 내용이 있는 로컬 에픽을 구분한다.
- [S39] E2EVM current main README: https://github.com/taejs/e2evm/tree/main
- [S40] E2EVM macOS guest / Chrome automation boundary: https://github.com/taejs/e2evm/blob/5bc0f1a39ee63c55472a9c3d6fd8ea1b4f299700/docs/macos.md#L95-L104
- [S41] E2EVM published validation limits: https://github.com/taejs/e2evm/blob/5bc0f1a39ee63c55472a9c3d6fd8ea1b4f299700/docs/validation.md#L43-L45
- [S42] E2EVM pinned Epic source/current main comparison: https://api.github.com/repos/taejs/e2evm/compare/e6a3df5ced1eae451c4a37bae394801843bda1f9...5bc0f1a39ee63c55472a9c3d6fd8ea1b4f299700
- [S43] E2EVM sequential guest request loop: https://github.com/taejs/e2evm/blob/5bc0f1a39ee63c55472a9c3d6fd8ea1b4f299700/guest/worker.py#L110-L139
