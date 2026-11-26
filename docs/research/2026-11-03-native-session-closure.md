# Native session 종료 · 원 자원의 재사용 판단

2026-11-03. QAutra B02의 모바일 frozen 실행을 연결하기 위한 구현 근거다. **Appium DELETE 성공이나 WDA `ready: true`만으로 원 기기가 재사용 가능하다고 판단하지 않는다.** 이 문서는 실행 권한·기기 소유권·QA PASS를 부여하지 않는다.

## 확인한 버전과 근거의 한계

- 설정: `src/appium/setup.ts:9-13`의 UiAutomator2 `8.7.0`, XCUITest `12.13.2`.
- 설치 metadata도 각각 같은 버전이다. Android 의존 선언은 `appium-adb 16.0.5`, `appium-android-driver 14.2.0`, `appium-uiautomator2-server 10.6.6`이다.
- XCUITest의 실제 nested `appium-webdriveragent/package.json`은 WDA `16.12.10`이다. 경로는 `.tools/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/`다. top-level hoisting을 가정하지 않고 Node의 package resolution으로 확인했다.
- 아래 동작은 **설치된 source를 읽은 결과**다. package의 원 upstream과 전체 bytes가 일치하는지는 확인 안 함이다. 배포할 때 실제 실행 module·agent build의 identity를 고정해야 하며 version 문자열만으로 이를 대신하지 않는다.
- 원 소유자의 공개 저장소: [UiAutomator2 driver](https://github.com/appium/appium-uiautomator2-driver), [XCUITest driver](https://github.com/appium/appium-xcuitest-driver), [WebDriverAgent](https://github.com/appium/WebDriverAgent). 링크의 최신 source가 로컬 설치본과 동일하다고 주장하지 않는다.

## Android: 종료 응답은 best-effort 정리를 포함한다

설치 prefix를 `U=.tools/appium/node_modules/appium-uiautomator2-driver/`라 한다.

| 근거 | 실제 source 동작 | QAutra의 판단 |
| --- | --- | --- |
| `U/lib/uiautomator2-server/core.ts:250-275` | native session DELETE 오류를 경고로 남기고 계속한다. instrumentation stop 오류와 server/test package force-stop 오류도 삼킨다. | 상위 W3C 성공이 native agent 종료의 독립 관측은 아니다. |
| `U/lib/uiautomator2-server/core.ts:465-485` | process 존재 조회가 실패하면 종료 조건을 `true`로 취급한다. 종료 대기 timeout도 경고 후 계속한다. | 관측 실패·시간 경과를 QAutra의 `stopped`로 변환하지 않는다. |
| `U/lib/driver.ts:508-565` | native delete·화면 녹화 종료·앱 force-stop 실패를 일부 경로에서 삼키고 다음 정리로 진행한다. | UI agent·capture·업무 앱·backend lease는 각각 확인한다. |

이것을 Appium의 보안 결함이나 미관측 실제 기기 실패라고 판정하지 않는다. 라이브러리의 best-effort 종료 계약과 QAutra의 자원 재사용 근거가 다른 것이다.

## iOS: idle WDA와 원 session 종료를 구분한다

설치 prefix를 `X=.tools/appium/node_modules/appium-xcuitest-driver/`, `W=X/node_modules/appium-webdriveragent/`라 한다.

- `X/lib/driver.ts:958-1036`은 recorder·WDA·연결·로그 등을 순서대로 정리한다. 각 단계의 성공 범위는 별도다.
- `X/lib/commands/wda/stop.ts:7-30`은 WDA DELETE 오류를 잡고 계속한다. WDA process의 `quit()`은 `useNewWDA`, `webDriverAgentUrl`, `canSkipXcodebuild` 조건에 따라 수행한다. 따라서 WDA process가 살아 있다는 사실만으로 미종료라고 단정하지도, Appium DELETE 응답만으로 물리 종료라고 주장하지도 않는다.
- `W/WebDriverAgentLib/Commands/FBSessionCommands.m:39-60,161-169`에서 active session 조회·DELETE·status route를 확인했다. 읽은 `WebDriverAgentLib`에는 `/sessions` literal 또는 `handleGetSessions`가 없다. **Android나 일반 WebDriver의 endpoint를 WDA에도 있다고 가정하지 않는다.**
- `W/WebDriverAgentLib/Commands/FBSessionCommands.m:172-227`의 status는 `ready: YES`를 반환하며 OS·SDK·build 정보를 담는다. 원 teardown 완료나 pending native 입력의 부재를 입증하는 field는 이 응답에 없다. healthcheck는 source 주석 자체가 simulator 상태를 바꿀 수 있다고 하므로 read-only 복구에 사용하지 않는다.
- `W/WebDriverAgentLib/Routing/FBSession.m:287-347`은 원 active pointer를 먼저 비우고 teardown count를 증가시킨 뒤 pending request 통지·alert monitor 중지·녹화 정리·조건부 앱 종료를 수행한다. 따라서 active pointer 부재와 teardown 완료를 동일시하지 않는다.
- 같은 파일 `129-158,306-310`의 concurrent teardown 대기는 bounded다. `442-503`의 앱 종료도 제한 시간과 포기·generation 보호를 갖는다. 일반적인 idle server 재사용 가능성은 있지만, QAutra가 원 generation과 실제 완료를 독립 확인하지 않은 상태를 자동 해제할 근거는 아니다.

## 실제 simulator metadata 실험

증거: `.qa/native-smoke/simulator-boot-identity-20261103-01/`.

- 새 임시 simulator 하나를 headless로 두 번 부팅했다. 기존 기기·업무 앱은 사용하지 않았다.
- iOS `26.5`, build `23F77`, 동일 UDID에서 `simctl spawn <원 UDID> launchctl managerpid`는 실제 `launchd_sim`의 PID `4671`, `5100`을 각각 반환했다. `proc_pidinfo`의 초·microsecond 시작 시각도 달랐다. 두 정지 후 inventory는 `Shutdown`, 원 프로세스 조회 결과는 `unobserved`였다.
- `unobserved`를 `stopped`로 저장하지 않았다. 이 실험은 simulator supervisor lifetime의 관측이지 물리 iOS kernel boot identity·WDA 종료·backend 정리의 증거가 아니다.
- foreground PID는 전후 `42511`, host-global 입력·업무 앱 실행은 0회였다. 자신이 만든 simulator의 delete command는 종료 코드 0이었다.

## 구현 결정

1. 최초 등록 시 실제 target·device lifetime·app/build·SDK/agent identity·원 session·private endpoint를 원 binding에 고정한다. caller가 지정한 UUID나 현재 임의의 endpoint만으로 원 자원을 인증하지 않는다.
2. 정상 종료는 원 transport의 입력 fence와 미해결 요청, 원 UI agent/session의 완료, Appium 소유 process, capture/encoder/inventory, backend lease의 late effect·복원 완료를 따로 기록한다. 조건을 증명할 수 없는 adapter는 자원을 자동 반환하지 않는다.
3. 응답 유실과 controller/worker 종료 후에는 원 source의 read-only 관측으로만 대조한다. replacement session 생성·새 WDA 실행·준비 mutation 재전송으로 원 결과를 확인하지 않는다. 다른 generation의 agent를 종료하지 않는다.
4. 그렇다고 모든 정상 native 실행을 영구 `unknown`으로 만드는 초안을 완료로 적용하지 않는다. 실제 supported adapter의 원 종료 관측과 성공·실패·중단·복구 시나리오가 연결돼야 한다. 현재 mobile owner/frozen 초안은 통합 완료가 아니다.
5. QA SDK의 인증은 위 device lifecycle과 별개다. 실제 QA build의 app-private credential과 business startup 이전 bootstrap이 필요하다. polling 파일의 존재만으로 프로세스 생존이나 원 principal을 증명하지 않는다. 후속 Android SDK 실측의 인증 성공도 원 UI agent 종료를 대신하지 않는다.

## 후속 SDK 실측과 남은 경계

- `.qa/native-smoke/native-sdk-android-20261103-06/`에서는 새로 소유한 Android 34 ARM64 emulator에 실제 UiAutomator2 Appium session을 만들고, 서명된 앱의 SDK entry와 별도 HTTPS backend로 현재 principal 인증·재전송 거부·backend 복원을 검증했다. 원 session의 HTTP 정리를 실행했지만 native instrumentation의 원 generation 종료 증명으로 계산하지 않았다.
- native 업무 입력·모바일 frozen QA·실제 WDA 제어·복구 후 재사용은 확인 안 함이다. 독립 연구 요청은 provider rate-limit으로 시작하지 못했다. source 조사나 실패한 요청을 독립 리뷰·workflow gate 통과로 계산하지 않는다.

## 후속 실제 Android kernel handle 검증

- `native-sdk-android-20261103-07`은 실제 APK에서 fixture 준비 후 승인 callback 안에서 SDK를 시작했다. 인증 전 bootstrap 대기와 인증 후 업무 화면을 구별했다. 이 결과는 generic launch나 frozen 실행의 허가가 아니다.
- `native-agent-pidfd-20261103-02`는 실제 Android 34 ARM64 emulator의 UiAutomator2 agent 3개에서 `pidfd_open`으로 원 process를 보유했다. 원 UID·시작 tick·boot ID·cmdline을 대조하고, 신호와 종료 관측에 같은 kernel handle을 사용했다. 명시 중지·잘못된 control token·stdin EOF 모두 escalation 없이 원 process 종료와 helper exit 0을 확인했다.
- 잘못된 시작 tick은 exit `87`이었으며, 그 뒤 실제 원 session 관측은 유지됐다. host foreground는 전후 `56335`, 업무 입력은 0회였다. helper·Appium child·업로드한 private 파일을 정리했고, generation G도 원 boot ID를 확인한 power-off 뒤 실제 supervisor exit 0으로 종료됐다.
- `01`의 duplex transport 실패는 별도 실패로 남긴다. 이 component를 제품 mobile owner에 통합하거나, ADB 단절 후 durable 원 종료·영상 연속성·backend recovery·물리 iOS까지 증명한 것은 아니다.

## 현재 물리 iOS 검증의 준비 상태

- 읽기 전용 `devicectl list devices`에서 paired 항목 8개가 있었으나 모두 `tunnelState=disconnected`였다. 특정 개인 기기를 선택·연결·pair하거나 기존 simulator를 채택하지 않았다.
- 읽기 전용 code-signing identity 조회에서 유효한 `Apple Distribution`과 `Developer ID Application`은 있었지만 `Apple Development` identity는 없었다. 이를 WDA development 서명이 준비됐다는 뜻으로 해석하지 않는다. keychain 잠금 해제·신뢰 설정 변경·인증서 발급은 수행하지 않았다.
- 설치된 XCUITest driver의 `lib/device/app-termination-client.ts:25-37,80-98`은 현재 bundle의 PID를 조회해 종료 요청을 보낸다. 원 process 객체의 종료 관측과 동일하지 않다. 설치된 `appium-ios-device/lib/xctest.js:329-347`의 `stop()`도 connection close/dispose와 내부 플래그 갱신이지 원 runner 종료를 기다린 receipt가 아니다.
- 준비된 실제 iOS worker와 원 agent/session 종료 권위가 없는 상태에서 이 API 성공이나 SDK witness만으로 물리 iOS 자원을 반환하지 않는다. 물리 iOS를 영구 `unknown`인 가짜 구현으로 대체하거나, simulator 검증을 실기기 검증으로 표시하지 않는다.

## 독립 적대적 검토의 결정

- `AndroidStopAdversarial`와 `IOSFenceAdversarial`는 실제 완료한 독립 read-only 검토다. 앞서 시작하지 못한 연구 요청과 구분한다. 이 검토는 설치 workflow의 Claude/Codex CLI `multi-review` gate를 대체하지 않는다.
- Android의 같은 `pidfd` 관측은 좁은 원 process 종료 근거로 타당하다는 조건부 판정이다. 다만 blocking stdout, PIN 숫자 overflow, EINTR·ESRCH 구분, binding과 disclosure의 대응, durable source 보존 및 원격 종료보다 먼저 local transport를 강제 종료하는 정리 순서는 보완 대상이었다.
- iOS의 HTTP handler·job counter만 `0`이 되는 논리 fence 초안은 채택하지 않는다. XCTest daemon 호출 timeout은 취소·완료 callback이 아니고, HTTP request abandonment도 이미 dispatch된 native 작업을 회수하지 않는다. 근거: 설치 WDA `FBXCTestDaemonsProxy.m:25-55,106-129`, `FBHTTPServer.m:683-704,757-768,807-825`.
- WDA session pointer 제거·timer disable·recording promise reset도 원 작업 완료 증명이 아니다. 특히 recorder stop 오류 후 identity를 없애는 기존 동작을 QAutra의 artifact 최종화 근거로 쓰지 않는다. 근거: `FBSession.m:287-329`, `FBXCTestDaemonsProxy.m:330-360`, `FBVideoCommands.m:63-77`.
- 향후 process-exit 또는 native actor-closed proof는 별도 versioned 계약이어야 한다. 현재 Chrome/guest용 `nativeStop: confirmed`에 이름만 바꾼 JSON을 넣지 않는다. 원 입력·daemon 작업·영상·fixture·late effect의 완료 범위를 각각 검증해야 한다.

## Android 종료 disclosure의 실제 검증

조사용 `.qa/native-owner-probe-review/native-agent-pidfd.c`와 `.qa/native-agent-pidfd-smoke.ts`의 결과다. **제품 frozen owner 통합이나 전체 기기 재사용 승인이 아니다.**

- PIN 한 번에 원 agent identity·binding digest·고유 secret을 묶고 ACK를 원 binding과 대조한다. native C는 crypto를 새로 구현하지 않는다. owner가 표준 SHA-256 commitment를 고정하고, C는 같은 held `pidfd`의 terminal 관측 후에만 opaque preimage를 공개한다. trusted-owner의 조건부 공개 규약이며 kernel attestation이 아니다.
- stdout은 nonblocking·bounded write다. 출력이 막혀도 원 종료와 source 확정이 출력 성공에 종속되지 않는다. 숫자는 token 분리와 범위 검사로 읽고, EINTR는 원 단조 deadline 안에서 처리하며 `signalSent`는 실제 syscall 성공과 구분한다.
- source는 원 private directory FD·UID·mode·inode에 고정한다. exclusive `closed.preimage`의 고정 길이 write·fsync·directory fsync 후 empty `closed.seal`을 확정한다. 충돌을 덮어쓰거나 새 producer로 보충하지 않는다.
- 복구용 `--read` 경로는 새 PIN·signal·session을 만들지 않는다. 원 inode·regular file·UID·mode·nlink·길이·불변성을 검사한 source만 반환한다. owner는 원 commitment와 대조하고 실제 공개 값·binding을 인증한 local 기록에 fsync한 뒤 원격 사본을 정리한다. provisioning 때 가진 secret 사본이나 commitment만으로 완료를 인정하지 않는다.

`native-agent-disclosure-20261103-02`의 실제 Android 34 ARM64 결과:

| 상황 | 관측·수용 결과 |
| --- | --- |
| 명시 stop | 원 종료와 disclosure 검증 |
| 잘못된 control token | 원 종료와 disclosure 검증 |
| stdin EOF | 원 종료와 disclosure 검증 |
| stdout reader 정체 | terminal stdout 없이 원 disclosure 검증 |
| 소유한 local ADB client 종료 | 새 producer 없이 원 disclosure 검증 |
| source 파일 충돌 | 원 process는 종료됐지만 commit 실패·helper exit `2`; recovery source는 `unknown` 유지 |

- 여섯 시나리오의 잘못된 start tick은 exit `87`, 각 PID·tick·UID의 overflow/음수 입력은 exit `65`였다. 거부 뒤 원 session 관측은 계속 가능했다. 잘못된 source inode와 변조한 local 인증 기록도 거부했다.
- helper build SHA-256은 `2797b6135178042759c5d66dfe01fdb2b0ef3e9a550f8be1635d7c7b432eaefe`다. 업무 입력은 0회, host foreground는 전후 `56335`다. 원 Appium·helper의 local child 31개는 모두 정리됐고 해당 실행의 remote directory는 남지 않았다.
- `01`은 마지막 충돌 시나리오의 control reason을 잘못 기대한 harness assertion으로 실패했다. 원 실패를 PASS로 소급하지 않았다. 충돌 source의 실제 bytes·metadata를 보존한 뒤 generation H를 종료했고, wipe 없는 새 generation I에서도 그 기록이 그대로임을 확인했다. 이전 unknown 결과는 바꾸지 않았다.
- 여기서 검증한 단절은 local ADB client 종료다. ADB server 전체·기기 소실·helper SIGKILL/OOM·SIGKILL escalation·물리 기기·인증된 native 완료 시각·영상·backend recovery는 확인 안 함이다. `verifiedAt`을 native source 완료 시각으로 바꾸지 않는다.

## iOS 원 DVT observer의 후속 후보

- 설치 `appium-ios-device/lib/xctest.js:140-157`은 실제로 runner launch 후 `startObservingPid:`를 부른다. `lib/instrument/index.js:59-89,162-180`에는 selector/channel/lifecycle callback 경로가 있다. 이 발견은 기존 `stop()`이 원 종료를 증명하지 않는다는 판단을 바꾸지 않는다.
- 현재 upstream [ProcessControlService](https://github.com/doronz88/pymobiledevice3/blob/3678d7c31b326657cfa4953269ea2aa527044453/pymobiledevice3/services/dvt/instruments/process_control.py)는 `processWithPID:terminatedWithExitCode:orCrashingSignal:`을 받는다. 관측한 Git blob은 `dafb2373c5061a59d0cf7b588f2fb98492b1c9b9`다. callback은 PID·exit code·signal이며 epoch는 없다. 설치·실기기 실행·Apple native service의 순서 보장을 확인한 결과가 아니다.
- `.qa/native-owner-probe-review/ios-dvt-observer-proposal.md`는 observer 설치 전후의 fresh native challenge로 원 runner를 묶는 **미구현·미승인 후보**다. stale callback·PID 재사용·등록 ACK의 의미와 원 native 작업·영상의 별도 완료가 반증 검토 대상이다. 재접속해 현재 PID를 다시 관측하는 복구는 허용하지 않는다.
- upstream 저장소는 GPL-3.0을 표시한다. 조사 참고일 뿐 제품 dependency나 코드 재사용을 추가하지 않았다.

## iOS DVT 후보의 독립 반증 결과

- `IOSDVTIdentityReview`는 설치 전후의 서로 다른 native challenge가 observer 등록을 사이에 두는 방식 자체를 PID 재사용 방어로 인정했다. 다만 **현재 종료 authority는 승인하지 않았다**. selector 존재와 client 코드만으로 Apple service의 등록 ACK·원 process instance 결속·terminal callback provenance를 증명할 수 없다.
- 필요한 native 계약은 성공 ACK 시점의 등록 완료, 이후 같은 구독이 원 process instance에만 묶임, 과거 PID의 terminal event 미재생이다. 같은 PID의 이전 process 이벤트가 현재 등록 뒤 재생된다는 반례는 **추정한 공격 모델**이지 실제 Apple 결함을 관측한 결과가 아니다.
- 설치 `xctest.js`는 등록 reply를 버린다. DTX 일반 reply는 오류 객체일 수도 있어 성공으로 단정할 수 없다. channel callback은 selector callback보다 먼저 처리되므로 observer 전용 원 connection과 callback 경로의 충돌도 해결해야 한다. 현재 `stop()`의 connection dispose는 그 원 observer를 유지하지 않는다.
- 등록 ACK 뒤 post-challenge 응답이 생성되고 process가 종료된 다음, terminal callback보다 응답 전달만 늦을 수 있다. 먼저 받은 원 terminal을 나중 fresh 응답으로 되돌려 active로 만들면 안 된다. 응답 수신·호스트 저장 시각은 native 생존 시각이 아니다.
- 원 runner의 실제 종료 증명과 native daemon 작업·영상 finalization·backend 정리는 별도 사실이다. 이 후보를 기존 Chrome/guest의 `closed` receipt나 단일 resource 재사용 승인으로 바꾸지 않는다.
- 후속 검증에는 준비된 signed WDA와 실제 native 등록/오류/종료 transcript, PID 재사용·단절·지연 전달의 원 구독 실험이 필요하다. 현재 physical iOS target은 준비되지 않았다. Apple Development identity를 생성하거나 기기 trust·설정을 바꾸지 않았다.
- 독립 CLI review gate의 완료는 아니다. 별도 `IOSClosureEffectsReview` 요청은 provider `429`로 시작하지 못했으므로 리뷰 결과로 세지 않는다.

