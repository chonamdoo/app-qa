// Sensitive URL query/fragment values are masked whatever way the parameter name is written: a URL parser decodes a
// percent-encoded name, so the redactor must too before it decides the value is not secret.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedactor } from '../../src/jev/redact.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';

const SECRET = 'REVIEW_TEST_SECRET';

describe('sensitive URL query values', () => {
  it('are masked when the parameter name is percent-encoded, in any hex case, in evidence and Jev text alike', () => {
    const clean = new EvidenceSanitizer([]);
    const jev = createRedactor();
    for (const url of [
      `https://a.example/cb?%74oken=${SECRET}`,
      `https://a.example/cb?access%5ftoken=${SECRET}&state=ok`,
      `https://a.example/cb?x=1&ACCESS%5FTOKEN=${SECRET}`,
      `https://a.example/#%69d%5F%74oken=${SECRET}`,
      `https://a.example/cb?%2574oken=${SECRET}`,
    ]) {
      const text = `열린 주소 ${url} 입니다`;
      const masked = text.replace(SECRET, '[REDACTED]');
      assert.equal(clean.text(text), masked, url);
      assert.equal(jev(text), masked, url);
    }
  });

  it('keep plain names as before: every sensitive value masked, other parameters and non-URL text untouched', () => {
    const clean = new EvidenceSanitizer([]);
    assert.equal(
      clean.text(`https://auth.example/cb?code=${SECRET}&amp;state=ok#access_token=${SECRET}`),
      'https://auth.example/cb?code=[REDACTED]&amp;state=ok#access_token=[REDACTED]',
    );
    assert.equal(clean.text(`/p?a=b;Token=${SECRET}&q=1 key= 대기`), '/p?a=b;Token=[REDACTED]&q=1 key= 대기');
    assert.equal(clean.text(`/p?token=${SECRET};key=${SECRET}"`), '/p?token=[REDACTED]"');
    assert.equal(clean.text('/p?tokens=1&xtoken=2&%74oke=3 token=4'), '/p?tokens=1&xtoken=2&%74oke=3 token=4');
  });
});
