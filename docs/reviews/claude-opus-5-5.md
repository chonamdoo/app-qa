## A. 결정별 판정

D1 | 동의 | Appium이 Node로 돌고, `@typesafe-ai/sdk` v0.6.0은 Node≥20을 지원함(TypeSafeAPI.md:265). Convoy(TS, MIT)의 정규화·게이트 코드도 가져다 쓸 수 있음. 다만 JS SDK 기본값은 시도당 10s이고 총 예산이 없어 최악 ~31.5s까지 걸림(TypeSafeAPI.md:232). 설계대로 얇은 fetch 클라이언트를 직접 쓰는 게 맞음.

D2 | 수정 | Android는 UIA2 `/source`가 0.01–0.12s이고 한글 setValue도 성공해서 적합함(design.md:15-16). iOS는 경로별 차이가 큼: Appium 경유 `/source` 1.1s(design.md:22), WDA 직접 0.3–0.5s(design.md:21), idb axbridge 웜 33ms(IOSAgents.md:118). 1.1s로는 D8의 150ms 폴링이 성립하지 않음. Appium은 유지하되 iOS에 `waitForIdleTimeout:0`을 켜고(openclaw 실측: 클릭당 ~10s 절감, IOSAgents.md:203) read/act를 나눈 Driver 인터페이스로 둘 것.

D3 | 동의 | jev-ios-bridge ADR-0003에서 자율 행동 선택은 top-1 17/20, 게이트 통과 10/20으로 사전 기준 미달이었음. 반대로 assertion Noul은 48개 claim에서 확신 오답 0이었음(ConvoyBridge.md:228-246). `which`에는 Convoy `gateWhich`처럼 "none=로딩중" 옵션이 꼭 필요함.

D4 | 수정 | 방향은 맞지만 세 가지를 고쳐야 함.
- "문서순서 hit-test" 하나로는 부족함. 떠남 4겹 시트 사건이 있었고(design.md:18), jev-pilot은 나중에 그려진 요소 기준으로 안 가린 영역을 고르고 `Obscured`면 거부함(AndroidC.md:73). jev-vphone은 대상마다 실제 hittest를 함(IOSAgents.md:136).
- "동일 라벨·겹치는 bounds 중복 제거"는 반복 행(예: "삭제" 여러 개)을 하나로 합쳐버림(jevDemo AndroidC.md:150, nier AndroidB.md:542).
- 후보 상한은 none을 포함해 254개임.

D5 | 수정 | 모든 수치가 캘리브레이션을 거치지 않았음.
- Convoy 기본값을 가져왔는데 Convoy 자체도 M6(캘리브레이션)을 끝내지 못함. 게다가 원래 식 `top≥.75 || gap≥.20`이 AND로 바뀜(ConvoyBridge.md:120).
- Noul 0.9/0.1은 영어 24화면에서 나온 값이고, 부재 claim은 0.78–0.80이라 inconclusive 구간에 들어감(ConvoyBridge.md:241-245).
- TypeSafe도 CJK 정확도가 낮다고 명시함(TypeSafeAPI.md:260).

한국어로 측정하기 전에는 확정하면 안 됨.

D6 | 동의 | 한국어 라벨을 fast path로 처리하는 방향이 맞음. Convoy는 ASCII 전용 정규화 때문에 한국어가 fast path를 절대 못 탔음(ConvoyBridge.md:70). 조건이 두 가지 있음.
- 유일성은 occlusion 필터 후, dedupe 전 원본 기준으로 셀 것.
- trace에 가짜 Jev 응답을 쓰지 말고 `decision_source: fast_path`를 기록할 것(Convoy `exactHit` 함정, ConvoyBridge.md:107).

D7 | 수정 |
- iOS clipboard 폴백은 설계 문서 자신의 실측(design.md:20)과 IOSAgents(iOS 27에서 조용히 거부됨, IOSAgents.md:66)로 이미 막힌 길임. 실측에 성공한 `/wda/keys`로 바꿀 것(design.md:21).
- 폴백은 read-back 결과 값이 전혀 안 바뀌었을 때만 허용해야 함. 그래야 §2.5 "불확실 mutation 재시도 금지" 원칙과 맞음.
- iOS back의 엣지 스와이프는 모달 화면에서 실패함(maestro-jev, CrossQA.md:343).

D8 | 수정 |
- 150ms 폴링은 iOS `/source`가 1.1s라서 불가능함.
- "변화가 생긴 뒤에 안정" 조건이 없음. 그래서 RN 전환이 늦게 시작되면 옛 화면을 안정 상태로 오판함(Friedjof: 변화 필수 + 250ms 안정, AndroidA.md:139).
- 시계·진행률 같은 값 변화 때문에 영원히 안정되지 않을 수 있음(Convoy ConvoyBridge.md:36, jevium CrossAgents.md:357). identity/layout 이중 지문이 필요함(jev-sim-use).
- 5s 타임아웃이 났을 때 어떻게 할지 정의되지 않음.

D9 | 수정 | 방향은 맞음(떠남 간헐 Render Error, design.md:24). 두 가지를 고쳐야 함.
- "Log 1 of"는 LogBox 경고 토스트에도 뜨므로 경고로 FAIL이 나는 오탐이 생김.
- LogBox는 dev 빌드에서만 보임. 이건 RN 동작에 대한 제 지식이고 research에는 없음. 즉 설치본이 dev 빌드라는 뜻이니 빌드 종류를 기록해야 함.

로그는 사후 조회보다 테스트 단위 시간창으로 모으는 게 나음(artemis logcat `-t`, Artemis.md:69).

D10 | 수정 | 키워드 + `allowRisky` + fast path 전용 구조는 좋음. 구멍이 있음.
- `tapAt`·OCR·아이콘 전용 버튼은 라벨이 없어서 키워드 검사를 우회함.
- 확인 다이얼로그의 "확인"은 키워드에 안 걸림.

jev-pilot `commits` Noul(비커밋 화면 <0.11, 커밋 화면 ≥0.73, AndroidC.md:92)과 jev-vphone `risky`(삭제 요청을 0.84로 거부, IOSAgents.md:158)는 "거부를 추가하는 용도"로만 쓸 것.

D11 | 수정 | 희소 트리거(ultrafast: 액션 <3개 & 텍스트 <32자)는 적절함. 고칠 점이 있음.
- jevium은 `swift -e`로 매 호출마다 컴파일했고, 언어를 설정하지 않아 한국어를 인식하지 못함(CrossAgents.md:359-360). 미리 빌드한 바이너리를 쓰고 `recognitionLanguages`를 명시할 것.
- OCR 결과는 픽셀(1206×2622)인데 탭은 포인트(402×874) 단위임(IOSAgents.md:402). 좌표계 표식이 필수임.

D12 | 동의 | 보강할 것:
- `x-typesafe-request-id`와 응답 `model`을 기록(TypeSafeAPI.md:359).
- JSONL을 fsync하고 권한 0600, 디렉터리 이름은 ms+uuid로(jev-ios-bridge).
- Convoy 함정 피하기: 초 단위 디렉터리 이름 충돌, `costs` 항상 0, `elements.json`에 PII 저장(ConvoyBridge.md:185-187).

D13 | 수정 |
- 반복 라벨 중 하나를 지정할 수단(`within`/`nth`)이 없음. 게이트가 ambiguous로 즉시 실패함.
- `see.not`을 단일 스냅샷으로 하면 flaky함(Convoy). Noul로 하면 부재 claim이 약함(0.78–0.80).
- 스텝별 `expect`·`timeout`, 권한 팝업용 `when` 핸들러가 필요함(jevsim, jev-ios-bridge guard).

D14 | 동의 | 추가할 것:
- 디바이스 락(artemis FIFO, Krilin flock).
- `qa calibrate` 명령.
- `qa inspect`에 occlusion/fast-path/risk 열.
- Android SDK가 PATH에 없으므로(design.md:6) 자식 프로세스에 `ANDROID_HOME`을 넣어줄 것.

D15 | 동의 | `TYPESAFE_LOG_LEVEL=debug`이면 JS SDK가 요청·응답 본문을 마스킹 없이 로그로 남김(TypeSafeAPI.md:278). debug 레벨은 강제로 금지할 것. 키 파일 권한 0600 검사도 추가.

D16 | 수정 | fixture 단위 테스트만으로는 게이트 수치를 검증할 수 없음. 필요한 것:
- 라벨을 단 한국어 골든셋과 사전등록 기준(jev-ios-bridge 방식).
- 녹화한 Jev 응답 재생. Convoy의 recorded 모드는 실제로는 기록을 안 하는 버그가 있었음(ConvoyBridge.md:82).
- fixture 메타데이터에 "dev 빌드에서 뜬 dump"라고 기록.

D17 | 수정 | 세 가지 문제가 있음.
- v1에서 자율 탐색을 제외한다는 §5와 사실상 충돌함.
- "에러/빈 화면인가"는 Jev가 약한 부재·빈 상태 claim임.
- jev-hands에서 모델이 진입 페이지를 완료로 판단했고, 틀릴 때 확신이 더 높았음(AndroidC.md:447).

v1은 결정적 검사와 탭바 순회만 하도록 줄일 것.

## B. 제안 (중요도 순)

### S-1 한국어 골든셋으로 게이트를 캘리브레이션한 뒤 수치 고정

- **근거:**
  - D5 수치는 Convoy 기본값이고, Convoy 자체도 M6 캘리브레이션을 끝내지 못함(ConvoyBridge.md:9).
  - jev-pilot README: "thresholds invented, not measured"(AndroidC.md:126).
  - Noul 0.9/0.1은 영어 24화면 기준이고, 부재 claim은 0.78–0.80(ConvoyBridge.md:241-245).
  - TypeSafe는 CJK가 "not equally well"이라고 함(TypeSafeAPI.md:260).
  - Noul과 Choice는 임계값을 공유하면 안 됨. 같은 질문인데 0.22 vs 0.01이 나옴(TypeSafeAPI.md:346).
  - 대조군: jev-hands는 라벨 단 56개 화면으로 캘리브레이션해 오판 정지 0을 확인했고, `model_drift`도 감지함(AndroidC.md:465-468).
- **제안:**
  1. 오늘 뜬 떠남 Android/iOS dump로 고정 화면 세트를 만듦.
  2. 화면마다 여섯 가지를 라벨링: 정답 grounding 문구, 없는 대상(정답=none), 중복 라벨, 가려진 대상, 참/거짓 claim, 부재·빈 상태 claim.
  3. 통과 기준을 먼저 적어둠. 예: 확신 오답 0, 수용률 ≥80%.
  4. `jev-1.13.0` + 동결한 질문 문구 v1로 돌려서 primitive별 임계값을 `calibration/<model>/<qver>.json`에 저장.
  5. 런타임은 (model, 질문 버전) 조합에 캘리브레이션 레코드가 없으면 실행을 거부함.
- **영향 범위:** D5, D16, Jev 질문 템플릿, receipt. 중간.
- **장점:** 게이트 수치에 실측 근거가 생김. 모델이 바뀔 때 다시 재는 절차가 생김.
- **단점/비용:** 라벨링 수작업. API 비용은 미미함($0.042/Mtok).
- **노력:** M
- **우선순위:** P0
- **무시할 때 위험:** 게이트가 느슨하면 틀린 요소를 탭함(fail-open). 빡빡하면 CI가 inconclusive로 가득 참.

### S-2 모든 mutation에 사후 효과 검증 + actionStatus

- **근거:**
  - 가려진 "항공편 바꾸기"를 탭했는데 명령은 성공으로 끝남(design.md:18).
  - Convoy는 드라이버 명령이 리턴하면 바로 pass 처리함(ConvoyBridge.md:158).
  - jevsim은 스텝마다 `expect`가 필수이고, `in_flight→uncertain` 상태가 있으며 재실행하지 않음(CrossQA.md:181-186).
  - openclaw는 쓰기 오류를 `WDAOutcomeUnknown`으로 두고 재생하지 않음(IOSAgents.md:232).
- **제안:**
  - tap/type/swipe/back 뒤 기본 postcondition은 `changed`: settle 창 안에서 identity 지문이 바뀌어야 함.
  - 스펙에 `expect:`가 있으면 그걸로 대체. `expectNoChange: true`로 명시적으로 끌 수 있음.
  - 드라이버를 호출하기 전에 intent를 journal에 기록(Friedjof MutationJournal).
  - 타임아웃·연결 끊김은 `uncertain` → 테스트 결과 `error`, 자동 재시도 없음.
- **영향 범위:** D7, D8, D12, D13, runner 상태기계. 중간.
- **장점:** 가려진 탭, 무반응 탭을 그 자리에서 잡음.
- **단점/비용:** 정당하게 변화가 없는 동작에는 스펙 주석이 필요함. 스텝마다 settle 창만큼 느려짐.
- **노력:** M
- **우선순위:** P0
- **무시할 때 위험:** 엉뚱한 요소를 누르고도 PASS로 진행함. 이후 스텝이 다른 화면에서 실행되고 위험 동작이 오발될 수 있음.

### S-3 occlusion을 다층 hit-test로

- **근거:**
  - 떠남 RN 시트 4겹이 모두 덤프에 들어 있었음(design.md:18).
  - jev-pilot: 나중에 그려진 요소를 기준으로 안 가린 밴드에 탭하고, 다 가려지면 `Obscured`로 거부(AndroidC.md:73).
  - jev-vphone: 라이브 hittest(IOSAgents.md:136).
  - jevium: `includeHittableInPageSource`(CrossAgents.md:308).
  - flick: 빈 라벨이면 hit 체크를 그냥 통과하는 버그(IOSAgents.md:71).
- **제안:**
  - **Android:** z순서 = (window layer, `drawing-order`, 없으면 문서순서). 뒤에 그려진 노드가 덮은 영역을 빼고 남은 영역이 최소 크기보다 작으면 `OCCLUDED`로 제외. 탭 좌표는 중심이 아니라 안 가린 영역의 중심.
  - **iOS:** freshness 단계에서 고른 대상 1개만 `hittable`을 조회하고 같은 기하 검사를 함.
  - 불일치하면 실패. 폴백 없음.
  - UIA2 source에 `drawing-order`가 있는지는 확실하지 않음. 실측 필요.
- **영향 범위:** D4, D7, 정규화 모듈, fixture. 중간.
- **장점:** 떠남 사건 재발을 막음. 앱과 무관하게 동작.
- **단점/비용:** 터치가 통과하는 투명 오버레이를 가림으로 오판할 수 있음. 실패 방향 오판이라 허용 가능.
- **노력:** M
- **우선순위:** P0
- **무시할 때 위험:** RN/Flutter 모달이 있는 앱에서 뒤 요소를 계속 누름.

### S-4 위험 정책 구멍 막기

- **근거:**
  - "내 항공편 지우기"가 실제로 있음(design.md:25).
  - `tapAt`은 라벨이 없음(D11).
  - jev-pilot `commits` Noul: 비커밋 <0.11, 커밋 ≥0.73(AndroidC.md:92).
  - flick, Friedjof, jev-sim-use 단어 목록에는 한국어가 없음.
  - phone-use는 `\b` 단어 경계를 씀(CrossAgents.md:106).
- **제안:**
  1. 판정 입력을 대상 라벨 + 화면 문맥(다이얼로그 제목·본문)으로 확장. "삭제하시겠습니까?" 다이얼로그의 "확인"도 위험으로 봄.
  2. 라벨 없는 대상(`tapAt`, OCR, 아이콘 전용)은 "위험 미상"으로 보고 `allowRisky`가 없으면 거부.
  3. Jev `commits` Noul은 거부를 추가할 때만 씀.
  4. 단어 추가: 공유, 보내기, 전송, 신고, 차단, 구독, 해지, 권한 허용, 전화. 영어 단어는 단어 경계로 검사.
- **영향 범위:** D10, D11, D17, 앱 프로필. 작음.
- **장점:** 블랙박스 앱의 데이터를 보호함.
- **단점/비용:** `allowRisky` 남용 가능성. 리포트에 눈에 띄게 표시할 것.
- **노력:** S
- **우선순위:** P0
- **무시할 때 위험:** 스모크나 `tapAt` 스텝이 사용자 데이터를 삭제함.

### S-5 D7 텍스트 입력 폴백 재정의

- **근거:**
  - Android는 setValue로 `배터리` 입력에 성공했지만, onChange가 발화했는지는 기록이 없음(design.md:16).
  - iOS는 pbcopy가 즉시 덮어써지고, `/wda/keys`로는 RN onChange까지 확인됨(design.md:20-21).
  - AX set-value는 IME 이벤트를 우회함(IOSAgents.md:384).
  - ACTION_SET_TEXT로 텍스트가 보여도 저장이 안 되는 앱이 있음(Friedjof, AndroidA.md:182).
  - 정확 일치 read-back은 포맷이 바뀌는 필드를 잘못 거부함(dougsong, AndroidA.md:310).
- **제안:**
  - **iOS:** setValue → read-back → 값이 그대로면 focus + clear + `/wda/keys`. clipboard 경로는 삭제.
  - **Android:** setValue → read-back → 값이 그대로면 Appium clipboard + `KEYCODE_PASTE`(droidjev 방식).
  - 값이 조금이라도 바뀌었으면 폴백 금지, `INPUT_UNVERIFIED`로 실패.
  - 비교는 NFC와 공백을 정규화해서. secure 필드는 길이만 비교.
- **영향 범위:** D7, 드라이버 어댑터. 작음.
- **장점:** 실측으로 확인된 경로만 씀.
- **단점/비용:** 마스킹 필드용 정규화 옵션이 필요함.
- **노력:** S
- **우선순위:** P0
- **무시할 때 위험:** 폴백이 조용히 실패하거나, 부분 입력 위에 다시 입력해 텍스트가 중복됨.

### S-6 블랙박스 앱 바이너리 백업과 디바이스 락

- **근거:**
  - 소스 없는 블랙박스 앱이고(design.md:7), D7에 reset `clear|reinstall`이 있음.
  - 떠남 .apk/.app을 가지고 있는지는 design.md에 없음. 확실하지 않음.
  - 참고할 락 구현: artemis 죽은 소유자 감지 락(Artemis.md:261-265), Krilin `flock`(AndroidB.md:285).
- **제안:**
  - `qa setup`에서 설치본을 먼저 확보: Android는 `pm path` + `adb pull`, iOS는 `simctl get_app_container`로 복사해서 `.qa/apps/<id>/<sha256>`에 저장.
  - 바이너리가 없으면 `clear|reinstall`을 금지.
  - 디바이스별 락: pid + 프로세스 시작시각.
- **영향 범위:** D7, D13, D14. 작음.
- **장점:** 되돌릴 수 없는 초기화를 막음.
- **단점/비용:** 디스크 사용.
- **노력:** S
- **우선순위:** P0
- **무시할 때 위험:** 첫 E2E에서 떠남을 다시 설치할 수 없게 되거나 데이터가 영구 손실됨.

### S-7 iOS 읽기 경로와 스텝 지연 예산

- **근거:**
  - Appium 경유 `/source` 1.1s, WDA 직접 0.3–0.5s(design.md:21-22).
  - idb axbridge 웜 33ms(IOSAgents.md:118).
  - openclaw는 `waitForIdleTimeout:0`, `animationCoolOffTimeout:0`, `excluded_attributes`를 씀(IOSAgents.md:198-203).
  - droidjev와 jevsim은 settle의 마지막 스냅샷을 다음 스텝 입력으로 재사용함.
- **제안:**
  - iOS 세션에 위 설정들을 적용.
  - `/source`를 세 경로(Appium 경유 / WDA 포트 직접 / 속성 제외)로 실측 비교.
  - settle 마지막 스냅샷 = 다음 observe.
  - freshness는 전체 트리 대신 대상 요소 속성만 다시 조회.
  - 스텝별 phase timing을 receipt에 기록.
- **영향 범위:** D2, D8, 드라이버 계층. 중간.
- **장점:** 추정 ~5s/스텝(1.1 + ≥2.2 + 1.1 + 0.69)을 크게 줄일 것으로 기대함(추정).
- **단점/비용:** WDA를 직접 부르면 Appium 세션 상태와 어긋날 수 있음.
- **노력:** M
- **우선순위:** P1
- **무시할 때 위험:** 타임아웃으로 flaky해지고, 느려서 아무도 안 씀.

### S-8 settle 재정의: 변화 → 안정, 이중 지문, 타임아웃 의미

- **근거:**
  - Friedjof: 변화가 먼저 있어야 하고, 그 뒤 ≥250ms 동일해야 함, 최대 5s(AndroidA.md:139-140).
  - jev-sim-use: identity/layout 이중 지문, 무변화면 2s 대기(CrossAgents.md:156-160).
  - flick: 타임아웃 때 마지막 읽기를 그냥 반환함(fail-open, IOSAgents.md:19).
  - artemis dHash: 같은 화면 ≤4, 다른 화면 ≥7(Artemis.md:59).
- **제안:**
  - 순서: 변화 감지(≤2s) → identity와 layout이 모두 N회 안정.
  - 캔버스처럼 트리가 안 바뀌는 앱은 dHash로 보조.
  - 타임아웃이면 스텝 실패가 아니라 `settled:false`를 기록. 이후에는 대상 의미를 비교하는 freshness가 보호함.
  - 폴링 값은 플랫폼별로 따로 둠.
- **영향 범위:** D8, S-2. 중간.
- **장점:** RN의 늦은 전환과 시계 노이즈를 둘 다 처리함.
- **단점/비용:** 구현이 복잡해짐.
- **노력:** M
- **우선순위:** P1
- **무시할 때 위험:** 옛 화면에 남은 같은 라벨을 다시 누름(ConvoyBridge.md:35).

### S-9 스펙 문법: 범위 지정, 인터럽트 핸들러, 결정적 부재 검사

- **근거:**
  - nier의 유일성 필터 때문에 반복되는 "Add" 버튼에 도달할 수 없음(AndroidB.md:606).
  - Krilin은 다중 매치면 실패시킴(AndroidB.md:271).
  - jev-ios-bridge는 guard `present`/`absent`를 씀(ConvoyBridge.md:276).
  - Convoy `see.not`은 단일 스냅샷(ConvoyBridge.md:160).
- **제안:**
  - 타깃 지정: `within`, `nth`, `near`.
  - `see.not`은 결정적(텍스트·OCR)으로 settle 후 `holdMs` 동안 부재가 유지되는지 봄. Jev는 안 씀.
  - 스텝 `timeout`, `optional` 추가.
  - 전역 `when: {see: ...} → do:`로 권한·업데이트·온보딩 팝업 처리.
- **영향 범위:** D13, D4, D6, D5. 중간.
- **장점:** 목록 UI를 다룰 수 있고, 팝업으로 인한 flaky가 줄어듦.
- **단점/비용:** 문법이 커짐.
- **노력:** M
- **우선순위:** P1
- **무시할 때 위험:** ambiguous 실패가 연달아 나고, 팝업에서 멈춤.

### S-10 health watchdog 오탐 줄이기와 로그 증거

- **근거:**
  - 간헐 `Render Error` 실측(design.md:24).
  - "Log 1 of"는 경고 토스트에도 뜸(research 밖 RN 지식).
  - artemis는 시간창 logcat을 씀(Artemis.md:69).
- **제안:**
  - LogBox를 둘로 나눔: 전체화면 에러는 FAIL, 접힌 경고 토스트는 WARN으로 두고 occluder로 등록.
  - 앱 프로필에 `build: dev|release`를 기록.
  - 테스트 시작과 함께 로그 스트림 시작(Android는 pid 필터 logcat, iOS는 simulator log). 실패 스텝 전후 시간창을 첨부.
- **영향 범위:** D9, D12. 중간.
- **장점:** 간헐 크래시의 증거를 확보하고, 경고 오탐이 사라짐.
- **단점/비용:** 로그 용량.
- **노력:** M
- **우선순위:** P1
- **무시할 때 위험:** 경고마다 FAIL이 나서 신뢰를 잃거나, 크래시 원인을 모름.

### S-11 D17 스모크 축소

- **근거:**
  - §5에서 자율 탐색을 제외함.
  - 부재·빈 상태 claim은 0.78–0.80으로 약함.
  - jev-hands에서 진입 페이지를 완료로 오판했음(AndroidC.md:447).
- **제안:**
  - v1 `qa smoke` 흐름: launch → health → 결정적 빈 화면 검사(가시 라벨 수, 스크린샷 단색 비율).
  - 순회는 역할로 식별되는 탭바만(iOS TabBar, Android는 artemis §2.1 규칙).
  - Jev Noul은 참고 컬럼으로만 두고 PASS/FAIL에 영향 없음.
- **영향 범위:** D17, D10. 작음.
- **장점:** 안전하고 결정적임.
- **단점/비용:** 커버리지가 작음.
- **노력:** S
- **우선순위:** P1
- **무시할 때 위험:** 데이터가 바뀌고, 가짜 FAIL/PASS가 나옴.

### S-12 Jev 클라이언트·receipt 강화와 데이터 반출 통제

- **근거:**
  - JS SDK: 총 예산이 없고, debug 레벨에서 본문을 마스킹 없이 로그로 남김(TypeSafeAPI.md:230-232, 278).
  - 서버는 US에 있고 ZDR은 엔터프라이즈만 제공(TypeSafeAPI.md:22).
  - Convoy는 trace가 합성·누락되는 함정이 있음.
- **제안:**
  - 타임아웃: 시도당 3s, 총 8s.
  - 재시도는 408/429/5xx/529만. 422는 바로 error.
  - receipt에 request-id와 `decision_source`를 기록.
  - 앱 프로필에 `redact` 패턴(전화, 이메일, 예약번호)을 두고 state 전송 전에 적용.
- **영향 범위:** D5, D12, D15. 작음.
- **장점:** 행(hang)이 사라지고, 감사할 수 있고, 개인정보 반출을 통제함.
- **단점/비용:** 마스킹이 grounding을 떨어뜨릴 수 있음. S-1 캘리브레이션에 포함해서 측정.
- **노력:** S
- **우선순위:** P1
- **무시할 때 위험:** 30s 행, 증거 누락, 개인정보가 해외로 전송됨.

## C. 구현 착수 전 반드시 할 3가지

1. **한국어 골든셋 캘리브레이션(S-1).** 떠남 dump로 라벨 세트를 만들고, 통과 기준을 사전등록하고, 질문 문구 v1을 동결한 뒤 `jev-1.13.0`로 한 번 측정함. D5 수치는 이 결과로만 확정.
2. **반나절 실측 스파이크 3개.**
   - (a) iOS `/source` 경로별 시간과 대상 `hittable` 조회 비용, `waitForIdleTimeout:0` 적용 후.
   - (b) UIA2 source에 `drawing-order`가 있는지, 그리고 4겹 시트 fixture로 occlusion 알고리즘 검증.
   - (c) Android setValue 뒤 떠남 검색 결과가 실제로 뜨는지(RN onChange).

   이 결과로 D2, D4, D7, D8을 확정함.
3. **안전 선행 작업.**
   - 떠남 바이너리 백업(S-6).
   - 위험 정책 v1(S-4).
   - 스텝/액션 상태기계 계약을 1페이지로 문서화: pass/fail/inconclusive/error, action `uncertain`, 재시도 금지 규칙(S-2).

   코드는 이 세 가지를 끝낸 뒤에 시작.