import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { actionStatusOf, AppiumClient, AppiumProtocolError, AppiumTransportError, parseW3CError } from '../../src/appium/client.ts';
import { CommandError, shq } from '../../src/appium/exec.ts';
import { crashBlocks, imeVisible } from '../../src/drivers/android.ts';
import { failureStatus, RefusedError, StepError, typeVerdict, xmlMaxDepth } from '../../src/drivers/base.ts';
import { ipsNamesApp } from '../../src/drivers/ios.ts';
import { sliceLog } from '../../src/drivers/logs.ts';

describe('W3C error classification', () => {
  it('refusal codes are rejected; unknown/transport/timeout are uncertain (never retried)', () => {
    assert.equal(actionStatusOf(parseW3CError(404, '{"value":{"error":"no such element","message":"x"}}')), 'rejected');
    assert.equal(actionStatusOf(parseW3CError(404, '{"value":{"error":"invalid session id","message":"x"}}')), 'rejected');
    assert.equal(actionStatusOf(parseW3CError(500, '{"value":{"error":"unknown error","message":"Could not proxy command: socket hang up"}}')), 'uncertain');
    assert.equal(actionStatusOf(parseW3CError(500, '{"value":{"error":"timeout","message":"x"}}')), 'uncertain');
    assert.equal(actionStatusOf(new AppiumTransportError('timeout', 'x')), 'uncertain');
    assert.equal(actionStatusOf(new Error('anything else')), 'uncertain');
  });

  it('non-JSON error bodies become "unknown error" with the text kept', () => {
    const e = parseW3CError(502, 'Bad Gateway');
    assert.equal(e.code, 'unknown error');
    assert.match(e.message, /Bad Gateway/);
  });

  it('host commands: non-zero exit / missing binary → rejected, killed (timeout) → uncertain; sub-step outcomes propagate', () => {
    assert.equal(failureStatus(new CommandError('adb', [], 1, '', null, 'exit 1')), 'rejected');
    assert.equal(failureStatus(new CommandError('adb', [], null, '', 'ENOENT', 'ENOENT')), 'rejected');
    assert.equal(failureStatus(new CommandError('adb', [], null, '', null, 'killed')), 'uncertain');
    assert.equal(failureStatus(new RefusedError('no focus')), 'rejected');
    assert.equal(failureStatus(new StepError({ status: 'uncertain', ms: 1 })), 'uncertain');
    assert.equal(failureStatus(new StepError({ status: 'rejected', ms: 1 })), 'rejected');
  });
});

describe('AppiumClient over HTTP', () => {
  let server: Server;
  let url: string;
  let lastHeaders: IncomingHttpHeaders = {};
  // 2xx bodies that are not a usable W3C answer for the command.
  const OK_BODIES: Record<string, string> = {
    '/ok-but-error': '{"value":{"error":"unknown error","message":"boom"}}',
    '/error-no-message': '{"value":{"error":"no such element"}}',
    '/bad-error': '{"value":{"error":42,"message":"x"}}',
    '/empty': '{}',
    '/array': '[1,2]',
    '/garbage': '<html>oops',
    '/null-value': '{"value":null}',
    '/session': '{"value":{"capabilities":{}}}',
    '/session/s2/source': '{"value":{"not":"xml"}}',
    '/session/s2/screenshot': '{"value":"aGVsbG8="}',
    '/session/s2/window/rect': '{"value":{"x":0,"y":0,"width":"390","height":844}}',
    '/session/s2/elements': '{"value":[{"element-6066-11e4-a52e-4f735466cecf":"E1"},{"id":"E2"}]}',
  };
  before(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      if (req.url === '/slow') return; // never answers: the client's own AbortSignal timeout must fire
      if (req.url === '/session/s1/element') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return void res.end('{"value":{"error":"no such element","message":"An element could not be located","stacktrace":""}}');
      }
      const canned = OK_BODIES[req.url ?? ''];
      if (canned) return void res.end(canned);
      if (req.url === '/session/s1/element/active') return void res.end('{"value":{"element-6066-11e4-a52e-4f735466cecf":"E1"}}');
      res.end('{"value":{"ready":true}}');
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('times out as a transport error of kind "timeout"', async () => {
    const err = await new AppiumClient(url).request('GET', '/slow', undefined, 100).catch((e: unknown) => e);
    assert.ok(err instanceof AppiumTransportError);
    assert.equal(err.kind, 'timeout');
  });

  it('connection refused is a transport error (uncertain)', async () => {
    const err = await new AppiumClient('http://127.0.0.1:1').status(500).catch((e: unknown) => e);
    assert.ok(err instanceof AppiumTransportError);
    assert.equal(err.kind, 'transport');
  });

  it('HTTP 200 carrying a W3C error object still throws a protocol error', async () => {
    const err = await new AppiumClient(url).request('GET', '/ok-but-error').catch((e: unknown) => e);
    assert.ok(err instanceof AppiumProtocolError);
    assert.equal(err.code, 'unknown error');
  });

  it('a 200 W3C error without a message is still that error (a refusal code stays rejected)', async () => {
    const err = await new AppiumClient(url).request('GET', '/error-no-message').catch((e: unknown) => e);
    assert.ok(err instanceof AppiumProtocolError);
    assert.equal(err.code, 'no such element');
    assert.equal(actionStatusOf(err), 'rejected');
  });

  it('a 200 body without a W3C value envelope, or with a non-string error, is malformed → uncertain', async () => {
    for (const path of ['/empty', '/array', '/garbage', '/bad-error']) {
      const err = await new AppiumClient(url).request('GET', path).catch((e: unknown) => e);
      assert.ok(err instanceof AppiumTransportError, path);
      assert.equal(err.kind, 'malformed', path);
      assert.equal(actionStatusOf(err), 'uncertain', path);
    }
    assert.equal(await new AppiumClient(url).request('GET', '/null-value'), null);
  });

  it('command results the drivers use are shape-checked (session id, XML source, PNG screenshot, rect, element refs)', async () => {
    const c = new AppiumClient(url);
    const noSession = await c.createSession({}).catch((e: unknown) => e);
    assert.ok(noSession instanceof AppiumTransportError && noSession.kind === 'malformed');
    assert.equal(c.sessionId, null);
    c.sessionId = 's2';
    for (const call of [() => c.source(), () => c.screenshot(), () => c.windowRect(), () => c.findElements({ using: 'xpath', value: '//*' })]) {
      const err = await call().catch((e: unknown) => e);
      assert.ok(err instanceof AppiumTransportError && err.kind === 'malformed', String(err));
      assert.equal(failureStatus(err), 'uncertain');
    }
  });

  it('marks every request sensitive so Appium masks bodies in its log', async () => {
    await new AppiumClient(url).status(500);
    assert.equal(lastHeaders['x-appium-is-sensitive'], 'true');
  });

  it('findElement maps "no such element" to null and reads W3C element ids', async () => {
    const c = new AppiumClient(url);
    c.sessionId = 's1';
    assert.equal(await c.findElement({ using: 'xpath', value: '//x' }), null);
    assert.equal(await c.activeElement(), 'E1');
  });
});

describe('typed-text verification', () => {
  it('match ignores NFC form and whitespace differences', () => {
    const nfd = '대한항공'.normalize('NFD');
    assert.equal(typeVerdict('대한항공', '', `  ${nfd} `, false), 'match');
  });

  it('fallback allowed only when the field did not change at all', () => {
    assert.equal(typeVerdict('대한항공', '', '', false), 'unchanged');
    assert.equal(typeVerdict('대한항공', '', '대한', false), 'partial');
    assert.equal(typeVerdict('대한항공', '', '대한항공대한항공', false), 'partial');
  });

  it('secure fields compare length only', () => {
    assert.equal(typeVerdict('pw12', '', '••••', true), 'match');
    assert.equal(typeVerdict('pw12', '', '•••', true), 'partial');
  });
});

describe('page source depth', () => {
  it('counts nesting below the root wrapper; ">" inside attribute values does not confuse it', () => {
    const xml = '<?xml version="1.0"?><hierarchy rotation="0"><a text="다음 >"><b><c/></b></a><d/></hierarchy>';
    assert.equal(xmlMaxDepth(xml), 3);
    assert.equal(xmlMaxDepth('<AppiumAUT><XCUIElementTypeApplication name="x"/></AppiumAUT>'), 1);
  });
});

describe('log slicing', () => {
  it('android UTC lines: inclusive range, continuation lines follow their stamped line', () => {
    const text = [
      '--------- beginning of main',
      '2026-09-25 23:45:40.000 +0000   518   518 I a: before',
      '2026-09-25 23:45:43.620 +0000   518   518 E a: in range',
      '\tat com.example.Foo(Foo.java:1)',
      '2026-09-25 23:45:50.000 +0000   518   518 I a: after',
    ].join('\n');
    const out = sliceLog('android', text, Date.parse('2026-09-25T23:45:43.000Z'), Date.parse('2026-09-25T23:45:45.000Z'));
    assert.equal(out, '2026-09-25 23:45:43.620 +0000   518   518 E a: in range\n\tat com.example.Foo(Foo.java:1)');
  });

  it('ios compact lines are host local time', () => {
    const text = 'Timestamp               Ty Process[PID:TID]\n2026-09-26 08:45:43.620 E  app[1:2] boom\n2026-09-26 08:46:00.000 I  app[1:2] later';
    const from = new Date(2026, 8, 26, 8, 45, 43).getTime();
    assert.equal(sliceLog('ios', text, from, from + 1000), '2026-09-26 08:45:43.620 E  app[1:2] boom');
  });
});

describe('crash evidence filters', () => {
  it('android crash buffer: keeps whole pid blocks since the start that mention the app', () => {
    const text = [
      '2026-09-25 23:00:00.000 +0000  100  100 E AndroidRuntime: Process: kr.tteonam.app, PID: 100',
      '2026-09-25 23:50:00.000 +0000  200  200 E AndroidRuntime: FATAL EXCEPTION: main',
      '2026-09-25 23:50:00.001 +0000  200  200 E AndroidRuntime: Process: kr.tteonam.app, PID: 200',
      '2026-09-25 23:50:00.002 +0000  200  200 E AndroidRuntime: java.lang.IllegalStateException',
      '2026-09-25 23:50:01.000 +0000  300  300 E AndroidRuntime: Process: com.other, PID: 300',
    ].join('\n');
    const out = crashBlocks(text, 'kr.tteonam.app', Date.parse('2026-09-25T23:30:00Z'));
    assert.equal(out.split('\n').length, 3);
    assert.ok(out.includes('FATAL EXCEPTION') && !out.includes('com.other') && !out.includes('PID: 100'));
  });

  it('ios .ips header must name the bundle id', () => {
    assert.equal(ipsNamesApp('{"app_name":"app","bundleID":"kr.tteonam.app"}\n{...}', 'kr.tteonam.app'), true);
    assert.equal(ipsNamesApp('{"bundleID":"kr.tteonam.app.widget"}\n', 'kr.tteonam.app'), false);
    assert.equal(ipsNamesApp('not json', 'kr.tteonam.app'), false);
  });
});

describe('android keyboard detection', () => {
  it('reads the IME window visibility from dumpsys window InputMethod', () => {
    const hidden = 'Window #0 Window{42e44c7 u0 InputMethod}:\n    mViewVisibility=0x8 mHaveFrame=true\n    mHasSurface=false isReadyForDisplay()=false\n    isOnScreen=false\n    isVisible=false\n';
    const shown = 'Window #0 Window{42e44c7 u0 InputMethod}:\n    mViewVisibility=0x0\n    Surface: shown=true      mDrawState=HAS_DRAWN\n    isOnScreen=true\n    isVisible=true\n';
    assert.equal(imeVisible(hidden), false);
    assert.equal(imeVisible(shown), true);
    assert.equal(imeVisible(''), false);
  });
});

describe('device shell quoting', () => {
  it('round-trips hostile strings through sh unchanged', () => {
    for (const s of ["it's", 'a; rm -rf /', '$(id) `id` "q"', 'tteonam://flight?q=대한항공&x=1']) {
      assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shq(s)}`], { encoding: 'utf8' }), s);
    }
  });
});
