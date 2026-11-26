(function () {
  'use strict';
  const U = window.QAUI;
  const N = U.n;
  const T = text => N('Text', {text, variant:'small'});
  const B = (label, action, variant) => N('Button', {label, action, variant:variant || ''});
  const descriptions = {A:'세로 단계 목록 · 가운데 Space · 오른쪽 검증 정보', B:'위쪽 Space와 검증 정보 · 아래쪽 가로 단계 목록', C:'왼쪽 검증 정보와 단계 · 오른쪽 넓은 Space'};
  const initialVariant = location.hash.slice(1).toUpperCase();
  const S = {variant:['A','B','C'].includes(initialVariant)?initialVariant:'A', state:'running'};
  function steps() {
    const items = [
      {title:'초기 상태 확인', detail:'테스트 계정 · 장바구니 fixture', status:'passed', label:'확인 완료 예시'},
      {title:'쿠폰 선택', detail:'3,000원 할인 쿠폰', status:'passed', label:'동작 완료 예시'},
      {title:'주문 요약 열기', detail:'같은 세션에서 상태 유지', status:'passed', label:'동작 완료 예시'},
      {title:'최종 금액 검증', detail:'주문 요약의 금액과 기대값 비교', status:S.state==='failed'?'failed':'running', label:S.state==='failed'?'불일치 예시':'검증 중 예시'}
    ];
    if (S.state === 'unknown') {
      items[2] = {...items[2], status:'unknown', label:'변경 결과 미확인'};
      items[3] = {...items[3], status:'blocked', label:'선행 결과 확인 필요'};
    }
    return items;
  }
  function render(focusId) {
    const stateText = S.state === 'running' ? '자동 실행 중 예시' : S.state === 'failed' ? '업무 불일치 · 실행 종료 예시' : '변경 결과 미확인 · 복구 필요 예시';
    const description = '2026년 11월 01일 10시 30분 05초 KST · 기본 순차 실행 · 샘플 시각';
    const content = [
      N('ExecutionHeading', {status:S.state, label:stateText, done:S.state==='failed'?4:S.state==='unknown'?2:3, description}),
      N('ExecutionToolbar', {state:S.state}),
      N('ExecutionLayout', {
        variant:S.variant,
        preview:N('SpacePreview', {status:S.state, timestamp:'10시 31분 24초 KST · 예시'}),
        steps:N('StepList', {items:steps()}),
        checks:N('CheckPanel', {status:S.state, evidence:S.state==='failed'?'저장 완료 예시':S.state==='unknown'?'수집 공백 있음 · 예시':'녹화 중 예시'})
      })
    ];
    U.mount('#qautra-root', N('DesignShell', {variant:S.variant, description:descriptions[S.variant]}, content));
    if (focusId) document.getElementById(focusId)?.focus();
  }
  function dialog(title, body, footer) {
    U.openDialog({title, footer:footer || [B('닫기', 'close-dialog')]}, body);
  }
  document.addEventListener('change', event => {
    if (event.target.id !== 'design-state') return;
    S.state = event.target.value;
    render('design-state');
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'variant') {
      S.variant = button.dataset.variant;
      history.replaceState(null, '', '#'+S.variant);
      render();
      document.querySelector('[data-action="variant"][data-variant="'+S.variant+'"]').focus();
    } else if (action === 'close-dialog') {
      U.closeDialog();
    } else if (action === 'conditions') {
      dialog('고정한 실행 조건 · 디자인 예시', [
        T('시나리오 r3 · 테스트 tenant · Chrome / Linux worker · 필수 검증 4개'),
        T('기대값과 단계는 실행 중 변경하지 않아요. 실제 브라우저 버전·fixture·권한은 연결 후 확인해야 해요.'),
        T('자동화 입력은 테스트 환경 내부로만 전달하는 설계예요. 이 시안은 호스트 입력 비간섭을 실증한 결과가 아니에요.')
      ]);
    } else if (action === 'primary' && S.state === 'running') {
      dialog('중지 후 정리 · 동작 설계', [
        T('새 입력 차단 → 진행 중 명령 효과 확인 → 영상 확정 및 소유 자원 정리 → 최종 상태 기록'),
        T('중지 버튼을 누른 즉시 안전하게 끝났다고 표시하지 않아요. 결과가 불명확하면 복구 필요 상태를 유지해요.'),
        N('Notice', {tone:'neutral', text:'구조 비교 시안이므로 실제 테스트나 중지 명령은 전송하지 않아요.'})
      ]);
    } else if (action === 'primary' && S.state === 'failed') {
      dialog('실패 증거 · 읽기 전용 설계', [
        T('기대 25,000원 / 관측 28,000원 · SC-006 r3 · attempt 01 예시'),
        N('Capture', {failed:true}),
        T('현재는 화면 배치 비교 단계이며 실제 녹화 파일은 없어요. 다음 화면 설계에서 영상 구간·불완전·만료 상태를 분리해요.')
      ]);
    } else if (action === 'primary') {
      dialog('복구 상태 확인 · 동작 설계', [
        N('Notice', {tone:'warning', text:'변경 결과를 확인하기 전에는 같은 동작을 재전송하거나 자원을 재사용하지 않아요.'}),
        T('이 버튼은 읽기 전용 확인이에요. 초기화·새 실행과 구분하고 원 unknown 이력은 유지해요.'),
        T('담당자: 프로젝트 환경 관리자 · 확인 대상: 진행 요청, backend 효과, 세션 종료, fixture 오염 범위. 디자인 예시이며 실제 조회하지 않아요.')
      ]);
    }
  });
  render();
})();
