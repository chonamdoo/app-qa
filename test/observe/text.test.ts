import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normLabel } from '../../src/observe/index.ts';
import { scanXml } from '../../src/observe/text.ts';

describe('normLabel', () => {
  it('matches decomposed (NFD) and composed Hangul', () => {
    const nfd = '항공편 찾기'.normalize('NFD');
    assert.notEqual(nfd, '항공편 찾기');
    assert.equal(normLabel(nfd), '항공편 찾기');
  });

  it('keeps Korean and other non-ASCII text, lower-cases, collapses whitespace', () => {
    assert.equal(normLabel('  내 항공편\u00a0지우기\n'), '내 항공편 지우기');
    assert.equal(normLabel('RELOAD\n(R,\u00a0R)'), 'reload (r, r)');
    assert.equal(normLabel('9월 28일 (월) · T2'), '9월 28일 (월) · t2');
    assert.equal(normLabel('다음\u200b키보드'), '다음키보드');
  });
});

describe('scanXml', () => {
  it('handles quoted `>` and entities inside attributes', () => {
    const seen: Record<string, string>[] = [];
    scanXml('<?xml version="1.0"?><!-- c --><a x="1 > 0" y=\'&lt;b&gt; &amp; &#44032;&#x0A;\'><b/></a>', {
      open: (_, attrs) => seen.push({ ...attrs }),
      close: () => {},
    });
    assert.deepEqual(seen, [{ x: '1 > 0', y: '<b> & 가\n' }, {}]);
  });

  it('rejects unbalanced markup', () => {
    const noop = { open: () => {}, close: () => {} };
    assert.throws(() => scanXml('<a><b></a>', noop), /XML/);
    assert.throws(() => scanXml('<a x="1"', noop), /XML/);
    assert.throws(() => scanXml('<a>', noop), /XML/);
  });
});
