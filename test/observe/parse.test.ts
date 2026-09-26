import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawNode } from '../../src/core/types.ts';
import { parseAndroidSource, parseIosSource } from '../../src/observe/index.ts';
import { ANDROID_SCREEN, fixtureScreen, fixtureXml, uiaNode, uiaSource } from './_fixtures.ts';

function find(nodes: RawNode[], pred: (n: RawNode) => boolean, what: string): RawNode {
  const n = nodes.find(pred);
  assert.ok(n, what);
  return n;
}

function rectIs(n: RawNode, x: number, y: number, width: number, height: number): boolean {
  return n.rect.x === x && n.rect.y === y && n.rect.width === width && n.rect.height === height;
}

describe('parseAndroidSource', () => {
  const nodes = parseAndroidSource(fixtureXml('android/tteonam/my-flight-sheet'), fixtureScreen('android/tteonam/my-flight-sheet'));

  it('orders siblings by drawing-order, not document order', () => {
    // Document order of these siblings is 23, 26, 25, 24, 27; paint order is 23 < 24 < 25 < 26 < 27.
    const clock = find(nodes, (n) => n.text === '00:45', '00:45');
    const ago = find(nodes, (n) => n.text === '40분 전', '40분 전');
    const line = find(nodes, (n) => rectIs(n, 255, 1768, 5, 57), 'drawing-order 25');
    const dot = find(nodes, (n) => rectIs(n, 234, 1802, 47, 47), 'drawing-order 26');
    const button = find(nodes, (n) => n.desc === '00:45, 40분 전, 탑승 시작, 지금. 게이트 12', 'button');
    const zs = [clock, ago, line, dot, button].map((n) => n.z);
    assert.deepEqual(zs, [...zs].sort((a, b) => a - b));
    const parent = find(nodes, (n) => n.id === clock.parentId, 'parent');
    assert.deepEqual(
      parent.childIds.filter((id) => [clock, ago, line, dot, button].some((n) => n.id === id)),
      [clock.id, ago.id, line.id, dot.id, button.id],
    );
  });

  it('draws the sheet backdrop above every timeline button', () => {
    const backdrop = find(nodes, (n) => n.flags.clickable && rectIs(n, 0, 0, 1080, 2400), 'backdrop');
    const timeline = nodes.filter((n) => /^\d{2}:\d{2}, /.test(n.desc ?? ''));
    assert.equal(timeline.length, 6);
    for (const n of timeline) assert.ok(n.z < backdrop.z);
  });

  it('returns nodes in z order with consistent parent/child links and path ids', () => {
    nodes.forEach((n, i) => assert.equal(n.z, i));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      for (const c of n.childIds) assert.equal(byId.get(c)?.parentId, n.id);
      if (n.parentId) assert.ok(n.id.startsWith(`${n.parentId}.`));
    }
    assert.equal(nodes[0]!.id, '0');
    assert.equal(nodes[0]!.windowId, '90');
  });

  it('maps attributes to flags and reports editable text as value', () => {
    const search = parseAndroidSource(fixtureXml('android/tteonam/search-results'), ANDROID_SCREEN);
    const input = find(search, (n) => n.className === 'android.widget.EditText', 'EditText');
    assert.equal(input.value, '대한항공');
    assert.equal(input.text, null);
    assert.equal(input.desc, '편명·도시·항공사');
    assert.equal(input.flags.editable, true);
    assert.equal(input.flags.longClickable, true);
    const heading = find(search, (n) => n.text === '내 항공편 찾기', 'heading');
    assert.equal(heading.flags.heading, true);
    assert.deepEqual(heading.rect, { x: 52, y: 188, width: 870, height: 74 });
  });

  it('drops displayed="false" subtrees and keeps sibling path ids stable', () => {
    const xml = uiaSource(
      uiaNode(
        { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
        uiaNode({ displayed: 'false', bounds: '[0,0][10,10]' }, uiaNode({ text: 'hidden child', bounds: '[0,0][10,10]' })) +
          uiaNode({ text: '보임', bounds: '[0,20][100,40]', 'drawing-order': '2' }),
      ),
    );
    const out = parseAndroidSource(xml, ANDROID_SCREEN);
    assert.ok(!out.some((n) => n.text === 'hidden child'));
    assert.equal(find(out, (n) => n.text === '보임', 'visible').id, '0.1');
  });

  it('keeps showing-hint text out of text/value', () => {
    const xml = uiaSource(uiaNode({ class: 'android.widget.EditText', text: '검색어 입력', 'showing-hint': 'true', bounds: '[0,0][100,100]' }));
    const [input] = parseAndroidSource(xml, ANDROID_SCREEN);
    assert.equal(input?.text, null);
    assert.equal(input?.value, null);
    assert.equal(input?.hint, '검색어 입력');
  });

  it('rejects truncated sources', () => {
    const xml = fixtureXml('android/tteonam/my-flight-sheet');
    assert.throws(() => parseAndroidSource(xml.slice(0, xml.length / 2), ANDROID_SCREEN), /XML/);
  });
});

describe('parseIosSource', () => {
  const screen = fixtureScreen('ios/tteonam/search-results-keyboard');
  const nodes = parseIosSource(fixtureXml('ios/tteonam/search-results-keyboard'), screen);

  it('strips the XCUIElementType prefix and keeps point geometry in document order', () => {
    assert.equal(nodes[0]!.className, 'Application');
    nodes.forEach((n, i) => assert.equal(n.z, i));
    const close = find(nodes, (n) => n.desc === '닫기', '닫기');
    assert.equal(close.className, 'Button');
    assert.deepEqual(close.rect, { x: 350, y: 78, width: 44, height: 44 });
    assert.equal(close.flags.clickable, true);
  });

  it('marks modal backdrops and the keyboard host as touch-intercepting, plain containers not', () => {
    const backdrops = nodes.filter((n) => rectIs(n, -402, -874, 1206, 2622));
    assert.ok(backdrops.length >= 1);
    assert.ok(backdrops.every((n) => n.flags.clickable));
    const host = find(nodes, (n) => n.flags.clickable && rectIs(n, 0, 566, 402, 308) && n.className === 'Other', 'keyboard host');
    assert.ok(nodes.some((k) => k.className === 'Keyboard' && k.id.startsWith(`${host.id}.`)));
    const fullScreenOthers = nodes.filter((n) => n.className === 'Other' && rectIs(n, 0, 0, 402, 874));
    assert.ok(fullScreenOthers.length > 5);
    assert.ok(fullScreenOthers.every((n) => !n.flags.clickable));
  });

  it('types trait-carrying Other elements and reads field values', () => {
    const tabBar = find(nodes, (n) => rectIs(n, 0, 759, 402, 115), 'tab bar');
    assert.equal(tabBar.className, 'TabBar');
    const field = find(nodes, (n) => n.className === 'TextField', 'field');
    assert.equal(field.value, '대한항공');
    assert.equal(field.desc, '편명·도시·항공사');
    assert.equal(field.flags.editable, true);
    const today = find(nodes, (n) => n.desc === '오늘', '오늘');
    assert.equal(today.flags.selected, true);
    const header = find(nodes, (n) => n.desc === '내 항공편 찾기', 'header');
    assert.equal(header.flags.heading, true);
    assert.equal(header.text, '내 항공편 찾기');
  });

  it('treats a value equal to the placeholder as empty and decodes entities', () => {
    const granite = parseIosSource(fixtureXml('ios/granite/launch'), fixtureScreen('ios/granite/launch'));
    const fields = granite.filter((n) => n.className === 'TextField');
    assert.equal(fields.length, 2);
    for (const f of fields) {
      assert.equal(f.value, null);
      assert.ok(f.hint);
    }
    assert.ok(granite.some((n) => n.text === 'Shared bundle url:\n'));
  });
});
