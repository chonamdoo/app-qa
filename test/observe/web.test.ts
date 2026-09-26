import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import type { Candidate, Rect, ScreenModel } from '../../src/core/types.ts';
import { loadFixtureModel } from '../../src/jev/calibrate.ts';
import { buildScreenModel, parseWebSource, webSourceFromExtract } from '../../src/observe/index.ts';
import { runExtract } from './_dom.ts';
import { loadModel, loadSnapshot, snapshotOf } from './_fixtures.ts';

type ExtractNode = {
  parent: number;
  kind: string;
  name: string | null;
  text: string | null;
  id: string | null;
  value: string | null;
  hint: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  flags: string[];
};
type Extract = { url: string; title: string; width: number; height: number; dpr: number; scrollX: number; scrollY: number; truncated: boolean; nodes: ExtractNode[] };

const DESKTOP = 'desktop-chrome/web-demo';
const VIEWPORT: Rect = { x: 0, y: 0, width: 1280, height: 800 };

function realExtract(name: string): Extract {
  return JSON.parse(readFileSync(join(PATHS.fixtures, DESKTOP, `${name}.extract.json`), 'utf8')) as Extract;
}

function node(parent: number, kind: string, rect: [number, number, number, number], extra: Partial<ExtractNode> = {}): ExtractNode {
  const [x, y, w, h] = rect;
  return { parent, kind, name: null, text: null, id: null, value: null, hint: null, x, y, w, h, flags: ['enabled'], ...extra };
}

function extractOf(nodes: ExtractNode[]): Extract {
  return { url: 'http://localhost/', title: 't', width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, truncated: false, nodes };
}

function webModel(e: Extract): ScreenModel {
  const src = webSourceFromExtract(e);
  return buildScreenModel(snapshotOf('desktop-chrome', src.xml, src.screen, 'web', src.pageUrl));
}

const named = (m: ScreenModel, name: string): Candidate[] => m.candidates.filter((c) => c.name === name);
const one = (m: ScreenModel, name: string): Candidate => {
  const found = named(m, name).filter((c) => c.actionable);
  assert.equal(found.length, 1, `exactly one actionable "${name}": ${JSON.stringify(m.candidates.map((c) => c.name))}`);
  return found[0]!;
};

describe('webSourceFromExtract', () => {
  it('never writes a password value, even when the page script reported one', () => {
    const e = realExtract('login-email');
    const pw = e.nodes.find((n) => n.kind === 'password')!;
    pw.value = 'hunter2';
    pw.flags = pw.flags.filter((f) => f !== 'password');
    const { xml } = webSourceFromExtract(e);
    assert.ok(!xml.includes('hunter2'));
    assert.match(xml, /<node class="web:password"[^>]* value="•••••••"[^>]* password="true"/);
    const parsed = parseWebSource(xml, VIEWPORT).find((n) => n.className === 'web:password')!;
    assert.equal(parsed.flags.password, true);
  });

  it('real Chrome capture: typed password is bullets in the extract and absent from the XML', () => {
    const xml = readFileSync(join(PATHS.fixtures, DESKTOP, 'login-email.xml'), 'utf8');
    assert.equal(realExtract('login-email').nodes.find((n) => n.kind === 'password')!.value, '••••••');
    assert.ok(!xml.includes('pw1234'));
  });

  it('rejects malformed extracts', () => {
    const good = realExtract('index');
    const bad: [string, unknown][] = [
      ['not an object', 'nope'],
      ['no nodes', { ...good, nodes: [] }],
      ['root is not the document', { ...good, nodes: [node(-1, 'generic', [0, 0, 10, 10])] }],
      ['parent after child', { ...good, nodes: [good.nodes[0], node(2, 'text', [0, 0, 10, 10]), node(0, 'generic', [0, 0, 10, 10])] }],
      ['second root', { ...good, nodes: [good.nodes[0], node(-1, 'generic', [0, 0, 10, 10])] }],
      ['unknown kind', { ...good, nodes: [good.nodes[0], node(0, 'marquee', [0, 0, 10, 10])] }],
      ['unknown flag', { ...good, nodes: [good.nodes[0], node(0, 'button', [0, 0, 10, 10], { flags: ['clicky'] })] }],
      ['non-finite rect', { ...good, nodes: [good.nodes[0], node(0, 'button', [0, Number.NaN, 10, 10])] }],
      ['negative size', { ...good, nodes: [good.nodes[0], node(0, 'button', [0, 0, -1, 10])] }],
      ['missing url', { ...good, url: undefined }],
      ['zero viewport', { ...good, width: 0 }],
    ];
    for (const [why, e] of bad) assert.throws(() => webSourceFromExtract(e), /웹 페이지 구조 추출 결과가 올바르지 않습니다/, why);
  });

  it('escapes markup-significant and control characters so labels survive the round trip', () => {
    const label = 'a "q" & <b> \'s\'\n다음\u0001';
    const e = extractOf([node(-1, 'document', [0, 0, 1280, 800]), node(0, 'button', [10, 10, 100, 40], { text: label, flags: ['enabled', 'clickable'] })]);
    const src = webSourceFromExtract(e);
    const btn = parseWebSource(src.xml, src.screen).find((n) => n.className === 'web:button')!;
    assert.equal(btn.text, 'a "q" & <b> \'s\'\n다음');
  });

  it('reports the viewport, page URL and truncation', () => {
    const e = { ...extractOf([node(-1, 'document', [0, 0, 1280, 800])]), truncated: true };
    const src = webSourceFromExtract(e);
    assert.deepEqual(src.screen, VIEWPORT);
    assert.equal(src.pageUrl, 'http://localhost/');
    assert.equal(src.truncated, true);
    assert.match(src.xml, /<web [^>]*truncated="true"/);
  });
});

describe('WEB_EXTRACT_SCRIPT (laid-out page, no browser)', () => {
  it('text directly under <body> or inside a skipped wrapper is a visible text line; hidden text is not', () => {
    const message = '정말 삭제하시겠습니까? 되돌릴 수 없습니다.';
    const extract = runExtract(
      {
        tag: 'body',
        box: [0, 0, 1280, 800],
        children: [
          { text: message, box: [20, 20, 277, 19] },
          { tag: 'button', box: [20, 39, 39, 22], children: [{ text: '취소', box: [26, 42, 27, 16] }] },
          { tag: 'button', box: [63, 39, 39, 22], children: [{ text: '삭제', box: [69, 42, 27, 16] }] },
          { tag: 'span', box: [0, 0, 0, 0], style: { display: 'contents' }, children: [{ text: '래퍼 안 문장', box: [146, 40, 78, 19] }] },
          { tag: 'div', box: [20, 70, 200, 19], style: { visibility: 'hidden' }, children: [{ text: '숨은 문장', box: [20, 70, 60, 19] }] },
          { text: '화면 밖 문장', box: [20, 900, 90, 19] },
        ],
      },
      { width: 1280, height: 800 },
    );
    const m = webModel(extract as Extract);
    assert.deepEqual(m.texts, [message, '취소', '삭제', '래퍼 안 문장']);
    one(m, '삭제');
  });
});

describe('parseWebSource + buildScreenModel (synthetic pages)', () => {
  it('lifts an occluding layer above later content: a sticky header earlier in the DOM covers the button scrolled under it', () => {
    const e = extractOf([
      node(-1, 'document', [0, 0, 1280, 800]),
      node(0, 'overlay', [0, 0, 1280, 60], { flags: ['enabled', 'clickable', 'occluder'] }),
      node(1, 'link', [20, 10, 80, 40], { text: '홈', flags: ['enabled', 'clickable'] }),
      node(0, 'generic', [0, 0, 1280, 2000]),
      node(3, 'button', [20, 20, 100, 30], { text: '가려진 버튼', flags: ['enabled', 'clickable'] }),
      node(3, 'button', [20, 200, 100, 30], { text: '보이는 버튼', flags: ['enabled', 'clickable'] }),
    ]);
    const nodes = parseWebSource(webSourceFromExtract(e).xml, VIEWPORT);
    assert.deepEqual(nodes.map((n) => n.id), ['0', '0.1', '0.1.0', '0.1.1', '0.0', '0.0.0']);
    const m = webModel(e);
    assert.equal(named(m, '가려진 버튼').length, 0);
    one(m, '보이는 버튼');
    one(m, '홈');
  });

  it('classifies roles by web kind; clickable generics become buttons but occluders and dialogs never do', () => {
    const e = extractOf([
      node(-1, 'document', [0, 0, 1280, 800], { name: '문서 제목' }),
      node(0, 'generic', [0, 0, 300, 40], { text: '카드 열기', flags: ['enabled', 'clickable'] }),
      node(0, 'checkbox', [0, 50, 20, 20], { name: '동의', flags: ['enabled', 'clickable', 'checkable', 'checked'] }),
      node(0, 'radio', [0, 80, 20, 20], { name: '배송', flags: ['enabled', 'clickable', 'checkable'] }),
      node(0, 'select', [0, 110, 200, 30], { name: '지역', value: '서울', flags: ['enabled', 'clickable'] }),
      node(0, 'tab', [0, 150, 80, 30], { text: '상세', flags: ['enabled', 'clickable', 'selected'] }),
      node(0, 'listitem', [0, 190, 300, 30], { text: '그냥 항목' }),
      node(0, 'image', [0, 230, 50, 50], { name: '로고' }),
      node(0, 'dialog', [400, 0, 400, 300], { name: '알림', flags: ['enabled', 'clickable', 'occluder'] }),
    ]);
    const m = webModel(e);
    const roleOf = (name: string): string => m.candidates.find((c) => c.name === name)!.role;
    assert.equal(roleOf('카드 열기'), 'button');
    assert.equal(roleOf('동의'), 'checkbox');
    assert.deepEqual(m.candidates.find((c) => c.name === '동의')!.state, ['checked']);
    assert.equal(roleOf('배송'), 'checkbox');
    assert.equal(roleOf('지역'), 'input');
    assert.equal(m.candidates.find((c) => c.name === '지역')!.value, '서울');
    assert.equal(roleOf('상세'), 'tab');
    assert.equal(roleOf('로고'), 'image');
    assert.equal(named(m, '그냥 항목')[0]!.actionable, false);
    const dialog = m.candidates.find((c) => c.name === '알림')!;
    assert.equal(dialog.role, 'other');
    assert.equal(dialog.actionable, false);
    assert.equal(named(m, '문서 제목').length, 0);
    assert.ok(!m.texts.includes('문서 제목'));
  });

  it('a later scrollable / focusable box does not hide an earlier control the page hit test found uncovered', () => {
    // e.g. an absolutely positioned menu earlier in the DOM, drawn over a carousel that comes later.
    const e = extractOf([
      node(-1, 'document', [0, 0, 1280, 800]),
      node(0, 'button', [20, 120, 120, 40], { text: '메뉴 항목', flags: ['enabled', 'clickable', 'focusable'] }),
      node(0, 'scroll', [0, 100, 1280, 300], { flags: ['enabled', 'scrollable', 'focusable'] }),
    ]);
    one(webModel(e), '메뉴 항목');
  });

  it('clips children of a scroll container to its viewport', () => {
    const e = extractOf([
      node(-1, 'document', [0, 0, 1280, 800]),
      node(0, 'scroll', [0, 100, 400, 200], { flags: ['enabled', 'scrollable'] }),
      node(1, 'button', [10, 120, 100, 40], { text: '안쪽', flags: ['enabled', 'clickable'] }),
      node(1, 'button', [10, 500, 100, 40], { text: '스크롤 밖', flags: ['enabled', 'clickable'] }),
    ]);
    const m = webModel(e);
    one(m, '안쪽');
    assert.equal(named(m, '스크롤 밖').length, 0);
  });
});

describe('desktop Chrome fixtures (web-demo)', () => {
  it('index: search button, labelled search input, login link', () => {
    const m = loadModel(`${DESKTOP}/index`);
    assert.equal(one(m, '검색').role, 'button');
    const input = m.candidates.find((c) => c.role === 'input')!;
    assert.equal(input.name, '상품 검색');
    assert.equal(one(m, '로그인').role, 'link');
    assert.equal(one(m, '도움말').role, 'button');
    assert.equal(named(m, '장바구니 담기').length, 3);
    assert.ok(m.candidates.every((c) => c.role !== 'list-item'), 'plain <li> rows are not targets');
    assert.equal(m.snapshot.surface, 'web');
  });

  it('index-help: the modal layer covers every page control; only the dialog content is offered', () => {
    const closed = loadModel(`${DESKTOP}/index`);
    const open = loadModel(`${DESKTOP}/index-help`);
    for (const name of ['검색', '도움말', '로그인', '주문하기', '장바구니 담기']) {
      assert.ok(named(closed, name).length > 0, name);
      assert.equal(named(open, name).filter((c) => c.actionable).length, 0, `${name} must not be offered under the modal`);
    }
    assert.equal(open.candidates.find((c) => c.role === 'input'), undefined);
    assert.equal(one(open, '닫기').role, 'button');
    assert.ok(open.texts.includes('검색창에 상품 이름을 입력하고 검색을 누르세요.'));
    assert.ok(!open.texts.includes('상품 3개'));
  });

  it('login-email: typed email value, password is a secure input with bullets only', () => {
    const m = loadModel(`${DESKTOP}/login-email`);
    const email = m.candidates.find((c) => c.name === '이메일' && c.role === 'input')!;
    assert.equal(email.value, 'qa@example.com');
    const pw = m.candidates.find((c) => c.name === '비밀번호' && c.actionable)!;
    assert.equal(pw.role, 'secure-input');
    assert.equal(pw.value, '••••••');
    assert.equal(one(m, '상점으로').role, 'link');
  });

  it('calibration loads desktop golden fixtures', () => {
    const m = loadFixtureModel(PATHS.fixtures, `${DESKTOP}/index`);
    assert.equal(m.snapshot.surface, 'web');
    assert.equal(m.snapshot.pageUrl, 'http://localhost:4173/');
    assert.equal(one(m, '검색').role, 'button');
  });
});

describe('Android Chrome fixtures (web-demo)', () => {
  const BROWSER_UI = ['localhost:4173', '홈페이지 열기', '새 탭', '4개 탭 보기', 'Chrome 맞춤설정 및 제어', 'Chrome이 명령줄 파일에서 플래그를 로드하고 있습니다. 안정성과 보안에 영향을 미칠 수 있습니다.'];

  it('browser UI (address bar, toolbar, snackbar) is never a candidate or a text line', () => {
    for (const name of ['index', 'index-help', 'login-email']) {
      const m = loadModel(`android/web-demo/${name}`);
      for (const c of m.candidates) assert.ok(!BROWSER_UI.some((b) => c.name.includes(b)) && !c.name.startsWith('localhost'), `${name}: ${c.name}`);
      for (const t of m.texts) assert.ok(!BROWSER_UI.includes(t) && !t.startsWith('localhost'), `${name}: ${t}`);
    }
    // Same source read as an app screen: the address bar would be offered. The surface decides.
    const asApp = buildScreenModel({ ...loadSnapshot('android/web-demo/index'), surface: 'app' });
    assert.ok(asApp.candidates.some((c) => c.value === 'localhost:4173' || c.name === '홈페이지 열기'));
  });

  it('the snackbar still occludes the page button under it', () => {
    const m = loadModel('android/web-demo/index');
    assert.equal(named(m, '주문하기').length, 0);
    const order = m.snapshot.nodes.find((n) => n.resourceId === 'order')!;
    assert.ok(m.occludedNodeIds.includes(order.id));
    assert.equal(one(loadModel('android/web-demo/index-help'), '닫기').role, 'button');
  });

  it('page content: search button, search field, password field', () => {
    const m = loadModel('android/web-demo/index');
    assert.equal(one(m, '검색').role, 'button');
    assert.equal(one(m, '로그인').role, 'button'); // Chrome exposes links as clickable views without a role
    const query = m.snapshot.nodes.find((n) => n.resourceId === 'query')!;
    assert.equal(m.candidates.find((c) => c.nodeId === query.id)!.role, 'input');
    const login = loadModel('android/web-demo/login-email');
    const email = login.snapshot.nodes.find((n) => n.resourceId === 'email')!;
    assert.equal(login.candidates.find((c) => c.nodeId === email.id)!.value, 'qa@example.com');
    const pw = login.snapshot.nodes.find((n) => n.resourceId === 'password')!;
    assert.equal(login.candidates.find((c) => c.nodeId === pw.id)!.role, 'secure-input');
  });

  it('index-help: the web dialog box covers the page controls', () => {
    const m = loadModel('android/web-demo/index-help');
    for (const name of ['검색', '도움말', '로그인', '장바구니 담기']) assert.equal(named(m, name).filter((c) => c.actionable).length, 0, name);
    assert.equal(m.candidates.find((c) => c.role === 'input'), undefined);
  });

  it('OCR lines on the status bar or Chrome toolbar are never candidates or texts; page lines are', () => {
    const ocr = [
      { text: '9:41', confidence: 1, rect: { x: 60, y: 15, width: 60, height: 30 } }, // status bar clock (outside the WebView)
      { text: 'localhost:4173', confidence: 1, rect: { x: 220, y: 100, width: 300, height: 60 } }, // address bar
      { text: '오늘의 특가', confidence: 1, rect: { x: 60, y: 1700, width: 300, height: 60 } }, // page pixels only
    ];
    const m = loadModel('android/web-demo/index', { ocr });
    assert.deepEqual(m.candidates.filter((c) => c.source === 'ocr').map((c) => c.name), ['오늘의 특가']);
    assert.ok(!m.texts.includes('9:41') && !m.texts.includes('localhost:4173'));
  });
});

describe('iOS Safari fixtures (web-demo)', () => {
  const SAFARI_UI = ['뒤로', '주소', '새로 고침', '더 보기', '페이지 메뉴', 'localhost'];

  it('Safari toolbar is never a candidate or a text line', () => {
    for (const name of ['index', 'index-help', 'login-email']) {
      const m = loadModel(`ios/web-demo/${name}`);
      for (const c of m.candidates) assert.ok(!SAFARI_UI.includes(c.name) && !(c.value ?? '').includes('localhost'), `${name}: ${c.name}`);
      for (const t of m.texts) assert.ok(!SAFARI_UI.includes(t) && !t.includes('localhost'), `${name}: ${t}`);
    }
    const asApp = buildScreenModel({ ...loadSnapshot('ios/web-demo/index'), surface: 'app' });
    assert.ok(asApp.candidates.some((c) => c.name === '새로 고침'));
  });

  it('page content: roles and names', () => {
    const m = loadModel('ios/web-demo/index');
    assert.equal(one(m, '검색').role, 'button');
    assert.equal(one(m, '상품 검색').role, 'input');
    assert.equal(one(m, '로그인').role, 'link');
    const login = loadModel('ios/web-demo/login-email');
    assert.equal(one(login, '비밀번호').role, 'secure-input');
    assert.equal(one(login, '이메일').value, 'qa@example.com');
  });

  it('index-help: the web dialog box covers the page controls', () => {
    const m = loadModel('ios/web-demo/index-help');
    for (const name of ['검색', '도움말', '로그인', '주문하기', '장바구니 담기', '상품 검색']) {
      assert.equal(named(m, name).filter((c) => c.actionable).length, 0, name);
    }
    assert.equal(one(m, '닫기').role, 'button');
  });

  it('page scrolled under the status bar (viewport-fit=cover): a link there is visible text but never a tap target', () => {
    const name = 'ios/web-demo/login-email';
    // Captured link: y 79..99; Safari's status-bar backdrop ends at y 62.
    assert.ok(one(loadModel(name), '상점으로').tapPoint.y >= 62);

    const under = loadModel(name, undefined, (xml) => shiftWebContent(xml, -40)); // link at y 39..59
    assert.equal(named(under, '상점으로').length, 0);
    const link = under.snapshot.nodes.find((n) => n.className === 'Link' && n.desc === '상점으로')!;
    assert.ok(under.occludedNodeIds.includes(link.id));
    assert.ok(under.texts.includes('상점으로'), 'still visible to the user');
    assert.equal(one(under, '로그인').role, 'button');

    const straddling = one(loadModel(name, undefined, (xml) => shiftWebContent(xml, -30)), '상점으로'); // y 49..69
    assert.ok(straddling.tapPoint.y >= 62, `tap point ${straddling.tapPoint.y} must be below the status bar`);

    // Native apps own their safe area: the same source read as an app screen keeps the link.
    const asApp = buildScreenModel({ ...loadSnapshot(name, (xml) => shiftWebContent(xml, -40)), surface: 'app' });
    assert.ok(asApp.candidates.some((c) => c.name === '상점으로' && c.actionable));
  });

  const SAFARI_OCR = [
    { text: '9:41', confidence: 1, rect: { x: 30, y: 18, width: 40, height: 14 } }, // status bar clock, center (50,25)
    { text: 'localhost', confidence: 1, rect: { x: 160, y: 806, width: 80, height: 21 } }, // address capsule
    { text: 'AA', confidence: 1, rect: { x: 6, y: 846, width: 22, height: 18 } }, // toolbar backdrop over the page, beside the buttons
  ];

  it('OCR lines on the status bar or Safari toolbar are never candidates or texts; page lines are', () => {
    const page = { text: '오늘의 특가', confidence: 1, rect: { x: 40, y: 640, width: 120, height: 20 } };
    const m = loadModel('ios/web-demo/index', { ocr: [...SAFARI_OCR, page] });
    assert.deepEqual(m.candidates.filter((c) => c.source === 'ocr').map((c) => c.name), ['오늘의 특가']);
    for (const { text } of SAFARI_OCR) assert.ok(!m.texts.includes(text), text);
  });

  it('a page not rendered yet (WebView kept, its content gone) stays empty despite OCR of the browser UI', () => {
    const blank = loadModel('ios/web-demo/index', { ocr: SAFARI_OCR }, emptyWebContent);
    assert.deepEqual(blank.candidates, []);
    assert.deepEqual(blank.texts, []);
  });
});

/** Start and end offsets of the first WebView element (with its subtree) in an XCUITest source. */
function webViewSpan(xml: string): [number, number] {
  const start = xml.indexOf('<XCUIElementTypeWebView');
  const tag = /<(\/?)XCUIElementType\w+[^>]*?(\/?)>/g;
  tag.lastIndex = start;
  let depth = 0;
  let end = start;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    depth += m[1] ? -1 : m[2] ? 0 : 1;
    end = tag.lastIndex;
    if (depth === 0) break;
  }
  return [start, end];
}

/** Moves the page inside the first WebView by `dy` points (the page scrolled; WebViews and browser UI stay put). */
function shiftWebContent(xml: string, dy: number): string {
  const [start, end] = webViewSpan(xml);
  const inner = xml
    .slice(start, end)
    .replace(/<XCUIElementType(\w+)[^>]*>/g, (el, type: string) => (type === 'WebView' ? el : el.replace(/ y="(-?[\d.]+)"/, (_, y: string) => ` y="${Number(y) + dy}"`)));
  return xml.slice(0, start) + inner + xml.slice(end);
}

/** Keeps the first WebView element but removes everything inside it (the page's own nodes). */
function emptyWebContent(xml: string): string {
  const [start, end] = webViewSpan(xml);
  const open = xml.slice(start, end).match(/^<XCUIElementTypeWebView[^>]*?>/)![0];
  return xml.slice(0, start) + open.replace(/>$/, '/>') + xml.slice(end);
}
