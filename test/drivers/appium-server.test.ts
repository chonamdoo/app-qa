// Appium must never write typed text / request bodies to .qa/logs/appium.log or into error messages.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPIUM_LOG_FILTERS, appiumServerArgs, logExcerpt } from '../../src/appium/server.ts';

const SECRET = 'hunter2비밀';

/** Body lines Appium 3.8 writes at info (`-->`), debug (proxy/Calling) or on a bad payload (warn). */
const BODY_LINES = [
  `2026-09-26 10:00:00:001 [HTTP] --> POST /session/s1/element/E1/value {"text":"${SECRET}","value":${JSON.stringify([...SECRET])}}`,
  `2026-09-26 10:00:00:002 [HTTP] --> POST /session/s1/keys {"value":["${SECRET}"]}`,
  `2026-09-26 10:00:00:003 [HTTP] --> POST /session/s1/execute/sync {"script":"mobile: setClipboard","args":[{"content":"${Buffer.from(SECRET).toString('base64')}","contentType":"plaintext"}]}`,
  `2026-09-26 10:00:00:004 [UiAutomator2] Proxying [POST /element/E1/value] to [POST http://127.0.0.1:8200/session/x/element/E1/value] with body: {"text":"${SECRET}"}`,
  `2026-09-26 10:00:00:005 [HTTP] --> POST /session/s1/element/E1/value {"text":"${SECRET}${'x'.repeat(40)}...`,
];

describe('Appium server logging', () => {
  it('starts at a level that drops request bodies (info logs them in Appium 3.8), with filters from a file', () => {
    const args = appiumServerArgs(4723);
    assert.equal(args[args.indexOf('--log-level') + 1], 'warn');
    assert.equal(args[args.indexOf('--address') + 1], '127.0.0.1');
    assert.equal(args[args.indexOf('--port') + 1], '4723');
    // Appium splits array CLI values on commas, which breaks inline JSON: the filters must come from a JSON file.
    const filters = args[args.indexOf('--log-filters') + 1]!;
    assert.match(filters, /^\/.*\.json$/);
  });

  it('log filters rewrite every text/value/content field as Appium applies them (new RegExp(pattern, "g"))', () => {
    for (const line of BODY_LINES) {
      let masked = line;
      for (const r of APPIUM_LOG_FILTERS) {
        new RegExp(r.pattern, 'u'); // Appium's config schema validates `format: regex` in unicode mode
        masked = masked.replace(new RegExp(r.pattern, 'g'), r.replacer);
      }
      assert.ok(!masked.includes(SECRET.slice(0, 6)), masked);
      assert.ok(!masked.includes(Buffer.from(SECRET).toString('base64')), masked);
      assert.ok(!masked.includes('"h","u"'), masked);
    }
  });

  it('startup error excerpts keep diagnostics but drop every body-bearing line', () => {
    const log = [
      '2026-09-26 10:00:00:000 [Appium] Welcome to Appium v3.8.0',
      ...BODY_LINES,
      `2026-09-26 10:00:00:006 [HTTP] Calling AndroidUiautomator2Driver.setValue() with args: [${JSON.stringify([...SECRET])},"E1","s1"]`,
      '2026-09-26 10:00:00:007 [Appium] Creating session with W3C capabilities: {',
      `  "alwaysMatch": "${SECRET}"`,
      '}',
      '2026-09-26 10:00:01:000 [Appium] Error: listen EADDRINUSE: address already in use 127.0.0.1:4723',
    ].join('\n');
    const excerpt = logExcerpt(log);
    assert.ok(!excerpt.includes(SECRET.slice(0, 6)), excerpt);
    assert.match(excerpt, /EADDRINUSE/);
    assert.match(excerpt, /Welcome to Appium/);
    assert.equal(logExcerpt(log, 1), '2026-09-26 10:00:01:000 [Appium] Error: listen EADDRINUSE: address already in use 127.0.0.1:4723');
  });
});
