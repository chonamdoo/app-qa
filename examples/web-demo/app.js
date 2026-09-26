// Demo behaviour only: nothing leaves the page. Every state change is visible text so tests can assert it.
const $ = (id) => document.getElementById(id);

if ($('search')) {
  const items = [...document.querySelectorAll('#products li')];
  const search = () => {
    const q = $('query').value.trim();
    let shown = 0;
    for (const li of items) {
      li.hidden = q !== '' && !li.dataset.name.includes(q);
      if (!li.hidden) shown++;
    }
    $('result-count').textContent = shown ? `상품 ${shown}개` : '검색 결과 없음';
  };
  $('search').addEventListener('click', search);
  $('query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) search();
  });

  let cart = 0;
  for (const btn of document.querySelectorAll('.add')) {
    btn.addEventListener('click', () => {
      cart++;
      $('cart').textContent = `장바구니 ${cart}개`;
    });
  }

  $('help-open').addEventListener('click', () => { $('help').hidden = false; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('order').addEventListener('click', () => { $('cart').textContent = cart ? `주문 완료: ${cart}개` : '장바구니가 비어 있음'; });
}

if ($('login-form')) {
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    const ok = /^[^@\s]+@[^@\s]+$/.test(email) && $('password').value.length >= 4;
    $('login-status').textContent = ok ? `환영합니다, ${email}` : '이메일 또는 비밀번호를 확인하세요';
  });
}
