import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Point, RawNode, Rect } from '../../src/core/types.ts';
import { isUnoccludedAt, topmostAt } from '../../src/observe/index.ts';
import { visibleRegion } from '../../src/observe/occlusion.ts';
import { loadSnapshot } from './_fixtures.ts';

const rect: Rect = { x: 100, y: 100, width: 200, height: 100 };

function inside(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

describe('visibleRegion', () => {
  it('taps the centre of an unobstructed rect', () => {
    assert.deepEqual(visibleRegion(rect, [], []), { tapPoint: { x: 200, y: 150 }, fraction: 1 });
  });

  it('is null when an occluder covers the whole rect', () => {
    assert.equal(visibleRegion(rect, [{ x: 0, y: 0, width: 1000, height: 1000 }], []), null);
  });

  it('taps inside the uncovered half when the right half is occluded', () => {
    const cover = { x: 200, y: 0, width: 500, height: 500 };
    const v = visibleRegion(rect, [cover], []);
    assert.ok(v);
    assert.ok(inside(rect, v.tapPoint) && !inside(cover, v.tapPoint), JSON.stringify(v.tapPoint));
    assert.ok(v.fraction > 0.4 && v.fraction < 0.6);
  });

  it('picks the larger of two disconnected visible parts', () => {
    // A vertical bar leaves a thin strip on the left and a wide area on the right.
    const bar = { x: 120, y: 0, width: 40, height: 500 };
    const v = visibleRegion(rect, [bar], []);
    assert.ok(v);
    assert.ok(v.tapPoint.x >= 160, JSON.stringify(v.tapPoint));
  });

  it('avoids a nested touchable at the centre but still reports the rect as visible', () => {
    const nested = { x: 150, y: 110, width: 100, height: 80 };
    const v = visibleRegion(rect, [], [nested]);
    assert.ok(v);
    assert.equal(v.fraction, 1);
    assert.ok(inside(rect, v.tapPoint) && !inside(nested, v.tapPoint), JSON.stringify(v.tapPoint));
  });

  it('falls back to a nested touchable when it covers everything visible', () => {
    const v = visibleRegion(rect, [], [{ x: 0, y: 0, width: 1000, height: 1000 }]);
    assert.deepEqual(v?.tapPoint, { x: 200, y: 150 });
  });
});

describe('topmostAt / isUnoccludedAt', () => {
  const nodes = loadSnapshot('android/tteonam/my-flight-sheet').nodes;
  const byDesc = (d: string): RawNode => nodes.find((n) => n.desc === d)!;
  const centre = (n: RawNode): Point => ({ x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 });

  it('returns the sheet backdrop over a background button and the button itself on the sheet', () => {
    const behind = byDesc('21:25, 4시간 전, 집에서 출발, 지난 단계. 공항철도·공항버스 타는 곳 보기');
    const top = topmostAt(nodes, centre(behind));
    assert.ok(top && top.flags.clickable && top.rect.width === 1080 && top.rect.height === 2400);
    assert.equal(isUnoccludedAt(nodes, behind, centre(behind)), false);
    const close = byDesc('닫기');
    assert.equal(topmostAt(nodes, centre(close))?.id, close.id);
    assert.equal(isUnoccludedAt(nodes, close, centre(close)), true);
  });

  it('treats the button under a label as reaching the label, and a descendant hit as reaching the ancestor', () => {
    const label = nodes.find((n) => n.text === '지우기')!;
    const button = byDesc('내 항공편 지우기');
    assert.equal(topmostAt(nodes, centre(label))?.id, button.id);
    assert.equal(isUnoccludedAt(nodes, label, centre(label)), true);
    const scroller = nodes.find((n) => n.flags.scrollable && button.id.startsWith(`${n.id}.`));
    assert.ok(scroller);
    assert.equal(isUnoccludedAt(nodes, scroller, centre(button)), true);
  });

  it('ignores content scrolled outside its scroll viewport', () => {
    const popup = loadSnapshot('ios/tteonam/search-popup').nodes;
    const chip = popup.find((n) => n.desc === '9월 30일 (수)')!;
    const p = { x: 385, y: 310 }; // inside the chip's frame, right of the chips' scroll viewport (27…375)
    assert.ok(inside(chip.rect, p));
    assert.notEqual(topmostAt(popup, p)?.id, chip.id);
  });
});
