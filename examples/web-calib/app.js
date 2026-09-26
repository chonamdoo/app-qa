// Calibration corpus behaviour only: nothing leaves the page. Buttons change visible UI state or a status line so the
// pages behave like the real screens they imitate; commits (order, post, subscribe…) are simulated by a status message.
const status = (text) => {
  const el = document.querySelector('[role="status"]');
  if (el) el.textContent = text;
};

for (const btn of document.querySelectorAll('[data-open]')) {
  btn.addEventListener('click', () => { document.getElementById(btn.dataset.open).hidden = false; });
}
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => { btn.closest('.modal').hidden = true; });
}
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of tab.parentElement.querySelectorAll('[role="tab"]')) {
      t.setAttribute('aria-selected', String(t === tab));
      document.getElementById(t.getAttribute('aria-controls')).hidden = t !== tab;
    }
  });
}
for (const btn of document.querySelectorAll('[aria-expanded][aria-controls]')) {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    document.getElementById(btn.getAttribute('aria-controls')).hidden = !open;
  });
}
for (const sw of document.querySelectorAll('[role="switch"]')) {
  sw.addEventListener('click', () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')));
}
for (const group of document.querySelectorAll('[data-pressed-group]')) {
  for (const btn of group.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    });
  }
}
for (const btn of document.querySelectorAll('[data-step]')) {
  btn.addEventListener('click', () => {
    const out = document.getElementById(btn.dataset.target);
    out.textContent = String(Math.max(1, Number(out.textContent) + Number(btn.dataset.step)));
  });
}
for (const btn of document.querySelectorAll('[data-status]')) {
  btn.addEventListener('click', () => status(btn.dataset.status));
}
for (const form of document.querySelectorAll('form[data-done]')) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    status(form.dataset.done);
  });
}
for (const btn of document.querySelectorAll('.cookie button')) {
  btn.addEventListener('click', () => {
    localStorage.setItem('cookie-consent', btn.dataset.consent);
    btn.closest('.cookie').hidden = true;
  });
}
