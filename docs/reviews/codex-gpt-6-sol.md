## A. 결정별 판정

D1 | 동의 | Node 24는 프로젝트 환경과 맞고, TypeSafe JS SDK는 Node ≥20을 지원한다([design.md:6](/tmp/app-qa-review/design.md:6), [TypeSafeAPI.md:265](/tmp/app-qa-review/research/TypeSafeAPI.md:265)).  
D2 | 수정 | 로컬 Appium 단일 실행 계층은 타당하다. 다만 iOS 한글 입력에 검증된 WDA 명령과 Appium 설정 명령까지 클라이언트 계약에 넣어야 한다([design.md:21](/tmp/app-qa-review/design.md:21), [IOSAgents.md:375](/tmp/app-qa-review/research/IOSAgents.md:375)).  
D3 | 동의 | 자율 다음 행동 선택은 20건 중 게이트 통과가 10건이었다. 작성된 스텝에 Jev 판단을 한정하는 편이 근거에 맞다([ConvoyBridge.md:226](/tmp/app-qa-review/research/ConvoyBridge.md:226)).  
D4 | 수정 | 떠남의 가려진 바텀시트 4겹은 문서순서만으로 안전하게 판정할 수 없다. `none`을 포함한 Choice의 후보 상한도 255개가 아니라 **254개**다([design.md:18](/tmp/app-qa-review/design.md:18), [TypeSafeAPI.md:239](/tmp/app-qa-review/research/TypeSafeAPI.md:239)).  
D5 | 수정 | 0.75/0.10/0.20은 미보정 초기값이다. 48개 assertion 평가에서도 3개가 불확실했고, 한국어 정확도 수치는 없다. 응답 모델·질문 키 검증과 스텝별 게이트 보정이 필요하다([ConvoyBridge.md:239](/tmp/app-qa-review/research/ConvoyBridge.md:239), [TypeSafeAPI.md:260](/tmp/app-qa-review/research/TypeSafeAPI.md:260)).  
D6 | 수정 | 라벨이 유일해도 가림·비활성·다른 창의 요소일 수 있다. 한국어 NFC 일치 후에도 실행 가능성과 타점 검사를 통과해야 한다([design.md:18](/tmp/app-qa-review/design.md:18), [ConvoyBridge.md:50](/tmp/app-qa-review/research/ConvoyBridge.md:50)).  
D7 | 수정 | 떠남에서 Android `setValue`와 iOS WDA 한글 입력은 성공했다. 반면 iOS 27의 클립보드 붙여넣기는 실패했다. 타임아웃 난 변경 명령의 결과도 `uncertain`으로 남겨 재실행을 막아야 한다([design.md:16](/tmp/app-qa-review/design.md:16), [design.md:20](/tmp/app-qa-review/design.md:20), [CrossQA.md:186](/tmp/app-qa-review/research/CrossQA.md:186)).  
D8 | 수정 | 2회 동일 화면은 *행동 전 화면*이 그대로인 경우도 통과시킨다. 화면 변화 또는 명시된 사후 조건을 기다리고, 시간 초과는 안정으로 취급하지 않아야 한다([AndroidA.md:139](/tmp/app-qa-review/research/AndroidA.md:139), [AndroidC.md:112](/tmp/app-qa-review/research/AndroidC.md:112)).  
D9 | 수정 | RN LogBox는 떠남에서 실제 관측됐다. 다만 문자열 패턴만으로 모든 앱의 결함을 판정할 수 없으므로 앱 결함, 도구 오류, 관측 불가를 구분해야 한다([design.md:24](/tmp/app-qa-review/design.md:24), [design.md:64](/tmp/app-qa-review/design.md:64)).  
D10 | 수정 | 떠남의 “내 항공편 지우기”는 차단 대상이다. 키워드만으로는 라벨 없는 버튼이나 “확인” 버튼의 효과를 알 수 없으므로 안전 행동 허용 목록과 다이얼로그 문맥 검사가 필요하다([design.md:25](/tmp/app-qa-review/design.md:25), [Artemis.md:95](/tmp/app-qa-review/research/Artemis.md:95)).  
D11 | 반대 | OCR만 있는 v1은 아이콘·캔버스·게임 UI를 조작할 근거가 없다. 아이콘 대응을 v2로 미루면 “어떤 모바일 앱이든”이라는 전제를 충족하지 못한다([design.md:4](/tmp/app-qa-review/design.md:4), [IOSAgents.md:398](/tmp/app-qa-review/research/IOSAgents.md:398)).  
D12 | 수정 | 필드 값 마스킹만으로는 스크린샷·OCR·Jev 요청에 남는 개인정보를 막지 못한다. receipt에는 요청 ID와 행동 결과 상태도 필요하다([ConvoyBridge.md:187](/tmp/app-qa-review/research/ConvoyBridge.md:187), [TypeSafeAPI.md:19](/tmp/app-qa-review/research/TypeSafeAPI.md:19)).  
D13 | 수정 | `see.not`과 선택적 `expect`만으로는 행동 후 성공을 입증하기 어렵다. 각 변경 스텝에 관찰 가능한 사후 조건을 지정하고, 부재 판정의 화면 범위를 명시해야 한다([CrossQA.md:179](/tmp/app-qa-review/research/CrossQA.md:179), [Artemis.md:210](/tmp/app-qa-review/research/Artemis.md:210)).  
D14 | 동의 | 로컬 설치·진단·검사·실행 CLI 구성은 적절하다. 프로젝트 로컬 npm 설치 사례도 있다([design.md:69](/tmp/app-qa-review/design.md:69), [CrossQA.md:15](/tmp/app-qa-review/research/CrossQA.md:15)).  
D15 | 수정 | `TYPESAFE_API_KEY_FILE`은 JS SDK의 기본 환경변수가 아니다. CLI가 파일을 직접 읽는 계약과 로그 비노출 규칙을 명시해야 한다([TypeSafeAPI.md:267](/tmp/app-qa-review/research/TypeSafeAPI.md:267)).  
D16 | 수정 | 떠남 덤프는 중요한 회귀 fixture지만, 한 앱만으로 WebView·Flutter·커스텀 드로잉의 범용성을 검증할 수 없다([design.md:7](/tmp/app-qa-review/design.md:7), [design.md:71](/tmp/app-qa-review/design.md:71)).  
D17 | 반대 | 키워드로 걸러낸 탭바·내비 요소도 앱 밖 이동이나 상태 변경을 일으킬 수 있다. 무작성 스모크의 기본 행동은 관찰로 제한하고, 크롤은 명시된 안전 행동만 실행해야 한다([design.md:72](/tmp/app-qa-review/design.md:72), [AndroidA.md:194](/tmp/app-qa-review/research/AndroidA.md:194)).

## B. 제안 (중요도 순)

### S-1 범용 시각 관측 경로를 v1에 포함
- 근거: 현재 D11은 아이콘 대응을 v2로 미룬다. `GUI_JEV`의 정적 ScreenSpot 12건 결과는 9/12였고, 아이콘은 3/6이었다([design.md:66](/tmp/app-qa-review/design.md:66), [AndroidD.md:376](/tmp/app-qa-review/research/AndroidD.md:376)).
- 제안: 양쪽 플랫폼 스크린샷에 로컬 OCR과 영역 묘사를 적용해 **텍스트 후보**를 만든다. 시각 모델은 목표를 모른 채 화면만 묘사하고, 선택은 Jev Choice가 맡는다. 박스와 새 스크린샷을 재확인할 수 없으면 `unsupported/inconclusive`로 종료한다. 한국어 OCR 품질은 실측한다.
- 영향 범위: D11·D17, 관측기·후보 생성기·`qa inspect`·스모크·receipt; 파급 반경 **큼**.
- 장점: 접근성 트리가 빈 앱에도 근거 있는 경로가 생긴다.
- 단점/비용: 시각 처리 비용이 크고 아이콘 오인 가능성이 남는다.
- 노력: L
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 범용 플랫폼을 표방하면서 해당 UI를 실제로는 검사하지 못한다.

### S-2 창·가림·타점 검증을 실행 게이트로 분리
- 근거: 떠남 Android에서 4겹 시트의 가려진 “항공편 바꾸기”가 덤프에 남아 오탭됐다. `agent-device`는 창 정보와 `drawing-order`를 수집한다([design.md:18](/tmp/app-qa-review/design.md:18), [CrossQA.md:452](/tmp/app-qa-review/research/CrossQA.md:452)).
- 제안: `visible/enabled/hittable`, 창 레이어, 조상 클리핑을 먼저 평가한다. 행동 직전 새 관측의 타점에서 최상단 대상이 같은지 확인한다. 순서를 알 수 없는 겹침은 거부한다. 후보는 `none` 자리 하나를 남겨 최대 254개로 제한한다.
- 영향 범위: D4·D6·D7, Android/iOS 정규화·freshness·선택 결과; 파급 반경 **큼**.
- 장점: 가려진 요소와 잘못된 중심 좌표를 실행 전에 막는다.
- 단점/비용: 일부 실제 클릭 가능한 복합 컨트롤이 불확실로 분류된다.
- 노력: L
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 떠남에서 이미 확인한 오탭이 재발한다.

### S-3 무작성 스모크의 행동 권한을 명시적으로 제한
- 근거: 떠남에 삭제 버튼이 있고, Artemis의 라벨 없는 아이콘은 인덱스조차 받지 못한다([design.md:25](/tmp/app-qa-review/design.md:25), [Artemis.md:95](/tmp/app-qa-review/research/Artemis.md:95)).
- 제안: 기본 `qa smoke`는 실행·관찰·크래시 감지만 한다. 탐색은 앱 프로필의 안전 요소 허용 목록과 실행 예산이 있을 때만 켠다. 키워드 검사는 추가 차단 장치로 쓰고, 확인 다이얼로그·외부 앱 이동·알 수 없는 아이콘에서는 멈춘다.
- 영향 범위: D10·D17, 정책 엔진·앱 프로필·`qa smoke` 워크플로·보고서; 파급 반경 **큼**.
- 장점: 앱 무관 실행에서 예측 못 한 변경을 줄인다.
- 단점/비용: 프로필 없는 앱의 탐색 범위는 작다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: “안전한” 자동 크롤이 삭제·구매·외부 이동을 실행할 수 있다.

### S-4 Jev 응답 계약과 게이트를 화면별로 보정
- 근거: Choice 최대 255옵션, 응답 모델과 확률 분포 검증이 필요하다. Jev assertion 실험은 48개 중 3개가 불확실했고, 부재 claim의 참 확률은 0.78–0.80이었다([TypeSafeAPI.md:239](/tmp/app-qa-review/research/TypeSafeAPI.md:239), [ConvoyBridge.md:239](/tmp/app-qa-review/research/ConvoyBridge.md:239)).
- 제안: 모델 ID, 답변 키 집합, 타입, 유한 확률, 합, argmax를 검증한다. `tap/type`, `see`, `which`, 부재 assertion의 게이트를 따로 보정한다. `none≥0.10`만으로 `not_found`라 하지 말고 `ambiguous`와 구분한다. 재시도는 재시도 가능한 HTTP 오류와 남은 시간 예산에 한정한다.
- 영향 범위: D3·D5·D16, Jev 어댑터·판정기·캘리브레이션 fixture; 파급 반경 **중간**.
- 장점: 잘못된 응답과 임의 임계값이 행동으로 이어지지 않는다.
- 단점/비용: 라벨링과 임계값 유지가 필요하다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 한국어 화면에서 오탭 또는 불필요한 실패율을 알 수 없다.

### S-5 행동 성공과 앱 결함의 증거를 분리
- 근거: `jevsim`은 각 스텝에 결정적 `expect`를 요구하고, 행동 상태를 `not_started/in_flight/completed/uncertain`으로 기록한다. Artemis는 실행이 확인되지 않은 assertion 실패를 결함으로 돌리지 않는다([CrossQA.md:181](/tmp/app-qa-review/research/CrossQA.md:181), [CrossQA.md:186](/tmp/app-qa-review/research/CrossQA.md:186), [Artemis.md:210](/tmp/app-qa-review/research/Artemis.md:210)).
- 제안: 변경 스텝마다 사후 조건 또는 명시적 `allowNoVisibleChange`를 요구한다. 최종 결과를 `PASS/FAIL/INCONCLUSIVE/ERROR`로 나누고, 앱 결함 `FAIL`에는 행동 승인과 화면·로그 증거를 연결한다. `see.not`은 지정된 화면 범위를 안정적으로 관찰한 뒤 판정한다.
- 영향 범위: D9·D12·D13·D17, 스펙 파서·검증기·JUnit/HTML·사용자 작성 흐름; 파급 반경 **큼**.
- 장점: 도구 실패와 실제 앱 결함을 구별할 수 있다.
- 단점/비용: 테스트 작성자가 사후 조건을 더 적어야 한다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 명령 전송만으로 성공하거나 관측 실패를 앱 결함으로 보고한다.

### S-6 한글 입력과 불확실한 변경 결과를 플랫폼별로 규정
- 근거: 떠남에서 Android `배터리`, iOS WDA `대한항공` 입력과 검색 결과가 확인됐다. iOS 27 클립보드 붙여넣기는 실패했다([design.md:16](/tmp/app-qa-review/design.md:16), [design.md:20](/tmp/app-qa-review/design.md:20), [design.md:21](/tmp/app-qa-review/design.md:21)).
- 제안: Android는 Appium `setValue`, iOS는 WDA 키 입력을 기본 경로로 둔다. 값 재읽기와 앱 반응을 모두 확인한다. iOS 클립보드 fallback은 제거한다. 탭·입력·reset은 호출 전 intent를 기록하고, 타임아웃이면 `uncertain`으로 종료해 자동 재실행하지 않는다.
- 영향 범위: D2·D7·D12, 실행 어댑터·입력 스텝·receipt; 파급 반경 **중간**.
- 장점: 검증된 한글 경로를 쓰고 중복 변경을 막는다.
- 단점/비용: 불확실한 결과에는 사람이 상태를 확인해야 한다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 한글이 화면에만 보이거나 타임아웃 뒤 중복 입력될 수 있다.

### S-7 settle을 행동 효과와 연결
- 근거: 기존 화면의 fingerprint도 2회 연속 같을 수 있다. `jev-pilot`은 행동 전과 다른 화면의 일치 관측을 요구하며, 떠남의 iOS 오류는 간헐적으로 나타났다([AndroidC.md:112](/tmp/app-qa-review/research/AndroidC.md:112), [design.md:24](/tmp/app-qa-review/design.md:24)).
- 제안: 행동 종류별로 변화 또는 사후 조건을 기다린다. 로딩 표시·모달·포그라운드 앱을 fingerprint와 함께 확인하고, 제한 시간 안에 증거가 없으면 `inconclusive`로 끝낸다. 변화가 없어도 정상인 행동은 스펙의 명시적 조건으로 처리한다.
- 영향 범위: D8·D9·D13, settle·health watchdog·대기 스텝; 파급 반경 **중간**.
- 장점: 전환 도중 다음 버튼을 누르는 일을 줄인다.
- 단점/비용: 느린 화면에서 실행 시간이 늘어난다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 이전 화면을 “안정”으로 오인해 뒤 스텝이 잘못 실행된다.

### S-8 receipt의 개인정보·비용·재현 계약 확정
- 근거: Convoy의 `elements.json`에는 필드 값이 저장됐다. Jev SDK의 debug 로그는 본문을 마스킹하지 않으며, 스크린샷에도 비밀값이 보일 수 있다([ConvoyBridge.md:183](/tmp/app-qa-review/research/ConvoyBridge.md:183), [TypeSafeAPI.md:278](/tmp/app-qa-review/research/TypeSafeAPI.md:278), [CrossAgents.md:423](/tmp/app-qa-review/research/CrossAgents.md:423)).
- 제안: Jev 전송값·OCR·트리·이미지의 민감정보 처리 규칙을 먼저 정한다. 가릴 수 없는 민감 화면은 저장과 전송을 중단한다. receipt에는 모델·질문 버전·request ID·관측 해시·행동 상태·입력 토큰을 남기고, 비용은 적용 단가와 함께 계산한다. 키 파일은 CLI가 읽고 값은 로그에 쓰지 않는다.
- 영향 범위: D12·D15, Jev 어댑터·이미지 저장·리포트·`qa setup`; 파급 반경 **큼**.
- 장점: 사고 조사에 필요한 근거를 남기면서 노출 범위를 통제한다.
- 단점/비용: 일부 화면의 증거 보존이 제한된다.
- 노력: M
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 로컬 산출물이나 외부 Jev 요청에 개인정보가 그대로 남는다.

### S-9 떠남 외 범용성·실패 fixture를 착수 기준으로 지정
- 근거: 현재 로컬 수치는 떠남 Android 124노드와 iOS 한글 검색 중심이다. 접근성 없는 Flutter·Unity·Metal 화면은 트리가 비어 있을 수 있다([design.md:14](/tmp/app-qa-review/design.md:14), [design.md:21](/tmp/app-qa-review/design.md:21), [IOSAgents.md:398](/tmp/app-qa-review/research/IOSAgents.md:398)).
- 제안: 떠남의 4겹 시트·LogBox·한글 입력에 더해 WebView, 빈 접근성 트리, 아이콘, 중복 라벨, 권한 팝업, 타임아웃, 민감 화면의 양·음성 fixture를 확보한다. Android/iOS 각각 오탭·거짓 PASS·거짓 FAIL·`inconclusive` 비율을 기록해 D5 임계값을 확정한다.
- 영향 범위: D4·D5·D9·D11·D16, fixture·캘리브레이션 결과·릴리스 기준; 파급 반경 **중간**.
- 장점: “어떤 앱이든”의 실제 한계와 실패율을 볼 수 있다.
- 단점/비용: 화면 수집과 수동 정답 표기가 필요하다.
- 노력: L
- 우선순위: P0(구현 전 반드시)
- 무시할 때 위험: 떠남에서만 통과하는 설계를 범용 플랫폼으로 오판한다.

### S-10 로컬 실행의 소유권과 예산을 CLI 계약에 추가
- 근거: Artemis는 디바이스별 락을 쓰고, 무제한에 가까운 반복을 문제로 기록했다. JS SDK 기본 재시도는 총 시간 예산 없이 약 31.5초까지 늘 수 있다([Artemis.md:261](/tmp/app-qa-review/research/Artemis.md:261), [Artemis.md:305](/tmp/app-qa-review/research/Artemis.md:305), [TypeSafeAPI.md:228](/tmp/app-qa-review/research/TypeSafeAPI.md:228)).
- 제안: `qa doctor`가 프로젝트 로컬 도구 버전과 지정 디바이스를 확인하게 한다. `qa run/smoke`에는 디바이스 락, 스텝·시간·Jev 호출 예산, 종료 시락 해제 규칙을 둔다. 예산 초과는 PASS가 아닌 `inconclusive`로 보고한다.
- 영향 범위: D2·D14·D17, CLI·러너·요약 보고서·실행 워크플로; 파급 반경 **중간**.
- 장점: 중복 조작과 끝나지 않는 실행을 막는다.
- 단점/비용: 락과 종료 복구 구현이 필요하다.
- 노력: M
- 우선순위: P1(v1 포함)
- 무시할 때 위험: 두 실행이 같은 디바이스를 조작하거나 스모크 비용이 통제되지 않는다.

## C. 구현 착수 전 반드시 할 3가지

1. **설계 계약 수정:** D4 후보 상한 254개, 가림 판정, 행동 결과 상태, 스텝 사후 조건, 스모크 권한, v1 시각 관측 경로를 문서에 확정한다.
2. **검증 자료 확보:** 떠남 Android/iOS 실측 화면과 WebView·Flutter·커스텀 드로잉·위험 버튼 fixture에 정답을 표시하고, Jev 게이트의 허용 기준을 정한다.
3. **실행 경로 사전 검증:** 로컬 Appium에서 양 플랫폼의 관측→타점 확인→한글 입력→사후 조건→receipt를 한 번씩 측정한다. iOS 클립보드와 한국어 OCR은 성공을 가정하지 않는다.