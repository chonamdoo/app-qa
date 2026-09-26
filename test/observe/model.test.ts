import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawNode, ScreenModel } from '../../src/core/types.ts';
import { buildScreenModel, normLabel } from '../../src/observe/index.ts';
import { ANDROID_SCREEN, loadModel, loadSnapshot, snapshotOf, uiaNode, uiaSource } from './_fixtures.ts';

function nodeByDesc(model: ScreenModel, desc: string): RawNode {
  const n = model.snapshot.nodes.find((x) => x.desc === desc);
  assert.ok(n, `node with desc ${desc}`);
  return n;
}

const HANGUL_JAMO = /^[\u3131-\u318E]$/;

describe('occlusion on real screens', () => {
  it('my-flight-sheet: only the sheet controls are visible actionable targets; the timeline behind is occluded', () => {
    const model = loadModel('android/tteonam/my-flight-sheet');
    const actionable = model.candidates.filter((c) => c.actionable).map((c) => c.name);
    assert.deepEqual(new Set(actionable), new Set(['닫기', '항공편 바꾸기', '내 항공편 지우기']));
    assert.equal(actionable.length, 3);
    const timeline = model.snapshot.nodes.filter((n) => n.flags.clickable && /^\d{2}:\d{2}, .*전, /.test(n.desc ?? ''));
    assert.equal(timeline.length, 6);
    for (const n of timeline) assert.ok(model.occludedNodeIds.includes(n.id), `${n.desc} occluded`);
    for (const desc of ['설정', '홈', '출국장', '주차', '안내']) assert.ok(model.occludedNodeIds.includes(nodeByDesc(model, desc).id), desc);
    for (const c of model.candidates) {
      assert.ok(c.tapPoint.x >= c.rect.x && c.tapPoint.x < c.rect.x + c.rect.width, `${c.name} tap x inside`);
      assert.ok(c.tapPoint.y >= c.rect.y && c.tapPoint.y < c.rect.y + c.rect.height, `${c.name} tap y inside`);
    }
    // Background texts are not visible lines either.
    assert.ok(!model.texts.includes('집에서 출발'));
    assert.ok(model.texts.includes('에티하드 항공 · EY827'));
  });

  it('ios search-results-keyboard: keyboard removed, home behind the sheet occluded, rows above the keyboard visible', () => {
    const model = loadModel('ios/tteonam/search-results-keyboard');
    for (const c of model.candidates) {
      assert.ok(!HANGUL_JAMO.test(c.name), `keyboard key leaked: ${c.name}`);
      assert.ok(!['shift', '삭제', '이모지', 'Next keyboard', 'Dictate', '검색', '숫자'].includes(c.name), `keyboard control leaked: ${c.name}`);
    }
    assert.ok(!model.texts.some((t) => HANGUL_JAMO.test(t)));
    for (const desc of ['항공편 찾기', '설정', '출국장 5, 대기 5분, 원활, 가장 빠름']) {
      const n = nodeByDesc(model, desc);
      assert.ok(model.occludedNodeIds.includes(n.id), `${desc} occluded`);
      assert.ok(!model.candidates.some((c) => c.nodeId === n.id));
    }
    const rows = model.candidates.filter((c) => c.role === 'button' && c.name.includes('대한항공'));
    assert.ok(rows.length >= 4, `rows visible: ${rows.length}`);
    for (const r of rows) assert.ok(r.tapPoint.y < 566, `${r.name} tap above keyboard`);
    // Rows fully under the keyboard are hidden.
    assert.ok(model.occludedNodeIds.includes(nodeByDesc(model, '정저우 CGO, KE133 · 대한항공 · T2, 07:57 출발, 원래 08:00, 출발').id));
    const input = model.candidates.find((c) => c.role === 'input');
    assert.equal(input?.value, '대한항공');
  });

  it('ios search-popup: the dismiss-popup backdrop hides home content, sheet controls stay visible', () => {
    const model = loadModel('ios/tteonam/search-popup');
    for (const desc of ['항공편 찾기', '설정', '출국장 5, 대기 5분, 원활, 가장 빠름', '홈', '떠남 로고']) {
      assert.ok(model.occludedNodeIds.includes(nodeByDesc(model, desc).id), `${desc} occluded`);
    }
    assert.ok(!model.candidates.some((c) => c.name === 'dismiss popup'), 'backdrop is not a target');
    const names = model.candidates.map((c) => c.name);
    for (const name of ['닫기', '내 항공편 찾기', '오늘', '내일', '9월 28일 (월)']) assert.ok(names.includes(name), name);
    // Chips scrolled outside the horizontal scroll viewport are not on screen.
    assert.ok(!names.includes('9월 30일 (수)'));
    assert.ok(!model.texts.includes('내 항공편을 추가하세요'));
  });

  it('android search-results: repeated result rows are never merged', () => {
    const model = loadModel('android/tteonam/search-results');
    const rows = model.candidates.filter((c) => c.name.includes('대한항공'));
    assert.ok(rows.length >= 4, `rows: ${rows.length}`);
    assert.equal(new Set(rows.map((r) => r.nodeId)).size, rows.length);
    assert.equal(new Set(rows.map((r) => `${r.rect.x},${r.rect.y}`)).size, rows.length);
    assert.ok(rows.every((r) => r.actionable && r.role === 'button'));
  });
});

describe('screen model fields', () => {
  it('sparse follows the architecture rule (actionable < 3 && text < 32 chars)', () => {
    const kroute = loadModel('ios/kroute/launch');
    assert.equal(kroute.sparse, true);
    assert.deepEqual(kroute.texts, ['Local URI identity smoke']);
    const granite = loadModel('ios/granite/launch');
    assert.equal(granite.candidates.filter((c) => c.actionable).length, 4);
    assert.equal(granite.sparse, false);
  });

  it('RedBox text is available for health checks', () => {
    const model = loadModel('android/ticketestimate/launch');
    assert.ok(model.texts.includes('DISMISS (ESC)'));
    assert.ok(model.texts.includes('RELOAD (R, R)'));
    assert.ok(model.texts.some((t) => t.startsWith('The development server returned response error code: 404')));
  });

  it('keys follow reading order (y, then x)', () => {
    const model = loadModel('android/tteonam/launch');
    model.candidates.forEach((c, i) => assert.equal(c.key, `e${i + 1}`));
    for (let i = 1; i < model.candidates.length; i++) {
      const a = model.candidates[i - 1]!.rect;
      const b = model.candidates[i]!.rect;
      assert.ok(a.y < b.y || (a.y === b.y && a.x <= b.x), `order at e${i + 1}`);
    }
  });

  it('merges RN duplicated labels (same label, same box, ancestor/descendant) into one candidate', () => {
    const model = loadModel('ios/tteonam/launch');
    assert.equal(model.candidates.filter((c) => c.name === '내 항공편을 추가하세요').length, 1);
    assert.equal(model.texts.filter((t) => t === '내 항공편을 추가하세요').length, 1);
    const heading = model.candidates.find((c) => c.name === '내 항공편을 추가하세요');
    assert.equal(heading?.role, 'heading');
  });

  it('labels unlabelled Compose/RN buttons from their child text and keeps state', () => {
    const model = loadModel('android/example-tickets/launch');
    const remove = model.candidates.find((c) => c.name === 'Remove');
    const add = model.candidates.find((c) => c.name === 'Add');
    assert.equal(remove?.role, 'button');
    assert.deepEqual(remove?.state, ['disabled']);
    assert.equal(add?.actionable, true);
    assert.equal(model.candidates.filter((c) => normLabel(c.name) === 'remove').length, 1);
  });

  it('identifies bottom tab bars on both platforms', () => {
    const android = loadModel('android/tteonam/launch');
    const ios = loadModel('ios/tteonam/launch');
    for (const model of [android, ios]) {
      const tabs = model.candidates.filter((c) => c.role === 'tab');
      assert.deepEqual(tabs.map((t) => t.name), ['홈', '출국장', '주차', '안내']);
      assert.ok(tabs.every((t) => t.actionable));
    }
    assert.deepEqual(ios.candidates.find((c) => c.name === '홈')?.state, ['selected']);
  });

  it('does not mistake a bottom row of text-only dialog buttons for tabs', () => {
    const button = (label: string, x: number) =>
      uiaNode({ class: 'android.widget.Button', clickable: 'true', text: label, bounds: `[${x},2200][${x + 340},2340]` });
    const xml = uiaSource(
      uiaNode({ class: 'android.widget.LinearLayout', bounds: '[0,2180][1080,2360]' }, button('취소', 20) + button('저장', 370) + button('삭제', 720)),
    );
    const model = buildScreenModel(snapshotOf('android', xml, ANDROID_SCREEN));
    assert.deepEqual(
      model.candidates.map((c) => [c.name, c.role]),
      [['취소', 'button'], ['저장', 'button'], ['삭제', 'button']],
    );
  });

  it('reports showing-hint as hint only, masks secure values, and surfaces Android error text', () => {
    const xml = uiaSource(
      uiaNode(
        { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
        uiaNode({ class: 'android.widget.EditText', text: '편명 검색', 'showing-hint': 'true', clickable: 'true', focusable: 'true', bounds: '[0,100][1080,250]' }) +
          uiaNode({ class: 'android.widget.EditText', text: 'hunter2', password: 'true', clickable: 'true', bounds: '[0,300][1080,450]', 'resource-id': 'pw', hint: '비밀번호' }) +
          uiaNode({ class: 'android.widget.EditText', text: 'abc', error: '형식이 올바르지 않아요', clickable: 'true', bounds: '[0,500][1080,650]', 'content-desc': '이메일' }),
      ),
    );
    const model = buildScreenModel(snapshotOf('android', xml, ANDROID_SCREEN));
    const [search, password, email] = model.candidates;
    assert.equal(search?.name, '편명 검색');
    assert.equal(search?.value, null);
    assert.equal(password?.role, 'secure-input');
    assert.equal(password?.value, '•••••••');
    assert.equal(email?.value, 'abc');
    assert.ok(!model.texts.includes('편명 검색'), 'placeholder is not visible content');
    assert.ok(!model.texts.some((t) => t.includes('hunter2')), 'secure text never becomes a text line');
    assert.ok(model.texts.includes('형식이 올바르지 않아요'));
  });

  it('flags overflow above 254 candidates without truncating', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      uiaNode({ class: 'android.widget.Button', clickable: 'true', 'content-desc': `항목 ${i}`, bounds: `[0,${i * 8}][1080,${i * 8 + 8}]`, 'drawing-order': String(i) }),
    ).join('');
    const xml = uiaSource(uiaNode({ class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, rows));
    const model = buildScreenModel(snapshotOf('android', xml, ANDROID_SCREEN));
    assert.equal(model.overflow, true);
    assert.equal(model.candidates.length, 300);
    assert.equal(model.candidates.at(-1)?.key, 'e300');
    const small = loadModel('android/tteonam/launch');
    assert.equal(small.overflow, false);
  });

  it('adds OCR lines as ocr text candidates, skipping duplicates of tree text', () => {
    const snapshot = loadSnapshot('ios/kroute/launch');
    const model = buildScreenModel(snapshot, {
      ocr: [
        { text: 'Local URI identity smoke', confidence: 1, rect: { x: 118, y: 428, width: 166, height: 18 } },
        { text: '◀ 떠남', confidence: 0.5, rect: { x: 12, y: 36, width: 36, height: 12 } },
      ],
    });
    const ocr = model.candidates.filter((c) => c.source === 'ocr');
    assert.deepEqual(ocr.map((c) => c.name), ['◀ 떠남']);
    assert.equal(ocr[0]?.role, 'text');
    assert.deepEqual(ocr[0]?.tapPoint, { x: 30, y: 42 });
    assert.ok(model.texts.includes('◀ 떠남'));
    assert.equal(model.texts.filter((t) => t === 'Local URI identity smoke').length, 1);
    assert.deepEqual(model.candidates.map((c) => c.key), ['e1', 'e2']);
    assert.equal(model.candidates[0]?.name, '◀ 떠남');
    // Sparse reflects the tree (it is what triggers OCR).
    assert.equal(model.sparse, true);
  });

  it('drops OCR lines that fall on the on-screen keyboard', () => {
    const model = buildScreenModel(loadSnapshot('ios/tteonam/search-results-keyboard'), {
      ocr: [{ text: 'ㅂ', confidence: 1, rect: { x: 10, y: 600, width: 20, height: 30 } }],
    });
    assert.ok(!model.candidates.some((c) => c.source === 'ocr'));
  });
});

describe('fingerprints', () => {
  it('are deterministic for the same source', () => {
    const a = loadModel('android/tteonam/tab-departures');
    const b = loadModel('android/tteonam/tab-departures');
    assert.deepEqual(a.fingerprints, b.fingerprints);
  });

  it('differ between different tabs', () => {
    const departures = loadModel('android/tteonam/tab-departures');
    const parking = loadModel('android/tteonam/tab-parking');
    assert.notEqual(departures.fingerprints.identity, parking.fingerprints.identity);
    assert.notEqual(departures.fingerprints.layout, parking.fingerprints.layout);
  });

  it('ignore a clock-only text change but not a real text change', () => {
    const withText = (text: string) => (xml: string) => xml.replaceAll('Local URI identity smoke', text);
    const at823 = loadModel('ios/kroute/launch', {}, withText('8:23'));
    const at824 = loadModel('ios/kroute/launch', {}, withText('8:24'));
    assert.deepEqual(at823.fingerprints, at824.fingerprints);
    const hello = loadModel('ios/kroute/launch', {}, withText('Hello'));
    const world = loadModel('ios/kroute/launch', {}, withText('World'));
    assert.notEqual(hello.fingerprints.identity, world.fingerprints.identity);
  });

  it('honour app-profile volatile patterns', () => {
    const volatile = ['^\\d{1,2}:\\d{2} 기준$'];
    const later = (xml: string) => xml.replaceAll('08:21 기준', '08:25 기준');
    const base = loadModel('ios/tteonam/launch', { volatile });
    const moved = loadModel('ios/tteonam/launch', { volatile }, later);
    assert.equal(base.fingerprints.identity, moved.fingerprints.identity);
    assert.notEqual(loadModel('ios/tteonam/launch').fingerprints.identity, loadModel('ios/tteonam/launch', {}, later).fingerprints.identity);
    assert.throws(() => loadModel('ios/tteonam/launch', { volatile: ['(unclosed'] }), /volatile 정규식/);
  });

  it('track geometry in layout but not in identity', () => {
    const shifted = (xml: string) => xml.replace('x="116" y="427"', 'x="116" y="627"');
    const a = loadModel('ios/kroute/launch');
    const b = loadModel('ios/kroute/launch', {}, shifted);
    assert.equal(a.fingerprints.identity, b.fingerprints.identity);
    assert.notEqual(a.fingerprints.layout, b.fingerprints.layout);
  });
});

describe('performance', () => {
  it('builds the ~177KB search-results model in under 50 ms', () => {
    const snapshot = loadSnapshot('android/tteonam/search-results');
    assert.ok(snapshot.rawSource.length > 170_000);
    buildScreenModel(snapshot);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      buildScreenModel(snapshot);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    assert.ok(times[3]! < 50, `median ${times[3]!.toFixed(1)} ms`);
  });
});
