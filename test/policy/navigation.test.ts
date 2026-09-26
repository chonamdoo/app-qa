import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { navigationProblem } from '../../src/policy/navigation.ts';

const ORIGINS = ['http://localhost:4173', 'https://shop.example'];

describe('navigation policy', () => {
  it('accepts an absolute URL inside the origins and a /path (resolved on the first origin)', () => {
    for (const url of ['http://localhost:4173/login.html?next=/cart', 'https://shop.example/', 'HTTPS://shop.example/a', '/', '/cart#top']) {
      assert.equal(navigationProblem(url, ORIGINS), null, url);
    }
  });

  it('refuses other origins, including ones a path-looking URL resolves to', () => {
    for (const url of [
      'https://evil.example/',
      'http://shop.example/', // scheme is part of the origin
      'http://localhost:4174/',
      '//evil.example/x', // protocol-relative
      '/\\evil.example/x', // the URL parser reads the backslash as a slash
      'http://user:pw@localhost:4173/', // credentials would land in evidence
    ]) {
      assert.notEqual(navigationProblem(url, ORIGINS), null, url);
    }
  });

  it('refuses anything that is not http(s) or a /path', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/hosts', 'chrome://settings', 'login.html', '?q=1', 'localhost:4173/']) {
      assert.notEqual(navigationProblem(url, ORIGINS), null, url);
    }
  });
});
