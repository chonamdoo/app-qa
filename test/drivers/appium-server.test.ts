// Appium must never write typed text / request bodies to .qa/logs/appium.log or into error messages, and a server
// that may have been started with another log configuration is never reused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AppiumClient } from '../../src/appium/client.ts';
import { APPIUM_LOG_FILTERS, appiumLaunchConfig, appiumServerArgs, ensureAppium, logExcerpt } from '../../src/appium/server.ts';

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

describe('reusing an Appium server that is already running', () => {
  let server: Server;
  let port: number;
  let dir: string;
  let stateFile: string;
  before(async () => {
    // A ready "Appium" owned by this test process.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: { ready: true, build: { version: '3.8.0' } } }));
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    port = (server.address() as AddressInfo).port;
    dir = mkdtempSync(join(tmpdir(), 'qa-appium-state-'));
    stateFile = join(dir, 'appium.json');
  });
  after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The record `ensureAppium` writes when it spawns this server, with `over` changed. */
  const record = (over: Record<string, unknown> = {}) =>
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date(performance.timeOrigin).toISOString(), ...appiumLaunchConfig(port), ...over }));

  it('reuses the server when its record proves this project started it with the current log config', async () => {
    record();
    const s = await ensureAppium({ port, stateFile });
    assert.deepEqual({ reused: s.reused, pid: s.pid, version: s.version }, { reused: true, pid: process.pid, version: '3.8.0' });
  });

  it('refuses — and leaves running — a server not proven to run the current log config', async () => {
    const idle = spawn('sleep', ['30'], { stdio: 'ignore' });
    await once(idle, 'spawn');
    const idleStartedAt = new Date().toISOString();
    try {
      const cases: Record<string, () => void> = {
        'no record': () => rmSync(stateFile, { force: true }),
        'record without launch config (written before the check existed)': () =>
          writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date(performance.timeOrigin).toISOString() })),
        'started at log level debug': () => record({ argv: appiumServerArgs(port).map((a) => (a === 'warn' ? 'debug' : a)) }),
        'started with other log filters': () => record({ logFilters: '0'.repeat(64) }),
        'recorded for another port': () => record({ port: port + 1 }),
        'recorded pid now belongs to another process': () => record({ startedAt: new Date(performance.timeOrigin - 3_600_000).toISOString() }),
        'recorded process is not the one listening on the port': () => record({ pid: idle.pid, startedAt: idleStartedAt }),
      };
      for (const [name, write] of Object.entries(cases)) {
        write();
        await assert.rejects(ensureAppium({ port, stateFile }), /재사용하지 않습니다[\s\S]*직접 종료/, name);
        assert.equal((await new AppiumClient(`http://127.0.0.1:${port}`).status()).ready, true, `${name}: the running server is left alone`);
      }
      assert.equal(idle.exitCode, null);
      assert.equal(idle.signalCode, null);
    } finally {
      idle.kill('SIGKILL');
    }
  });
});
