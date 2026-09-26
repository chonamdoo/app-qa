import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refind } from '../../src/observe/index.ts';
import { loadModel } from './_fixtures.ts';

/** Moves every UIA2 bounds down by `dy` px (a scroll / layout shift between observations). */
function shiftBounds(dy: number) {
  return (xml: string) =>
    xml.replace(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/g, (_, x1, y1, x2, y2) => `bounds="[${x1},${Number(y1) + dy}][${x2},${Number(y2) + dy}]"`);
}

describe('refind', () => {
  it('re-locates a row after the layout shifted', () => {
    const before = loadModel('android/tteonam/search-results');
    const row = before.candidates.find((c) => c.name.startsWith('칭다오 TAO'))!;
    const after = loadModel('android/tteonam/search-results', {}, shiftBounds(40));
    const found = refind(row, after);
    assert.ok(found);
    assert.equal(found.name, row.name);
    assert.equal(found.tapPoint.y, row.tapPoint.y + 40);
  });

  it('returns null when the value changed', () => {
    const before = loadModel('android/tteonam/search-results');
    const input = before.candidates.find((c) => c.role === 'input')!;
    assert.equal(input.value, '대한항공');
    const after = loadModel('android/tteonam/search-results', {}, (xml) => xml.replace('text="대한항공"', 'text="아시아나"'));
    assert.equal(refind(input, after), null);
  });

  it('returns null when another element took the same place, name and state (resource id differs)', () => {
    const before = loadModel('android/web-demo/index');
    const help = before.candidates.find((c) => c.name === '도움말' && c.actionable)!;
    assert.equal(help.resourceId, 'help-open');
    assert.equal(refind(help, before)?.nodeId, help.nodeId);
    for (const replaced of ['resource-id="help-replacement"', 'resource-id=""']) {
      const after = loadModel('android/web-demo/index', {}, (xml) => xml.replace('resource-id="help-open"', replaced));
      const same = after.candidates.find((c) => c.nodeId === help.nodeId)!;
      assert.deepEqual({ ...same, resourceId: help.resourceId }, help, 'only the resource id changed');
      assert.equal(refind(help, after), null, replaced);
    }
    // A node without a resource id matches only a node without one.
    const bare = loadModel('android/web-demo/index', {}, (xml) => xml.replace('resource-id="help-open"', 'resource-id=""'));
    const unnamed = bare.candidates.find((c) => c.nodeId === help.nodeId)!;
    assert.equal(refind(unnamed, bare)?.nodeId, help.nodeId);
    assert.equal(refind(unnamed, before), null);
  });

  it('returns null when the target disappeared (now occluded)', () => {
    const launch = loadModel('android/tteonam/launch');
    const settings = launch.candidates.find((c) => c.name === '설정')!;
    assert.equal(refind(settings, loadModel('android/tteonam/my-flight-sheet')), null);
  });

  it('picks the nearest of several identical rows', () => {
    const model = loadModel('ios/expo-go/launch');
    const rows = model.candidates.filter((c) => c.name === 'standalone');
    assert.ok(rows.length >= 3);
    for (const row of rows) assert.equal(refind(row, model)?.key, row.key);
    const between = { ...rows[1]!, rect: { ...rows[1]!.rect, y: rows[1]!.rect.y + 10 } };
    assert.equal(refind(between, model)?.key, rows[1]!.key);
  });
});
